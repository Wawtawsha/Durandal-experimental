/**
 * Simplified SQLite Database Client for Durandal MCP Server
 *
 * Zero-configuration SQLite client with automatic schema setup.
 * Extracted from unified-db-client.js for MCP server simplicity.
 */

class MCPDatabaseClient {
    constructor() {
        this.client = null;
        this.initialized = false;

        // Determine database path with priority order
        this.dbPath = this.resolveDatabasePath();

        this.initializeSQLite();
    }

    /**
     * Resolves the database path with exhaustive search to prevent data loss
     * CRITICAL: This method will NEVER create a new database if ANY existing one is found
     *
     * Priority order:
     * 1. DATABASE_PATH environment variable (explicit override)
     * 2. Run full system discovery to find ALL databases
     * 3. Select database with most records (not just size)
     * 4. Only create new if absolutely NO databases found anywhere
     */
    resolveDatabasePath() {
        const path = require('path');
        const fs = require('fs');
        const sqlite3 = require('sqlite3').verbose();

        // Priority 1: Check for explicit override
        if (process.env.DATABASE_PATH) {
            process.stderr.write(`[DB] Using DATABASE_PATH from environment: ${process.env.DATABASE_PATH}\n`);
            return process.env.DATABASE_PATH;
        }

        process.stderr.write('[DB] No DATABASE_PATH set, searching for existing databases...\n');

        const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
        const durandalDir = path.join(homeDir, '.durandal-mcp');

        // Priority 2: Quick check of known locations first
        const quickCheckLocations = [
            // Check current directory first (legacy support)
            './durandal-mcp-memory.db',
            // Check home directory location
            path.join(durandalDir, 'durandal-mcp-memory.db'),
            // Check where script is installed
            path.join(__dirname, 'durandal-mcp-memory.db'),
            // Alternative names in current directory
            './durandal-memory.db',
            './memories.db'
        ];

        // Quick check for databases
        const quickDatabases = [];
        for (const location of quickCheckLocations) {
            if (fs.existsSync(location)) {
                const stats = fs.statSync(location);
                if (stats.isFile() && stats.size > 0) {
                    quickDatabases.push({
                        path: location,
                        size: stats.size,
                        isPreferred: location === path.join(durandalDir, 'durandal-mcp-memory.db')
                    });
                }
            }
        }

        // If we found any databases from the quick check, pick the largest one.
        // Sort by preferred location first, then by file size as a pragmatic proxy
        // for "most data" (accurate record count requires async sqlite open, which
        // we can't do in a constructor — leave that tool to `--discover`).
        if (quickDatabases.length > 0) {
            quickDatabases.sort((a, b) => {
                if (a.isPreferred !== b.isPreferred) return b.isPreferred ? 1 : -1;
                return b.size - a.size;
            });
            const selectedDb = quickDatabases[0];
            process.stderr.write(`[DB] Found existing database: ${selectedDb.path}\n`);
            if (quickDatabases.length > 1) {
                process.stderr.write(`[DB] WARNING: ${quickDatabases.length} candidate databases exist. Set DATABASE_PATH to disambiguate.\n`);
                for (const db of quickDatabases) {
                    process.stderr.write(`[DB]   - ${db.path} (${(db.size / 1024).toFixed(1)} KB)\n`);
                }
                process.stderr.write(`[DB] Run 'durandal-mcp --discover' for a full scan.\n`);
            }
            return selectedDb.path;
        }

        // No existing databases — create a fresh one in the canonical location.
        const newPath = path.join(durandalDir, 'durandal-mcp-memory.db');
        process.stderr.write(`[DB] No existing databases found. Creating new database at: ${newPath}\n`);

        if (!fs.existsSync(durandalDir)) {
            fs.mkdirSync(durandalDir, { recursive: true });
        }

        return newPath;
    }

