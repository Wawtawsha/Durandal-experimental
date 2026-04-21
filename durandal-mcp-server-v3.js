#!/usr/bin/env node

/**
 * Durandal MCP Server v3 - Enhanced with Logging, Testing, and Debug Features
 *
 * Zero-configuration AI memory system with comprehensive logging and debugging
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const DatabaseAdapter = require('./db-adapter');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

// New modules
const Logger = require('./logger');
const {
    MCPError,
    ValidationError,
    DatabaseError,
    CacheError,
    ErrorHandler
} = require('./errors');
const TestRunner = require('./test-runner');
const UpdateChecker = require('./update-checker');

class DurandalMCPServer extends EventEmitter {
    constructor(options = {}) {
        super();

        // Load persisted config from ~/.durandal-mcp/.env
        this.loadPersistedConfig();

        // Initialize logger first
        this.logger = new Logger({
            level: options.logLevel || process.env.LOG_LEVEL || 'warn',
            verbose: options.verbose || process.env.VERBOSE === 'true',
            debug: options.debug || process.env.DEBUG === 'true',
            logMCPTools: options.logMCPTools || process.env.LOG_MCP_TOOLS === 'true',
            logFile: options.logFile || process.env.LOG_FILE,
            errorLogFile: options.errorLogFile || process.env.ERROR_LOG_FILE
        });

        // Initialize error handler
        this.errorHandler = new ErrorHandler(this.logger);

        // Get package info for version
        this.packageInfo = this.loadPackageInfo();

        // Log startup
        this.logger.info('[START] Durandal MCP Server starting', {
            version: this.packageInfo.version,
            node: process.version,
            pid: process.pid
        });

        // Initialize MCP server
        this.server = new Server({
            name: 'durandal-memory-server',
            version: this.packageInfo.version,
            description: this.packageInfo.description
        }, {
            capabilities: {
                tools: {}
            }
        });

        // Initialize components. The in-memory "RAMR cache" from prior versions
        // was removed: it was a plain Map that duplicated DB state without
        // invalidation, never actually prioritized by "cache priority", and was
        // the root cause of the client-side-id-vs-DB-id dedup bug. SQLite with
        // proper indexes is fast enough without it.
        this.db = new DatabaseAdapter();

        // Run database startup check — expose as a promise so tests/shutdown
        // can await completion instead of racing with fire-and-forget logging.
        this.ready = this.runDatabaseStartupCheck();

        this.setupHandlers();
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

            if (fs.existsSync(envPath)) {
                const envContent = fs.readFileSync(envPath, 'utf8');
                const lines = envContent.split('\n');

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed && !trimmed.startsWith('#')) {
                        const [key, value] = trimmed.split('=');
                        if (key && value && !process.env[key]) {
                            // Only set if not already in environment
                            process.env[key] = value;
                        }
                    }
                }
            }
        } catch (error) {
            // Silently fail - config loading shouldn't break server
        }
    }

    /**
     * Runs comprehensive database checks on startup
     */
    async runDatabaseStartupCheck() {
        this.logger.info('[DB-CHECK] Running database startup check...');

        const checks = {
            connectivity: false,
            schema: false,
            readWrite: false,
            integrity: false
        };

        try {
            // Check 1: Database connectivity
            const connTest = await this.db.testConnection();
            if (connTest.success) {
                checks.connectivity = true;
                this.logger.info('[DB-CHECK] Connectivity test passed');
            } else {
                this.logger.error('[DB-CHECK] Connectivity test failed', { error: connTest.error });
                throw new Error(`Database connectivity failed: ${connTest.error}`);
            }

            // Check 2: Schema validation
            const schemaTest = await this.validateDatabaseSchema();
            if (schemaTest.valid) {
                checks.schema = true;
                this.logger.info('[DB-CHECK] Schema validation passed');
            } else {
                this.logger.warn('[DB-CHECK] Schema validation warnings', { issues: schemaTest.issues });
                checks.schema = true; // Allow startup with warnings
            }

            // Check 3: Read/Write test
            const rwTest = await this.testReadWrite();
            if (rwTest.success) {
                checks.readWrite = true;
                this.logger.info('[DB-CHECK] Read/Write test passed');
            } else {
                this.logger.error('[DB-CHECK] Read/Write test failed', { error: rwTest.error });
                throw new Error(`Database read/write failed: ${rwTest.error}`);
            }

            // Check 4: Database integrity
            const integrityTest = await this.checkDatabaseIntegrity();
            if (integrityTest.ok) {
                checks.integrity = true;
                this.logger.info('[DB-CHECK] Integrity check passed');
            } else {
                this.logger.warn('[DB-CHECK] Integrity check found issues', { issues: integrityTest.errors });
                checks.integrity = true; // Allow startup with warnings
            }

            // Summary
            const allPassed = Object.values(checks).every(c => c === true);
            if (allPassed) {
                this.logger.success('[DB-CHECK] All database checks passed');
            } else {
                this.logger.warn('[DB-CHECK] Some checks failed or had warnings', { checks });
            }

        } catch (error) {
            this.logger.error('[DB-CHECK] Critical database check failed', {
                error: error.message,
                checks
            });

            // Log a prominent warning but don't crash - allow server to start
            console.error('\n[CRITICAL] Database startup check failed:');
            console.error(`  Error: ${error.message}`);
            console.error('  Server will continue but database operations may fail.\n');
        }
    }

    /**
     * Validates database schema exists and is correct
     */
    async validateDatabaseSchema() {
        try {
            const tables = await new Promise((resolve, reject) => {
                this.db.db.client.all(
                    "SELECT name FROM sqlite_master WHERE type='table'",
                    (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows.map(r => r.name));
                    }
                );
            });

            const issues = [];

            // Check for main memories table (required)
            if (!tables.includes('memories')) {
                return {
                    valid: false,
                    issues: ['Critical: Missing memories table - database needs initialization']
                };
            }

            // Check memories table structure
            const columns = await new Promise((resolve, reject) => {
                this.db.db.client.all(
                    "PRAGMA table_info(memories)",
                    (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows.map(r => r.name));
                    }
                );
            });

            // Essential columns for memories table
            const essentialColumns = ['id', 'content'];
            const missingEssential = essentialColumns.filter(c => !columns.includes(c));

            if (missingEssential.length > 0) {
                issues.push(`Missing essential columns in memories table: ${missingEssential.join(', ')}`);
            }

            // Optional but expected columns
            const expectedColumns = ['metadata', 'created_at'];
            const missingExpected = expectedColumns.filter(c => !columns.includes(c));

            if (missingExpected.length > 0) {
                // This is a warning, not a failure
                this.logger.debug('[DB-CHECK] Optional columns missing', { columns: missingExpected });
            }

            // Check for legacy tables (informational)
            const legacyTables = ['projects', 'conversation_sessions', 'conversation_messages'];
            const existingLegacy = legacyTables.filter(t => tables.includes(t));

            if (existingLegacy.length > 0) {
                this.logger.debug('[DB-CHECK] Legacy tables present', { tables: existingLegacy });
            }

            // Count records to verify database is operational
            const recordCount = await new Promise((resolve, reject) => {
                this.db.db.client.get(
                    "SELECT COUNT(*) as count FROM memories",
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row.count);
                    }
                );
            });

            this.logger.debug('[DB-CHECK] Database contains memories', { count: recordCount });

            return {
                valid: issues.length === 0,
                issues,
                info: {
                    tables: tables.length,
                    memories: recordCount,
                    hasLegacyTables: existingLegacy.length > 0
                }
            };

        } catch (error) {
            return {
                valid: false,
                issues: [`Schema validation error: ${error.message}`]
            };
        }
    }

    /**
     * Tests basic read/write operations
     */
    async testReadWrite() {
        try {
            const testContent = `[DB-CHECK] Test memory created at ${new Date().toISOString()}`;
            const testMetadata = {
                type: 'system-test',
                test: true,
                timestamp: new Date().toISOString()
            };

            // Write test using proper abstraction
            const storeResult = await this.db.storeMemory(testContent, testMetadata);

            if (!storeResult || !storeResult.id) {
                throw new Error('Store operation did not return an ID');
            }

            // Read test using proper abstraction
            const searchResult = await this.db.searchMemories('[DB-CHECK]', {}, 1);

            if (!searchResult || searchResult.length === 0) {
                throw new Error('Search operation returned no results');
            }

            // Cleanup test memory - we need direct access for cleanup
            // This is acceptable as it's a cleanup operation
            try {
                await new Promise((resolve, reject) => {
                    this.db.db.client.run(
                        'DELETE FROM memories WHERE id = ?',
                        [storeResult.id],
                        (err) => err ? reject(err) : resolve()
                    );
                });
            } catch (cleanupError) {
                // Non-critical if cleanup fails
                this.logger.warn('[DB-CHECK] Test memory cleanup failed', {
                    error: cleanupError.message
                });
            }

            return { success: true };

        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Checks database integrity using SQLite's PRAGMA integrity_check
     */
    async checkDatabaseIntegrity() {
        try {
            const result = await new Promise((resolve, reject) => {
                this.db.db.client.all(
                    'PRAGMA integrity_check',
                    (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows);
                    }
                );
            });

            // SQLite returns 'ok' if database is healthy
            if (result.length === 1 && result[0].integrity_check === 'ok') {
                return { ok: true, errors: [] };
            } else {
                return {
                    ok: false,
                    errors: result.map(r => r.integrity_check)
                };
            }

        } catch (error) {
            return {
                ok: false,
                errors: [`Integrity check failed: ${error.message}`]
            };
        }
    }

    setupHandlers() {
        // List tools handler
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            this.logger.debug('Listing MCP tools');

            return {
                tools: [
                    {
                        name: 'store_memory',
                        description: 'Store content with enriched metadata for intelligent processing',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                content: {
                                    type: 'string',
                                    description: 'Content to store'
                                },
                                metadata: {
                                    type: 'object',
                                    description: 'Enriched metadata from Claude Code',
                                    properties: {
                                        project: { type: 'string' },
                                        session: { type: 'string' },
                                        type: { type: 'string' },
                                        importance: { type: 'number', minimum: 0, maximum: 1 },
                                        categories: { type: 'array', items: { type: 'string' } },
                                        keywords: { type: 'array', items: { type: 'string' } }
                                    }
                                }
                            },
                            required: ['content']
                        }
                    },
                    {
                        name: 'search_memories',
                        description: 'Search memories using metadata and content filters',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                query: { type: 'string', description: 'Search query' },
                                filters: {
                                    type: 'object',
                                    properties: {
                                        categories: { type: 'array', items: { type: 'string' } },
                                        project: { type: 'string' },
                                        session: { type: 'string' },
                                        importance_min: { type: 'number' },
                                        importance_max: { type: 'number' }
                                    }
                                },
                                limit: { type: 'number', default: 10 }
                            },
                            required: ['query']
                        }
                    },
                    {
                        name: 'get_context',
                        description: 'Get contextual information and recent memories',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                project: { type: 'string' },
                                session: { type: 'string' },
                                limit: { type: 'number', default: 10 },
                                include_stats: { type: 'boolean', default: true }
                            }
                        }
                    },
                    {
                        name: 'optimize_memory',
                        description: 'Run SQLite database maintenance (VACUUM, ANALYZE, integrity check, WAL checkpoint). Previously advertised "retention review" and "pattern analysis" operations which were placeholders; those were removed.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                operations: {
                                    type: 'array',
                                    items: {
                                        type: 'string',
                                        enum: ['vacuum', 'analyze', 'integrity_check', 'wal_checkpoint']
                                    },
                                    default: ['vacuum', 'analyze'],
                                    description: 'Maintenance operations to run, in order.'
                                }
                            }
                        }
                    },
                    {
                        name: 'get_status',
                        description: 'Get current Durandal MCP server status including memory usage, uptime, database stats, and logging configuration',
                        inputSchema: {
                            type: 'object',
                            properties: {}
                        }
                    },
                    {
                        name: 'configure_logging',
                        description: 'Configure console and file logging levels for Durandal MCP server. Console level controls terminal output (quiet), file level controls session history (detailed for debugging).',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                console_level: {
                                    type: 'string',
                                    enum: ['error', 'warn', 'info', 'debug'],
                                    description: 'Log level for console output (what you see in terminal). Default: warn (quiet)'
                                },
                                file_level: {
                                    type: 'string',
                                    enum: ['error', 'warn', 'info', 'debug'],
                                    description: 'Log level for file output (detailed session history for debugging). Default: info'
                                }
                            }
                        }
                    },
                    {
                        name: 'get_logs',
                        description: 'Retrieve recent log entries from Durandal MCP server for debugging and troubleshooting session history',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                lines: {
                                    type: 'number',
                                    description: 'Number of recent log lines to retrieve',
                                    default: 50
                                },
                                level_filter: {
                                    type: 'string',
                                    enum: ['error', 'warn', 'info', 'debug'],
                                    description: 'Filter logs by minimum level (e.g., "error" shows only errors and fatal)'
                                },
                                search: {
                                    type: 'string',
                                    description: 'Search for specific text in log messages'
                                }
                            }
                        }
                    },
                    {
                        name: 'list_projects_sessions',
                        description: 'List all projects and sessions with memory counts',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                type: {
                                    type: 'string',
                                    enum: ['projects', 'sessions', 'both'],
                                    description: 'What to list: projects, sessions, or both',
                                    default: 'both'
                                },
                                include_samples: {
                                    type: 'boolean',
                                    description: 'Include sample memories from each project/session',
                                    default: false
                                }
                            }
                        }
                    }
                ]
            };
        });

        // Call tool handler with enhanced logging
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const toolName = request.params.name;
            const args = request.params.arguments || {};

            // Start MCP tool logging
            const requestId = this.logger.startMCPTool(toolName, args);

            try {
                this.logger.debug(`Processing tool: ${toolName}`, { requestId, args });

                let result;
                switch (toolName) {
                    case 'store_memory':
                        result = await this.handleStoreMemory(args, requestId);
                        break;
                    case 'search_memories':
                        result = await this.handleSearchMemories(args, requestId);
                        break;
                    case 'get_context':
                        result = await this.handleGetContext(args, requestId);
                        break;
                    case 'optimize_memory':
                        result = await this.handleOptimizeMemory(args, requestId);
                        break;
                    case 'get_status':
                        result = await this.handleGetStatus(args, requestId);
                        break;
                    case 'configure_logging':
                        result = await this.handleConfigureLogging(args, requestId);
                        break;
                    case 'get_logs':
                        result = await this.handleGetLogs(args, requestId);
                        break;
                    case 'list_projects_sessions':
                        result = await this.handleListProjectsSessions(args, requestId);
                        break;
                    default:
                        throw new ValidationError(`Unknown tool: ${toolName}`, 'toolName', toolName);
                }

                // End MCP tool logging - success
                this.logger.endMCPTool(requestId, true, result);
                return result;

            } catch (error) {
                // End MCP tool logging - failure
                this.logger.endMCPTool(requestId, false, null, error);

                // Handle error with structured error response
                const errorResponse = this.errorHandler.handle(error, requestId);
                return {
                    content: [{
                        type: 'text',
                        text: `[ERR] Error: ${errorResponse.error.message}\n\nRecovery: ${errorResponse.error.recovery || 'Check logs for details'}`
                    }]
                };
            }
        });
    }

    async handleStoreMemory(args, requestId) {
        this.logger.processing('Processing store_memory request from Claude');

        if (!args.content || typeof args.content !== 'string') {
            throw new ValidationError('Content must be a non-empty string', 'content', args.content);
        }
        if (args.content.length > 50000) {
            throw new ValidationError('Content exceeds maximum length (50000 characters)', 'content', args.content.length);
        }

        // Metadata must be a plain object. Arrays, strings, null, and other
        // non-objects previously slipped through and crashed downstream on
        // property access. JSON.stringify also throws on circular structures;
        // we catch that here with a clear error instead of leaking the cryptic
        // native message into the MCP response.
        const metadata = args.metadata ?? {};
        if (typeof metadata !== 'object' || Array.isArray(metadata) || metadata === null) {
            throw new ValidationError('Metadata must be an object', 'metadata', typeof metadata);
        }

        if (metadata.importance !== undefined) {
            if (typeof metadata.importance !== 'number' || metadata.importance < 0 || metadata.importance > 1) {
                throw new ValidationError('Importance must be a number between 0 and 1', 'metadata.importance', metadata.importance);
            }
        }

        for (const field of ['project', 'session', 'type']) {
            if (metadata[field] !== undefined && typeof metadata[field] !== 'string') {
                throw new ValidationError(`metadata.${field} must be a string`, `metadata.${field}`, metadata[field]);
            }
        }
        for (const field of ['categories', 'keywords']) {
            if (metadata[field] !== undefined) {
                if (!Array.isArray(metadata[field])) {
                    throw new ValidationError(`metadata.${field} must be an array of strings`, `metadata.${field}`, metadata[field]);
                }
                if (!metadata[field].every(v => typeof v === 'string')) {
                    throw new ValidationError(`metadata.${field} must contain only strings`, `metadata.${field}`, metadata[field]);
                }
            }
        }

        if (!metadata.project) metadata.project = 'default';
        if (!metadata.session) metadata.session = new Date().toISOString().split('T')[0];

        const enrichedMetadata = this.enrichMetadata(metadata);

        // Bound metadata size — 64 KB JSON cap. An unbounded metadata can balloon
        // the row well beyond the 50 KB content cap and fragment the DB over time.
        let serialized;
        try {
            serialized = JSON.stringify(enrichedMetadata);
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

        // Write to DB first and await — the DB's autoincrement id is the canonical one.
        // Previously this fire-and-forgot the write and returned a client-generated id
        // that never matched the stored row, breaking get-by-id and cache dedup.
        this.logger.substep('Storing to database');
        const dbResult = await this.db.storeMemory(args.content, enrichedMetadata);
        if (!dbResult || !dbResult.success) {
            throw new DatabaseError(
                'Failed to store memory',
                'store',
                new Error(dbResult?.error || 'unknown database error')
            );
        }
        const memoryId = dbResult.id;

        this.logger.success(`Memory stored (id: ${memoryId})`, {
            requestId,
            memoryId,
            contentLength: args.content.length,
            importance: enrichedMetadata.importance
        });

        return {
            content: [{
                type: 'text',
                text: `[OK] Memory stored successfully\n\n` +
                      `**ID:** ${memoryId}\n` +
                      `**Project:** ${enrichedMetadata.project}\n` +
                      `**Session:** ${enrichedMetadata.session}\n` +
                      `**Importance:** ${enrichedMetadata.importance ?? 'Not set'}\n` +
                      `**Categories:** ${enrichedMetadata.categories?.join(', ') || 'None'}`
            }]
        };
    }

    async handleSearchMemories(args, requestId) {
        this.logger.processing('Processing search_memories request from Claude');

        if (!args.query || typeof args.query !== 'string') {
            throw new ValidationError('Query must be a non-empty string', 'query', args.query);
        }

        const filters = args.filters || {};
        const limit = Math.min(args.limit || 10, 100);

        // Validate importance range if supplied — caught a silent "filter ignored"
        // bug where typos in filter keys produced no matches rather than errors.
        if (filters.importance_min !== undefined && typeof filters.importance_min !== 'number') {
            throw new ValidationError('importance_min must be a number', 'filters.importance_min', filters.importance_min);
        }
        if (filters.importance_max !== undefined && typeof filters.importance_max !== 'number') {
            throw new ValidationError('importance_max must be a number', 'filters.importance_max', filters.importance_max);
        }

        this.logger.substep('Querying database');
        const dbResults = await this.db.searchMemories(args.query, {
            project: filters.project,
            session: filters.session,
            limit: limit * 2 // over-fetch so post-filters (categories/importance) can trim
        });

        // Post-filter by importance range and categories — these aren't columns,
        // they live inside the metadata JSON, so we apply them in JS.
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
            requestId,
            query: args.query,
            resultsCount: filtered.length
        });

        if (filtered.length === 0) {
            return {
                content: [{ type: 'text', text: 'No memories found matching your query.' }]
            };
        }

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
            content: [{
                type: 'text',
                text: `**Search Results** (${filtered.length} found)\n\n${formatted}`
            }]
        };
    }

    async handleGetContext(args, requestId) {
        this.logger.processing('Processing get_context request from Claude');

        const project = args.project || 'default';
        const session = args.session || 'default';
        const limit = Math.min(args.limit || 10, 50);
        const includeStats = args.include_stats !== false;

        this.logger.substep('Retrieving recent memories');
        const recentMemories = await this.getRecentMemoriesFromDb(project, session, limit);

        // Real stats — previously this reported made-up "RAMR enabled / Selective
        // Attention enabled" flags plus a cache hit rate that measured nothing
        // meaningful (every access pattern counted regardless of whether the
        // memory was actually in cache).
        let stats = {};
        if (includeStats) {
            const rowCountRes = await this.db.db.query('SELECT COUNT(*) as count FROM memories').catch(() => ({ rows: [{ count: 0 }] }));
            const projectCountRes = project && project !== 'default'
                ? await this.db.db.query("SELECT COUNT(*) as count FROM memories WHERE json_extract(metadata, '$.project') = ?", [project]).catch(() => ({ rows: [{ count: 0 }] }))
                : null;
            stats = {
                totalMemoriesInDb: rowCountRes.rows[0]?.count || 0,
                memoriesInProject: projectCountRes ? (projectCountRes.rows[0]?.count || 0) : null,
                returned: recentMemories.length
            };
        }

        this.logger.success(`Context retrieved (${recentMemories.length} memories)`, {
            requestId,
            memoriesCount: recentMemories.length
        });

        let response = `**Context for Project: ${project}, Session: ${session}**\n\n`;

        if (recentMemories.length > 0) {
            response += '**Recent Memories:**\n';
            recentMemories.slice(0, Math.min(5, recentMemories.length)).forEach((memory, index) => {
                const preview = memory.content.length > 80 ? memory.content.slice(0, 80) + '...' : memory.content;
                response += `${index + 1}. ${preview}\n`;
            });
        } else {
            response += 'No recent memories found.\n';
        }

        if (includeStats) {
            response += `\n**Statistics:**\n`;
            response += `- Returned: ${stats.returned}\n`;
            response += `- Total memories (database): ${stats.totalMemoriesInDb}\n`;
            if (stats.memoriesInProject !== null) {
                response += `- Memories in "${project}": ${stats.memoriesInProject}\n`;
            }
        }

        return {
            content: [{ type: 'text', text: response }]
        };
    }

    async handleOptimizeMemory(args, requestId) {
        this.logger.processing('Processing optimize_memory request from Claude');

        const operations = args.operations || ['vacuum', 'analyze'];
        this.logger.substep(`Running ${operations.length} maintenance operation(s)`);

        const results = [];
        for (const op of operations) {
            try {
                const message = await this.runMaintenanceOperation(op);
                results.push(`[OK] ${op}: ${message}`);
            } catch (error) {
                this.logger.error(`Maintenance operation failed: ${op}`, { requestId, error: error.message });
                results.push(`[ERR] ${op} failed: ${error.message}`);
            }
        }

        this.logger.success('Maintenance complete', { requestId, operationsCount: operations.length });

        return {
            content: [{
                type: 'text',
                text: `**Database Maintenance Results:**\n\n${results.join('\n')}`
            }]
        };
    }

    async handleGetStatus(args, requestId) {
        this.logger.processing('Processing get_status request from Claude');

        // Use the actual database path that was resolved
        const dbPath = this.db.db.dbPath;
        const dbExists = fs.existsSync(dbPath);
        const dbSize = dbExists ? (fs.statSync(dbPath).size / 1024 / 1024).toFixed(2) : '0.00';

        // Get memory counts from database
        let dbMemoryCount = 0;
        let dbProjectCount = 0;
        let dbSessionCount = 0;

        if (dbExists) {
            try {
                // Get total memory count
                const countResult = await this.db.db.query('SELECT COUNT(*) as count FROM memories');
                dbMemoryCount = countResult.rows[0]?.count || 0;

                // Get unique projects and sessions
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
        const uptimeSeconds = process.uptime();

        const statusData = {
            version: this.packageInfo.version,
            uptime: formatUptime(uptimeSeconds),
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
            node: process.version,
            platform: process.platform,
            pid: process.pid
        };

        this.logger.success('Status retrieved');

        // Format as nice display
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
        const logFileDisplay = (statusData.logging.logFile || '(none)').slice(-35).padStart(35);
        output += `┃  Log File:        ${logFileDisplay}┃\n`;
        output += '┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫\n';
        output += `┃  Node Version:    ${statusData.node.padEnd(35)}┃\n`;
        output += `┃  Platform:        ${statusData.platform.padEnd(35)}┃\n`;
        output += `┃  Process ID:      ${statusData.pid.toString().padEnd(35)}┃\n`;
        output += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n';

        return {
            content: [{
                type: 'text',
                text: output
            }]
        };
    }

    async handleConfigureLogging(args, requestId) {
        this.logger.processing('Processing configure_logging request from Claude');

        const { console_level, file_level } = args;

        if (!console_level && !file_level) {
            throw new ValidationError('Must specify at least one log level', 'console_level or file_level', args);
        }

        const validLevels = ['error', 'warn', 'info', 'debug'];

        if (console_level && !validLevels.includes(console_level)) {
            throw new ValidationError(`Invalid console log level: ${console_level}. Must be one of: ${validLevels.join(', ')}`, 'console_level', console_level);
        }

        if (file_level && !validLevels.includes(file_level)) {
            throw new ValidationError(`Invalid file log level: ${file_level}. Must be one of: ${validLevels.join(', ')}`, 'file_level', file_level);
        }

        const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
        const configDir = path.join(homeDir, '.durandal-mcp');
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
        const envPath = path.join(configDir, '.env');
        let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

        let updated = [];

        if (console_level) {
            if (/^CONSOLE_LOG_LEVEL=/m.test(envContent)) {
                envContent = envContent.replace(/^CONSOLE_LOG_LEVEL=.*$/gm,`CONSOLE_LOG_LEVEL=${console_level}`);
            } else {
                envContent += `\nCONSOLE_LOG_LEVEL=${console_level}\n`;
            }

            if (this.logger.setConsoleLevel(console_level)) {
                updated.push(`Console level: ${console_level}`);
            }
        }

        if (file_level) {
            if (/^FILE_LOG_LEVEL=/m.test(envContent)) {
                envContent = envContent.replace(/^FILE_LOG_LEVEL=.*$/gm,`FILE_LOG_LEVEL=${file_level}`);
            } else {
                envContent += `\nFILE_LOG_LEVEL=${file_level}\n`;
            }

            if (this.logger.setFileLevel(file_level)) {
                updated.push(`File level: ${file_level}`);
            }
        }

        try {
            fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf8');
            this.logger.info('Config file written successfully to:', envPath);
        } catch (error) {
            this.logger.error('Failed to write config file:', error);
            throw new Error(`Failed to save configuration: ${error.message}`);
        }

        this.logger.success('Logging configuration updated');

        let output = '[OK] **Logging Configuration Updated**\n\n';
        updated.forEach(change => {
            output += `- ${change}\n`;
        });
        output += '\n**Current Configuration:**\n';
        output += `- Console Level: ${this.logger.getConsoleLevel()} (terminal output)\n`;
        output += `- File Level: ${this.logger.getFileLevel()} (session history)\n`;
        output += `- Log File: ${this.logger.logFile}\n\n`;
        output += 'Changes applied immediately to current session.\n';
        output += 'Configuration saved to .env for future sessions.';

        return {
            content: [{
                type: 'text',
                text: output
            }]
        };
    }

    async handleGetLogs(args, requestId) {
        this.logger.processing('Processing get_logs request from Claude');

        const { lines = 50, level_filter, search } = args;
        if (typeof lines !== 'number' || lines < 1 || lines > 10000) {
            throw new ValidationError('lines must be a number between 1 and 10000', 'lines', lines);
        }

        if (!this.logger.logFile || !fs.existsSync(this.logger.logFile)) {
            throw new ValidationError('No log file found', 'logFile', this.logger.logFile);
        }

        this.logger.substep('Reading log file');

        // Stream-read into a rolling buffer of size `lines * 4` so we keep enough
        // raw candidates to satisfy post-filters (level + search) without
        // loading the whole file — logs can grow to 10+ MB.
        const readline = require('readline');
        const rl = readline.createInterface({
            input: fs.createReadStream(this.logger.logFile, { encoding: 'utf8' }),
            crlfDelay: Infinity
        });

        const keep = Math.min(Math.max(lines * 4, 100), 20000);
        const ring = new Array(keep);
        let writeIdx = 0;
        let count = 0;
        for await (const line of rl) {
            if (!line.trim()) continue;
            ring[writeIdx] = line;
            writeIdx = (writeIdx + 1) % keep;
            count++;
        }

        const ordered = [];
        const actual = Math.min(count, keep);
        const start = count > keep ? writeIdx : 0;
        for (let i = 0; i < actual; i++) {
            ordered.push(ring[(start + i) % keep]);
        }

        let parsedLogs = [];
        for (const line of ordered) {
            try {
                parsedLogs.push(JSON.parse(line));
            } catch (_) { /* skip corrupt line */ }
        }

        this.logger.substep(`Found ${parsedLogs.length} log entries`);

        // Filter by level
        if (level_filter) {
            const filterValue = this.logger.levels[level_filter];
            parsedLogs = parsedLogs.filter(log => {
                const logLevel = this.logger.levels[log.level];
                return logLevel >= filterValue;
            });
            this.logger.substep(`Filtered to ${parsedLogs.length} entries by level`);
        }

        // Search filter
        if (search) {
            const searchLower = search.toLowerCase();
            parsedLogs = parsedLogs.filter(log =>
                log.message.toLowerCase().includes(searchLower) ||
                JSON.stringify(log).toLowerCase().includes(searchLower)
            );
            this.logger.substep(`Filtered to ${parsedLogs.length} entries by search`);
        }

        // Get most recent N entries
        const recentLogs = parsedLogs.slice(-lines);

        this.logger.success(`Retrieved ${recentLogs.length} log entries`);

        // Format for display
        let output = `**Recent Log Entries** (${recentLogs.length} of ${parsedLogs.length} total)\n\n`;
        output += `Log file: \`${path.basename(this.logger.logFile)}\`\n\n`;

        if (recentLogs.length === 0) {
            output += '**No matching log entries found.**\n';
        } else {
            recentLogs.forEach((log, index) => {
                const timestamp = new Date(log.timestamp).toLocaleString();
                const levelEmoji = {
                    debug: '[DEBUG]',
                    info: '[INFO] ',
                    warn: '[WARN] ',
                    error: '[ERR] ',
                    fatal: '[FATAL]'
                }[log.level] || '[LOG]  ';

                output += `**${index + 1}.** ${levelEmoji} \`[${log.level.toUpperCase()}]\` ${timestamp}\n`;
                output += `   ${log.message}\n`;

                if (log.requestId) {
                    output += `   _Request: ${log.requestId}_\n`;
                }

                output += `\n`;
            });
        }

        return {
            content: [{
                type: 'text',
                text: output
            }]
        };
    }

    async handleListProjectsSessions(args, requestId) {
        this.logger.processing('Processing list_projects_sessions request from Claude');

        const listType = args.type || 'both';
        const includeSamples = args.include_samples || false;

        let output = '';
        const results = {};

        // Get projects if requested
        if (listType === 'projects' || listType === 'both') {
            try {
                const projectsResult = await this.db.db.query(`
                    SELECT
                        json_extract(metadata, '$.project') as project,
                        COUNT(*) as count,
                        MIN(created_at) as first_memory,
                        MAX(created_at) as last_memory
                    FROM memories
                    WHERE json_extract(metadata, '$.project') IS NOT NULL
                    GROUP BY json_extract(metadata, '$.project')
                    ORDER BY count DESC
                `);

                results.projects = projectsResult.rows.map(row => ({
                    name: row.project,
                    memoryCount: row.count,
                    firstMemory: row.first_memory,
                    lastMemory: row.last_memory
                }));

                // Get samples if requested
                if (includeSamples && results.projects.length > 0) {
                    for (const project of results.projects) {
                        const sampleResult = await this.db.db.query(`
                            SELECT content, created_at
                            FROM memories
                            WHERE json_extract(metadata, '$.project') = ?
                            ORDER BY created_at DESC
                            LIMIT 2
                        `, [project.name]);
                        project.samples = sampleResult.rows;
                    }
                }
            } catch (e) {
                this.logger.error('Failed to list projects', { error: e.message });
                results.projects = [];
            }
        }

        // Get sessions if requested
        if (listType === 'sessions' || listType === 'both') {
            try {
                const sessionsResult = await this.db.db.query(`
                    SELECT
                        json_extract(metadata, '$.session') as session,
                        COUNT(*) as count,
                        MIN(created_at) as first_memory,
                        MAX(created_at) as last_memory
                    FROM memories
                    WHERE json_extract(metadata, '$.session') IS NOT NULL
                    GROUP BY json_extract(metadata, '$.session')
                    ORDER BY last_memory DESC
                    LIMIT 50
                `);

                results.sessions = sessionsResult.rows.map(row => ({
                    name: row.session,
                    memoryCount: row.count,
                    firstMemory: row.first_memory,
                    lastMemory: row.last_memory
                }));

                // Get samples if requested
                if (includeSamples && results.sessions.length > 0) {
                    for (const session of results.sessions.slice(0, 10)) { // Limit samples to first 10 sessions
                        const sampleResult = await this.db.db.query(`
                            SELECT content, created_at
                            FROM memories
                            WHERE json_extract(metadata, '$.session') = ?
                            ORDER BY created_at DESC
                            LIMIT 2
                        `, [session.name]);
                        session.samples = sampleResult.rows;
                    }
                }
            } catch (e) {
                this.logger.error('Failed to list sessions', { error: e.message });
                results.sessions = [];
            }
        }

        // Format output
        output = `# Durandal Memory Organization\n\n`;

        if (results.projects) {
            output += `## Projects (${results.projects.length} total)\n\n`;
            for (const project of results.projects) {
                output += `### ${project.name}\n`;
                output += `- **Memories:** ${project.memoryCount}\n`;
                output += `- **First:** ${new Date(project.firstMemory).toLocaleDateString()}\n`;
                output += `- **Latest:** ${new Date(project.lastMemory).toLocaleDateString()}\n`;

                if (project.samples) {
                    output += `- **Recent samples:**\n`;
                    for (const sample of project.samples) {
                        const preview = sample.content.substring(0, 100);
                        output += `  - "${preview}${sample.content.length > 100 ? '...' : ''}"\n`;
                    }
                }
                output += '\n';
            }
        }

        if (results.sessions) {
            output += `## Sessions (${results.sessions.length} recent)\n\n`;
            for (const session of results.sessions.slice(0, 20)) { // Show max 20 sessions
                output += `### ${session.name}\n`;
                output += `- **Memories:** ${session.memoryCount}\n`;
                output += `- **Duration:** ${new Date(session.firstMemory).toLocaleTimeString()} - ${new Date(session.lastMemory).toLocaleTimeString()}\n`;

                if (session.samples) {
                    output += `- **Recent samples:**\n`;
                    for (const sample of session.samples) {
                        const preview = sample.content.substring(0, 100);
                        output += `  - "${preview}${sample.content.length > 100 ? '...' : ''}"\n`;
                    }
                }
                output += '\n';
            }
        }

        // Add summary
        const totalProjects = results.projects?.length || 0;
        const totalSessions = results.sessions?.length || 0;
        const totalMemories = results.projects?.reduce((sum, p) => sum + p.memoryCount, 0) || 0;

        output += `## Summary\n`;
        output += `- **Total Projects:** ${totalProjects}\n`;
        output += `- **Total Sessions:** ${totalSessions}\n`;
        output += `- **Total Memories:** ${totalMemories}\n`;

        this.logger.success('Listed projects and sessions');

        return {
            content: [{
                type: 'text',
                text: output
            }]
        };
    }

    // --- helpers -------------------------------------------------------

    // Stamp a `created_at` on metadata. Prior versions layered "RAMR" and
    // "selectiveAttention" objects onto every memory that were never read by
    // anything meaningful — they've been removed.
    enrichMetadata(metadata) {
        return { ...metadata, created_at: new Date().toISOString() };
    }

    async getRecentMemoriesFromDb(project, session, limit) {
        // Treat 'default' as "no filter" since the handler supplies it as a
        // fallback — otherwise users who never passed a project see nothing.
        const p = project && project !== 'default' ? project : null;
        const s = session && session !== 'default' ? session : null;
        return await this.db.getRecentMemories(limit, p, s);
    }

    // Real database maintenance. Replaces the placeholder "cache_optimization",
    // "retention_review", "pattern_analysis", "relationship_update" operations
    // that returned static numbers or "Feature in development" text.
    async runMaintenanceOperation(op) {
        const client = this.db.db.client;
        switch (op) {
            case 'vacuum':
                await new Promise((res, rej) => client.exec('VACUUM', e => e ? rej(e) : res()));
                return 'VACUUM completed (reclaimed fragmentation)';
            case 'analyze':
                await new Promise((res, rej) => client.exec('ANALYZE', e => e ? rej(e) : res()));
                return 'ANALYZE completed (query planner statistics refreshed)';
            case 'integrity_check': {
                const rows = await new Promise((res, rej) =>
                    client.all('PRAGMA integrity_check', (e, r) => e ? rej(e) : res(r))
                );
                const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
                return ok ? 'integrity_check: ok' : `integrity_check: ${rows.map(r => r.integrity_check).join('; ')}`;
            }
            case 'wal_checkpoint': {
                const row = await new Promise((res, rej) =>
                    client.get('PRAGMA wal_checkpoint(TRUNCATE)', (e, r) => e ? rej(e) : res(r))
                );
                return `wal_checkpoint: ${JSON.stringify(row)}`;
            }
            default:
                throw new ValidationError(`Unknown maintenance operation: ${op}`, 'operation', op);
        }
    }

    async start() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);

        this.logger.info('[START] Durandal MCP Server running', {
            transport: 'stdio',
            features: ['logging', 'testing', 'debug', 'error-handling']
        });

        // Log system info
        this.logger.logSystemInfo();

        // Check for updates (async, non-blocking)
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
            // Silently fail - update check shouldn't break server
            this.logger.debug('Update check error', { error: error.message });
        }
    }

    async shutdown() {
        // Guard against double shutdown (SIGINT + SIGTERM can fire close together)
        if (this._shuttingDown) return;
        this._shuttingDown = true;

        this.logger.info('[STOP] Shutting down Durandal MCP Server');

        // Wait for the startup check in case we're shutting down very quickly.
        try { await this.ready; } catch (_) {}

        // Best-effort WAL checkpoint — if SQLite was opened in WAL mode, the
        // -wal sibling file can grow unbounded between checkpoints.
        try {
            const client = this.db?.db?.client;
            if (client) {
                await new Promise((resolve) => {
                    client.exec('PRAGMA wal_checkpoint(TRUNCATE)', () => resolve());
                });
            }
        } catch (_) { /* best-effort */ }

        if (this.db?.close) {
            await this.db.close();
        }

        this.logger.close();

        // 250ms grace so any final stderr flush completes before exit.
        setTimeout(() => process.exit(0), 50);
    }

    // Command line interface
    static async cli() {
        const args = process.argv.slice(2);

        if (args.includes('--help') || args.includes('-h')) {
            console.log(`
Durandal MCP Server v3 - Zero-config AI memory system for Claude Code

Usage: durandal-mcp [options]

Options:
  --help, -h        Show this help message
  --version, -v     Show version information
  --test            Run built-in test suite
  --status          Show system status and statistics
  --discover        Find all Durandal databases on system
  --migrate         Merge all databases into universal database
  --configure       Interactive log level configuration
  --update          Check for and install updates
  --debug           Enable debug logging
  --verbose         Enable verbose output
  --log-file FILE   Write logs to file
  --log-level LEVEL Set log level (debug, info, warn, error)

Environment Variables:
  LOG_LEVEL         Set logging level (debug, info, warn, error)
  VERBOSE           Enable verbose logging (true/false)
  DEBUG             Enable debug mode (true/false)
  LOG_MCP_TOOLS     Log all MCP tool calls (true/false)
  LOG_FILE          Path to log file
  ERROR_LOG_FILE    Path to error log file
  DATABASE_PATH     SQLite database path (default: ./durandal-mcp-memory.db)

Examples:
  durandal-mcp                    # Start normally
  durandal-mcp --test             # Run tests
  durandal-mcp --debug            # Start with debug logging
  DEBUG=true durandal-mcp         # Enable debug via environment
  LOG_FILE=./logs/mcp.log durandal-mcp  # Log to file
`);
            process.exit(0);
        }

        if (args.includes('--version') || args.includes('-v')) {
            const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
            console.log(`
Durandal MCP Server
Version: ${pkg.version}
Node.js: ${process.version}
Platform: ${process.platform} ${process.arch}
MCP SDK: ${pkg.dependencies['@modelcontextprotocol/sdk']}
SQLite3: ${pkg.dependencies.sqlite3}
`);
            process.exit(0);
        }

        if (args.includes('--test')) {
            console.log('Running Durandal MCP Server Tests\n');
            const logger = new Logger({ level: 'info' });
            const runner = new TestRunner(logger);
            const success = await runner.runAllTests();
            process.exit(success ? 0 : 1);
        }

        if (args.includes('--status')) {
            const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

            // Use the same database resolution logic as the server
            const MCPDatabaseClient = require('./mcp-db-client');
            const tempClient = new MCPDatabaseClient();
            const dbPath = tempClient.dbPath;
            const dbExists = fs.existsSync(dbPath);

            // Get memory counts from database
            let memoryCount = 0;
            let projectCount = 0;
            let sessionCount = 0;

            if (dbExists) {
                try {
                    // Get counts from database
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
                } catch (e) {
                    // Ignore errors
                }
            }

            tempClient.close();  // Clean up

            const statusData = {
                version: pkg.version,
                status: 'running',
                uptime: formatUptime(process.uptime()),
                memory: {
                    rss: (process.memoryUsage().rss / 1024 / 1024).toFixed(2),
                    heapUsed: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
                    heapTotal: (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)
                },
                database: {
                    path: dbPath,
                    exists: dbExists,
                    size: dbExists ? (fs.statSync(dbPath).size / 1024 / 1024).toFixed(2) : '0.00',
                    memoryCount: memoryCount,
                    projectCount: projectCount,
                    sessionCount: sessionCount
                },
                node: process.version,
                platform: process.platform,
                pid: process.pid
            };

            displayStatusSummary(statusData);
            process.exit(0);
        }

        if (args.includes('--discover')) {
            console.log('Discovering all Durandal databases on system...\n');
            try {
                const DatabaseDiscovery = require('./db-discovery');
                const discovery = new DatabaseDiscovery();
                await discovery.discover();
            } catch (error) {
                console.error('Discovery failed:', error.message);
                console.error('\nTry running: node db-discovery.js');
            }
            process.exit(0);
        }

        if (args.includes('--migrate')) {
            console.log('Starting database migration...\n');
            try {
                const DatabaseMigrator = require('./db-migrate');
                const migrator = new DatabaseMigrator();
                await migrator.migrate();
            } catch (error) {
                console.error('Migration failed:', error.message);
                console.error('\nTry running: node db-migrate.js');
            }
            process.exit(0);
        }

        if (args.includes('--configure')) {
            await configureLogLevel();
            process.exit(0);
        }

        if (args.includes('--update')) {
            console.log('Durandal MCP Update Tool\n');
            const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
            const logger = new Logger({ level: 'info' });
            const updateChecker = new UpdateChecker(pkg, logger);

            try {
                const success = await updateChecker.performUpdate({ confirm: false });
                process.exit(success ? 0 : 1);
            } catch (error) {
                console.error('\n[ERR] Update failed:', error.message);
                console.log('\nYou can update manually with:');
                console.log('  npm install -g durandal-memory-mcp@latest\n');
                process.exit(1);
            }
        }

        // Parse command line options
        const options = {};
        if (args.includes('--debug')) {
            options.debug = true;
            options.logLevel = 'debug';
        }
        if (args.includes('--verbose')) {
            options.verbose = true;
        }

        const logFileIndex = args.indexOf('--log-file');
        if (logFileIndex > -1) {
            const val = args[logFileIndex + 1];
            if (!val || val.startsWith('--')) {
                console.error('Error: --log-file requires a file path argument');
                process.exit(2);
            }
            options.logFile = val;
        }

        const logLevelIndex = args.indexOf('--log-level');
        if (logLevelIndex > -1) {
            const val = args[logLevelIndex + 1];
            const validLevels = ['debug', 'info', 'warn', 'error'];
            if (!val || !validLevels.includes(val)) {
                console.error(`Error: --log-level must be one of ${validLevels.join(', ')}`);
                process.exit(2);
            }
            options.logLevel = val;
        }

        // Start server
        const server = new DurandalMCPServer(options);

        // Handle shutdown signals
        process.on('SIGTERM', () => server.shutdown());
        process.on('SIGINT', () => server.shutdown());

        // Handle uncaught errors. Previously uncaughtException called
        // shutdown() which exits 0 — a supervisor (Claude Code's process
        // manager, systemd, etc.) couldn't tell a clean shutdown from a
        // crash. Now exit non-zero so crashes are detectable.
        process.on('uncaughtException', (error) => {
            server.logger.error('Uncaught exception', {
                error: error.message,
                stack: error.stack
            });
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

function formatUptime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${secs}s`;
    } else {
        return `${secs}s`;
    }
}

function displayStatusSummary(data) {
    const statusEmoji = data.status === 'running' ? '[OK]' : '[STOP]';

    console.log('\n┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
    console.log(`┃  Durandal MCP Server v${data.version}                              ┃`);
    console.log('┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫');
    console.log(`┃  Status:          ${statusEmoji} ${data.status.charAt(0).toUpperCase() + data.status.slice(1).padEnd(29)}┃`);
    console.log(`┃  Uptime:          ${data.uptime.padEnd(35)}┃`);
    console.log(`┃  Memory (RSS):    ${(data.memory.rss + ' MB').padEnd(35)}┃`);
    console.log(`┃  Memory (Heap):   ${(data.memory.heapUsed + ' / ' + data.memory.heapTotal + ' MB').padEnd(35)}┃`);
    console.log('┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫');
    console.log(`┃  Database:        ${(data.database.exists ? '[OK] Connected' : '[ERR] Not Found').padEnd(35)}┃`);
    console.log(`┃  Database Size:   ${(data.database.size + ' MB').padEnd(35)}┃`);

    // Show memory counts if available
    if (data.database.memoryCount !== undefined) {
        console.log(`┃  Stored Memories: ${(data.database.memoryCount + ' memories').padEnd(35)}┃`);
        console.log(`┃  Projects:        ${(data.database.projectCount + ' projects').padEnd(35)}┃`);
        console.log(`┃  Sessions:        ${(data.database.sessionCount + ' sessions').padEnd(35)}┃`);
    }

    console.log('┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫');
    console.log(`┃  Node Version:    ${data.node.padEnd(35)}┃`);
    console.log(`┃  Platform:        ${data.platform.padEnd(35)}┃`);
    console.log(`┃  Process ID:      ${data.pid.toString().padEnd(35)}┃`);
    console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n');
}

async function configureLogLevel() {
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const question = (query) => new Promise((resolve) => rl.question(query, resolve));

    console.clear();
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║                                                           ║');
    console.log('║           DURANDAL LOG LEVEL CONFIGURATION                ║');
    console.log('║                                                           ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    console.log('Durandal uses separate log levels for console and file output:\n');
    console.log('  Console Level - What you see in the terminal (quiet)');
    console.log('  File Level - Session history for debugging (detailed)\n');

    // Console Level Selection
    console.log('═══════════════════════════════════════════════════════════\n');
    console.log('1. Select CONSOLE log level (terminal output):\n');

    console.log('┌───────────────────────────────────────────────────────────┐');
    console.log('│  [1] ERROR - Only critical errors                         │');
    console.log('│  [2] WARN - Warnings and errors (RECOMMENDED)             │');
    console.log('│  [3] INFO - Include success messages                      │');
    console.log('│  [4] DEBUG - Everything including substeps                │');
    console.log('└───────────────────────────────────────────────────────────┘\n');

    const consoleChoice = await question('Console level [1-4, default=2]: ');

    const levels = {
        '1': 'error',
        '2': 'warn',
        '3': 'info',
        '4': 'debug',
        '': 'warn'  // default
    };

    if (!levels[consoleChoice]) {
        console.log('\n[ERR] Invalid choice\n');
        rl.close();
        return;
    }

    const consoleLevel = levels[consoleChoice];

    // File Level Selection
    console.log('\n═══════════════════════════════════════════════════════════\n');
    console.log('2. Select FILE log level (session history):\n');

    console.log('┌───────────────────────────────────────────────────────────┐');
    console.log('│  [1] ERROR - Only errors                                  │');
    console.log('│  [2] WARN - Warnings and errors                           │');
    console.log('│  [3] ℹ️  INFO - Detailed session history (RECOMMENDED)    │');
    console.log('│  [4] 🔍 DEBUG - Maximum detail for troubleshooting        │');
    console.log('└───────────────────────────────────────────────────────────┘\n');

    const fileChoice = await question('File level [1-4, default=3]: ');

    if (!levels[fileChoice] && fileChoice !== '') {
        console.log('\n[ERR] Invalid choice\n');
        rl.close();
        return;
    }

    const fileLevel = fileChoice === '' ? 'info' : levels[fileChoice];

    // Save configuration to the SAME location the server reads on startup
    // (loadPersistedConfig reads from ~/.durandal-mcp/.env). Previously this
    // wrote to the install directory and the changes were silently ignored.
    const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
    const configDir = path.join(homeDir, '.durandal-mcp');
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }
    const envPath = path.join(configDir, '.env');
    let envContent = '';

    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
    }

    // Update or add console level
    if (/^CONSOLE_LOG_LEVEL=/m.test(envContent)) {
        envContent = envContent.replace(/^CONSOLE_LOG_LEVEL=.*$/gm,`CONSOLE_LOG_LEVEL=${consoleLevel}`);
    } else {
        envContent += `\nCONSOLE_LOG_LEVEL=${consoleLevel}\n`;
    }

    // Update or add file level
    if (/^FILE_LOG_LEVEL=/m.test(envContent)) {
        envContent = envContent.replace(/^FILE_LOG_LEVEL=.*$/gm,`FILE_LOG_LEVEL=${fileLevel}`);
    } else {
        envContent += `FILE_LOG_LEVEL=${fileLevel}\n`;
    }

    fs.writeFileSync(envPath, envContent, 'utf8');

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║                    CONFIGURATION SAVED                    ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    console.log('[OK] Log levels configured:\n');
    console.log(`   Console Level: ${consoleLevel.toUpperCase()} (terminal output)`);
    console.log(`   File Level:    ${fileLevel.toUpperCase()} (session history)`);
    console.log(`   Log File:      ~/.durandal-mcp/logs/durandal-YYYY-MM-DD.log\n`);
    console.log('💡 Restart the server for changes to take effect.\n');
    console.log('To change these settings later:\n');
    console.log('  1. Run: durandal-mcp --configure');
    console.log('  2. Edit: .env file');
    console.log('  3. Set env vars: CONSOLE_LOG_LEVEL and FILE_LOG_LEVEL\n');

    rl.close();
}

// Run CLI if executed directly
if (require.main === module) {
    DurandalMCPServer.cli().catch(error => {
        console.error('Failed to start MCP server:', error);
        process.exit(1);
    });
}

module.exports = DurandalMCPServer;