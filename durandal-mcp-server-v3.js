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

const DatabaseAdapter = require('./db-adapter');
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

        this.db = new DatabaseAdapter();

        this.ready = this.runDatabaseStartupCheck();
        this.registerTools();
    }

    loadPackageInfo() {
        try {
            const packagePath = path.join(__dirname, 'package.json');
            return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        } catch (error) {
            this.logger?.warn('Could not load package.json', { error: error.message });
            return { version: '3.0.0', description: 'Durandal MCP Server' };
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
            const client = this.db.db.client;
            const tables = await new Promise((resolve, reject) => {
                client.all("SELECT name FROM sqlite_master WHERE type='table'", (err, rows) =>
                    err ? reject(err) : resolve(rows.map(r => r.name)));
            });
            if (!tables.includes('memories')) {
                return { valid: false, issues: ['missing memories table'] };
            }
            const cols = await new Promise((resolve, reject) => {
                client.all('PRAGMA table_info(memories)', (err, rows) =>
                    err ? reject(err) : resolve(rows.map(r => r.name)));
            });
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
            const rows = await new Promise((resolve, reject) => {
                this.db.db.client.all('PRAGMA integrity_check', (err, r) =>
                    err ? reject(err) : resolve(r));
            });
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
    wrapHandler(toolName, handler) {
        return async (args) => {
            const requestId = this.logger.startMCPTool(toolName, args);
            try {
                const result = await handler.call(this, args || {}, requestId);
                this.logger.endMCPTool(requestId, true, result);
                return result;
            } catch (error) {
                this.logger.endMCPTool(requestId, false, null, error);
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

    registerTools() {
        const R = (name, config, handler) => this.server.registerTool(name, config, this.wrapHandler(name, handler));

        R('store_memory', {
            title: 'Store Memory',
            description: 'Store a piece of information so Claude can recall it in a future session. Content is indexed by project and session in metadata.',
            inputSchema: {
                content: z.string().min(1).max(50000).describe('The text to remember'),
                metadata: metadataSchema.optional().describe('Optional tagging/categorization metadata')
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
            description: 'Full-text search over stored memories with BM25 relevance ranking. The query is tokenized on whitespace and all tokens must match (implicit AND). Results can be filtered by project/session/categories/importance range. Falls back to substring search if the query tokenizes to nothing.',
            inputSchema: {
                query: z.string().min(1).describe('Search query. Tokens are AND-ed; "react typescript" matches rows with both words.'),
                filters: filtersSchema.optional(),
                limit: z.number().int().min(1).max(100).optional().default(10)
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
    // Tool handlers
    // -------------------------------------------------------------------------

    async handleStoreMemory(args, requestId) {
        this.logger.processing('Processing store_memory request from Claude');

        // Zod enforces types on `content` and metadata shape, but not
        // serialized-metadata size or the circular-reference guard — those
        // are structural concerns outside the schema layer.
        const content = args.content;
        const metadata = args.metadata || {};

        if (!metadata.project) metadata.project = 'default';
        if (!metadata.session) metadata.session = new Date().toISOString().split('T')[0];

        const enriched = { ...metadata, created_at: new Date().toISOString() };

        let serialized;
        try {
            serialized = JSON.stringify(enriched);
        } catch (e) {
            throw new ValidationError(`metadata is not serializable: ${e.message}`, 'metadata', null);
        }
        if (serialized.length > 65536) {
            throw new ValidationError(
                `metadata exceeds maximum size (${serialized.length} bytes, max 65536)`,
                'metadata',
                serialized.length
            );
        }

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

        this.logger.success(`Memory stored (id: ${memoryId})`, {
            requestId, memoryId, contentLength: content.length, importance: enriched.importance
        });

        return {
            content: [{
                type: 'text',
                text: `[OK] Memory stored successfully\n\n` +
                      `**ID:** ${memoryId}\n` +
                      `**Project:** ${enriched.project}\n` +
                      `**Session:** ${enriched.session}\n` +
                      `**Importance:** ${enriched.importance ?? 'Not set'}\n` +
                      `**Categories:** ${enriched.categories?.join(', ') || 'None'}`
            }],
            structuredContent: {
                id: memoryId,
                project: enriched.project,
                session: enriched.session,
                importance: enriched.importance ?? null,
                categories: enriched.categories || []
            }
        };
    }

    async handleSearchMemories(args, requestId) {
        this.logger.processing('Processing search_memories request from Claude');
        const { query, filters = {}, limit = 10 } = args;

        this.logger.substep('Querying database');
        const dbResults = await this.db.searchMemories(query, {
            project: filters.project,
            session: filters.session,
            limit: limit * 2 // over-fetch so post-filters trim without starving results
        });

        const filtered = dbResults.filter((r) => {
            const m = r.metadata || {};
            if (filters.importance_min !== undefined && (m.importance ?? 0) < filters.importance_min) return false;
            if (filters.importance_max !== undefined && (m.importance ?? 0) > filters.importance_max) return false;
            if (filters.categories && filters.categories.length) {
                const cats = new Set(m.categories || []);
                if (!filters.categories.some(c => cats.has(c))) return false;
            }
            return true;
        }).slice(0, limit);

        this.logger.success(`Search completed (${filtered.length} results)`, {
            requestId, query, resultsCount: filtered.length
        });

        if (!filtered.length) {
            return { content: [{ type: 'text', text: 'No memories found matching your query.' }] };
        }

        // Results come back ranked by FTS BM25 when possible, so position i=0
        // is the best match. We don't print raw BM25 scores — they're negative
        // and un-normalized, so the number is meaningless to humans. The
        // structuredContent.results below still carries the raw relevance
        // for programmatic consumers.
        const formatted = filtered.map((r, i) => {
            const m = r.metadata || {};
            const preview = r.content.length > 100 ? r.content.slice(0, 100) + '...' : r.content;
            return `**${i + 1}. Memory ${r.id}**\n` +
                   `   Content: ${preview}\n` +
                   `   Project: ${m.project || 'None'}\n` +
                   `   Session: ${m.session || 'None'}\n` +
                   `   Importance: ${m.importance ?? 'N/A'}\n` +
                   `   Categories: ${m.categories?.join(', ') || 'None'}\n` +
                   `   Created: ${r.created_at || 'Unknown'}`;
        }).join('\n\n');

        return {
            content: [{ type: 'text', text: `**Search Results** (${filtered.length} found)\n\n${formatted}` }],
            structuredContent: {
                count: filtered.length,
                results: filtered.map(r => ({
                    id: r.id,
                    content: r.content,
                    metadata: r.metadata,
                    created_at: r.created_at,
                    relevance: r.relevance ?? null
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
            const rowCountRes = await this.db.db.query('SELECT COUNT(*) as count FROM memories')
                .catch(() => ({ rows: [{ count: 0 }] }));
            const projectCountRes = p
                ? await this.db.db.query(
                      "SELECT COUNT(*) as count FROM memories WHERE json_extract(metadata, '$.project') = ?",
                      [p]
                  ).catch(() => ({ rows: [{ count: 0 }] }))
                : null;
            stats = {
                returned: memories.length,
                totalMemoriesInDb: rowCountRes.rows[0]?.count || 0,
                memoriesInProject: projectCountRes ? (projectCountRes.rows[0]?.count || 0) : null
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
        const dbPath = this.db.db.dbPath;
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
        const client = this.db.db.client;
        switch (op) {
            case 'vacuum':
                await new Promise((r, j) => client.exec('VACUUM', e => e ? j(e) : r()));
                return 'VACUUM completed (reclaimed fragmentation)';
            case 'analyze':
                await new Promise((r, j) => client.exec('ANALYZE', e => e ? j(e) : r()));
                return 'ANALYZE completed (query planner statistics refreshed)';
            case 'integrity_check': {
                const rows = await new Promise((r, j) =>
                    client.all('PRAGMA integrity_check', (e, x) => e ? j(e) : r(x)));
                const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
                return ok ? 'integrity_check: ok' : `integrity_check: ${rows.map(r => r.integrity_check).join('; ')}`;
            }
            case 'wal_checkpoint': {
                const row = await new Promise((r, j) =>
                    client.get('PRAGMA wal_checkpoint(TRUNCATE)', (e, x) => e ? j(e) : r(x)));
                return `wal_checkpoint: ${JSON.stringify(row)}`;
            }
            default:
                throw new ValidationError(`Unknown maintenance operation: ${op}`, 'operation', op);
        }
    }

    async handleGetStatus(args, requestId) {
        this.logger.processing('Processing get_status request from Claude');
        const dbPath = this.db.db.dbPath;
        const dbExists = fs.existsSync(dbPath);
        const dbSize = dbExists ? (fs.statSync(dbPath).size / 1024 / 1024).toFixed(2) : '0.00';

        let dbMemoryCount = 0, dbProjectCount = 0, dbSessionCount = 0;
        if (dbExists) {
            try {
                const countResult = await this.db.db.query('SELECT COUNT(*) as count FROM memories');
                dbMemoryCount = countResult.rows[0]?.count || 0;
                const projectResult = await this.db.db.query(
                    "SELECT COUNT(DISTINCT json_extract(metadata, '$.project')) as count FROM memories WHERE json_extract(metadata, '$.project') IS NOT NULL"
                );
                dbProjectCount = projectResult.rows[0]?.count || 0;
                const sessionResult = await this.db.db.query(
                    "SELECT COUNT(DISTINCT json_extract(metadata, '$.session')) as count FROM memories WHERE json_extract(metadata, '$.session') IS NOT NULL"
                );
                dbSessionCount = sessionResult.rows[0]?.count || 0;
            } catch (e) {
                this.logger.debug('Could not get memory counts:', e.message);
            }
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
                sessionCount: dbSessionCount
            },
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

        const results = {};
        if (type === 'projects' || type === 'both') {
            try {
                const q = await this.db.db.query(`
                    SELECT
                        json_extract(metadata, '$.project') as project,
                        COUNT(*) as count,
                        MIN(created_at) as first_memory,
                        MAX(created_at) as last_memory
                    FROM memories
                    WHERE json_extract(metadata, '$.project') IS NOT NULL
                    GROUP BY json_extract(metadata, '$.project')
                    ORDER BY count DESC
                    LIMIT ?
                `, [limit]);
                results.projects = q.rows.map(r => ({
                    name: r.project, memoryCount: r.count,
                    firstMemory: r.first_memory, lastMemory: r.last_memory
                }));
                if (includeSamples) {
                    for (const project of results.projects) {
                        const s = await this.db.db.query(
                            "SELECT content, created_at FROM memories WHERE json_extract(metadata, '$.project') = ? ORDER BY created_at DESC LIMIT 2",
                            [project.name]
                        );
                        project.samples = s.rows;
                    }
                }
            } catch (e) {
                this.logger.error('Failed to list projects', { error: e.message });
                results.projects = [];
            }
        }
        if (type === 'sessions' || type === 'both') {
            try {
                const q = await this.db.db.query(`
                    SELECT
                        json_extract(metadata, '$.session') as session,
                        COUNT(*) as count,
                        MIN(created_at) as first_memory,
                        MAX(created_at) as last_memory
                    FROM memories
                    WHERE json_extract(metadata, '$.session') IS NOT NULL
                    GROUP BY json_extract(metadata, '$.session')
                    ORDER BY last_memory DESC
                    LIMIT ?
                `, [limit]);
                results.sessions = q.rows.map(r => ({
                    name: r.session, memoryCount: r.count,
                    firstMemory: r.first_memory, lastMemory: r.last_memory
                }));
                if (includeSamples) {
                    for (const session of results.sessions.slice(0, 10)) {
                        const s = await this.db.db.query(
                            "SELECT content, created_at FROM memories WHERE json_extract(metadata, '$.session') = ? ORDER BY created_at DESC LIMIT 2",
                            [session.name]
                        );
                        session.samples = s.rows;
                    }
                }
            } catch (e) {
                this.logger.error('Failed to list sessions', { error: e.message });
                results.sessions = [];
            }
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
        const prepared = args.items.map(it => {
            const meta = { ...(it.metadata || {}) };
            if (!meta.project) meta.project = 'default';
            if (!meta.session) meta.session = new Date().toISOString().split('T')[0];
            meta.created_at = new Date().toISOString();
            // Same 64KB metadata cap as store_memory. Reject the whole batch
            // on oversize to keep behavior consistent with the single variant.
            const serialized = JSON.stringify(meta);
            if (serialized.length > 65536) {
                throw new ValidationError(
                    `metadata for batch item exceeds maximum size (${serialized.length} bytes)`,
                    'metadata', serialized.length
                );
            }
            return { content: it.content, metadata: meta };
        });

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
        if (args.metadata !== undefined) patch.metadata = { ...args.metadata };

        if (patch.metadata) {
            const serialized = JSON.stringify(patch.metadata);
            if (serialized.length > 65536) {
                throw new ValidationError(
                    `metadata exceeds maximum size (${serialized.length} bytes)`,
                    'metadata', serialized.length
                );
            }
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
        const memories = await this.db.listMemories({
            project: args.project,
            session: args.session,
            since: args.since,
            until: args.until,
            limit: args.limit ?? 50,
            offset: args.offset ?? 0
        });
        this.logger.success(`Listed ${memories.length} memories`, { requestId });
        const preview = memories.slice(0, 20).map((m, i) => {
            const c = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
            return `${i + 1}. [${m.id}] ${c}`;
        }).join('\n');
        return {
            content: [{
                type: 'text',
                text: `**Memories** (${memories.length} shown${args.offset ? `, starting at offset ${args.offset}` : ''})\n\n${preview || '(none)'}`
            }],
            structuredContent: {
                count: memories.length,
                offset: args.offset ?? 0,
                limit: args.limit ?? 50,
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
        return {
            content: [{
                type: 'text',
                text: `**Exported ${memories.length} memories.**\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``
            }],
            structuredContent: payload
        };
    }

    async handleImportMemories(args, requestId) {
        this.logger.processing('Processing import_memories request');
        const items = args.items.map(it => ({
            content: it.content,
            metadata: it.metadata || {}
        }));
        const res = await this.db.storeMemoriesBatch(items);
        if (!res.success) {
            throw new DatabaseError('Import failed', 'import', new Error(res.error));
        }
        return {
            content: [{ type: 'text', text: `[OK] Imported ${res.ids.length} memories.` }],
            structuredContent: { count: res.ids.length, ids: res.ids }
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

        try {
            const client = this.db?.db?.client;
            if (client) {
                await new Promise((resolve) => client.exec('PRAGMA wal_checkpoint(TRUNCATE)', () => resolve()));
            }
        } catch (_) {}

        if (this.db?.close) await this.db.close();
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
            process.stdout.write(`\nDurandal MCP Server\nVersion: ${pkg.version}\nNode.js: ${process.version}\nPlatform: ${process.platform} ${process.arch}\nMCP SDK: ${pkg.dependencies['@modelcontextprotocol/sdk']}\nSQLite3: ${pkg.dependencies.sqlite3}\n`);
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
Durandal MCP Server v3 - Zero-config AI memory system for Claude Code

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
    const MCPDatabaseClient = require('./mcp-db-client');
    const tempClient = new MCPDatabaseClient();
    const dbPath = tempClient.dbPath;
    const dbExists = fs.existsSync(dbPath);

    let memoryCount = 0, projectCount = 0, sessionCount = 0;
    if (dbExists) {
        try {
            const countResult = await tempClient.query('SELECT COUNT(*) as count FROM memories');
            memoryCount = countResult.rows[0]?.count || 0;
            const projectResult = await tempClient.query(
                "SELECT COUNT(DISTINCT json_extract(metadata, '$.project')) as count FROM memories WHERE json_extract(metadata, '$.project') IS NOT NULL"
            );
            projectCount = projectResult.rows[0]?.count || 0;
            const sessionResult = await tempClient.query(
                "SELECT COUNT(DISTINCT json_extract(metadata, '$.session')) as count FROM memories WHERE json_extract(metadata, '$.session') IS NOT NULL"
            );
            sessionCount = sessionResult.rows[0]?.count || 0;
        } catch (_) {}
    }
    await tempClient.close();

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
