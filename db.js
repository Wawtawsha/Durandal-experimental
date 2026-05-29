/**
 * Durandal MemoryDB — SQLite storage with hybrid retrieval and write-time consolidation.
 *
 * One SQLite file holds three things:
 *   - memories       : the source of truth (id, content, metadata JSON, timestamps, superseded_by)
 *   - memories_fts   : FTS5 external-content index for lexical BM25 search
 *   - vec_memories   : sqlite-vec vec0 table of 384-d embeddings for semantic search
 *
 * Retrieval is HYBRID: lexical (BM25) and semantic (cosine KNN) candidate lists
 * are fused with Reciprocal Rank Fusion. Lexical nails exact tokens (identifiers,
 * error strings, paths); semantic catches paraphrase ("build broken" ~ "compilation
 * failing"). Fusing both is the modern standard and beats either alone.
 *
 * Write-time CONSOLIDATION ("selective attention"): when a new memory is a near
 * duplicate of an existing one (cosine distance below a conservative threshold),
 * the older one is marked superseded and dropped from default results — but never
 * deleted, so nothing is lost and the action is reported back to the caller.
 *
 * GRACEFUL DEGRADATION is a hard invariant: if sqlite-vec won't load or the
 * embedding model is unavailable, every semantic path short-circuits and the
 * server behaves exactly like a pure FTS5/BM25 store. v4 is never worse than v3.
 *
 * better-sqlite3 is synchronous, so pure-DB methods are sync; only methods that
 * touch the (async) embedder are async. better-sqlite3 transactions MUST be
 * synchronous, so embeddings are always computed BEFORE opening a transaction.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Embedder, EMBED_DIM } = require('./embeddings');

// --- tuning constants (all overridable via env) -----------------------------

// Candidate pool size per signal before fusion. Small DBs: this is plenty.
const POOL = Number(process.env.DURANDAL_SEARCH_POOL) || 50;
// Reciprocal Rank Fusion constant. 60 is the value from the original RRF paper.
const RRF_K = Number(process.env.DURANDAL_RRF_K) || 60;
// Cosine distance (1 - cosine similarity) at/below which a new memory is treated
// as a near-duplicate of an existing one. 0.08 => cosine similarity >= 0.92, i.e.
// "essentially restating the same thing." Deliberately conservative — superseding
// is reversible (nothing is deleted) but should still only fire on clear restatements.
const NEAR_DUP_DISTANCE = Number(process.env.DURANDAL_DEDUP_DISTANCE) || 0.08;
// Minimum cosine similarity for a semantic (vector) hit to count as a real match
// during search. Vector KNN always returns *a* nearest neighbour, so without a
// floor a small store would return everything ranked. 0.35 keeps genuine
// paraphrases ("build broken" ~ "compilation failing" ≈ 0.51) and drops noise.
const SEMANTIC_MIN_SIM = Number(process.env.DURANDAL_SEMANTIC_MIN_SIM) || 0.35;
// RRF scores within this absolute epsilon are treated as a tie and broken by
// importance, then recency.
const TIE_EPSILON = 1e-4;

// --- small pure helpers ------------------------------------------------------

const round = (n, d = 6) => Number(Number(n).toFixed(d));

// Pack a Float32Array into the little-endian blob sqlite-vec expects.
// (Bind as a Buffer — better-sqlite3 does not reliably bind a raw Float32Array.)
const toBlob = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);

// Escape LIKE wildcards so user queries can't widen the match (ESCAPE '\' in SQL).
const escapeLike = (s) => String(s).replace(/[\\%_]/g, '\\$&');

// Tokenize a user query for FTS5 MATCH: split on non-word runs, quote each token,
// AND-join. Returns null if nothing tokenizable remains (caller falls back).
function toFtsQuery(input) {
    const tokens = String(input).split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
    if (!tokens.length) return null;
    return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}

// Reciprocal Rank Fusion. lists = array of id-arrays (each pre-ranked best-first).
// Returns [[id, score], ...] sorted by fused score descending. With a single
// non-empty list this reduces to that list's original order.
function rrfFuse(lists, K = RRF_K) {
    const scores = new Map();
    for (const list of lists) {
        list.forEach((id, i) => scores.set(id, (scores.get(id) || 0) + 1 / (K + i + 1)));
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

class MemoryDB {
    constructor(opts = {}) {
        this.dbPath = opts.dbPath || process.env.DATABASE_PATH || this.resolveDatabasePath();
        this.embedder = opts.embedder || new Embedder({ cacheDir: this._modelCacheDir() });
        this.ftsAvailable = false;
        this.vecAvailable = false;
        this._open();
        // Compat: the server awaits nothing on the db directly, but keep a
        // resolved ready promise so any `await db.ready` is harmless.
        this.ready = Promise.resolve();
    }

    // -------------------------------------------------------------------------
    // Path resolution (ported from v3 — never silently create a new DB when an
    // existing one can be found; that would orphan the user's memories).
    // -------------------------------------------------------------------------

    resolveDatabasePath() {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
        const durandalDir = path.join(homeDir, '.durandal-mcp');

        const candidates = [
            './durandal-mcp-memory.db',
            path.join(durandalDir, 'durandal-mcp-memory.db'),
            path.join(__dirname, 'durandal-mcp-memory.db'),
            './durandal-memory.db',
            './memories.db'
        ];
        const found = [];
        for (const loc of candidates) {
            try {
                const st = fs.statSync(loc);
                if (st.isFile() && st.size > 0) {
                    found.push({ path: loc, size: st.size, preferred: loc === path.join(durandalDir, 'durandal-mcp-memory.db') });
                }
            } catch (_) { /* not present */ }
        }
        if (found.length) {
            found.sort((a, b) => (a.preferred !== b.preferred ? (b.preferred ? 1 : -1) : b.size - a.size));
            if (found.length > 1) {
                process.stderr.write(`[DB] ${found.length} candidate databases found; using ${found[0].path}. Set DATABASE_PATH to disambiguate.\n`);
            }
            return found[0].path;
        }
        if (!fs.existsSync(durandalDir)) fs.mkdirSync(durandalDir, { recursive: true });
        return path.join(durandalDir, 'durandal-mcp-memory.db');
    }

    _modelCacheDir() {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
        return path.join(homeDir, '.durandal-mcp', '.model-cache');
    }

    // -------------------------------------------------------------------------
    // Open + schema
    // -------------------------------------------------------------------------

    _open() {
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');

        // sqlite-vec is optional. If it won't load we keep running as an FTS-only
        // store (the v3 floor) rather than failing.
        try {
            const sqliteVec = require('sqlite-vec');
            sqliteVec.load(this.db);
            this.db.prepare('SELECT vec_version()').get(); // prove it registered
            this.vecAvailable = true;
        } catch (e) {
            process.stderr.write(`[DB] sqlite-vec unavailable, semantic search disabled: ${e.message}\n`);
            this.vecAvailable = false;
        }

        this._initCore();
        this._migrate();
        this._initFts();
        if (this.vecAvailable) this._initVec();

        process.stderr.write(`[DB] ready at ${this.dbPath} (fts=${this.ftsAvailable}, vec=${this.vecAvailable})\n`);
    }

    _initCore() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME,
                superseded_by INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
            CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by);
            CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(json_extract(metadata, '$.project')) WHERE json_extract(metadata, '$.project') IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(json_extract(metadata, '$.session')) WHERE json_extract(metadata, '$.session') IS NOT NULL;
        `);
    }

    // Non-destructive migration for pre-v4 databases (which only had
    // id/content/metadata/created_at). Adds the new columns if absent.
    _migrate() {
        const cols = this.db.prepare(`PRAGMA table_info(memories)`).all().map(c => c.name);
        if (!cols.includes('updated_at')) {
            try { this.db.exec(`ALTER TABLE memories ADD COLUMN updated_at DATETIME`); } catch (_) {}
        }
        if (!cols.includes('superseded_by')) {
            try { this.db.exec(`ALTER TABLE memories ADD COLUMN superseded_by INTEGER`); } catch (_) {}
        }
    }

    _initFts() {
        try {
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                    content, content='memories', content_rowid='id', tokenize='porter unicode61'
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
            `);
            // Backfill FTS for a legacy DB whose rows predate the index.
            const ftsCount = this.db.prepare('SELECT COUNT(*) AS c FROM memories_fts').get().c;
            const memCount = this.db.prepare('SELECT COUNT(*) AS c FROM memories').get().c;
            if (memCount > 0 && ftsCount === 0) {
                process.stderr.write(`[DB] Backfilling FTS index for ${memCount} memories...\n`);
                this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
            }
            this.ftsAvailable = true;
        } catch (e) {
            process.stderr.write(`[DB] FTS5 unavailable, using LIKE search: ${e.message}\n`);
            this.ftsAvailable = false;
        }
    }

    _initVec() {
        try {
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
                    memory_id INTEGER PRIMARY KEY,
                    embedding FLOAT[${EMBED_DIM}] distance_metric=cosine,
                    project TEXT
                );
            `);
        } catch (e) {
            process.stderr.write(`[DB] vec table init failed, semantic search disabled: ${e.message}\n`);
            this.vecAvailable = false;
        }
    }

    // -------------------------------------------------------------------------
    // Row parsing + filter building
    // -------------------------------------------------------------------------

    _parseRow(row) {
        let metadata = {};
        if (row.metadata) {
            try {
                metadata = JSON.parse(row.metadata);
                if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) metadata = {};
            } catch (_) {
                metadata = { _corrupt: true };
            }
        }
        return { id: row.id, content: row.content, metadata, created_at: row.created_at };
    }

    _project(metadata) {
        if (typeof metadata === 'string') {
            try { metadata = JSON.parse(metadata); } catch (_) { return 'default'; }
        }
        return (metadata && metadata.project) || 'default';
    }

    // Build a metadata-filter SQL fragment shared by search/count/list/fetch.
    // alias is the table/alias the metadata column lives on.
    _filterClause(filters = {}, alias = 'm') {
        const parts = [];
        const params = [];
        const j = (p) => `json_extract(${alias}.metadata, '${p}')`;
        if (filters.project) { parts.push(`${j('$.project')} = ?`); params.push(filters.project); }
        if (filters.session) { parts.push(`${j('$.session')} = ?`); params.push(filters.session); }
        if (filters.importance_min !== undefined) {
            parts.push(`COALESCE(CAST(${j('$.importance')} AS REAL), 0) >= ?`); params.push(filters.importance_min);
        }
        if (filters.importance_max !== undefined) {
            parts.push(`COALESCE(CAST(${j('$.importance')} AS REAL), 0) <= ?`); params.push(filters.importance_max);
        }
        if (Array.isArray(filters.categories) && filters.categories.length) {
            const ph = filters.categories.map(() => '?').join(',');
            parts.push(`EXISTS (SELECT 1 FROM json_each(${j('$.categories')}) WHERE value IN (${ph}))`);
            params.push(...filters.categories);
        }
        return { clause: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
    }

    // -------------------------------------------------------------------------
    // Write path: store (+ embed + consolidate)
    // -------------------------------------------------------------------------

    async storeMemory(content, metadata = {}) {
        try {
            const project = this._project(metadata);
            // Embed BEFORE the transaction (better-sqlite3 txns must be sync).
            const embedding = this.embedder.available ? await this.embedder.embed(content) : null;

            let supersededId = null;
            const tx = this.db.transaction(() => {
                const info = this.db.prepare(
                    'INSERT INTO memories (content, metadata, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
                ).run(content, JSON.stringify(metadata));
                const id = Number(info.lastInsertRowid);

                if (embedding && this.vecAvailable) {
                    this.db.prepare('INSERT INTO vec_memories(memory_id, embedding, project) VALUES (?, ?, ?)')
                        .run(BigInt(id), toBlob(embedding), project);

                    // Consolidation: supersede the nearest active same-project memory
                    // if it's a near-duplicate. Reversible — we only set a flag.
                    const near = this._nearestActive(embedding, project, id);
                    if (near && near.distance <= NEAR_DUP_DISTANCE) {
                        this.db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(id, near.id);
                        supersededId = near.id;
                    }
                }
                return id;
            });
            const id = tx();
            return { success: true, id, supersededId };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Nearest active, same-project memory to a query embedding, excluding excludeId.
    // Over-fetches candidates (superseded rows keep their vectors) and skips
    // superseded ones, so a supersede-heavy project doesn't blind consolidation.
    _nearestActive(embedding, project, excludeId) {
        if (!this.vecAvailable) return null;
        let sql = 'SELECT memory_id, distance FROM vec_memories WHERE embedding MATCH ? AND k = ?';
        const params = [toBlob(embedding), 20];
        if (project) { sql += ' AND project = ?'; params.push(project); }
        sql += ' ORDER BY distance';
        const rows = this.db.prepare(sql).all(...params);
        for (const r of rows) {
            const mid = Number(r.memory_id);
            if (mid === excludeId) continue;
            const active = this.db.prepare('SELECT 1 FROM memories WHERE id = ? AND superseded_by IS NULL').get(mid);
            if (active) return { id: mid, distance: r.distance };
        }
        return null;
    }

    // Bulk insert in one transaction. Embeds the whole batch up front. Skips
    // consolidation (bulk import is not where dedup is expected) for speed.
    async storeMemoriesBatch(items) {
        try {
            const vectors = this.embedder.available
                ? await this.embedder.embedBatch(items.map(it => it.content))
                : items.map(() => null);

            const tx = this.db.transaction(() => {
                const insMem = this.db.prepare('INSERT INTO memories (content, metadata, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)');
                const insVec = this.vecAvailable
                    ? this.db.prepare('INSERT INTO vec_memories(memory_id, embedding, project) VALUES (?, ?, ?)')
                    : null;
                const ids = [];
                items.forEach((it, i) => {
                    const info = insMem.run(it.content, JSON.stringify(it.metadata || {}));
                    const id = Number(info.lastInsertRowid);
                    ids.push(id);
                    if (insVec && vectors[i]) {
                        insVec.run(BigInt(id), toBlob(vectors[i]), this._project(it.metadata));
                    }
                });
                return ids;
            });
            return { success: true, ids: tx() };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async updateMemory(id, { content, metadata }) {
        try {
            const existing = this.getMemoryById(id);
            if (!existing) return { success: false, error: 'not_found' };

            const nextContent = content !== undefined ? content : existing.content;
            const nextMetadata = metadata !== undefined ? metadata : existing.metadata;
            const contentChanged = content !== undefined && content !== existing.content;
            const embedding = (contentChanged && this.embedder.available)
                ? await this.embedder.embed(nextContent)
                : null;

            const newProject = this._project(nextMetadata);
            const projectChanged = newProject !== this._project(existing.metadata);
            const tx = this.db.transaction(() => {
                this.db.prepare('UPDATE memories SET content = ?, metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                    .run(nextContent, JSON.stringify(nextMetadata || {}), id);
                if (contentChanged && this.vecAvailable && embedding) {
                    this.db.prepare('DELETE FROM vec_memories WHERE memory_id = ?').run(BigInt(id));
                    this.db.prepare('INSERT INTO vec_memories(memory_id, embedding, project) VALUES (?, ?, ?)')
                        .run(BigInt(id), toBlob(embedding), newProject);
                } else if (projectChanged && this.vecAvailable) {
                    // Keep the vec project column in sync so project-filtered KNN stays correct.
                    try { this.db.prepare('UPDATE vec_memories SET project = ? WHERE memory_id = ?').run(newProject, BigInt(id)); } catch (_) {}
                }
            });
            tx();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // -------------------------------------------------------------------------
    // Read path: hybrid search
    // -------------------------------------------------------------------------

    // Returns { results: [...], total }. total = lexical (FTS) matches passing
    // the filters — well-defined for pagination. Semantic neighbours can surface
    // additional related items within the returned window.
    async searchMemories(query, opts = {}) {
        try {
            const limit = opts.limit ?? 10;
            const filters = {
                project: opts.project, session: opts.session, categories: opts.categories,
                importance_min: opts.importance_min, importance_max: opts.importance_max
            };

            const total = this._countMatches(query, filters);

            const ftsRows = this.ftsAvailable ? this._ftsSearch(query, filters, POOL) : null;
            let vecHits = [];
            if (this.embedder.available && this.vecAvailable) {
                const qv = await this.embedder.embed(query);
                if (qv) {
                    const maxDist = 1 - SEMANTIC_MIN_SIM;
                    vecHits = this._vectorSearch(qv, POOL, filters.project).filter(h => h.distance <= maxDist);
                }
            }

            // Neither signal produced candidates -> LIKE fallback (e.g. punctuation
            // query with no embeddings).
            if ((!ftsRows || !ftsRows.length) && !vecHits.length) {
                const like = this._likeSearch(query, filters, limit);
                return { results: like, total: total || like.length };
            }

            const ftsIds = (ftsRows || []).map(r => r.id);
            const vecIds = vecHits.map(h => h.id);
            const fused = rrfFuse([ftsIds, vecIds].filter(l => l.length));

            const candidateIds = fused.map(([id]) => id).slice(0, Math.max(limit * 3, POOL));
            const rowsById = this._fetchActiveByIds(candidateIds, filters);

            const snippetById = new Map((ftsRows || []).map(r => [r.id, r.snippet]));
            const distById = new Map(vecHits.map(h => [h.id, h.distance]));
            const ftsSet = new Set(ftsIds);
            const vecSet = new Set(vecIds);

            const ranked = [];
            for (const [id, score] of fused) {
                const row = rowsById.get(id);
                if (!row) continue; // filtered out or superseded
                const signals = [];
                if (ftsSet.has(id)) signals.push('lexical');
                if (vecSet.has(id)) signals.push('semantic');
                ranked.push({
                    ...row,
                    relevance: round(score),
                    snippet: snippetById.get(id) ?? null,
                    distance: distById.has(id) ? round(distById.get(id), 4) : null,
                    signals
                });
            }

            // Break near-equal fused scores by importance, then recency.
            ranked.sort((a, b) => {
                if (Math.abs(a.relevance - b.relevance) > TIE_EPSILON) return b.relevance - a.relevance;
                const ia = a.metadata?.importance ?? 0, ib = b.metadata?.importance ?? 0;
                if (ia !== ib) return ib - ia;
                return String(b.created_at).localeCompare(String(a.created_at));
            });

            return { results: ranked.slice(0, limit), total };
        } catch (error) {
            // Distinguish failure from "no matches": throw so the handler reports
            // an error instead of silently returning an empty result set (a v3 wart).
            throw new Error(`searchMemories failed: ${error.message}`);
        }
    }

    _ftsSearch(query, filters, limit) {
        const ftsQuery = toFtsQuery(query);
        if (!ftsQuery) return null;
        const f = this._filterClause(filters, 'm');
        const sql = `
            SELECT m.id, m.content, m.metadata, m.created_at,
                   bm25(memories_fts) AS rank,
                   snippet(memories_fts, 0, '**', '**', '…', 16) AS snippet
            FROM memories_fts JOIN memories m ON memories_fts.rowid = m.id
            WHERE memories_fts MATCH ? AND m.superseded_by IS NULL${f.clause}
            ORDER BY rank LIMIT ?`;
        try {
            return this.db.prepare(sql).all(ftsQuery, ...f.params, limit)
                .map(r => ({ ...this._parseRow(r), rank: r.rank, snippet: r.snippet }));
        } catch (e) {
            process.stderr.write(`[DB] FTS match failed: ${e.message}\n`);
            return null;
        }
    }

    _vectorSearch(embedding, k, project = null) {
        if (!this.vecAvailable) return [];
        try {
            // Pre-filter by project INSIDE the KNN. Without it, a multi-project
            // store's k nearest vectors are mostly other projects and get dropped
            // at fetch time, starving semantic recall to nothing.
            let sql = 'SELECT memory_id, distance FROM vec_memories WHERE embedding MATCH ? AND k = ?';
            const params = [toBlob(embedding), k];
            if (project) { sql += ' AND project = ?'; params.push(project); }
            sql += ' ORDER BY distance';
            return this.db.prepare(sql).all(...params).map(r => ({ id: Number(r.memory_id), distance: r.distance }));
        } catch (e) {
            process.stderr.write(`[DB] vector search failed: ${e.message}\n`);
            return [];
        }
    }

    _fetchActiveByIds(ids, filters) {
        const map = new Map();
        if (!ids.length) return map;
        const ph = ids.map(() => '?').join(',');
        const f = this._filterClause(filters, 'm');
        const sql = `SELECT m.id, m.content, m.metadata, m.created_at FROM memories m
                     WHERE m.id IN (${ph}) AND m.superseded_by IS NULL${f.clause}`;
        for (const row of this.db.prepare(sql).all(...ids, ...f.params)) {
            map.set(row.id, this._parseRow(row));
        }
        return map;
    }

    _likeSearch(query, filters, limit) {
        const f = this._filterClause(filters, 'memories');
        const sql = `SELECT id, content, metadata, created_at FROM memories
                     WHERE content LIKE ? ESCAPE '\\' AND superseded_by IS NULL${f.clause}
                     ORDER BY created_at DESC LIMIT ?`;
        return this.db.prepare(sql).all(`%${escapeLike(query)}%`, ...f.params, limit)
            .map(r => ({ ...this._parseRow(r), relevance: null, snippet: null, distance: null, signals: ['substring'] }));
    }

    _countMatches(query, filters) {
        try {
            if (this.ftsAvailable) {
                const ftsQuery = toFtsQuery(query);
                if (ftsQuery) {
                    const f = this._filterClause(filters, 'm');
                    const sql = `SELECT COUNT(*) AS c FROM memories_fts JOIN memories m ON memories_fts.rowid = m.id
                                 WHERE memories_fts MATCH ? AND m.superseded_by IS NULL${f.clause}`;
                    return this.db.prepare(sql).get(ftsQuery, ...f.params).c;
                }
            }
            const f = this._filterClause(filters, 'memories');
            const sql = `SELECT COUNT(*) AS c FROM memories WHERE content LIKE ? ESCAPE '\\' AND superseded_by IS NULL${f.clause}`;
            return this.db.prepare(sql).get(`%${escapeLike(query)}%`, ...f.params).c;
        } catch (_) {
            return 0;
        }
    }

    // Semantic "more like this": embed the source and KNN, excluding the source
    // and superseded rows. Falls back to FTS token-overlap if semantic is off.
    async findSimilar(id, { limit = 5 } = {}) {
        const source = this.getMemoryById(id);
        if (!source) return null;

        if (this.embedder.available && this.vecAvailable) {
            const qv = await this.embedder.embed(source.content);
            if (qv) {
                const hits = this._vectorSearch(qv, limit + 5).filter(h => h.id !== id);
                const rows = this._fetchActiveByIds(hits.map(h => h.id), {});
                const distById = new Map(hits.map(h => [h.id, h.distance]));
                const out = [];
                for (const h of hits) {
                    const row = rows.get(h.id);
                    if (!row) continue;
                    out.push({ ...row, relevance: round(1 - h.distance, 4), distance: round(h.distance, 4) });
                    if (out.length >= limit) break;
                }
                return out;
            }
        }

        // Lexical fallback (v3 behaviour): OR-join the source's distinctive tokens.
        if (this.ftsAvailable) {
            const tokens = String(source.content).split(/[^\p{L}\p{N}_]+/u).filter(t => t.length >= 3).slice(0, 12);
            if (tokens.length) {
                const ftsQuery = tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
                try {
                    const rows = this.db.prepare(`
                        SELECT m.id, m.content, m.metadata, m.created_at, bm25(memories_fts) AS rank
                        FROM memories_fts JOIN memories m ON memories_fts.rowid = m.id
                        WHERE memories_fts MATCH ? AND m.id != ? AND m.superseded_by IS NULL
                        ORDER BY rank LIMIT ?`).all(ftsQuery, id, limit);
                    return rows.map(r => ({ ...this._parseRow(r), relevance: r.rank }));
                } catch (_) { /* fall through */ }
            }
        }
        return [];
    }

    // -------------------------------------------------------------------------
    // Plain reads (active rows only by default)
    // -------------------------------------------------------------------------

    getRecentMemories(limit = 10, project = null, session = null) {
        const f = this._filterClause({ project, session }, 'memories');
        const sql = `SELECT id, content, metadata, created_at FROM memories
                     WHERE superseded_by IS NULL${f.clause}
                     ORDER BY created_at DESC LIMIT ?`;
        return this.db.prepare(sql).all(...f.params, limit).map(r => this._parseRow(r));
    }

    getMemoryById(id) {
        const row = this.db.prepare('SELECT id, content, metadata, created_at, superseded_by FROM memories WHERE id = ?').get(id);
        if (!row) return null;
        return { ...this._parseRow(row), superseded_by: row.superseded_by ?? null };
    }

    deleteMemoryById(id) {
        try {
            const tx = this.db.transaction(() => {
                // Reactivate anything this row had superseded, so deleting a winner
                // doesn't permanently hide its (still-valid) predecessors.
                this.db.prepare('UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?').run(id);
                if (this.vecAvailable) this.db.prepare('DELETE FROM vec_memories WHERE memory_id = ?').run(BigInt(id));
                return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes;
            });
            return { success: true, changes: tx() };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    listMemories({ project, session, offset = 0, limit = 50, since, until } = {}) {
        const f = this._filterClause({ project, session }, 'memories');
        let sql = `SELECT id, content, metadata, created_at FROM memories WHERE superseded_by IS NULL${f.clause}`;
        const params = [...f.params];
        if (since) { sql += ' AND created_at >= ?'; params.push(since); }
        if (until) { sql += ' AND created_at <= ?'; params.push(until); }
        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);
        return this.db.prepare(sql).all(...params).map(r => this._parseRow(r));
    }

    countList({ project, session, since, until } = {}) {
        const f = this._filterClause({ project, session }, 'memories');
        let sql = `SELECT COUNT(*) AS c FROM memories WHERE superseded_by IS NULL${f.clause}`;
        const params = [...f.params];
        if (since) { sql += ' AND created_at >= ?'; params.push(since); }
        if (until) { sql += ' AND created_at <= ?'; params.push(until); }
        return this.db.prepare(sql).get(...params).c;
    }

    // Export ACTIVE memories as portable JSON. Superseded rows are omitted (they
    // are hidden duplicates, and their ids wouldn't survive a re-import anyway).
    // For a byte-exact, full-fidelity snapshot that preserves consolidation
    // state, use backup_database (VACUUM INTO) instead.
    exportAll() {
        return this.db.prepare('SELECT id, content, metadata, created_at FROM memories WHERE superseded_by IS NULL ORDER BY id')
            .all().map(r => this._parseRow(r));
    }

    renameProject(fromName, toName) {
        try {
            const r = this.db.prepare(
                "UPDATE memories SET metadata = json_set(metadata, '$.project', ?) WHERE json_extract(metadata, '$.project') = ?"
            ).run(toName, fromName);
            // Keep the vec project column in sync (used for consolidation pre-filter).
            if (this.vecAvailable) {
                try { this.db.prepare('UPDATE vec_memories SET project = ? WHERE project = ?').run(toName, fromName); } catch (_) {}
            }
            return { success: true, changes: r.changes };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    countAll() {
        return this.db.prepare('SELECT COUNT(*) AS c FROM memories').get().c;
    }

    deleteMemoriesWhere({ project, session, olderThan }) {
        try {
            if (!project && !session && !olderThan) return { success: false, error: 'at_least_one_filter_required' };
            const conditions = [];
            const params = [];
            if (project) { conditions.push("json_extract(metadata, '$.project') = ?"); params.push(project); }
            if (session) { conditions.push("json_extract(metadata, '$.session') = ?"); params.push(session); }
            if (olderThan) { conditions.push('created_at < ?'); params.push(olderThan); }
            const where = conditions.join(' AND ');

            const tx = this.db.transaction(() => {
                const ids = this.db.prepare(`SELECT id FROM memories WHERE ${where}`).all(...params).map(r => r.id);
                if (!ids.length) return 0;
                const ph = ids.map(() => '?').join(',');
                this.db.prepare(`UPDATE memories SET superseded_by = NULL WHERE superseded_by IN (${ph})`).run(...ids);
                if (this.vecAvailable) {
                    this.db.prepare(`DELETE FROM vec_memories WHERE memory_id IN (${ph})`).run(...ids.map(BigInt));
                }
                return this.db.prepare(`DELETE FROM memories WHERE id IN (${ph})`).run(...ids).changes;
            });
            return { success: true, deleted: tx() };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    tagMemory(id, { add = [], remove = [] } = {}) {
        try {
            const existing = this.getMemoryById(id);
            if (!existing) return { success: false, error: 'not_found' };
            const meta = { ...(existing.metadata || {}) };
            const current = new Set(Array.isArray(meta.categories) ? meta.categories : []);
            for (const t of add) current.add(t);
            for (const t of remove) current.delete(t);
            meta.categories = [...current];
            this.db.prepare('UPDATE memories SET metadata = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                .run(JSON.stringify(meta), id);
            return { success: true, categories: meta.categories };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // -------------------------------------------------------------------------
    // Stats / admin
    // -------------------------------------------------------------------------

    stats({ project } = {}) {
        const out = {
            total: this.db.prepare('SELECT COUNT(*) AS c FROM memories WHERE superseded_by IS NULL').get().c,
            projects: this.db.prepare("SELECT COUNT(DISTINCT json_extract(metadata, '$.project')) AS c FROM memories WHERE json_extract(metadata, '$.project') IS NOT NULL").get().c,
            sessions: this.db.prepare("SELECT COUNT(DISTINCT json_extract(metadata, '$.session')) AS c FROM memories WHERE json_extract(metadata, '$.session') IS NOT NULL").get().c,
            superseded: this.db.prepare('SELECT COUNT(*) AS c FROM memories WHERE superseded_by IS NOT NULL').get().c
        };
        if (project) {
            out.inProject = this.db.prepare("SELECT COUNT(*) AS c FROM memories WHERE json_extract(metadata, '$.project') = ? AND superseded_by IS NULL").get(project).c;
        }
        return out;
    }

    groupSummary(groupByField, { limit = 50, includeSamples = false } = {}) {
        if (!['project', 'session'].includes(groupByField)) throw new Error(`groupByField must be 'project' or 'session'`);
        const p = `$.${groupByField}`;
        const items = this.db.prepare(`
            SELECT json_extract(metadata, ?) AS name, COUNT(*) AS count,
                   MIN(created_at) AS first_memory, MAX(created_at) AS last_memory
            FROM memories
            WHERE json_extract(metadata, ?) IS NOT NULL AND superseded_by IS NULL
            GROUP BY json_extract(metadata, ?)
            ORDER BY ${groupByField === 'project' ? 'count' : 'last_memory'} DESC
            LIMIT ?`).all(p, p, p, limit)
            .map(r => ({ name: r.name, memoryCount: r.count, firstMemory: r.first_memory, lastMemory: r.last_memory }));

        if (includeSamples && items.length) {
            const names = items.map(i => i.name);
            const ph = names.map(() => '?').join(',');
            const samples = this.db.prepare(`
                SELECT name, content, created_at FROM (
                    SELECT json_extract(metadata, ?) AS name, content, created_at,
                           ROW_NUMBER() OVER (PARTITION BY json_extract(metadata, ?) ORDER BY created_at DESC) AS rn
                    FROM memories
                    WHERE json_extract(metadata, ?) IN (${ph}) AND superseded_by IS NULL
                ) WHERE rn <= 2 ORDER BY name, rn`).all(p, p, p, ...names);
            const byName = new Map();
            for (const s of samples) {
                if (!byName.has(s.name)) byName.set(s.name, []);
                byName.get(s.name).push({ content: s.content, created_at: s.created_at });
            }
            for (const item of items) item.samples = byName.get(item.name) || [];
        }
        return items;
    }

    // Embed any memories that lack a vector (e.g. rows from a pre-v4 database, or
    // rows created while embeddings were unavailable). Safe to run repeatedly.
    async backfillEmbeddings({ batchSize = 32 } = {}) {
        if (!this.vecAvailable || !this.embedder.available) {
            return { embedded: 0, missing: 0, available: false };
        }
        const have = new Set(this.db.prepare('SELECT memory_id FROM vec_memories').all().map(r => Number(r.memory_id)));
        const missing = this.db.prepare('SELECT id, content, metadata FROM memories').all().filter(r => !have.has(r.id));
        let embedded = 0;
        for (let i = 0; i < missing.length; i += batchSize) {
            const chunk = missing.slice(i, i + batchSize);
            const vecs = await this.embedder.embedBatch(chunk.map(r => r.content));
            const tx = this.db.transaction(() => {
                const ins = this.db.prepare('INSERT OR REPLACE INTO vec_memories(memory_id, embedding, project) VALUES (?, ?, ?)');
                chunk.forEach((r, j) => {
                    if (!vecs[j]) return;
                    ins.run(BigInt(r.id), toBlob(vecs[j]), this._project(r.metadata));
                    embedded++;
                });
            });
            tx();
        }
        return { embedded, missing: missing.length, available: true };
    }

    embeddingInfo() {
        let vectorCount = 0;
        if (this.vecAvailable) {
            try { vectorCount = this.db.prepare('SELECT COUNT(*) AS c FROM vec_memories').get().c; } catch (_) {}
        }
        const enabled = this.embedder.available && this.vecAvailable;
        return {
            available: enabled,
            loaded: this.embedder.loaded,
            status: !enabled ? 'disabled' : (this.embedder.loaded ? 'ready' : 'loading'),
            model: this.embedder.model,
            dim: this.embedder.dim,
            vectorCount
        };
    }

    // -------------------------------------------------------------------------
    // Maintenance helpers used by optimize_memory / startup checks / shutdown
    // -------------------------------------------------------------------------

    testConnection() {
        try {
            this.db.prepare('SELECT 1').get();
            return { success: true, message: 'SQLite connection successful', type: 'sqlite' };
        } catch (e) {
            return { success: false, error: e.message, type: 'sqlite' };
        }
    }

    listTables() {
        return this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    }

    tableColumns(table) {
        return this.db.prepare(`PRAGMA table_info(${table.replace(/[^a-zA-Z0-9_]/g, '')})`).all().map(r => r.name);
    }

    integrityCheck() {
        return this.db.prepare('PRAGMA integrity_check').all();
    }

    exec(sql) {
        this.db.exec(sql);
    }

    pragma(sql) {
        // Accept "PRAGMA wal_checkpoint(TRUNCATE)" style strings for compatibility.
        const m = sql.replace(/^\s*PRAGMA\s+/i, '');
        return this.db.pragma(m, { simple: false });
    }

    checkpoint() {
        try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
    }

    backupTo(destPath) {
        try {
            if (typeof destPath !== 'string' || destPath.includes("'")) throw new Error('Invalid destination path');
            this.db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
            return { success: true, path: destPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    close() {
        try { this.checkpoint(); } catch (_) {}
        try { this.db.close(); } catch (_) {}
    }

    // Back-compat shim for the few call sites (CLI --status) that used the old
    // raw query() interface. Returns { rows }.
    query(sql, params = []) {
        const stmt = this.db.prepare(sql);
        if (stmt.reader) return { rows: stmt.all(...params) };
        const info = stmt.run(...params);
        return { rows: [{ id: Number(info.lastInsertRowid) }], rowCount: info.changes };
    }
}

module.exports = MemoryDB;