    initializeSQLite() {
        const sqlite3 = require('sqlite3').verbose();

        process.stderr.write(`[DB] Using SQLite at ${this.dbPath}\n`);

        // Expose a ready promise so callers can await schema initialization
        this.ready = new Promise((resolve, reject) => {
            this.client = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    process.stderr.write(`[DB] SQLite connection error: ${err.message}\n`);
                    return reject(err);
                }
                this.initializeSQLiteSchema().then(resolve).catch(reject);
            });
        });
    }

    async initializeSQLiteSchema() {
        const schema = `
            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
            CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(json_extract(metadata, '$.project')) WHERE json_extract(metadata, '$.project') IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(json_extract(metadata, '$.session')) WHERE json_extract(metadata, '$.session') IS NOT NULL;
        `;

        return new Promise((resolve, reject) => {
            this.client.exec(schema, (err) => {
                if (err) {
                    process.stderr.write(`[DB] Schema init failed: ${err.message}\n`);
                    return reject(err);
                }
                this.initialized = true;
                process.stderr.write('[DB] Schema initialized\n');
                resolve();
            });
        });
    }

    async testConnection() {
        try {
            await this.ready;
        } catch (e) {
            return { success: false, error: e.message, type: 'sqlite' };
        }
        return new Promise((resolve) => {
            this.client.get('SELECT 1 as test', (err) => {
                if (err) {
                    resolve({ success: false, error: err.message, type: 'sqlite' });
                } else {
                    resolve({ success: true, message: 'SQLite connection successful', type: 'sqlite' });
                }
            });
        });
    }

    async query(sql, params = []) {
        await this.ready;
        return new Promise((resolve, reject) => {
            if (sql.trim().toLowerCase().startsWith('select')) {
                this.client.all(sql, params, (err, rows) => {
                    if (err) return reject(err);
                    resolve({ rows: rows || [] });
                });
            } else {
                this.client.run(sql, params, function(err) {
                    if (err) return reject(err);
                    resolve({ rows: [{ id: this.lastID }], rowCount: this.changes });
                });
            }
        });
    }

    async close() {
        try { await this.ready; } catch (_) { /* schema never inited — close anyway */ }
        if (!this.client) return;
        return new Promise((resolve) => {
            this.client.close((err) => {
                if (err) process.stderr.write(`[DB] Close error: ${err.message}\n`);
                resolve();
            });
        });
    }

    // Escape LIKE wildcards so user-provided queries don't match more than intended.
    // Uses backslash as the ESCAPE character (applied in SQL with ESCAPE '\').
    _escapeLike(s) {
        return s.replace(/[\\%_]/g, '\\$&');
    }

    async storeMemory(content, metadata = {}) {
        try {
            await this.ready;
            // Use sqlite's lastID (via run() callback) instead of RETURNING — some
            // node-sqlite3 builds don't expose rows from RETURNING in run() mode,
            // so we'd get an undefined id. lastID is always populated for INSERT.
            const result = await this.query(
                'INSERT INTO memories (content, metadata) VALUES (?, ?)',
                [content, JSON.stringify(metadata)]
            );
            return { success: true, id: result.rows[0].id };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Parse metadata from a DB row. Corrupt or externally-edited metadata
    // previously broke the whole result set because JSON.parse threw up the
    // outer try/catch and we returned [] for ALL rows. Now one bad row
    // degrades to empty-metadata for that row and keeps going.
    _parseRow(row) {
        let metadata = {};
        if (row.metadata) {
            try {
                metadata = JSON.parse(row.metadata);
                if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
                    metadata = {};
                }
            } catch (_) {
                metadata = { _corrupt: true };
            }
        }
        return { id: row.id, content: row.content, metadata, created_at: row.created_at };
    }

    async searchMemories(query, options = {}, limitArg) {
        try {
            await this.ready;
            // Accept limit from options OR positional 3rd arg (keeps db-adapter signature working).
            const limit = limitArg ?? options.limit ?? 10;
            const { project, session } = options;

            let sql = "SELECT id, content, metadata, created_at FROM memories WHERE content LIKE ? ESCAPE '\\'";
            const params = [`%${this._escapeLike(query)}%`];

            if (project) {
                sql += " AND json_extract(metadata, '$.project') = ?";
                params.push(project);
            }
            if (session) {
                sql += " AND json_extract(metadata, '$.session') = ?";
                params.push(session);
            }
            sql += ' ORDER BY created_at DESC LIMIT ?';
            params.push(limit);

            const result = await this.query(sql, params);
            return result.rows.map((row) => this._parseRow(row));
        } catch (error) {
            process.stderr.write(`[DB] searchMemories error: ${error.message}\n`);
            return [];
        }
    }

    async getRecentMemories(limit = 10, project = null, session = null) {
        try {
            await this.ready;
            let sql = 'SELECT id, content, metadata, created_at FROM memories';
            const params = [];
            const conditions = [];

            if (project) {
                conditions.push("json_extract(metadata, '$.project') = ?");
                params.push(project);
            }
            if (session) {
                conditions.push("json_extract(metadata, '$.session') = ?");
                params.push(session);
            }
            if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
            sql += ' ORDER BY created_at DESC LIMIT ?';
            params.push(limit);

            const result = await this.query(sql, params);
            return result.rows.map((row) => this._parseRow(row));
        } catch (error) {
            process.stderr.write(`[DB] getRecentMemories error: ${error.message}\n`);
            return [];
        }
    }

    async getMemoryById(id) {
        try {
            await this.ready;
            const result = await this.query(
                'SELECT id, content, metadata, created_at FROM memories WHERE id = ?',
                [id]
            );
            if (!result.rows.length) return null;
            return this._parseRow(result.rows[0]);
        } catch (error) {
            process.stderr.write(`[DB] getMemoryById error: ${error.message}\n`);
            return null;
        }
    }

    async deleteMemoryById(id) {
        try {
            await this.ready;
            const result = await this.query('DELETE FROM memories WHERE id = ?', [id]);
            return { success: true, changes: result.rowCount || 0 };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

module.exports = MCPDatabaseClient;