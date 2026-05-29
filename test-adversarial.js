#!/usr/bin/env node
/**
 * Adversarial / stress battery for the v4 hybrid memory engine.
 *
 * Goes beyond the happy-path unit suite: edge content, FTS special-character
 * fuzzing, cross-connection concurrency, scale + latency, the consolidation
 * reactivation graph, backfill idempotency, type edge cases, and graceful
 * degradation. Every test uses throwaway temp DBs — never the user's real one.
 *
 *   node test-adversarial.js      (or: npm run test:adversarial)
 *
 * Exit 0 = all passed, 1 = a failure. Semantic tests skip if the model can't load.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const MemoryDB = require('./db');
const { Embedder } = require('./embeddings');

// Safety net: any MemoryDB created without an explicit path resolves here, not
// the user's real database.
process.env.DATABASE_PATH = path.join(os.tmpdir(), `dur-adv-default-${Date.now()}.db`);
process.env.NO_UPDATE_CHECK = '1';

const NULL_EMBEDDER = {
    enabled: false, _failed: true, dim: 384, model: 'disabled',
    get available() { return false; }, get loaded() { return false; },
    async embed() { return null; }, async embedBatch(t) { return t.map(() => null); }, warmup() {}
};

const temps = [];
function tmp(tag) {
    const p = path.join(os.tmpdir(), `dur-adv-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`);
    temps.push(p);
    return p;
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

let pass = 0, fail = 0, skip = 0;
async function test(name, fn) {
    process.stdout.write(`  ${name}...`);
    try {
        const r = await fn();
        if (r && r.skip) { skip++; console.log(` [SKIP] ${r.reason || ''}`); }
        else { pass++; console.log(' [PASS]'); }
    } catch (e) {
        fail++; console.log(` [FAIL] ${e.message}`);
        if (process.env.VERBOSE) console.log(e.stack);
    }
}

async function main() {
    console.log('Durandal v4 — adversarial / stress battery\n' + '='.repeat(56));
    const cacheDir = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.durandal-mcp', '.model-cache');
    const embedder = new Embedder({ cacheDir }); // shared so the model loads once
    const semantic = !!(await embedder.embed('probe'));
    console.log(semantic ? '  Semantic: ENABLED\n' : '  Semantic: UNAVAILABLE (semantic tests skip)\n');
    const mk = (tag, emb = embedder) => { const db = new MemoryDB({ dbPath: tmp(tag), embedder: emb }); return db; };

    // 1. Edge content: emoji, CJK, whitespace, single char, 50k chars.
    await test('edge content stores + retrieves', async () => {
        const db = mk('edge');
        try {
            const cases = ['x', '😀🎉🔥', '日本語のメモ', '   ', 'a\nb\tc', 'important '.repeat(5000)];
            for (const c of cases) assert((await db.storeMemory(c, { project: 'e' })).success, `store failed: ${JSON.stringify(c.slice(0, 16))}`);
            assert(db.getRecentMemories(50, 'e').length === cases.length, 'not all edge contents stored');
            const big = await db.searchMemories('important', { project: 'e' });
            assert(big.results.length >= 1, '50k-char memory not searchable by a contained token');
        } finally { db.close(); }
    });

    // 2. FTS special characters / injection: nothing should throw.
    await test('FTS special-char queries never crash', async () => {
        const db = mk('fts');
        try {
            await db.storeMemory('the deploy script failed with error code 500', { project: 'f' });
            const queries = ['deploy OR error', 'deploy AND error', 'NEAR(deploy error)', '"deploy"',
                'code:500', 'depl*', 'error^2', '(deploy', '-deploy', '!!!', '   ', 'say "hi"', 'x'.repeat(5000)];
            for (const q of queries) {
                const res = await db.searchMemories(q, { project: 'f' });
                assert(res && Array.isArray(res.results), `query crashed: ${JSON.stringify(q.slice(0, 24))}`);
                assert(res.results.length <= (res.total), `count>total for query ${JSON.stringify(q.slice(0, 24))}`);
            }
        } finally { db.close(); }
    });

    // 3. Cross-connection tagging accumulates (no lost update across connections).
    await test('cross-connection tagging accumulates', async () => {
        const p = tmp('conc');
        const a = new MemoryDB({ dbPath: p, embedder }); const b = new MemoryDB({ dbPath: p, embedder });
        try {
            const seed = await a.storeMemory('concurrency seed', { project: 'c', categories: [] });
            a.tagMemory(seed.id, { add: ['tagA'] });
            b.tagMemory(seed.id, { add: ['tagB'] }); // b is a separate connection
            const cats = new Set(b.getMemoryById(seed.id).metadata.categories);
            assert(cats.has('tagA') && cats.has('tagB'), `lost update across connections: ${[...cats]}`);
        } finally { a.close(); b.close(); }
    });

    // 4. Scale: 150 memories across 6 projects + project-scoped semantic recall + latency.
    await test('scale: project-scoped recall + latency (150 rows)', async () => {
        if (!semantic) return { skip: true, reason: '(needs embeddings)' };
        const db = mk('scale');
        try {
            const projects = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
            const items = [];
            for (let i = 0; i < 150; i++) items.push({ content: `routine memory ${i} regarding subsystem ${i % 25} status`, metadata: { project: projects[i % 6] } });
            items.push({ content: 'the kubernetes ingress controller is misconfigured and dropping traffic', metadata: { project: 'p3' } });
            const r = await db.storeMemoriesBatch(items);
            assert(r.success && r.ids.length === 151, 'batch insert failed at scale');
            const t0 = Date.now();
            const res = await db.searchMemories('the load balancer routing is broken', { project: 'p3' });
            const ms = Date.now() - t0;
            assert(res.results.every(x => x.metadata.project === 'p3'), 'project filter leaked other projects at scale');
            assert(res.results.some(x => x.content.includes('kubernetes ingress')), 'project-scoped semantic recall failed at scale');
            assert(ms < 1500, `search too slow at scale: ${ms}ms`);
        } finally { db.close(); }
    });

    // 5. Reactivation graph: A<-B<-C chain, deletes revive correctly, no orphans.
    await test('supersede chain + reactivation is correct', async () => {
        if (!semantic) return { skip: true, reason: '(needs embeddings)' };
        const db = mk('react');
        try {
            const c = 'identical fact used for the supersede chain test';
            const a = await db.storeMemory(c, { project: 'r' });
            const b = await db.storeMemory(c, { project: 'r' });
            const cc = await db.storeMemory(c, { project: 'r' });
            assert(b.supersededId === a.id, 'B should supersede A');
            assert(cc.supersededId === b.id, 'C should supersede the ACTIVE B, not A');
            assert(db.getRecentMemories(10, 'r').length === 1, 'only C should be active');
            db.deleteMemoryById(cc.id);
            const act = db.getRecentMemories(10, 'r');
            assert(act.length === 1 && act[0].id === b.id, `deleting C should revive B, got ${act.map(x => x.id)}`);
            assert(db.getMemoryById(a.id).superseded_by === b.id, 'A should remain superseded by B');
        } finally { db.close(); }
    });

    // 6. Backfill is idempotent (no duplicate vectors on re-run).
    await test('backfill embeddings is idempotent', async () => {
        if (!semantic) return { skip: true, reason: '(needs embeddings)' };
        const db = mk('bf');
        try {
            await db.storeMemory('backfill one', { project: 'b' });
            await db.storeMemory('backfill two', { project: 'b' });
            const r2 = await db.backfillEmbeddings(); // already embedded on store
            assert(r2.embedded === 0, `re-backfill should embed 0, got ${r2.embedded}`);
            assert(db.embeddingInfo().vectorCount === 2, `expected 2 vectors, got ${db.embeddingInfo().vectorCount}`);
        } finally { db.close(); }
    });

    // 7. Non-numeric importance must not crash search/sort (F5).
    await test('non-numeric importance does not break ranking', async () => {
        const db = mk('imp');
        try {
            await db.storeMemory('tiebreak alpha widget', { project: 'i', importance: 'high' });
            await db.storeMemory('tiebreak beta widget', { project: 'i', importance: 'low' });
            const res = await db.searchMemories('widget', { project: 'i' });
            assert(res.results.length === 2, 'both widgets should be found');
            assert(res.results.every(r => typeof r.id === 'number'), 'results malformed');
        } finally { db.close(); }
    });

    // 8. export is active-only (superseded duplicates excluded).
    await test('export excludes superseded rows', async () => {
        if (!semantic) return { skip: true, reason: '(needs embeddings)' };
        const db = mk('exp');
        try {
            await db.storeMemory('export alpha unique', { project: 'x' });
            const dup = 'export beta duplicate line';
            await db.storeMemory(dup, { project: 'x' });
            await db.storeMemory(dup, { project: 'x' }); // supersedes the first beta
            const exported = db.exportAll();
            assert(exported.length === 2, `export should have 2 active rows (alpha + 1 beta), got ${exported.length}`);
        } finally { db.close(); }
    });

    // 9. Graceful degradation: embeddings off — store/search/find/suggest all sane.
    await test('graceful degradation with embeddings off', async () => {
        const db = new MemoryDB({ dbPath: tmp('deg'), embedder: NULL_EMBEDDER });
        try {
            const s = await db.storeMemory('lexical only token zqxw9', { project: 'd' });
            assert(s.success && s.supersededId === null, 'store should succeed without consolidation');
            assert((await db.searchMemories('zqxw9', { project: 'd' })).results.length === 1, 'lexical search broke');
            assert((await db.suggestConsolidations({ project: 'd' })).available === false, 'suggest should report unavailable');
            assert(Array.isArray(await db.findSimilar(s.id)), 'find_similar should return an array');
            assert(db.embeddingInfo().available === false, 'embeddingInfo should be unavailable');
        } finally { db.close(); }
    });

    // 10. Empty DB searches return cleanly.
    await test('empty database searches return cleanly', async () => {
        const db = mk('empty');
        try {
            const res = await db.searchMemories('anything at all', {});
            assert(res.results.length === 0 && res.total === 0, 'empty DB should return no results, total 0');
            assert(db.getRecentMemories(10).length === 0, 'empty recent');
            assert(await db.findSimilar(123) === null, 'find_similar on missing id should be null');
        } finally { db.close(); }
    });

    console.log('\n' + '='.repeat(56));
    console.log(`  Passed: ${pass}   Failed: ${fail}   Skipped: ${skip}`);
    for (const p of temps) for (const ext of ['', '-wal', '-shm']) { try { fs.existsSync(p + ext) && fs.unlinkSync(p + ext); } catch (_) {} }
    if (fail) { console.log('\n[FAIL] adversarial battery had failures.'); process.exit(1); }
    console.log('\n[SUCCESS] adversarial battery passed.');
    process.exit(0);
}

main().catch(e => { console.error('battery crashed:', e); process.exit(1); });
