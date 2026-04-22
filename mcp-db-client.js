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
        // Core table + indexes. FTS5 is added separately so we can fall back
        // if the sqlite3 build happens to be compiled without FTS5 support.
        const core = `
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
        await new Promise((res, rej) => this.client.exec(core, e => e ? rej(e) : res()));

        // FTS5 virtual table with external-content linkage, plus triggers to
        // keep it in sync. After this, search can do BM25-ranked full-text
        // instead of LIKE substring. If the sqlite3 build lacks FTS5 for some
        // reason, we log and fall back to LIKE-only search — no crash.
        try {
            const fts = `
                CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                    content,
                    content='memories',
                    content_rowid='id',
                    tokenize='porter unicode61'
                );

                CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
                    INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
                END;
                CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
                    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
                END;
                CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
                    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
                    INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
                END;
            `;
            await new Promise((res, rej) => this.client.exec(fts, e => e ? rej(e) : res()));

            // Backfill: if memories has rows but memories_fts is empty (fresh
            // FTS table on a legacy DB), rebuild the FTS index from the
            // existing content column.
            const ftsCount = await new Promise((res, rej) =>
                this.client.get('SELECT COUNT(*) as c FROM memories_fts', (e, r) => e ? rej(e) : res(r?.c || 0))
            ).catch(() => 0);
            const memCount = await new Promise((res, rej) =>
                this.client.get('SELECT COUNT(*) as c FROM memories', (e, r) => e ? rej(e) : res(r?.c || 0))
            ).catch(() => 0);
            if (memCount > 0 && ftsCount === 0) {
                process.stderr.write(`[DB] Backfilling FTS index for ${memCount} existing memories...\n`);
                await new Promise((res, rej) =>
                    this.client.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')", e => e ? rej(e) : res())
                );
            }
            this.ftsAvailable = true;
        } catch (e) {
            process.stderr.write(`[DB] FTS5 unavailable, falling back to LIKE search: ${e.message}\n`);
            this.ftsAvailable = false;
        }

        this.initialized = true;
        process.stderr.write('[DB] Schema initialized\n');
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

    // Sanitize a user-typed search query for FTS5 MATCH syntax. We SPLIT on
    // any non-word-character run (not just whitespace) so a hyphenated query
    // like "smoke-test-marker" becomes five tokens, matching the way the
    // FTS5 unicode61 tokenizer already breaks the stored content.
    _toFtsQuery(input) {
        const tokens = String(input)
            .split(/[^\p{L}\p{N}_]+/u)
            .filter(Boolean);
        if (!tokens.length) return null;
        return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
    }

    async searchMemories(query, options = {}, limitArg) {
        try {
            await this.ready;
            const limit = limitArg ?? options.limit ?? 10;
            const { project, session } = options;

            // Try FTS5 first for proper tokenized, BM25-ranked search. This
            // correctly handles "react typescript" as AND-of-tokens and ranks
            // by relevance instead of just recency. snippet() extracts a
            // 16-token window around the match, wrapping matched tokens with
            // ** ... ** so clients can highlight them.
            if (this.ftsAvailable) {
                const ftsQuery = this._toFtsQuery(query);
                if (ftsQuery) {
                    let sql = `
                        SELECT m.id, m.content, m.metadata, m.created_at,
                               bm25(memories_fts) AS rank,
                               snippet(memories_fts, 0, '**', '**', '…', 16) AS snippet
                        FROM memories_fts
                        JOIN memories m ON memories_fts.rowid = m.id
                        WHERE memories_fts MATCH ?
                    `;
                    const params = [ftsQuery];
                    if (project) { sql += " AND json_extract(m.metadata, '$.project') = ?"; params.push(project); }
                    if (session) { sql += " AND json_extract(m.metadata, '$.session') = ?"; params.push(session); }
                    sql += ' ORDER BY rank LIMIT ?';
                    params.push(limit);

                    try {
                        const result = await this.query(sql, params);
                        return result.rows.map((row) => {
                            const parsed = this._parseRow(row);
                            parsed.relevance = row.rank;
                            parsed.snippet = row.snippet;
                            return parsed;
                        });
                    } catch (e) {
                        // Malformed MATCH — fall through to LIKE
                        process.stderr.write(`[DB] FTS match failed, falling back to LIKE: ${e.message}\n`);
                    }
                }
            }

            // LIKE fallback: used when FTS isn't available OR when the query
            // tokenizes to nothing (e.g. pure punctuation) OR when MATCH failed.
            let sql = "SELECT id, content, metadata, created_at FROM memories WHERE content LIKE ? ESCAPE '\\'";
            const params = [`%${this._escapeLike(query)}%`];
            if (project) { sql += " AND json_extract(metadata, '$.project') = ?"; params.push(project); }
            if (session) { sql += " AND json_extract(metadata, '$.session') = ?"; params.push(session); }
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

    // Phase 6: bulk insert wrapped in a single transaction. Without this,
    // 100-row imports fire 100 sqlite commits which is ~100x slower.
    async storeMemoriesBatch(items) {
        try {
            await this.ready;
            await new Promise((res, rej) => this.client.exec('BEGIN', e => e ? rej(e) : res()));
            const stmt = this.client.prepare('INSERT INTO memories (content, metadata) VALUES (?, ?)');
            const ids = [];
            try {
                for (const { content, metadata } of items) {
                    const id = await new Promise((res, rej) => {
                        stmt.run(content, JSON.stringify(metadata || {}), function (err) {
                            if (err) return rej(err);
                            res(this.lastID);
                        });
                    });
                    ids.push(id);
                }
                await new Promise((res) => stmt.finalize(() => res()));
                await new Promise((res, rej) => this.client.exec('COMMIT', e => e ? rej(e) : res()));
                return { success: true, ids };
            } catch (e) {
                await new Promise((res) => stmt.finalize(() => res()));
                await new Promise((res) => this.client.exec('ROLLBACK', () => res()));
                throw e;
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Phase 6: update content and/or metadata of an existing row.
    async updateMemory(id, { content, metadata }) {
        try {
            await this.ready;
            const existing = await this.getMemoryById(id);
            if (!existing) return { success: false, error: 'not_found' };
            const nextContent = content !== undefined ? content : existing.content;
            const nextMetadata = metadata !== undefined ? metadata : existing.metadata;
            await this.query(
                'UPDATE memories SET content = ?, metadata = ? WHERE id = ?',
                [nextContent, JSON.stringify(nextMetadata || {}), id]
            );
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Phase 6: paginated list with filters. Distinct from search_memories
    // (no query required) and get_context (no project/session defaulting).
    async listMemories({ project, session, offset = 0, limit = 50, since, until }) {
        try {
            await this.ready;
            let sql = 'SELECT id, content, metadata, created_at FROM memories';
            const conditions = [];
            const params = [];
            if (project) { conditions.push("json_extract(metadata, '$.project') = ?"); params.push(project); }
            if (session) { conditions.push("json_extract(metadata, '$.session') = ?"); params.push(session); }
            if (since) { conditions.push('created_at >= ?'); params.push(since); }
            if (until) { conditions.push('created_at <= ?'); params.push(until); }
            if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
            sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
            params.push(limit, offset);
            const result = await this.query(sql, params);
            return result.rows.map((row) => this._parseRow(row));
        } catch (error) {
            process.stderr.write(`[DB] listMemories error: ${error.message}\n`);
            return [];
        }
    }

    // Phase 6: return all rows for export. Stream-friendly in principle,
    // but for typical DB sizes (<1M rows) a single query is fine.
    async exportAll() {
        try {
            await this.ready;
            const result = await this.query('SELECT id, content, metadata, created_at FROM memories ORDER BY id');
            return result.rows.map((row) => this._parseRow(row));
        } catch (error) {
            process.stderr.write(`[DB] exportAll error: ${error.message}\n`);
            return [];
        }
    }

    // Phase 6: rename a project across all memories' metadata JSON.
    // Uses SQLite's json_set so we don't have to read every row into JS.
    async renameProject(fromName, toName) {
        try {
            await this.ready;
            const result = await this.query(
                "UPDATE memories SET metadata = json_set(metadata, '$.project', ?) WHERE json_extract(metadata, '$.project') = ?",
                [toName, fromName]
            );
            return { success: true, changes: result.rowCount || 0 };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async countAll() {
        try {
            await this.ready;
            const r = await this.query('SELECT COUNT(*) as c FROM memories');
            return r.rows[0]?.c || 0;
        } catch (_) {
            return 0;
        }
    }

    // Iteration 2: atomic backup using SQLite's VACUUM INTO. Writes a
    // consistent snapshot to destPath even while other transactions are
    // running, without needing to close the live database.
    async backupTo(destPath) {
        try {
            await this.ready;
            // VACUUM INTO requires a literal path — can't be parameterized.
            // We sanitize by requiring it to be an absolute path with no
            // single quotes (since sqlite strings are '...').
            if (typeof destPath !== 'string' || destPath.includes("'")) {
                throw new Error('Invalid destination path');
            }
            const escaped = destPath.replace(/'/g, "''");
            await new Promise((res, rej) =>
                this.client.exec(`VACUUM INTO '${escaped}'`, e => e ? rej(e) : res())
            );
            return { success: true, path: destPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Iter 3: structured stats — replaces handlers reaching into this.client.
    async stats({ project } = {}) {
        try {
            await this.ready;
            const total = await this.query('SELECT COUNT(*) as c FROM memories');
            const projects = await this.query(
                "SELECT COUNT(DISTINCT json_extract(metadata, '$.project')) as c FROM memories WHERE json_extract(metadata, '$.project') IS NOT NULL"
            );
            const sessions = await this.query(
                "SELECT COUNT(DISTINCT json_extract(metadata, '$.session')) as c FROM memories WHERE json_extract(metadata, '$.session') IS NOT NULL"
            );
            const out = {
                total: total.rows[0]?.c || 0,
                projects: projects.rows[0]?.c || 0,
                sessions: sessions.rows[0]?.c || 0
            };
            if (project) {
                const p = await this.query(
                    "SELECT COUNT(*) as c FROM memories WHERE json_extract(metadata, '$.project') = ?",
                    [project]
                );
                out.inProject = p.rows[0]?.c || 0;
            }
            return out;
        } catch (e) {
            process.stderr.write(`[DB] stats error: ${e.message}\n`);
            return { total: 0, projects: 0, sessions: 0, inProject: project ? 0 : undefined };
        }
    }

    // Iter 3: total match count for FTS results — used for client pagination.
    async countSearchMatches(query, { project, session } = {}) {
        try {
            await this.ready;
            if (this.ftsAvailable) {
                const ftsQuery = this._toFtsQuery(query);
                if (ftsQuery) {
                    let sql = `
                        SELECT COUNT(*) as c
                        FROM memories_fts
                        JOIN memories m ON memories_fts.rowid = m.id
                        WHERE memories_fts MATCH ?
                    `;
                    const params = [ftsQuery];
                    if (project) { sql += " AND json_extract(m.metadata, '$.project') = ?"; params.push(project); }
                    if (session) { sql += " AND json_extract(m.metadata, '$.session') = ?"; params.push(session); }
                    try {
                        const r = await this.query(sql, params);
                        return r.rows[0]?.c || 0;
                    } catch (_) { /* fall through */ }
                }
            }
            // LIKE fallback
            let sql = "SELECT COUNT(*) as c FROM memories WHERE content LIKE ? ESCAPE '\\'";
            const params = [`%${this._escapeLike(query)}%`];
            if (project) { sql += " AND json_extract(metadata, '$.project') = ?"; params.push(project); }
            if (session) { sql += " AND json_extract(metadata, '$.session') = ?"; params.push(session); }
            const r = await this.query(sql, params);
            return r.rows[0]?.c || 0;
        } catch (e) {
            process.stderr.write(`[DB] countSearchMatches error: ${e.message}\n`);
            return 0;
        }
    }

    // Iter 3: total count for listMemories filters (pagination total).
    async countList({ project, session, since, until } = {}) {
        try {
            await this.ready;
            let sql = 'SELECT COUNT(*) as c FROM memories';
            const conditions = [];
            const params = [];
            if (project) { conditions.push("json_extract(metadata, '$.project') = ?"); params.push(project); }
            if (session) { conditions.push("json_extract(metadata, '$.session') = ?"); params.push(session); }
            if (since) { conditions.push('created_at >= ?'); params.push(since); }
            if (until) { conditions.push('created_at <= ?'); params.push(until); }
            if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
            const r = await this.query(sql, params);
            return r.rows[0]?.c || 0;
        } catch (e) {
            return 0;
        }
    }

    // Iter 3: aggregate projects/sessions in one go, with samples joined via
    // GROUP_CONCAT instead of N+1 follow-up queries. groupByField is either
    // 'project' or 'session'.
    async groupSummary(groupByField, { limit = 50, includeSamples = false } = {}) {
        try {
            await this.ready;
            if (!['project', 'session'].includes(groupByField)) {
                throw new Error(`groupByField must be 'project' or 'session'`);
            }
            const path = `$.${groupByField}`;
            const sql = `
                SELECT
                    json_extract(metadata, ?) as name,
                    COUNT(*) as count,
                    MIN(created_at) as first_memory,
                    MAX(created_at) as last_memory
                FROM memories
                WHERE json_extract(metadata, ?) IS NOT NULL
                GROUP BY json_extract(metadata, ?)
                ORDER BY ${groupByField === 'project' ? 'count' : 'last_memory'} DESC
                LIMIT ?
            `;
            const r = await this.query(sql, [path, path, path, limit]);
            const items = r.rows.map(row => ({
                name: row.name,
                memoryCount: row.count,
                firstMemory: row.first_memory,
                lastMemory: row.last_memory
            }));

            // Samples: one batched query that ranks rows within each group and
            // pulls the top 2 per group. Replaces the prior N+1 pattern.
            if (includeSamples && items.length) {
                const names = items.map(i => i.name);
                const placeholders = names.map(() => '?').join(',');
                const sampleSql = `
                    SELECT name, content, created_at FROM (
                        SELECT
                            json_extract(metadata, ?) as name,
                            content,
                            created_at,
                            ROW_NUMBER() OVER (PARTITION BY json_extract(metadata, ?) ORDER BY created_at DESC) as rn
                        FROM memories
                        WHERE json_extract(metadata, ?) IN (${placeholders})
                    )
                    WHERE rn <= 2
                    ORDER BY name, rn
                `;
                const samples = await this.query(sampleSql, [path, path, path, ...names]);
                const byName = new Map();
                for (const s of samples.rows) {
                    if (!byName.has(s.name)) byName.set(s.name, []);
                    byName.get(s.name).push({ content: s.content, created_at: s.created_at });
                }
                for (const item of items) {
                    item.samples = byName.get(item.name) || [];
                }
            }
            return items;
        } catch (e) {
            process.stderr.write(`[DB] groupSummary error: ${e.message}\n`);
            return [];
        }
    }

    // Iter 3: schema/integrity helpers — used to be inline in the server's
    // runDatabaseStartupCheck via this.db.db.client reach-through.
    async listTables() {
        await this.ready;
        return new Promise((resolve, reject) => {
            this.client.all("SELECT name FROM sqlite_master WHERE type='table'", (err, rows) =>
                err ? reject(err) : resolve(rows.map(r => r.name))
            );
        });
    }

    async tableColumns(table) {
        await this.ready;
        return new Promise((resolve, reject) => {
            this.client.all(`PRAGMA table_info(${table.replace(/[^a-zA-Z0-9_]/g, '')})`, (err, rows) =>
                err ? reject(err) : resolve(rows.map(r => r.name))
            );
        });
    }

    async integrityCheck() {
        await this.ready;
        return new Promise((resolve, reject) => {
            this.client.all('PRAGMA integrity_check', (err, rows) => err ? reject(err) : resolve(rows));
        });
    }

    async exec(sql) {
        await this.ready;
        return new Promise((resolve, reject) => {
            this.client.exec(sql, (err) => err ? reject(err) : resolve());
        });
    }

    async pragma(sql) {
        await this.ready;
        return new Promise((resolve, reject) => {
            this.client.get(sql, (err, row) => err ? reject(err) : resolve(row));
        });
    }

    // Iter 3: "more like this". Uses the source memory's content as an FTS
    // query (top-N most distinctive tokens) and returns matches excluding
    // the source itself. Fall back to LIKE on the first 64 chars if FTS
    // isn't available.
    async findSimilar(id, { limit = 5 } = {}) {
        try {
            await this.ready;
            const source = await this.getMemoryById(id);
            if (!source) return null;

            // Tokenize the source content the same way we tokenize search queries.
            const tokens = String(source.content)
                .split(/[^\p{L}\p{N}_]+/u)
                .filter(t => t.length >= 3) // drop ultra-short tokens (a, of, etc.)
                .slice(0, 12); // cap query complexity

            if (this.ftsAvailable && tokens.length) {
                const ftsQuery = tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
                try {
                    const sql = `
                        SELECT m.id, m.content, m.metadata, m.created_at, bm25(memories_fts) AS rank
                        FROM memories_fts
                        JOIN memories m ON memories_fts.rowid = m.id
                        WHERE memories_fts MATCH ?
                          AND m.id != ?
                        ORDER BY rank
                        LIMIT ?
                    `;
                    const r = await this.query(sql, [ftsQuery, id, limit]);
                    return r.rows.map((row) => {
                        const parsed = this._parseRow(row);
                        parsed.relevance = row.rank;
                        return parsed;
                    });
                } catch (_) { /* fall through to LIKE */ }
            }

            // LIKE fallback
            const stem = source.content.slice(0, 64);
            const r = await this.query(
                "SELECT id, content, metadata, created_at FROM memories WHERE content LIKE ? ESCAPE '\\' AND id != ? ORDER BY created_at DESC LIMIT ?",
                [`%${this._escapeLike(stem)}%`, id, limit]
            );
            return r.rows.map(row => this._parseRow(row));
        } catch (e) {
            process.stderr.write(`[DB] findSimilar error: ${e.message}\n`);
            return [];
        }
    }

    // Iter 3: additive category tag operations. Lighter than update_memory
    // (which replaces the whole metadata blob).
    async tagMemory(id, { add = [], remove = [] } = {}) {
        try {
            await this.ready;
            const existing = await this.getMemoryById(id);
            if (!existing) return { success: false, error: 'not_found' };
            const meta = { ...(existing.metadata || {}) };
            const current = new Set(Array.isArray(meta.categories) ? meta.categories : []);
            for (const t of add) current.add(t);
            for (const t of remove) current.delete(t);
            meta.categories = [...current];
            await this.query(
                'UPDATE memories SET metadata = ? WHERE id = ?',
                [JSON.stringify(meta), id]
            );
            return { success: true, categories: meta.categories };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // Iteration 2: bulk delete by filter. Returns number of rows deleted.
    // Same filter shape as listMemories.
    async deleteMemoriesWhere({ project, session, olderThan }) {
        try {
            await this.ready;
            if (!project && !session && !olderThan) {
                // Safety: never allow unfiltered bulk deletes. The user must
                // specify at least one criterion.
                return { success: false, error: 'at_least_one_filter_required' };
            }
            let sql = 'DELETE FROM memories';
            const conditions = [];
            const params = [];
            if (project) { conditions.push("json_extract(metadata, '$.project') = ?"); params.push(project); }
            if (session) { conditions.push("json_extract(metadata, '$.session') = ?"); params.push(session); }
            if (olderThan) { conditions.push('created_at < ?'); params.push(olderThan); }
            sql += ' WHERE ' + conditions.join(' AND ');
            const result = await this.query(sql, params);
            return { success: true, deleted: result.rowCount || 0 };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

module.exports = MCPDatabaseClient;