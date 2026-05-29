#!/usr/bin/env node
/**
 * Load / scale benchmark for the v4 hybrid memory engine.
 *
 *   node loadtest.js [N]        (default N = 10000)
 *
 * Runs against a THROWAWAY temp DB (never your real memories). Measures write
 * throughput, hybrid search latency (global + project-scoped), single-store cost
 * with consolidation at scale, recall correctness (find one needle among N),
 * suggest_consolidations cost, DB size, and RSS. sqlite-vec KNN is brute-force
 * (exhaustive), so this is the real test of whether that holds at N.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const MemoryDB = require('./db');

const N = Number(process.argv[2]) || 10000;
const dbPath = path.join(os.tmpdir(), `dur-loadtest-${Date.now()}.db`);
process.env.NO_UPDATE_CHECK = '1';

const sorted = (a) => [...a].sort((x, y) => x - y);
const pct = (a, p) => { const s = sorted(a); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length);
const mb = (b) => (b / 1024 / 1024).toFixed(1);

const PROJECTS = Array.from({ length: 20 }, (_, i) => `proj${i}`);
const TOPICS = ['authentication', 'database migration', 'deployment pipeline', 'memory leak', 'api rate limit',
    'frontend rendering', 'cache invalidation', 'race condition', 'null reference', 'timeout error', 'config drift',
    'dependency upgrade', 'security patch', 'performance regression', 'data corruption', 'log rotation',
    'monitoring alert', 'backup failure', 'network partition', 'disk pressure'];
const QUERIES = ['authentication token expired', 'database migration rollback', 'deployment failed in production',
    'memory leak in the worker', 'api returning 429 errors', 'cache not invalidating', 'intermittent race condition',
    'null reference exception', 'request timed out', 'configuration mismatch', 'upgrade broke the build',
    'security vulnerability patched', 'latency regression', 'corrupted records', 'where are the logs',
    'load balancer routing problem', 'pods crashing on startup', 'traffic dropping intermittently',
    'cluster networking issue', 'running out of disk'];

const NEEDLE = 'the kubernetes ingress controller is dropping production traffic intermittently';
const NEEDLE_PROJECT = 'proj7';
const NEEDLE_QUERY = 'load balancer routing is broken and traffic keeps dropping';

(async () => {
    const db = new MemoryDB({ dbPath });
    await db.ready;
    await db.embedder.embed('warmup');
    const semantic = db.vecAvailable && db.embedder.available;
    console.log(`\nLoad test: N=${N}, semantic=${semantic}\n${'='.repeat(56)}`);

    // ---------- WRITE ----------
    const CHUNK = 200;
    let written = 0;
    const t0 = Date.now();
    for (let i = 0; i < N; i += CHUNK) {
        const items = [];
        for (let j = 0; j < CHUNK && (i + j) < N; j++) {
            const k = i + j;
            items.push({
                content: `memory ${k}: investigating ${TOPICS[k % TOPICS.length]} in module ${k % 137}; status note with specific detail number ${k}`,
                metadata: { project: PROJECTS[k % PROJECTS.length], session: 'load', importance: (k % 10) / 10 }
            });
        }
        const r = await db.storeMemoriesBatch(items);
        if (!r.success) { console.error('batch failed:', r.error); process.exit(1); }
        written += r.ids.length;
        if (written % 2000 === 0) process.stderr.write(`  ...written ${written}/${N}\n`);
    }
    const writeMs = Date.now() - t0;

    // single store WITH consolidation (the O(n) _nearestActive KNN) at scale
    const ns = Date.now();
    await db.storeMemory(NEEDLE, { project: NEEDLE_PROJECT, session: 'load', importance: 0.9 });
    const needleStoreMs = Date.now() - ns;

    console.log(`\nWRITE`);
    console.log(`  ${written} memories (batched) in ${(writeMs / 1000).toFixed(1)}s = ${(writeMs / written).toFixed(2)} ms/mem (incl. embedding)`);
    console.log(`  single store + consolidation KNN at N=${written}: ${needleStoreMs} ms`);
    const st = db.stats();
    console.log(`  stats: total=${st.total} projects=${st.projects} superseded=${st.superseded} vectors=${db.embeddingInfo().vectorCount}`);

    // ---------- SEARCH: global hybrid ----------
    const warm = 20, runs = 200;
    for (let i = 0; i < warm; i++) await db.searchMemories(QUERIES[i % QUERIES.length], { limit: 10 });
    const gLat = [];
    for (let i = 0; i < runs; i++) { const s = Date.now(); await db.searchMemories(QUERIES[i % QUERIES.length], { limit: 10 }); gLat.push(Date.now() - s); }
    console.log(`\nSEARCH — global hybrid (${runs} queries, brute-force KNN over ${written} vectors)`);
    console.log(`  p50=${pct(gLat, 50)}ms  p95=${pct(gLat, 95)}ms  max=${Math.max(...gLat)}ms  avg=${avg(gLat).toFixed(1)}ms`);

    // ---------- SEARCH: project-scoped ----------
    const pLat = [];
    for (let i = 0; i < runs; i++) { const s = Date.now(); await db.searchMemories(QUERIES[i % QUERIES.length], { project: PROJECTS[i % PROJECTS.length], limit: 10 }); pLat.push(Date.now() - s); }
    console.log(`SEARCH — project-scoped (${runs} queries)`);
    console.log(`  p50=${pct(pLat, 50)}ms  p95=${pct(pLat, 95)}ms  max=${Math.max(...pLat)}ms  avg=${avg(pLat).toFixed(1)}ms`);

    // ---------- CORRECTNESS: find the needle ----------
    const inProj = await db.searchMemories(NEEDLE_QUERY, { project: NEEDLE_PROJECT, limit: 10 });
    const f1 = inProj.results.findIndex(r => r.content.includes('kubernetes ingress'));
    const global = await db.searchMemories(NEEDLE_QUERY, { limit: 10 });
    const f2 = global.results.findIndex(r => r.content.includes('kubernetes ingress'));
    console.log(`\nCORRECTNESS — recall 1 needle among ${written}`);
    console.log(`  project-scoped: ${f1 >= 0 ? 'FOUND at rank ' + (f1 + 1) + ' (' + inProj.results[f1].signals.join('+') + ')' : 'NOT in top 10'}`);
    console.log(`  global:         ${f2 >= 0 ? 'FOUND at rank ' + (f2 + 1) + ' (' + global.results[f2].signals.join('+') + ')' : 'NOT in top 10'}`);

    // ---------- suggest_consolidations (O(n^2) within scan window) ----------
    for (const scan of [200, 500, 1000]) {
        const s = Date.now();
        const sug = await db.suggestConsolidations({ scan });
        console.log(`\nsuggest_consolidations(scan=${scan}): ${Date.now() - s}ms, ${sug.groups.length} clusters`);
    }

    // ---------- size + memory ----------
    const size = fs.statSync(dbPath).size + (fs.existsSync(dbPath + '-wal') ? fs.statSync(dbPath + '-wal').size : 0);
    console.log(`\nDB size on disk: ${mb(size)} MB   |   process RSS: ${mb(process.memoryUsage().rss)} MB`);

    db.close();
    for (const ext of ['', '-wal', '-shm']) { try { fs.existsSync(dbPath + ext) && fs.unlinkSync(dbPath + ext); } catch (_) {} }
    console.log(`\n${'='.repeat(56)}\ndone (temp DB removed).`);
})().catch(e => { console.error('loadtest crashed:', e); process.exit(1); });
