/**
 * Durandal MCP Server — built-in test suite (`durandal-mcp --test`).
 *
 * Tests assert real BEHAVIOUR, not just that calls return without throwing:
 *   - lexical search finds exact tokens
 *   - SEMANTIC search finds paraphrase ("compilation failing" -> "build is broken")
 *   - write-time consolidation supersedes near-duplicates (and hides them)
 *   - metadata filters are applied in SQL and the total count respects them
 *   - the server degrades to lexical-only when embeddings are unavailable
 *
 * Semantic tests SKIP (not fail) if the embedding model can't load (e.g. offline
 * on first run), so the suite still validates the lexical floor everywhere.
 *
 * Every test runs against a throwaway DB in the OS temp dir — never the user's
 * real ~/.durandal-mcp database.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MemoryDB = require('./db');
const Logger = require('./logger');
const { ValidationError } = require('./errors');

// A stub embedder used to prove graceful degradation to lexical-only.
const NULL_EMBEDDER = {
    enabled: false, _failed: true, dim: 384, model: 'disabled',
    get available() { return false; },
    get loaded() { return false; },
    async embed() { return null; },
    async embedBatch(texts) { return texts.map(() => null); },
    warmup() {}
};

class TestRunner {
    constructor(logger = null) {
        this.logger = logger || new Logger({ level: 'info' });
        this.tests = [];
        this.passed = 0;
        this.failed = 0;
        this.skipped = 0;
        this.startTime = Date.now();
        this._tempFiles = [];

        if (!process.env.DURANDAL_TEST_KEEP_DB) {
            this._tempDbPath = this._tmp('main');
            process.env.DATABASE_PATH = this._tempDbPath;
            process.env.NO_UPDATE_CHECK = '1';
        }
    }

    _tmp(tag) {
        const p = path.join(os.tmpdir(), `durandal-test-${tag}-${Date.now()}-${process.pid}.db`);
        this._tempFiles.push(p);
        return p;
    }

    async runAllTests() {
        console.log('Running Durandal MCP Server Tests (v4 — hybrid memory)\n');
        console.log('='.repeat(56));

        // One shared DB for the data tests (one process, one embedder load).
        this.db = new MemoryDB();
        await this.db.ready;

        // Probe whether semantic search is actually available on this machine.
        const probe = await this.db.embedder.embed('availability probe');
        this.semantic = !!probe && this.db.vecAvailable;
        console.log(this.semantic
            ? `  Semantic search: ENABLED (${this.db.embedder.model})\n`
            : `  Semantic search: UNAVAILABLE — semantic tests will be skipped (lexical floor still tested)\n`);

        await this.runTest('Database connection', this.testConnection.bind(this));
        await this.runTest('Schema + indexes (incl. vec table)', this.testSchema.bind(this));
        await this.runTest('Store + get round-trip', this.testStoreGet.bind(this));
        await this.runTest('Lexical search (exact tokens)', this.testLexical.bind(this));
        await this.runTest('Semantic recall (paraphrase)', this.testSemantic.bind(this));
        await this.runTest('Consolidation supersedes near-duplicate', this.testConsolidation.bind(this));
        await this.runTest('Semantic recall is project-scoped', this.testSemanticScoped.bind(this));
        await this.runTest('Filters applied in SQL + filter-aware total', this.testFilters.bind(this));
        await this.runTest('find_similar', this.testFindSimilar.bind(this));
        await this.runTest('suggest_consolidations (client-driven)', this.testSuggestConsolidations.bind(this));
        await this.runTest('Graceful degradation (embeddings off)', this.testDegradation.bind(this));
        await this.runTest('MCP tool registry (21 tools)', this.testMCPTools.bind(this));
        await this.runTest('Error types + clean not-found', this.testErrors.bind(this));
        await this.runTest('Performance sanity', this.testPerformance.bind(this));

        this.printSummary();
        this._cleanup();
        return this.failed === 0;
    }

    async runTest(name, fn) {
        const t = { name, started: Date.now(), status: 'running' };
        this.tests.push(t);
        try {
            process.stdout.write(`  ${name}...`);
            const r = await fn();
            t.duration = Date.now() - t.started;
            if (r && r.skipped) {
                t.status = 'skipped';
                this.skipped++;
                console.log(` [SKIP] ${r.reason || ''}`);
            } else {
                t.status = 'passed';
                this.passed++;
                console.log(` [PASS] (${t.duration}ms)`);
            }
        } catch (error) {
            t.status = 'failed';
            t.duration = Date.now() - t.started;
            t.error = error.message;
            this.failed++;
            console.log(` [FAIL] (${t.duration}ms)`);
            console.log(`    Error: ${error.message}`);
            if (process.env.VERBOSE === 'true') console.log(`    Stack: ${error.stack}`);
        }
    }

    // --- assertions ----------------------------------------------------------

    assert(cond, msg) { if (!cond) throw new Error(msg); }

    // --- tests ---------------------------------------------------------------

    async testConnection() {
        const r = this.db.testConnection();
        this.assert(r.success, `connection failed: ${r.error}`);
        this.assert(this.db.query('SELECT 1 AS x').rows[0].x === 1, 'SELECT 1 failed');
    }

    async testSchema() {
        const tables = this.db.listTables();
        this.assert(tables.includes('memories'), 'missing memories table');
        const cols = this.db.tableColumns('memories');
        for (const c of ['id', 'content', 'metadata', 'created_at', 'updated_at', 'superseded_by']) {
            this.assert(cols.includes(c), `missing column: ${c}`);
        }
        this.assert(this.db.ftsAvailable, 'FTS5 should be available');
        if (this.semantic) {
            this.assert(tables.includes('vec_memories'), 'missing vec_memories table when semantic enabled');
        }
    }

    async testStoreGet() {
        const content = 'Round-trip content ' + Date.now();
        const res = await this.db.storeMemory(content, {
            project: 'rt', session: 's1', importance: 0.8, categories: ['a', 'b']
        });
        this.assert(res.success && res.id, `store failed: ${res.error}`);
        const got = this.db.getMemoryById(res.id);
        this.assert(got && got.content === content, 'get did not round-trip content');
        this.assert(got.metadata.importance === 0.8, 'metadata not preserved');
    }

    async testLexical() {
        const token = 'ztokenq' + Date.now();
        await this.db.storeMemory(`a memory containing ${token} as an exact token`, { project: 'lex' });
        const { results, total } = await this.db.searchMemories(token, { project: 'lex' });
        this.assert(results.length >= 1, 'lexical search found nothing');
        this.assert(results[0].content.includes(token), 'top result missing the token');
        this.assert(results[0].signals.includes('lexical'), 'lexical signal not reported');
        this.assert(total >= 1, 'total should be >= 1');
    }

    async testSemantic() {
        if (!this.semantic) return { skipped: true, reason: '(embeddings unavailable)' };
        // Store a statement, then search with NO shared tokens. Lexical/BM25 alone
        // would return nothing here — only semantic recall can find it.
        await this.db.storeMemory('the build is broken after the latest merge', { project: 'sem' });
        await this.db.storeMemory('remember to water the office plants on fridays', { project: 'sem' });
        const { results } = await this.db.searchMemories('compilation is failing', { project: 'sem' });
        const hit = results.find(r => r.content.includes('the build is broken'));
        this.assert(hit, 'semantic search did NOT find the paraphrased memory');
        this.assert(hit.signals.includes('semantic'), 'semantic signal not reported on the hit');
        // And it should rank above the unrelated "plants" memory.
        const plantsIdx = results.findIndex(r => r.content.includes('plants'));
        const hitIdx = results.findIndex(r => r.content.includes('the build is broken'));
        this.assert(plantsIdx === -1 || hitIdx < plantsIdx, 'paraphrase did not outrank unrelated memory');
    }

    async testConsolidation() {
        if (!this.semantic) return { skipped: true, reason: '(needs embeddings)' };
        const content = 'consolidation marker: I prefer four-space indentation ' + Date.now();
        const first = await this.db.storeMemory(content, { project: 'consol' });
        this.assert(first.success && !first.supersededId, 'first store should not supersede anything');
        // Storing identical content again is an exact near-duplicate (distance ~0).
        const second = await this.db.storeMemory(content, { project: 'consol' });
        this.assert(second.supersededId === first.id,
            `expected store to supersede #${first.id}, got ${second.supersededId}`);
        // The superseded one must be hidden from search + recent.
        const { results } = await this.db.searchMemories('four-space indentation', { project: 'consol' });
        this.assert(!results.some(r => r.id === first.id), 'superseded memory still appears in search');
        const recent = this.db.getRecentMemories(50, 'consol');
        this.assert(!recent.some(r => r.id === first.id), 'superseded memory still appears in recent');
        // But it is NOT deleted — still fetchable by id.
        this.assert(this.db.getMemoryById(first.id) !== null, 'superseded memory was deleted (should be retained)');
        this.assert(this.db.stats().superseded >= 1, 'stats.superseded should count it');
    }

    async testSemanticScoped() {
        if (!this.semantic) return { skipped: true, reason: '(needs embeddings)' };
        // Regression guard for project-filtered vector KNN: a target in one project
        // must be recalled semantically, and a search scoped to that project must
        // never leak rows from another project (the bug a global KNN would cause).
        await this.db.storeMemory('the kubernetes ingress is misconfigured', { project: 'mpA' });
        for (let i = 0; i < 6; i++) {
            await this.db.storeMemory(`team lunch plans note ${i}`, { project: 'mpB' });
        }
        const { results } = await this.db.searchMemories('the ingress routing is broken', { project: 'mpA' });
        this.assert(results.length >= 1, 'project-scoped semantic search returned nothing');
        this.assert(results.every(r => r.metadata.project === 'mpA'), 'project filter leaked other-project rows');
        this.assert(results.some(r => r.content.includes('kubernetes ingress')), 'did not recall the in-project target');
    }

    async testFilters() {
        const tag = 'flt' + Date.now();
        await this.db.storeMemory(`${tag} high one`, { project: 'fltA', importance: 0.9, categories: ['x'] });
        await this.db.storeMemory(`${tag} low one`, { project: 'fltA', importance: 0.1, categories: ['y'] });
        await this.db.storeMemory(`${tag} other project`, { project: 'fltB', importance: 0.9, categories: ['x'] });

        // Project filter narrows the total (the v3 wart: total used to ignore filters).
        const a = await this.db.searchMemories(tag, { project: 'fltA' });
        const b = await this.db.searchMemories(tag, { project: 'fltB' });
        this.assert(a.total === 2, `project fltA total expected 2, got ${a.total}`);
        this.assert(b.total === 1, `project fltB total expected 1, got ${b.total}`);

        // Importance floor filter (applied in SQL).
        const hi = await this.db.searchMemories(tag, { project: 'fltA', importance_min: 0.5 });
        this.assert(hi.results.every(r => (r.metadata.importance ?? 0) >= 0.5), 'importance_min not enforced');
        this.assert(hi.results.some(r => r.content.includes('high one')), 'importance_min dropped a valid row');
        this.assert(!hi.results.some(r => r.content.includes('low one')), 'importance_min let a low row through');

        // Category filter.
        const cat = await this.db.searchMemories(tag, { project: 'fltA', categories: ['y'] });
        this.assert(cat.results.length === 1 && cat.results[0].content.includes('low one'), 'category filter wrong');
    }

    async testFindSimilar() {
        const base = await this.db.storeMemory('docker compose fails to start the postgres container', { project: 'sim' });
        await this.db.storeMemory('the database container will not boot under docker', { project: 'sim' });
        const similar = await this.db.findSimilar(base.id, { limit: 5 });
        this.assert(Array.isArray(similar), 'findSimilar should return an array');
        this.assert(!similar.some(r => r.id === base.id), 'findSimilar must exclude the source');
        if (this.semantic) {
            this.assert(similar.length >= 1, 'findSimilar found nothing despite a related memory');
        }
    }

    async testSuggestConsolidations() {
        if (!this.semantic) return { skipped: true, reason: '(needs embeddings)' };
        const proj = 'sugg' + Date.now();
        // Two phrasings of the same fact (an "update"): semantically close but too
        // far apart to auto-consolidate. Plus an unrelated memory. The two should
        // cluster as a consolidation candidate; the unrelated one should not join.
        await this.db.storeMemory('we deploy the api to AWS using terraform', { project: proj });
        await this.db.storeMemory('the api deployment now runs on AWS via terraform scripts', { project: proj });
        await this.db.storeMemory('the office coffee machine is broken again', { project: proj });
        const res = await this.db.suggestConsolidations({ project: proj, threshold: 0.55, scan: 50 });
        this.assert(res.available, 'suggestConsolidations should be available with embeddings on');
        // This also proves stored vectors can be read back (blobToF32); a failure
        // there would yield zero clusters.
        const group = res.groups.find(g => g.size >= 2);
        this.assert(group, 'expected a cluster of >= 2 similar memories');
        this.assert(!group.memories.some(m => m.content.includes('coffee')),
            'unrelated memory should not be clustered with the deploy memories');
    }

    async testDegradation() {
        // A DB with embeddings forced off must still store + search via FTS.
        const db2 = new MemoryDB({ dbPath: this._tmp('degraded'), embedder: NULL_EMBEDDER });
        try {
            const token = 'degradetoken' + Date.now();
            const res = await db2.storeMemory(`lexical only ${token}`, { project: 'deg' });
            this.assert(res.success, 'store failed with embeddings off');
            this.assert(res.supersededId === null, 'no consolidation expected without embeddings');
            const { results } = await db2.searchMemories(token, { project: 'deg' });
            this.assert(results.length === 1, 'lexical search broke with embeddings off');
            this.assert(db2.embeddingInfo().available === false, 'embeddingInfo should report unavailable');
        } finally {
            db2.close();
        }
    }

    async testMCPTools() {
        const DurandalMCPServer = require('./durandal-mcp-server');
        const server = new DurandalMCPServer({ logLevel: 'error' });
        await server.ready;
        const required = [
            'store_memory', 'search_memories', 'get_context', 'optimize_memory', 'get_status',
            'configure_logging', 'get_logs', 'list_projects_sessions', 'get_memory', 'delete_memory',
            'store_memories_batch', 'update_memory', 'list_memories', 'export_memories',
            'import_memories', 'rename_project', 'backup_database', 'delete_memories_where',
            'find_similar', 'tag_memory', 'suggest_consolidations'
        ];
        const registered = Object.keys(server.server._registeredTools || {});
        for (const tool of required) {
            this.assert(registered.includes(tool), `tool not registered: ${tool}`);
        }
        try { server.db.close(); } catch (_) {}
        try { server.logger.close(); } catch (_) {}
    }

    async testErrors() {
        const e = new ValidationError('bad', 'field', 1);
        this.assert(e.code === 'VALIDATION_ERROR', 'ValidationError code wrong');
        // Not-found paths return clean nulls/objects, not throws.
        this.assert(this.db.getMemoryById(99999999) === null, 'missing id should return null');
        const upd = await this.db.updateMemory(99999999, { content: 'x' });
        this.assert(upd.success === false && upd.error === 'not_found', 'update of missing id should be not_found');
        const del = this.db.deleteMemoryById(99999999);
        this.assert(del.success === true && del.changes === 0, 'delete of missing id should be a no-op success');
    }

    async testPerformance() {
        const N = 40;
        const storeStart = Date.now();
        for (let i = 0; i < N; i++) await this.db.storeMemory(`perf row ${i} ${Date.now()}`, { project: 'perf' });
        const perStore = (Date.now() - storeStart) / N;

        const searchStart = Date.now();
        for (let i = 0; i < 10; i++) await this.db.searchMemories('perf row', { project: 'perf' });
        const perSearch = (Date.now() - searchStart) / 10;

        console.log(`\n    store ~${perStore.toFixed(1)}ms/op${this.semantic ? ' (incl. embedding)' : ''}, search ~${perSearch.toFixed(1)}ms/op`);
        // Don't fail on perf (CPU-dependent + embedding cost) — just surface it.
    }

    printSummary() {
        const totalTime = Date.now() - this.startTime;
        console.log('\n' + '='.repeat(56));
        console.log(`  Total: ${this.tests.length}   Passed: ${this.passed}   Failed: ${this.failed}   Skipped: ${this.skipped}`);
        console.log(`  Duration: ${totalTime}ms`);
        if (this.failed === 0) {
            console.log('\n[SUCCESS] All tests passed' + (this.skipped ? ` (${this.skipped} skipped)` : '') + '.');
        } else {
            console.log('\n[FAIL] Failures:');
            this.tests.filter(t => t.status === 'failed').forEach(t => console.log(`  - ${t.name}: ${t.error}`));
        }
    }

    _cleanup() {
        try { this.db.close(); } catch (_) {}
        for (const p of this._tempFiles) {
            for (const ext of ['', '-wal', '-shm', '-journal']) {
                try { if (fs.existsSync(p + ext)) fs.unlinkSync(p + ext); } catch (_) {}
            }
        }
    }
}

if (require.main === module) {
    new TestRunner().runAllTests()
        .then(ok => process.exit(ok ? 0 : 1))
        .catch(err => { console.error('Test runner failed:', err); process.exit(1); });
}

module.exports = TestRunner;
