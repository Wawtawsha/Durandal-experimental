#!/usr/bin/env node

/**
 * Durandal Memory MCP Server v3
 *
 * Zero-config persistent memory for Claude Code via the Model Context Protocol.
 * This file is the single entry point for both the MCP server (stdio transport)
 * and the admin CLI (--test, --status, --discover, --migrate, --configure,
 * --update, --version, --help).
 *
 * Modernized in phase 4 to use the high-level `McpServer` API and Zod input
 * schemas from @modelcontextprotocol/sdk ^1.29.0 instead of the older
 * Server + setRequestHandler(ListToolsRequestSchema) low-level API.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const MemoryDB = require('./db');
const Logger = require('./logger');
const {
    MCPError,
    ValidationError,
    DatabaseError,
    ErrorHandler
} = require('./errors');
const TestRunner = require('./test-runner');
const UpdateChecker = require('./update-checker');

// -----------------------------------------------------------------------------
// Zod input schemas — these both validate tool calls and drive the JSON Schema
// advertised to clients via tools/list. Raw schema objects from prior versions
// duplicated the validation logic in each handler; now Zod enforces it for us.
// -----------------------------------------------------------------------------

const metadataSchema = z.object({
    project: z.string().optional(),
    session: z.string().optional(),
    type: z.string().optional(),
    importance: z.number().min(0).max(1).optional(),
    categories: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional()
}).passthrough();

const filtersSchema = z.object({
    project: z.string().optional(),
    session: z.string().optional(),
    categories: z.array(z.string()).optional(),
    importance_min: z.number().min(0).max(1).optional(),
    importance_max: z.number().min(0).max(1).optional()
}).passthrough();

const logLevel = z.enum(['error', 'warn', 'info', 'debug']);

// Iter 3: outputSchema fragments for tools whose structuredContent is part
// of the public contract. Clients with typed tool support can rely on these.
// We don't declare an outputSchema for tools whose response shape is opaque
// or varies (configure_logging, get_logs, optimize_memory).
const memoryRowSchema = z.object({
    id: z.number().int(),
    content: z.string(),
    metadata: z.object({}).passthrough(),
    created_at: z.string()
});

// -----------------------------------------------------------------------------
// Server class
// -----------------------------------------------------------------------------

class DurandalMCPServer extends EventEmitter {
    constructor(options = {}) {
        super();

        this.loadPersistedConfig();

        this.logger = new Logger({
            level: options.logLevel || process.env.LOG_LEVEL || 'warn',
            verbose: options.verbose || process.env.VERBOSE === 'true',
            debug: options.debug || process.env.DEBUG === 'true',
            logMCPTools: options.logMCPTools || process.env.LOG_MCP_TOOLS === 'true',
            logFile: options.logFile || process.env.LOG_FILE,
            errorLogFile: options.errorLogFile || process.env.ERROR_LOG_FILE
        });

        this.errorHandler = new ErrorHandler(this.logger);
        this.packageInfo = this.loadPackageInfo();

        this.logger.info('[START] Durandal MCP Server starting', {
            version: this.packageInfo.version,
            node: process.version,
            pid: process.pid
        });

        // High-level SDK server — uses registerTool / registerResource /
        // registerPrompt instead of the low-level setRequestHandler pattern.
        this.server = new McpServer({
            name: 'durandal-memory-server',
            version: this.packageInfo.version
        }, {
            capabilities: {
                tools: { listChanged: true },
                // Phase 6: announce resources (memory://{id}) and prompt templates
                resources: { listChanged: true },
                prompts: { listChanged: true },
                logging: {}
            }
        });

        this.db = new MemoryDB();

        this.ready = this.runDatabaseStartupCheck();
        this.registerTools();
    }

    loadPackageInfo() {
        try {
            const packagePath = path.join(__dirname, 'package.json');
            return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        } catch (error) {
            this.logger?.warn('Could not load package.json', { error: error.message });
            return { version: 'unknown', description: 'Durandal MCP Server' };
        }
    }

    loadPersistedConfig() {
        try {
            const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
            const envPath = path.join(homeDir, '.durandal-mcp', '.env');
            if (!fs.existsSync(envPath)) return;

            const envContent = fs.readFileSync(envPath, 'utf8');
            for (const line of envContent.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx < 0) continue;
                const key = trimmed.slice(0, eqIdx);
                const value = trimmed.slice(eqIdx + 1);
                if (key && value && !process.env[key]) {
                    process.env[key] = value;
                }
            }
        } catch (_) {
            // Best-effort — config loading must never break the server.
        }
    }

    // -------------------------------------------------------------------------
    // Startup checks
    // -------------------------------------------------------------------------

    async runDatabaseStartupCheck() {
        this.logger.info('[DB-CHECK] Running database startup check...');

        const checks = { connectivity: false, schema: false, readWrite: false, integrity: false };

        try {
            const connTest = await this.db.testConnection();
            if (!connTest.success) throw new Error(`Database connectivity failed: ${connTest.error}`);
            checks.connectivity = true;

            const schemaTest = await this.validateDatabaseSchema();
            checks.schema = true;
            if (!schemaTest.valid) {
                this.logger.warn('[DB-CHECK] Schema validation warnings', { issues: schemaTest.issues });
            }

            const rwTest = await this.testReadWrite();
            if (!rwTest.success) throw new Error(`Database read/write failed: ${rwTest.error}`);
            checks.readWrite = true;

            const integrityTest = await this.checkDatabaseIntegrity();
            checks.integrity = true;
            if (!integrityTest.ok) {
                this.logger.warn('[DB-CHECK] Integrity issues', { issues: integrityTest.errors });
            }

            this.logger.success('[DB-CHECK] All database checks passed');
        } catch (error) {
            this.logger.error('[DB-CHECK] Critical database check failed', {
                error: error.message,
                checks
            });
            // Don't crash — expose the failure via get_status instead.
            this._startupCheckError = error.message;
        }
    }

    async validateDatabaseSchema() {
        try {
            const tables = await this.db.listTables();
            if (!tables.includes('memories')) {
                return { valid: false, issues: ['missing memories table'] };
            }
            const cols = await this.db.tableColumns('memories');
            const missing = ['id', 'content'].filter(c => !cols.includes(c));
            if (missing.length) return { valid: false, issues: [`missing columns: ${missing.join(', ')}`] };
            return { valid: true, issues: [] };
        } catch (error) {
            return { valid: false, issues: [error.message] };
        }
    }

    async testReadWrite() {
        try {
            const content = `[DB-CHECK] Test ${new Date().toISOString()}`;
            const result = await this.db.storeMemory(content, { type: 'system-test', test: true });
            if (!result?.success || !result.id) {
                throw new Error(result?.error || 'storeMemory returned no id');
            }
            await this.db.deleteMemoryById(result.id);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async checkDatabaseIntegrity() {
        try {
            const rows = await this.db.integrityCheck();
            const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
            return ok ? { ok: true, errors: [] } : { ok: false, errors: rows.map(r => r.integrity_check) };
        } catch (error) {
            return { ok: false, errors: [error.message] };
        }
    }

    // -------------------------------------------------------------------------
    // MCP tool registration
    // -------------------------------------------------------------------------

    // Wrap each handler so it logs uniformly and surfaces validation errors as
    // isError:true MCP responses with a recovery hint, which the 1.29 spec uses
    // to give clients a structured way to handle tool failures.
    //
    // Iter 3 also emits MCP `notifications/message` log events through the
    // protocol so connected clients see a record of every tool call without
    // needing access to the server's stderr.
    wrapHandler(toolName, handler) {
        return async (args) => {
            const requestId = this.logger.startMCPTool(toolName, args);
            const started = Date.now();
            this._emitMcpLog('debug', { event: 'tool_call_start', tool: toolName });
            try {
                const result = await handler.call(this, args || {}, requestId);
                this.logger.endMCPTool(requestId, true, result);
                this._emitMcpLog('info', {
                    event: 'tool_call_complete',
                    tool: toolName,
                    duration_ms: Date.now() - started,
                    isError: result?.isError === true
                });
                return result;
            } catch (error) {
                this.logger.endMCPTool(requestId, false, null, error);
                this._emitMcpLog('error', {
                    event: 'tool_call_error',
                    tool: toolName,
                    duration_ms: Date.now() - started,
                    error: error.message
                });
                const wrapped = this.errorHandler.handle(error, requestId);
                return {
                    isError: true,
                    content: [{
                        type: 'text',
                        text: `[ERR] ${wrapped.error.message}\n\nRecovery: ${wrapped.error.recovery || 'Check logs for details'}`
                    }]
                };
            }
        };
    }

    // MCP log notification — best-effort, swallows transport errors so a
    // disconnected client can never break tool execution. isConnected()
    // returns false during startup before transport.connect resolves.
    _emitMcpLog(level, data) {
        try {
            if (typeof this.server?.isConnected === 'function' && !this.server.isConnected()) return;
            this.server.sendLoggingMessage({
                level,
                logger: 'durandal-memory',
                data
            }).catch(() => {});
        } catch (_) { /* best-effort */ }
    }

    registerTools() {
        const R = (name, config, handler) => this.server.registerTool(name, config, this.wrapHandler(name, handler));

        R('store_memory', {
            title: 'Store Memory',
            description: 'Store a piece of information so Claude can recall it in a future session. Content is indexed for both lexical (BM25) and semantic (embedding) search. If the new memory is a near-duplicate of an existing one in the same project, the older one is automatically superseded (hidden from results but not deleted) and reported in the response.',
            inputSchema: {
                content: z.string().min(1).max(50000).describe('The text to remember'),
                metadata: metadataSchema.optional().describe('Optional tagging/categorization metadata')
            },
            outputSchema: {
                id: z.number().int(),
                project: z.string(),
                session: z.string(),
                importance: z.number().nullable(),
                categories: z.array(z.string()),
                superseded: z.number().int().nullable().describe('Id of a near-duplicate memory this one replaced, or null')
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false
            }
        }, this.handleStoreMemory);

        R('search_memories', {
            title: 'Search Memories',
            description: 'Hybrid search over stored memories: lexical full-text (BM25) and semantic (embedding similarity) candidates are fused with Reciprocal Rank Fusion. Lexical catches exact tokens (identifiers, error strings); semantic catches paraphrase ("build broken" finds "compilation failing"). Falls back to lexical-only, then substring, if embeddings are unavailable. Filterable by project/session/categories/importance. Superseded (consolidated) memories are excluded.',
            inputSchema: {
                query: z.string().min(1).describe('Natural-language or keyword query. Matched both lexically and semantically.'),
                filters: filtersSchema.optional(),
                limit: z.number().int().min(1).max(100).optional().default(10)
            },
            outputSchema: {
                count: z.number().int(),
                total: z.number().int().describe('Lexical (FTS) matches passing the filters; semantic neighbours may add related results within the returned set.'),
                results: z.array(memoryRowSchema.extend({
                    relevance: z.number().nullable().describe('Fused RRF score (higher = more relevant)'),
                    snippet: z.string().nullable(),
                    distance: z.number().nullable().optional().describe('Cosine distance from the query (lower = closer), if matched semantically'),
                    signals: z.array(z.string()).optional().describe('Which signals matched: "lexical", "semantic", or "substring"')
                }))
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        }, this.handleSearchMemories);

        R('get_context', {
            title: 'Get Context',
            description: 'Get the most recent memories for a given project/session with optional counts.',
            inputSchema: {
                project: z.string().optional(),
                session: z.string().optional(),
                limit: z.number().int().min(1).max(50).optional().default(10),
                include_stats: z.boolean().optional().default(true)
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        }, this.handleGetContext);

        R('optimize_memory', {
            title: 'Optimize Memory',
            description: 'Run SQLite maintenance: VACUUM, ANALYZE, integrity check, WAL checkpoint.',
            inputSchema: {
                operations: z.array(z.enum(['vacuum', 'analyze', 'integrity_check', 'wal_checkpoint']))
                    .optional()
                    .default(['vacuum', 'analyze'])
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        }, this.handleOptimizeMemory);

        R('get_status', {
            title: 'Get Status',
            description: 'Show server status: version, uptime, database path and size, memory counts, logging config.',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: false }
        }, this.handleGetStatus);

        R('configure_logging', {
            title: 'Configure Logging',
            description: 'Change console and file logging levels at runtime. Persists to ~/.durandal-mcp/.env.',
            inputSchema: {
                console_level: logLevel.optional(),
                file_level: logLevel.optional()
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        }, this.handleConfigureLogging);

        R('get_logs', {
            title: 'Get Logs',
            description: 'Retrieve recent log entries from the session history log file, optionally filtered by level or search.',
            inputSchema: {
                lines: z.number().int().min(1).max(10000).optional().default(50),
                level_filter: logLevel.optional(),
                search: z.string().optional()
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        }, this.handleGetLogs);

        R('list_projects_sessions', {
            title: 'List Projects and Sessions',
            description: 'List all distinct projects and/or sessions in the database with memory counts and date ranges.',
            inputSchema: {
                type: z.enum(['projects', 'sessions', 'both']).optional().default('both'),
                include_samples: z.boolean().optional().default(false),
                limit: z.number().int().min(1).max(500).optional().default(50)
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        }, this.handleListProjectsSessions);

        R('get_memory', {
            title: 'Get Memory By ID',
            description: 'Fetch a single memory by its numeric id.',
            inputSchema: { id: z.number().int().positive() },
            outputSchema: {
                found: z.boolean(),
                id: z.number().int().optional(),
                memory: memoryRowSchema.optional()
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        }, this.handleGetMemory);

        R('delete_memory', {
            title: 'Delete Memory',
            description: 'Delete a memory by its numeric id. Irreversible.',
            inputSchema: { id: z.number().int().positive() },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
        }, this.handleDeleteMemory);

        // --- Phase 6 additions ---

        R('store_memories_batch', {
            title: 'Store Memories (Batch)',
            description: 'Insert multiple memories in a single transaction. Returns the list of created ids in input order.',
            inputSchema: {
                items: z.array(z.object({
                    content: z.string().min(1).max(50000),
                    metadata: metadataSchema.optional()
                })).min(1).max(1000)
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        }, this.handleStoreMemoriesBatch);

        R('update_memory', {
            title: 'Update Memory',
            description: 'Update content and/or metadata of an existing memory. Provided metadata replaces the existing metadata entirely.',
            inputSchema: {
                id: z.number().int().positive(),
                content: z.string().min(1).max(50000).optional(),
                metadata: metadataSchema.optional()
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        }, this.handleUpdateMemory);

        R('list_memories', {
            title: 'List Memories',
            description: 'Paginated list of memories with optional project/session/date filters. No search query required.',
            inputSchema: {
                project: z.string().optional(),
                session: z.string().optional(),
                since: z.string().optional().describe('ISO 8601 start timestamp (inclusive)'),
                until: z.string().optional().describe('ISO 8601 end timestamp (inclusive)'),
                limit: z.number().int().min(1).max(500).optional().default(50),
                offset: z.number().int().min(0).optional().default(0)
            },
            outputSchema: {
                count: z.number().int(),
                total: z.number().int().describe('Total rows matching the filters (before limit/offset).'),
                offset: z.number().int(),
                limit: z.number().int(),
                memories: z.array(memoryRowSchema)
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        }, this.handleListMemories);

        R('export_memories', {
            title: 'Export Memories',
            description: 'Dump all memories as a JSON array suitable for backup or migration.',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: false }
        }, this.handleExportMemories);

        R('import_memories', {
            title: 'Import Memories',
            description: 'Insert memories from a JSON array (as produced by export_memories). Each item may provide content and metadata.',
            inputSchema: {
                items: z.array(z.object({
                    content: z.string().min(1),
                    // Use an open object with passthrough instead of z.record —
                    // Zod 4's record-to-JSON-schema conversion crashes on
                    // records of z.any(), but an open object serializes fine.
                    metadata: z.object({}).passthrough().optional()
                })).min(1).max(10000)
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        }, this.handleImportMemories);

        R('rename_project', {
            title: 'Rename Project',
            description: 'Rename a project name across every memory that has it. Useful for reorganizing.',
            inputSchema: {
                from: z.string().min(1),
                to: z.string().min(1)
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        }, this.handleRenameProject);

        // --- Iteration 2 additions ---

        R('backup_database', {
            title: 'Backup Database',
            description: 'Create an atomic, consistent snapshot of the memory database at the given path. Uses SQLite VACUUM INTO — no downtime, no locked writes.',
            inputSchema: {
                destination: z.string().min(1).describe('Absolute path where the backup file will be written')
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
        }, this.handleBackupDatabase);

        R('delete_memories_where', {
            title: 'Delete Memories By Filter',
            description: 'Bulk delete memories matching a project, session, or older-than timestamp filter. Requires at least one filter criterion. Irreversible.',
            inputSchema: {
                project: z.string().optional(),
                session: z.string().optional(),
                older_than: z.string().optional().describe('ISO 8601 timestamp; rows with created_at < this are deleted')
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
        }, this.handleDeleteMemoriesWhere);

        // --- Iter 3 additions ---

        R('find_similar', {
            title: 'Find Similar Memories',
            description: 'Find memories semantically similar to the given one using embedding similarity (cosine KNN), excluding the source and any superseded memories. Falls back to FTS token-overlap if embeddings are unavailable.',
            inputSchema: {
                id: z.number().int().positive(),
                limit: z.number().int().min(1).max(50).optional().default(5)
            },
            outputSchema: {
                source_id: z.number().int(),
                count: z.number().int(),
                results: z.array(memoryRowSchema.extend({
                    relevance: z.number().nullable().optional(),
                    distance: z.number().nullable().optional()
                }))
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        }, this.handleFindSimilar);

        R('tag_memory', {
            title: 'Tag Memory',
            description: 'Add and/or remove categories on a memory without rewriting its other metadata. Lighter than update_memory.',
            inputSchema: {
                id: z.number().int().positive(),
                add: z.array(z.string()).optional(),
                remove: z.array(z.string()).optional()
            },
            outputSchema: {
                tagged: z.boolean(),
                id: z.number().int(),
                categories: z.array(z.string()).optional()
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        }, this.handleTagMemory);

        // --- MCP resources: each memory is addressable as durandal://memory/{id} ---
        // Using a ResourceTemplate so clients can list and discover memories
        // without the server pre-enumerating them all.
        const { ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
        this.server.registerResource(
            'memory',
            new ResourceTemplate('durandal://memory/{id}', {
                list: async () => {
                    const recent = await this.db.getRecentMemories(100, null, null);
                    return {
                        resources: recent.map(r => ({
                            uri: `durandal://memory/${r.id}`,
                            name: `Memory ${r.id}`,
                            description: r.content.slice(0, 120),
                            mimeType: 'application/json'
                        }))
                    };
                }
            }),
            {
                title: 'Memory',
                description: 'An individual stored memory, addressable by its numeric id.',
                mimeType: 'application/json'
            },
            async (uri, params) => {
                const id = Number(params.id);
                if (!Number.isInteger(id) || id <= 0) {
                    throw new ValidationError(`Invalid memory id: ${params.id}`, 'id', params.id);
                }
                const memory = await this.db.getMemoryById(id);
                if (!memory) {
                    throw new MCPError(`Memory ${id} not found`, 'NOT_FOUND');
                }
                return {
                    contents: [{
                        uri: uri.href,
                        mimeType: 'application/json',
                        text: JSON.stringify(memory, null, 2)
                    }]
                };
            }
        );

        // --- MCP prompt template: canned "summarize recent memories" prompt ---
        this.server.registerPrompt(
            'summarize_recent_memories',
            {
                title: 'Summarize Recent Memories',
                description: 'Produce a prompt that asks Claude to summarize the recent memories for a given project.',
                argsSchema: {
                    project: z.string().optional(),
                    limit: z.string().optional()
                }
            },
            async (args) => {
                const project = args.project || 'default';
                const limit = Math.min(parseInt(args.limit || '20', 10) || 20, 100);
                const p = project !== 'default' ? project : null;
                const memories = await this.db.getRecentMemories(limit, p, null);
                const body = memories.length
                    ? memories.map(m => `- (id ${m.id}, ${m.created_at}) ${m.content}`).join('\n')
                    : '(no memories in scope)';
                return {
                    messages: [{
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `Please summarize the following ${memories.length} recent memories from project "${project}". Identify themes, outstanding questions, and anything worth flagging for next session.\n\n${body}`
                        }
                    }]
                };
            }
        );
    }

    // -------------------------------------------------------------------------
    // Tool handler helpers (DRY for metadata defaults + size check)
    // -------------------------------------------------------------------------

    // Stamp a `created_at`, default project/session, and enforce the 64 KB
    // serialized-metadata cap. Used by store_memory, store_memories_batch,
    // update_memory, import_memories. Extracted so the call sites can't drift.
    //
    // `stampDefaults: false` skips the project/session defaults and the
    // created_at re-stamp — used by import where we want to preserve the
    // original metadata as-is from the backup.
    prepareStoredMetadata(metadata, fieldLabel = 'metadata', stampDefaults = true) {
        const m = { ...(metadata || {}) };
        if (stampDefaults) {
            if (!m.project) m.project = 'default';
            if (!m.session) m.session = new Date().toISOString().split('T')[0];
            m.created_at = new Date().toISOString();
        }

        let serialized;
        try {
            serialized = JSON.stringify(m);
        } catch (e) {
            throw new ValidationError(`${fieldLabel} is not serializable: ${e.message}`, fieldLabel, null);
        }
        if (serialized.length > 65536) {
            throw new ValidationError(
                `${fieldLabel} exceeds maximum size (${serialized.length} bytes, max 65536)`,
                fieldLabel,
                serialized.length
            );
        }
        return m;
    }

    // -------------------------------------------------------------------------
    // Tool handlers
    // -------------------------------------------------------------------------

    async handleStoreMemory(args, requestId) {
        this.logger.processing('Processing store_memory request from Claude');

        const content = args.content;
        const enriched = this.prepareStoredMetadata(args.metadata);

        this.logger.substep('Storing to database');
        const dbResult = await this.db.storeMemory(content, enriched);
        if (!dbResult?.success) {
            throw new DatabaseError(
                'Failed to store memory',
                'store',
                new Error(dbResult?.error || 'unknown database error')
            );
        }
        const memoryId = dbResult.id;
        const supersededId = dbResult.supersededId ?? null;

        this.logger.success(`Memory stored (id: ${memoryId})`, {
            requestId, memoryId, contentLength: content.length, importance: enriched.importance, supersededId
        });

        const supersededLine = supersededId
            ? `\n**Consolidated:** superseded near-duplicate memory #${supersededId} (hidden from results, not deleted)`
            : '';

        return {
            content: [{
                type: 'text',
                text: `[OK] Memory stored successfully\n\n` +
                      `**ID:** ${memoryId}\n` +
                      `**Project:** ${enriched.project}\n` +
                      `**Session:** ${enriched.session}\n` +
                      `**Importance:** ${enriched.importance ?? 'Not set'}\n` +
                      `**Categories:** ${enriched.categories?.join(', ') || 'None'}` +
                      supersededLine
            }],
            structuredContent: {
                id: memoryId,
                project: enriched.project,
                session: enriched.session,
                importance: enriched.importance ?? null,
                categories: enriched.categories || [],
                superseded: supersededId
            }
        };
    }

    async handleSearchMemories(args, requestId) {
        this.logger.processing('Processing search_memories request from Claude');
        const { query, filters = {}, limit = 10 } = args;

        this.logger.substep('Querying database (hybrid: lexical + semantic)');
        const { results, total } = await this.db.searchMemories(query, {
            project: filters.project,
            session: filters.session,
            categories: filters.categories,
            importance_min: filters.importance_min,
            importance_max: filters.importance_max,
            limit
        });

        this.logger.success(`Search completed (${results.length} results)`, {
            requestId, query, resultsCount: results.length
        });

        if (!results.length) {
            return {
                content: [{ type: 'text', text: 'No memories found matching your query.' }],
                structuredContent: { count: 0, total, results: [] }
            };
        }

        // Results are ranked by fused RRF score (lexical BM25 + semantic cosine),
        // best first. We surface the snippet() highlight when the lexical signal
        // fired, and tag each result with which signals matched so the value of
        // semantic recall is visible. Raw scores aren't printed — they're only
        // meaningful relative to each other.
        const formatted = results.map((r, i) => {
            const m = r.metadata || {};
            const body = r.snippet
                ? r.snippet
                : (r.content.length > 100 ? r.content.slice(0, 100) + '...' : r.content);
            const how = r.signals?.length ? ` _(${r.signals.join('+')})_` : '';
            return `**${i + 1}. Memory ${r.id}**${how}\n` +
                   `   ${body}\n` +
                   `   Project: ${m.project || 'None'}\n` +
                   `   Session: ${m.session || 'None'}\n` +
                   `   Importance: ${m.importance ?? 'N/A'}\n` +
                   `   Categories: ${m.categories?.join(', ') || 'None'}\n` +
                   `   Created: ${r.created_at || 'Unknown'}`;
        }).join('\n\n');

        return {
            content: [{ type: 'text', text: `**Search Results** (${results.length} shown; ${total} lexical matches)\n\n${formatted}` }],
            structuredContent: {
                count: results.length,
                total,
                results: results.map(r => ({
                    id: r.id,
                    content: r.content,
                    metadata: r.metadata,
                    created_at: r.created_at,
                    relevance: r.relevance ?? null,
                    snippet: r.snippet ?? null,
                    distance: r.distance ?? null,
                    signals: r.signals ?? []
                }))
            }
        };
    }

    async handleGetContext(args, requestId) {
        this.logger.processing('Processing get_context request from Claude');
        const project = args.project || 'default';
        const session = args.session || 'default';
        const limit = args.limit ?? 10;
        const includeStats = args.include_stats !== false;

        const p = project !== 'default' ? project : null;
        const s = session !== 'default' ? session : null;
        const memories = await this.db.getRecentMemories(limit, p, s);

        let stats = null;
        if (includeStats) {
            const s = await this.db.stats({ project: p });
            stats = {
                returned: memories.length,
                totalMemoriesInDb: s.total,
                memoriesInProject: p ? (s.inProject ?? 0) : null
            };
        }

        this.logger.success(`Context retrieved (${memories.length} memories)`, {
            requestId, memoriesCount: memories.length
        });

        let response = `**Context for Project: ${project}, Session: ${session}**\n\n`;
        if (memories.length) {
            response += '**Recent Memories:**\n';
            memories.slice(0, Math.min(5, memories.length)).forEach((memory, index) => {
                const preview = memory.content.length > 80 ? memory.content.slice(0, 80) + '...' : memory.content;
                response += `${index + 1}. ${preview}\n`;
            });
        } else {
            response += 'No recent memories found.\n';
        }
        if (stats) {
            response += `\n**Statistics:**\n- Returned: ${stats.returned}\n- Total memories (database): ${stats.totalMemoriesInDb}\n`;
            if (stats.memoriesInProject !== null) response += `- Memories in "${project}": ${stats.memoriesInProject}\n`;
        }

        return {
            content: [{ type: 'text', text: response }],
            structuredContent: { project, session, memories, stats }
        };
    }

    async handleOptimizeMemory(args, requestId) {
        this.logger.processing('Processing optimize_memory request from Claude');
        const operations = args.operations || ['vacuum', 'analyze'];

        // Capture before/after DB size so the user can see what VACUUM actually
        // reclaimed. Prior versions printed "Cache optimization: Evicted 0 items"
        // with no connection to disk footprint.
        const dbPath = this.db.dbPath;
        const sizeBefore = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;

        const results = [];
        for (const op of operations) {
            try {
                const message = await this.runMaintenanceOperation(op);
                results.push({ operation: op, status: 'ok', message });
            } catch (error) {
                this.logger.error(`Maintenance operation failed: ${op}`, { requestId, error: error.message });
                results.push({ operation: op, status: 'error', message: error.message });
            }
        }

        const sizeAfter = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
        const delta = sizeAfter - sizeBefore;
        const kb = (b) => (b / 1024).toFixed(1);

        this.logger.success('Maintenance complete', {
            requestId, operationsCount: operations.length, sizeBefore, sizeAfter
        });

        const text = results.map(r =>
            `${r.status === 'ok' ? '[OK]' : '[ERR]'} ${r.operation}: ${r.message}`
        ).join('\n');
        const sizeLine = `\n\nDatabase size: ${kb(sizeBefore)} KB → ${kb(sizeAfter)} KB (${delta >= 0 ? '+' : ''}${kb(delta)} KB)`;

        return {
            content: [{ type: 'text', text: `**Database Maintenance Results:**\n\n${text}${sizeLine}` }],
            structuredContent: { results, sizeBefore, sizeAfter, sizeDelta: delta }
        };
    }

    async runMaintenanceOperation(op) {
        switch (op) {
            case 'vacuum':
                await this.db.exec('VACUUM');
                return 'VACUUM completed (reclaimed fragmentation)';
            case 'analyze':
                await this.db.exec('ANALYZE');
                return 'ANALYZE completed (query planner statistics refreshed)';
            case 'integrity_check': {
                const rows = await this.db.integrityCheck();
                const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
                return ok ? 'integrity_check: ok' : `integrity_check: ${rows.map(r => r.integrity_check).join('; ')}`;
            }
            case 'wal_checkpoint': {
                const row = await this.db.pragma('PRAGMA wal_checkpoint(TRUNCATE)');
                return `wal_checkpoint: ${JSON.stringify(row)}`;
            }
            default:
                throw new ValidationError(`Unknown maintenance operation: ${op}`, 'operation', op);
        }
    }

    async handleGetStatus(args, requestId) {
        this.logger.processing('Processing get_status request from Claude');
        const dbPath = this.db.dbPath;
        const dbExists = fs.existsSync(dbPath);
        const dbSize = dbExists ? (fs.statSync(dbPath).size / 1024 / 1024).toFixed(2) : '0.00';

        let dbMemoryCount = 0, dbProjectCount = 0, dbSessionCount = 0;
        if (dbExists) {
            const s = await this.db.stats();
            dbMemoryCount = s.total;
            dbProjectCount = s.projects;
            dbSessionCount = s.sessions;
        }

        const memUsage = process.memoryUsage();
        const statusData = {
            version: this.packageInfo.version,
            uptime: formatUptime(process.uptime()),
            memory: {
                rss: (memUsage.rss / 1024 / 1024).toFixed(2),
                heapUsed: (memUsage.heapUsed / 1024 / 1024).toFixed(2),
                heapTotal: (memUsage.heapTotal / 1024 / 1024).toFixed(2)
            },
            database: {
                path: dbPath,
                connected: dbExists,
                size: dbSize,
                memoryCount: dbMemoryCount,
                projectCount: dbProjectCount,
                sessionCount: dbSessionCount,
                ftsEnabled: this.db.ftsAvailable
            },
            embeddings: this.db.embeddingInfo(),
            logging: {
                consoleLevel: this.logger.getConsoleLevel(),
                fileLevel: this.logger.getFileLevel(),
                logFile: this.logger.logFile
            },
            startupCheckError: this._startupCheckError || null,
            node: process.version,
            platform: process.platform,
            pid: process.pid
        };

        const logFileDisplay = (statusData.logging.logFile || '(none)').slice(-35).padStart(35);
        let output = '\n┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
        output += `┃  Durandal MCP Server v${statusData.version}                              ┃\n`;
        output += '┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫\n';
        output += `┃  Status:          ${(statusData.database.connected ? '[OK] Running' : '[WARN] Database Missing').padEnd(35)}┃\n`;
        output += `┃  Uptime:          ${statusData.uptime.padEnd(35)}┃\n`;
        output += `┃  Memory (RSS):    ${(statusData.memory.rss + ' MB').padEnd(35)}┃\n`;
        output += `┃  Memory (Heap):   ${(statusData.memory.heapUsed + ' / ' + statusData.memory.heapTotal + ' MB').padEnd(35)}┃\n`;
        output += '┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫\n';
        output += `┃  Database:        ${(statusData.database.connected ? '[OK] Connected' : '[ERR] Not Found').padEnd(35)}┃\n`;
        output += `┃  Database Size:   ${(statusData.database.size + ' MB').padEnd(35)}┃\n`;
        output += `┃  Stored Memories: ${(statusData.database.memoryCount + ' memories').padEnd(35)}┃\n`;
        output += `┃  Projects:        ${(statusData.database.projectCount + ' projects').padEnd(35)}┃\n`;
        output += `┃  Sessions:        ${(statusData.database.sessionCount + ' sessions').padEnd(35)}┃\n`;
        output += '┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫\n';
        const emb = statusData.embeddings;
        const embLine = emb.available ? `[OK] ${emb.model}` : '[OFF] lexical-only';
        output += `┃  Semantic Search: ${embLine.slice(0, 35).padEnd(35)}┃\n`;
        output += `┃  Vectors Indexed: ${(emb.vectorCount + ' vectors').padEnd(35)}┃\n`;
        output += '┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫\n';
        output += `┃  Console Level:   ${statusData.logging.consoleLevel.padEnd(35)}┃\n`;
        output += `┃  File Level:      ${statusData.logging.fileLevel.padEnd(35)}┃\n`;
        output += `┃  Log File:        ${logFileDisplay}┃\n`;
        output += '┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫\n';
        output += `┃  Node Version:    ${statusData.node.padEnd(35)}┃\n`;
        output += `┃  Platform:        ${statusData.platform.padEnd(35)}┃\n`;
        output += `┃  Process ID:      ${statusData.pid.toString().padEnd(35)}┃\n`;
        output += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n';

        return {
            content: [{ type: 'text', text: output }],
            structuredContent: statusData
        };
    }

    async handleConfigureLogging(args, requestId) {
        this.logger.processing('Processing configure_logging request from Claude');
        const { console_level, file_level } = args;
        if (!console_level && !file_level) {
            throw new ValidationError('Must specify at least one log level', 'console_level or file_level', args);
        }

        const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
        const configDir = path.join(homeDir, '.durandal-mcp');
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
        const envPath = path.join(configDir, '.env');
        let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

        const updated = [];
        if (console_level) {
            if (/^CONSOLE_LOG_LEVEL=/m.test(envContent)) {
                envContent = envContent.replace(/^CONSOLE_LOG_LEVEL=.*$/gm, `CONSOLE_LOG_LEVEL=${console_level}`);
            } else {
                envContent += `\nCONSOLE_LOG_LEVEL=${console_level}\n`;
            }
            if (this.logger.setConsoleLevel(console_level)) updated.push(`Console level: ${console_level}`);
        }
        if (file_level) {
            if (/^FILE_LOG_LEVEL=/m.test(envContent)) {
                envContent = envContent.replace(/^FILE_LOG_LEVEL=.*$/gm, `FILE_LOG_LEVEL=${file_level}`);
            } else {
                envContent += `\nFILE_LOG_LEVEL=${file_level}\n`;
            }
            if (this.logger.setFileLevel(file_level)) updated.push(`File level: ${file_level}`);
        }

        try {
            fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf8');
        } catch (error) {
            throw new Error(`Failed to save configuration: ${error.message}`);
        }

        let output = '[OK] **Logging Configuration Updated**\n\n';
        updated.forEach(c => { output += `- ${c}\n`; });
        output += `\n**Current Configuration:**\n- Console Level: ${this.logger.getConsoleLevel()}\n- File Level: ${this.logger.getFileLevel()}\n- Log File: ${this.logger.logFile}\n`;

        return {
            content: [{ type: 'text', text: output }],
            structuredContent: {
                consoleLevel: this.logger.getConsoleLevel(),
                fileLevel: this.logger.getFileLevel(),
                logFile: this.logger.logFile
            }
        };
    }

    async handleGetLogs(args, requestId) {
        this.logger.processing('Processing get_logs request from Claude');
        const { lines = 50, level_filter, search } = args;

        if (!this.logger.logFile || !fs.existsSync(this.logger.logFile)) {
            throw new ValidationError('No log file found', 'logFile', this.logger.logFile);
        }

        this.logger.substep('Streaming log file');
        const readline = require('readline');
        const rl = readline.createInterface({
            input: fs.createReadStream(this.logger.logFile, { encoding: 'utf8' }),
            crlfDelay: Infinity
        });

        const keep = Math.min(Math.max(lines * 4, 100), 20000);
        const ring = new Array(keep);
        let writeIdx = 0, count = 0;
        for await (const line of rl) {
            if (!line.trim()) continue;
            ring[writeIdx] = line;
            writeIdx = (writeIdx + 1) % keep;
            count++;
        }
        const actual = Math.min(count, keep);
        const start = count > keep ? writeIdx : 0;
        let parsedLogs = [];
        for (let i = 0; i < actual; i++) {
            const line = ring[(start + i) % keep];
            try { parsedLogs.push(JSON.parse(line)); } catch (_) {}
        }

        if (level_filter) {
            const filterValue = this.logger.levels[level_filter];
            parsedLogs = parsedLogs.filter(log => this.logger.levels[log.level] >= filterValue);
        }
        if (search) {
            const s = search.toLowerCase();
            parsedLogs = parsedLogs.filter(log =>
                log.message.toLowerCase().includes(s) ||
                JSON.stringify(log).toLowerCase().includes(s)
            );
        }
        const recent = parsedLogs.slice(-lines);

        let output = `**Recent Log Entries** (${recent.length} of ${parsedLogs.length} total)\n\nLog file: \`${path.basename(this.logger.logFile)}\`\n\n`;
        if (!recent.length) {
            output += '**No matching log entries found.**\n';
        } else {
            recent.forEach((log, i) => {
                const ts = new Date(log.timestamp).toLocaleString();
                const emoji = { debug: '[DEBUG]', info: '[INFO] ', warn: '[WARN] ', error: '[ERR] ', fatal: '[FATAL]' }[log.level] || '[LOG]  ';
                output += `**${i + 1}.** ${emoji} \`[${log.level.toUpperCase()}]\` ${ts}\n   ${log.message}\n`;
                if (log.requestId) output += `   _Request: ${log.requestId}_\n`;
                output += '\n';
            });
        }

        return {
            content: [{ type: 'text', text: output }],
            structuredContent: { count: recent.length, entries: recent }
        };
    }

    async handleListProjectsSessions(args, requestId) {
        this.logger.processing('Processing list_projects_sessions request');
        const type = args.type || 'both';
        const includeSamples = args.include_samples || false;
        const limit = args.limit ?? 50;

        // Iter 3: groupSummary batches samples via window function instead of
        // firing one query per project/session (was N+1).
        const results = {};
        if (type === 'projects' || type === 'both') {
            results.projects = await this.db.groupSummary('project', { limit, includeSamples });
        }
        if (type === 'sessions' || type === 'both') {
            results.sessions = await this.db.groupSummary('session', { limit, includeSamples });
        }

        let output = '# Durandal Memory Organization\n\n';
        if (results.projects) {
            output += `## Projects (${results.projects.length} total)\n\n`;
            for (const p of results.projects) {
                output += `### ${p.name}\n`;
                output += `- **Memories:** ${p.memoryCount}\n`;
                output += `- **First:** ${new Date(p.firstMemory).toLocaleDateString()}\n`;
                output += `- **Latest:** ${new Date(p.lastMemory).toLocaleDateString()}\n`;
                if (p.samples) {
                    output += `- **Recent samples:**\n`;
                    for (const sample of p.samples) {
                        const preview = sample.content.slice(0, 100);
                        output += `  - "${preview}${sample.content.length > 100 ? '...' : ''}"\n`;
                    }
                }
                output += '\n';
            }
        }
        if (results.sessions) {
            output += `## Sessions (${results.sessions.length} recent)\n\n`;
            for (const s of results.sessions.slice(0, 20)) {
                output += `### ${s.name}\n`;
                output += `- **Memories:** ${s.memoryCount}\n`;
                output += `- **Duration:** ${new Date(s.firstMemory).toLocaleTimeString()} - ${new Date(s.lastMemory).toLocaleTimeString()}\n`;
                if (s.samples) {
                    output += `- **Recent samples:**\n`;
                    for (const sample of s.samples) {
                        const preview = sample.content.slice(0, 100);
                        output += `  - "${preview}${sample.content.length > 100 ? '...' : ''}"\n`;
                    }
                }
                output += '\n';
            }
        }
        output += `## Summary\n- **Total Projects:** ${results.projects?.length || 0}\n- **Total Sessions:** ${results.sessions?.length || 0}\n`;

        return {
            content: [{ type: 'text', text: output }],
            structuredContent: results
        };
    }

    async handleGetMemory(args, requestId) {
        this.logger.processing('Processing get_memory request');
        const memory = await this.db.getMemoryById(args.id);
        if (!memory) {
            return {
                content: [{ type: 'text', text: `Memory ${args.id} not found.` }],
                structuredContent: { found: false, id: args.id }
            };
        }
        const m = memory.metadata || {};
        let text = `**Memory ${memory.id}**\n\n`;
        text += `**Content:** ${memory.content}\n\n`;
        text += `**Project:** ${m.project || 'None'}\n`;
        text += `**Session:** ${m.session || 'None'}\n`;
        text += `**Importance:** ${m.importance ?? 'N/A'}\n`;
        text += `**Categories:** ${m.categories?.join(', ') || 'None'}\n`;
        text += `**Created:** ${memory.created_at}\n`;
        return {
            content: [{ type: 'text', text }],
            structuredContent: { found: true, memory }
        };
    }

    async handleDeleteMemory(args, requestId) {
        this.logger.processing('Processing delete_memory request');
        const memory = await this.db.getMemoryById(args.id);
        if (!memory) {
            return {
                content: [{ type: 'text', text: `Memory ${args.id} not found.` }],
                structuredContent: { deleted: false, id: args.id }
            };
        }
        const res = await this.db.deleteMemoryById(args.id);
        if (!res.success) {
            throw new DatabaseError('Failed to delete memory', 'delete', new Error(res.error || 'unknown'));
        }
        return {
            content: [{ type: 'text', text: `[OK] Deleted memory ${args.id}.` }],
            structuredContent: { deleted: true, id: args.id, changes: res.changes }
        };
    }

    async handleStoreMemoriesBatch(args, requestId) {
        this.logger.processing('Processing store_memories_batch request');
        const prepared = args.items.map((it, i) => ({
            content: it.content,
            metadata: this.prepareStoredMetadata(it.metadata, `items[${i}].metadata`)
        }));

        const res = await this.db.storeMemoriesBatch(prepared);
        if (!res.success) {
            throw new DatabaseError('Batch insert failed', 'batch_store', new Error(res.error));
        }
        this.logger.success(`Stored ${res.ids.length} memories`, { requestId, count: res.ids.length });
        return {
            content: [{
                type: 'text',
                text: `[OK] Stored ${res.ids.length} memories.\nIDs: ${res.ids.join(', ')}`
            }],
            structuredContent: { count: res.ids.length, ids: res.ids }
        };
    }

    async handleUpdateMemory(args, requestId) {
        this.logger.processing('Processing update_memory request');
        if (args.content === undefined && args.metadata === undefined) {
            throw new ValidationError(
                'update_memory requires at least one of `content` or `metadata`',
                'args', args
            );
        }
        const patch = {};
        if (args.content !== undefined) patch.content = args.content;
        if (args.metadata !== undefined) {
            // Intentionally DON'T stamp created_at on updates — preserve the
            // original creation time. The serialize-size cap still applies.
            let serialized;
            try {
                serialized = JSON.stringify(args.metadata);
            } catch (e) {
                throw new ValidationError(`metadata is not serializable: ${e.message}`, 'metadata', null);
            }
            if (serialized.length > 65536) {
                throw new ValidationError(
                    `metadata exceeds maximum size (${serialized.length} bytes, max 65536)`,
                    'metadata', serialized.length
                );
            }
            patch.metadata = { ...args.metadata };
        }

        const res = await this.db.updateMemory(args.id, patch);
        if (!res.success) {
            if (res.error === 'not_found') {
                return {
                    content: [{ type: 'text', text: `Memory ${args.id} not found.` }],
                    structuredContent: { updated: false, id: args.id }
                };
            }
            throw new DatabaseError('Failed to update memory', 'update', new Error(res.error));
        }
        return {
            content: [{ type: 'text', text: `[OK] Updated memory ${args.id}.` }],
            structuredContent: { updated: true, id: args.id }
        };
    }

    async handleListMemories(args, requestId) {
        this.logger.processing('Processing list_memories request');
        const filter = {
            project: args.project,
            session: args.session,
            since: args.since,
            until: args.until,
            limit: args.limit ?? 50,
            offset: args.offset ?? 0
        };
        const [memories, total] = await Promise.all([
            this.db.listMemories(filter),
            this.db.countList(filter)
        ]);
        this.logger.success(`Listed ${memories.length} of ${total} memories`, { requestId });

        const preview = memories.slice(0, 20).map((m, i) => {
            const c = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
            return `${i + 1}. [${m.id}] ${c}`;
        }).join('\n');

        const offset = args.offset ?? 0;
        const limit = args.limit ?? 50;
        const headerSuffix = offset ? `, offset ${offset}` : '';
        return {
            content: [{
                type: 'text',
                text: `**Memories** (${memories.length} of ${total}${headerSuffix})\n\n${preview || '(none)'}`
            }],
            structuredContent: {
                count: memories.length,
                total,
                offset,
                limit,
                memories
            }
        };
    }

    async handleExportMemories(args, requestId) {
        this.logger.processing('Processing export_memories request');
        const memories = await this.db.exportAll();
        const payload = {
            version: this.packageInfo.version,
            exported_at: new Date().toISOString(),
            count: memories.length,
            memories
        };

        // Iter 3: don't inline the entire JSON dump in `text` — for a 50K-row
        // database that ballooned the response to ~10 MB before the client
        // even saw it. Text is a summary; structuredContent carries the data.
        const summary = `**Exported ${memories.length} memories.**\n` +
            `Total bytes (JSON): ~${JSON.stringify(payload).length}\n\n` +
            `The full export is available in this response's structuredContent.memories.`;

        return {
            content: [{ type: 'text', text: summary }],
            structuredContent: payload
        };
    }

    async handleImportMemories(args, requestId) {
        this.logger.processing('Processing import_memories request');

        // Iter 3 hardening: import used to bypass every safeguard. Now each
        // item runs through prepareStoredMetadata (size-cap + serialization
        // safety) WITHOUT the defaulting/re-stamp — imports preserve original
        // created_at and project/session from the backup payload.
        // We also surface light type warnings without rejecting (imports are
        // intentionally permissive so partial-quality backups can still load).
        const warnings = [];
        const items = args.items.map((it, i) => {
            const meta = this.prepareStoredMetadata(it.metadata, `items[${i}].metadata`, false);
            if (meta.importance !== undefined && (typeof meta.importance !== 'number' || meta.importance < 0 || meta.importance > 1)) {
                warnings.push(`items[${i}].metadata.importance is not a number in [0,1] (got ${JSON.stringify(meta.importance)})`);
            }
            for (const f of ['categories', 'keywords']) {
                if (meta[f] !== undefined && (!Array.isArray(meta[f]) || !meta[f].every(v => typeof v === 'string'))) {
                    warnings.push(`items[${i}].metadata.${f} is not an array of strings`);
                }
            }
            return { content: it.content, metadata: meta };
        });

        const res = await this.db.storeMemoriesBatch(items);
        if (!res.success) {
            throw new DatabaseError('Import failed', 'import', new Error(res.error));
        }

        let text = `[OK] Imported ${res.ids.length} memories.`;
        if (warnings.length) {
            text += `\n\n${warnings.length} item(s) had non-fatal validation warnings:\n` +
                    warnings.slice(0, 10).map(w => `  - ${w}`).join('\n') +
                    (warnings.length > 10 ? `\n  ... and ${warnings.length - 10} more` : '');
        }

        return {
            content: [{ type: 'text', text }],
            structuredContent: { count: res.ids.length, ids: res.ids, warnings }
        };
    }

    async handleRenameProject(args, requestId) {
        this.logger.processing('Processing rename_project request');
        if (args.from === args.to) {
            return {
                content: [{ type: 'text', text: `Source and destination project names are identical; nothing to do.` }],
                structuredContent: { renamed: 0 }
            };
        }
        const res = await this.db.renameProject(args.from, args.to);
        if (!res.success) {
            throw new DatabaseError('rename_project failed', 'rename', new Error(res.error));
        }
        return {
            content: [{
                type: 'text',
                text: `[OK] Renamed ${res.changes} memories from project "${args.from}" to "${args.to}".`
            }],
            structuredContent: { renamed: res.changes, from: args.from, to: args.to }
        };
    }

    async handleBackupDatabase(args, requestId) {
        this.logger.processing('Processing backup_database request');
        const absPath = path.resolve(args.destination);
        const res = await this.db.backupTo(absPath);
        if (!res.success) {
            throw new DatabaseError('backup failed', 'backup', new Error(res.error));
        }
        const size = fs.existsSync(absPath) ? fs.statSync(absPath).size : 0;
        return {
            content: [{
                type: 'text',
                text: `[OK] Backup written to ${absPath}\nSize: ${(size / 1024).toFixed(1)} KB`
            }],
            structuredContent: { path: absPath, size }
        };
    }

    async handleFindSimilar(args, requestId) {
        this.logger.processing('Processing find_similar request');
        const results = await this.db.findSimilar(args.id, { limit: args.limit ?? 5 });
        if (results === null) {
            return {
                content: [{ type: 'text', text: `Source memory ${args.id} not found.` }],
                structuredContent: { source_id: args.id, count: 0, results: [] }
            };
        }
        const lines = results.map((r, i) => {
            const c = r.content.length > 80 ? r.content.slice(0, 80) + '...' : r.content;
            return `${i + 1}. [${r.id}] ${c}`;
        }).join('\n');
        return {
            content: [{
                type: 'text',
                text: `**Memories similar to ${args.id}** (${results.length} found)\n\n${lines || '(none)'}`
            }],
            structuredContent: {
                source_id: args.id,
                count: results.length,
                results: results.map(r => ({
                    id: r.id,
                    content: r.content,
                    metadata: r.metadata,
                    created_at: r.created_at,
                    relevance: r.relevance ?? null
                }))
            }
        };
    }

    async handleTagMemory(args, requestId) {
        this.logger.processing('Processing tag_memory request');
        if ((!args.add || !args.add.length) && (!args.remove || !args.remove.length)) {
            throw new ValidationError(
                'tag_memory requires at least one of `add` or `remove` to be a non-empty array',
                'args', args
            );
        }
        const res = await this.db.tagMemory(args.id, { add: args.add || [], remove: args.remove || [] });
        if (!res.success) {
            if (res.error === 'not_found') {
                return {
                    content: [{ type: 'text', text: `Memory ${args.id} not found.` }],
                    structuredContent: { tagged: false, id: args.id }
                };
            }
            throw new DatabaseError('tag_memory failed', 'tag', new Error(res.error));
        }
        return {
            content: [{
                type: 'text',
                text: `[OK] Memory ${args.id} now has categories: ${res.categories.join(', ') || '(none)'}`
            }],
            structuredContent: { tagged: true, id: args.id, categories: res.categories }
        };
    }

    async handleDeleteMemoriesWhere(args, requestId) {
        this.logger.processing('Processing delete_memories_where request');
        const res = await this.db.deleteMemoriesWhere({
            project: args.project,
            session: args.session,
            olderThan: args.older_than
        });
        if (!res.success) {
            if (res.error === 'at_least_one_filter_required') {
                throw new ValidationError(
                    'delete_memories_where requires at least one of project, session, older_than',
                    'args', args
                );
            }
            throw new DatabaseError('delete_memories_where failed', 'bulk_delete', new Error(res.error));
        }
        return {
            content: [{
                type: 'text',
                text: `[OK] Deleted ${res.deleted} memories matching filter.`
            }],
            structuredContent: { deleted: res.deleted, filter: { project: args.project, session: args.session, older_than: args.older_than } }
        };
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    async start() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);

        this.logger.info('[START] Durandal MCP Server running', {
            transport: 'stdio',
            sdk: require('@modelcontextprotocol/sdk/package.json').version
        });
        this.logger.logSystemInfo();
        this.checkForUpdates();
    }

    async checkForUpdates() {
        try {
            const updateChecker = new UpdateChecker(this.packageInfo, this.logger);
            const updateInfo = await updateChecker.checkForUpdates();
            if (updateInfo && updateInfo.updateAvailable) {
                updateChecker.showUpdateNotification(updateInfo);
            }
        } catch (error) {
            this.logger.debug('Update check error', { error: error.message });
        }
    }

    async shutdown() {
        if (this._shuttingDown) return;
        this._shuttingDown = true;

        this.logger.info('[STOP] Shutting down Durandal MCP Server');
        try { await this.ready; } catch (_) {}

        try { this.db?.checkpoint?.(); } catch (_) {}

        if (this.db?.close) this.db.close();
        this.logger.close();
        setTimeout(() => process.exit(0), 50);
    }

    // -------------------------------------------------------------------------
    // CLI entry point
    // -------------------------------------------------------------------------

    static async cli() {
        const args = process.argv.slice(2);

        if (args.includes('--help') || args.includes('-h')) {
            process.stdout.write(helpText());
            process.exit(0);
        }
        if (args.includes('--version') || args.includes('-v')) {
            const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
            process.stdout.write(`\nDurandal MCP Server\nVersion: ${pkg.version}\nNode.js: ${process.version}\nPlatform: ${process.platform} ${process.arch}\nMCP SDK: ${pkg.dependencies['@modelcontextprotocol/sdk']}\nbetter-sqlite3: ${pkg.dependencies['better-sqlite3']}\nsqlite-vec: ${pkg.dependencies['sqlite-vec']}\nEmbeddings: ${pkg.dependencies['@huggingface/transformers']} (local, all-MiniLM-L6-v2)\n`);
            process.exit(0);
        }
        if (args.includes('--test')) {
            process.stdout.write('Running Durandal MCP Server Tests\n');
            const logger = new Logger({ level: 'info' });
            const runner = new TestRunner(logger);
            const success = await runner.runAllTests();
            process.exit(success ? 0 : 1);
        }
        if (args.includes('--status')) {
            await statusCliCommand();
            process.exit(0);
        }
        if (args.includes('--discover')) {
            try {
                const DatabaseDiscovery = require('./db-discovery');
                await new DatabaseDiscovery().discover();
            } catch (error) {
                process.stderr.write(`Discovery failed: ${error.message}\n`);
            }
            process.exit(0);
        }
        if (args.includes('--migrate')) {
            try {
                const DatabaseMigrator = require('./db-migrate');
                await new DatabaseMigrator().migrate();
            } catch (error) {
                process.stderr.write(`Migration failed: ${error.message}\n`);
            }
            process.exit(0);
        }
        if (args.includes('--configure')) {
            await configureLogLevel();
            process.exit(0);
        }
        if (args.includes('--update')) {
            process.stdout.write('Durandal MCP Update Tool\n');
            const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
            const logger = new Logger({ level: 'info' });
            const updateChecker = new UpdateChecker(pkg, logger);
            try {
                const success = await updateChecker.performUpdate({ confirm: false });
                process.exit(success ? 0 : 1);
            } catch (error) {
                process.stderr.write(`\n[ERR] Update failed: ${error.message}\n`);
                process.stderr.write('\nYou can update manually with:\n  npm install -g durandal-memory-mcp@latest\n\n');
                process.exit(1);
            }
        }

        const options = {};
        if (args.includes('--debug')) { options.debug = true; options.logLevel = 'debug'; }
        if (args.includes('--verbose')) options.verbose = true;

        const logFileIndex = args.indexOf('--log-file');
        if (logFileIndex > -1) {
            const val = args[logFileIndex + 1];
            if (!val || val.startsWith('--')) {
                process.stderr.write('Error: --log-file requires a file path argument\n');
                process.exit(2);
            }
            options.logFile = val;
        }
        const logLevelIndex = args.indexOf('--log-level');
        if (logLevelIndex > -1) {
            const val = args[logLevelIndex + 1];
            const validLevels = ['debug', 'info', 'warn', 'error'];
            if (!val || !validLevels.includes(val)) {
                process.stderr.write(`Error: --log-level must be one of ${validLevels.join(', ')}\n`);
                process.exit(2);
            }
            options.logLevel = val;
        }

        const server = new DurandalMCPServer(options);
        process.on('SIGTERM', () => server.shutdown());
        process.on('SIGINT', () => server.shutdown());
        process.on('uncaughtException', (error) => {
            server.logger.error('Uncaught exception', { error: error.message, stack: error.stack });
            server.shutdown().finally(() => process.exit(1));
        });
        process.on('unhandledRejection', (reason) => {
            server.logger.error('Unhandled rejection', {
                reason: reason instanceof Error ? reason.message : String(reason),
                stack: reason instanceof Error ? reason.stack : undefined
            });
        });
        await server.start();
    }
}

// -----------------------------------------------------------------------------
// CLI helpers
// -----------------------------------------------------------------------------

function helpText() {
    return `
Durandal MCP Server v4 - Zero-config AI memory for Claude Code (hybrid lexical + semantic)

Usage: durandal-mcp [options]

Options:
  --help, -h          Show this help
  --version, -v       Show version information
  --test              Run built-in test suite
  --status            Show system status and statistics
  --discover          Find all Durandal databases on system
  --migrate           Merge all databases into a universal database
  --configure         Interactive log level configuration
  --update            Check for and install updates
  --debug             Enable debug logging
  --verbose           Enable verbose output
  --log-file FILE     Write logs to file
  --log-level LEVEL   Set log level (debug, info, warn, error)

Environment Variables:
  LOG_LEVEL           Legacy: sets both console and file levels
  CONSOLE_LOG_LEVEL   Console output level (default: warn)
  FILE_LOG_LEVEL      File output level (default: info)
  DATABASE_PATH       SQLite database path
  VERBOSE, DEBUG, LOG_MCP_TOOLS   Feature flags (true/false)

Examples:
  durandal-mcp                      # Start as MCP server (stdio)
  durandal-mcp --test               # Run tests
  durandal-mcp --status             # Show health summary
`;
}

function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

async function statusCliCommand() {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    const MemoryDB = require('./db');
    const tempClient = new MemoryDB();
    const dbPath = tempClient.dbPath;
    const dbExists = fs.existsSync(dbPath);

    let memoryCount = 0, projectCount = 0, sessionCount = 0;
    if (dbExists) {
        try {
            const s = tempClient.stats();
            memoryCount = s.total;
            projectCount = s.projects;
            sessionCount = s.sessions;
        } catch (_) {}
    }
    tempClient.close();

    const data = {
        version: pkg.version,
        uptime: formatUptime(process.uptime()),
        memory: {
            rss: (process.memoryUsage().rss / 1024 / 1024).toFixed(2),
            heapUsed: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
            heapTotal: (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)
        },
        database: {
            path: dbPath, exists: dbExists,
            size: dbExists ? (fs.statSync(dbPath).size / 1024 / 1024).toFixed(2) : '0.00',
            memoryCount, projectCount, sessionCount
        },
        node: process.version, platform: process.platform, pid: process.pid
    };

    let output = '\n┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    output += `┃  Durandal MCP Server v${data.version}                              ┃\n`;
    output += '┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫\n';
    output += `┃  Uptime:          ${data.uptime.padEnd(35)}┃\n`;
    output += `┃  Database:        ${(data.database.exists ? '[OK] Connected' : '[ERR] Not Found').padEnd(35)}┃\n`;
    output += `┃  Database Size:   ${(data.database.size + ' MB').padEnd(35)}┃\n`;
    output += `┃  Stored Memories: ${(data.database.memoryCount + ' memories').padEnd(35)}┃\n`;
    output += `┃  Projects:        ${(data.database.projectCount + ' projects').padEnd(35)}┃\n`;
    output += `┃  Sessions:        ${(data.database.sessionCount + ' sessions').padEnd(35)}┃\n`;
    output += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n';
    process.stdout.write(output);
}

async function configureLogLevel() {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (q) => new Promise((resolve) => rl.question(q, resolve));

    process.stdout.write('\n=== Durandal Log Level Configuration ===\n\n');
    process.stdout.write('Console levels:\n  1=error  2=warn (default)  3=info  4=debug\n\n');
    const levels = { '1': 'error', '2': 'warn', '3': 'info', '4': 'debug', '': 'warn' };

    const consoleChoice = await question('Console level [1-4, default=2]: ');
    if (!(consoleChoice in levels)) {
        process.stdout.write('[ERR] Invalid choice\n');
        rl.close();
        return;
    }
    const consoleLevel = levels[consoleChoice];

    process.stdout.write('\nFile levels:\n  1=error  2=warn  3=info (default)  4=debug\n\n');
    const fileChoice = await question('File level [1-4, default=3]: ');
    if (fileChoice !== '' && !(fileChoice in levels)) {
        process.stdout.write('[ERR] Invalid choice\n');
        rl.close();
        return;
    }
    const fileLevel = fileChoice === '' ? 'info' : levels[fileChoice];

    const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
    const configDir = path.join(homeDir, '.durandal-mcp');
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    const envPath = path.join(configDir, '.env');
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

    if (/^CONSOLE_LOG_LEVEL=/m.test(envContent)) {
        envContent = envContent.replace(/^CONSOLE_LOG_LEVEL=.*$/gm, `CONSOLE_LOG_LEVEL=${consoleLevel}`);
    } else {
        envContent += `\nCONSOLE_LOG_LEVEL=${consoleLevel}\n`;
    }
    if (/^FILE_LOG_LEVEL=/m.test(envContent)) {
        envContent = envContent.replace(/^FILE_LOG_LEVEL=.*$/gm, `FILE_LOG_LEVEL=${fileLevel}`);
    } else {
        envContent += `FILE_LOG_LEVEL=${fileLevel}\n`;
    }
    fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf8');

    process.stdout.write(`\n[OK] Saved to ${envPath}\n  Console: ${consoleLevel.toUpperCase()}\n  File:    ${fileLevel.toUpperCase()}\n`);
    rl.close();
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

if (require.main === module) {
    DurandalMCPServer.cli().catch((error) => {
        process.stderr.write(`Failed to start MCP server: ${error.stack || error}\n`);
        process.exit(1);
    });
}

module.exports = DurandalMCPServer;
