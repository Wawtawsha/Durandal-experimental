#!/usr/bin/env node

/**
 * End-to-end MCP stdio smoke test.
 *
 * Spawns durandal-mcp-server-v3.js as a subprocess and speaks raw JSON-RPC
 * over stdin/stdout to verify the server:
 *   1. Doesn't corrupt stdout with non-protocol text (logs, banners, etc.)
 *   2. Returns a valid initialize response
 *   3. Lists tools
 *   4. Can round-trip a store_memory + search_memories call
 *
 * Exit code: 0 = success, 1 = failure.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function makeTempDbPath() {
    return path.join(os.tmpdir(), `durandal-mcp-smoke-${Date.now()}-${process.pid}.db`);
}

function parseLines(buffer) {
    const lines = buffer.split('\n');
    const remainder = lines.pop(); // last element is either '' or a partial line
    const messages = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            messages.push(JSON.parse(line));
        } catch (e) {
            throw new Error(`Non-JSON on stdout (protocol corruption): ${line.slice(0, 200)}`);
        }
    }
    return { messages, remainder };
}

async function runSmoke() {
    const dbPath = makeTempDbPath();
    const serverPath = path.join(__dirname, 'durandal-mcp-server-v3.js');

    const child = spawn(process.execPath, [serverPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, DATABASE_PATH: dbPath, NO_UPDATE_CHECK: '1' }
    });

    let stdoutBuf = '';
    const inbox = [];
    let stdoutCorruption = null;
    const pendingResolvers = new Map();

    child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString('utf8');
        try {
            const { messages, remainder } = parseLines(stdoutBuf);
            stdoutBuf = remainder;
            for (const msg of messages) {
                if (msg.id !== undefined && pendingResolvers.has(msg.id)) {
                    pendingResolvers.get(msg.id)(msg);
                    pendingResolvers.delete(msg.id);
                } else {
                    inbox.push(msg);
                }
            }
        } catch (err) {
            stdoutCorruption = err.message;
        }
    });

    child.stderr.on('data', (chunk) => {
        if (process.env.SMOKE_VERBOSE) {
            process.stderr.write(`[server-stderr] ${chunk.toString('utf8')}`);
        }
    });

    let nextId = 1;
    function send(method, params = {}) {
        const id = nextId++;
        const msg = { jsonrpc: '2.0', id, method, params };
        return new Promise((resolve, reject) => {
            pendingResolvers.set(id, resolve);
            child.stdin.write(JSON.stringify(msg) + '\n');
            setTimeout(() => {
                if (pendingResolvers.has(id)) {
                    pendingResolvers.delete(id);
                    reject(new Error(`Timeout waiting for response to ${method}`));
                }
            }, 15000);
        });
    }

    const failures = [];
    try {
        // 1. Initialize
        const initResp = await send('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'smoke-test', version: '1.0.0' }
        });
        if (stdoutCorruption) failures.push(`Stdout corruption: ${stdoutCorruption}`);
        if (initResp.error) failures.push(`initialize error: ${JSON.stringify(initResp.error)}`);
        if (!initResp.result?.serverInfo) failures.push('initialize missing serverInfo');

        // Required notification after initialize
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

        // 2. List tools
        const listResp = await send('tools/list');
        if (listResp.error) failures.push(`tools/list error: ${JSON.stringify(listResp.error)}`);
        const toolNames = (listResp.result?.tools || []).map(t => t.name);
        for (const required of ['store_memory', 'search_memories', 'get_context', 'get_status']) {
            if (!toolNames.includes(required)) failures.push(`Missing tool: ${required}`);
        }

        // 3. store_memory roundtrip
        const uniqueText = `smoke-test-marker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const storeResp = await send('tools/call', {
            name: 'store_memory',
            arguments: {
                content: `The canary phrase is ${uniqueText}. Remember this exactly.`,
                metadata: { project: 'smoke', session: 'smoke-run', importance: 0.7 }
            }
        });
        if (storeResp.error) failures.push(`store_memory error: ${JSON.stringify(storeResp.error)}`);
        const storeText = storeResp.result?.content?.[0]?.text || '';
        // Extract numeric ID from the response text.
        const idMatch = storeText.match(/\*\*ID:\*\*\s*(\d+)/);
        if (!idMatch) failures.push(`store_memory response missing numeric ID: ${storeText.slice(0, 200)}`);
        const storedId = idMatch ? Number(idMatch[1]) : null;

        // 4. search_memories finds it
        const searchResp = await send('tools/call', {
            name: 'search_memories',
            arguments: { query: uniqueText, limit: 5 }
        });
        if (searchResp.error) failures.push(`search_memories error: ${JSON.stringify(searchResp.error)}`);
        const searchText = searchResp.result?.content?.[0]?.text || '';
        if (!searchText.includes(uniqueText)) {
            failures.push('search_memories did not find the stored canary phrase');
        }
        if (storedId !== null && !searchText.includes(`Memory ${storedId}`)) {
            failures.push(`search_memories did not return the stored id (${storedId})`);
        }

        // 5. get_status returns counts
        const statusResp = await send('tools/call', { name: 'get_status', arguments: {} });
        if (statusResp.error) failures.push(`get_status error: ${JSON.stringify(statusResp.error)}`);
        const statusText = statusResp.result?.content?.[0]?.text || '';
        if (!statusText.includes('Durandal MCP Server')) failures.push('get_status output missing server banner');

        // 6. get_context returns the memory we just stored
        const ctxResp = await send('tools/call', {
            name: 'get_context',
            arguments: { project: 'smoke', session: 'smoke-run', limit: 5 }
        });
        if (ctxResp.error) failures.push(`get_context error: ${JSON.stringify(ctxResp.error)}`);
        const ctxText = ctxResp.result?.content?.[0]?.text || '';
        if (!ctxText.includes(uniqueText)) failures.push('get_context did not include the stored canary');

        // 7. optimize_memory runs real DB ops (vacuum/analyze) and reports them
        const optResp = await send('tools/call', {
            name: 'optimize_memory',
            arguments: { operations: ['vacuum', 'analyze', 'integrity_check'] }
        });
        if (optResp.error) failures.push(`optimize_memory error: ${JSON.stringify(optResp.error)}`);
        const optText = optResp.result?.content?.[0]?.text || '';
        for (const expected of ['VACUUM completed', 'ANALYZE completed', 'integrity_check: ok']) {
            if (!optText.includes(expected)) failures.push(`optimize_memory missing "${expected}": ${optText.slice(0, 300)}`);
        }

        // 8. Importance filter works (search with a min-importance that excludes our 0.7 entry)
        const filteredResp = await send('tools/call', {
            name: 'search_memories',
            arguments: { query: uniqueText, filters: { importance_min: 0.9 } }
        });
        if (filteredResp.error) failures.push(`filtered search error: ${JSON.stringify(filteredResp.error)}`);
        const filteredText = filteredResp.result?.content?.[0]?.text || '';
        if (filteredText.includes(uniqueText)) {
            failures.push('search_memories importance_min=0.9 returned a 0.7-importance memory (filter not applied)');
        }

        // In SDK 1.29, Zod schemas validate at the MCP-SDK layer and return
        // isError:true responses with "expected X, received Y" language,
        // before our handler runs. The test now checks for isError rather
        // than matching our hand-rolled error text.
        const isValidationError = (resp, hint) => {
            const r = resp.result;
            return r?.isError === true && (hint ? JSON.stringify(r).includes(hint) : true);
        };

        // 9. Non-numeric importance_min
        const badFilterResp = await send('tools/call', {
            name: 'search_memories',
            arguments: { query: 'anything', filters: { importance_min: 'not-a-number' } }
        });
        if (!isValidationError(badFilterResp, 'importance_min')) {
            failures.push('search_memories did not reject non-numeric importance_min');
        }

        // 10. Metadata must be an object (not a string)
        const badMetaShape = await send('tools/call', {
            name: 'store_memory',
            arguments: { content: 'x', metadata: 'this is a string' }
        });
        if (!isValidationError(badMetaShape, 'metadata')) {
            failures.push('store_memory accepted non-object metadata');
        }

        // 11. Categories must be an array of strings (not a bare string)
        const badCategories = await send('tools/call', {
            name: 'store_memory',
            arguments: { content: 'x', metadata: { categories: 'not-an-array' } }
        });
        if (!isValidationError(badCategories, 'categories')) {
            failures.push('store_memory accepted non-array categories');
        }

        // 12. Phase 3 hardening: circular metadata caught with a clear error
        // (We can't actually send circular JSON over JSON-RPC — it can't be
        // serialized by the client. But we can send a massive object to hit
        // the size cap.)
        const hugeMeta = {};
        for (let i = 0; i < 5000; i++) hugeMeta[`k${i}`] = 'x'.repeat(100);
        const hugeResp = await send('tools/call', {
            name: 'store_memory',
            arguments: { content: 'x', metadata: hugeMeta }
        });
        const hugeText = hugeResp.result?.content?.[0]?.text || '';
        if (!hugeText.includes('metadata exceeds maximum size')) {
            failures.push('store_memory accepted oversized metadata');
        }

        // 13. LIKE wildcards in search query don't leak — searching for a unique
        // marker with % should NOT match unrelated rows.
        await send('tools/call', {
            name: 'store_memory',
            arguments: { content: 'progress is 100% complete', metadata: { project: 'esc' } }
        });
        await send('tools/call', {
            name: 'store_memory',
            arguments: { content: 'progress is ongoing', metadata: { project: 'esc' } }
        });
        const escResp = await send('tools/call', {
            name: 'search_memories',
            arguments: { query: '100%', filters: { project: 'esc' } }
        });
        const escText = escResp.result?.content?.[0]?.text || '';
        if (!escText.includes('100% complete')) {
            failures.push('search_memories did not return the "100% complete" entry');
        }
        if (escText.includes('progress is ongoing')) {
            failures.push('search_memories for "100%" matched an entry without a % sign (escape broken)');
        }

        // 14. Phase 4: get_memory and delete_memory round-trip.
        if (storedId !== null) {
            const getResp = await send('tools/call', {
                name: 'get_memory', arguments: { id: storedId }
            });
            const getText = getResp.result?.content?.[0]?.text || '';
            if (!getText.includes(uniqueText)) {
                failures.push(`get_memory did not return the stored canary for id=${storedId}`);
            }
            if (!getResp.result?.structuredContent?.found) {
                failures.push('get_memory missing structuredContent.found=true');
            }

            const delResp = await send('tools/call', {
                name: 'delete_memory', arguments: { id: storedId }
            });
            if (!delResp.result?.structuredContent?.deleted) {
                failures.push('delete_memory structuredContent missing deleted=true');
            }

            // Searching for it again should now find nothing.
            const aftergetResp = await send('tools/call', {
                name: 'search_memories', arguments: { query: uniqueText }
            });
            const aftergetText = aftergetResp.result?.content?.[0]?.text || '';
            if (aftergetText.includes(uniqueText)) {
                failures.push('delete_memory did not actually delete the row');
            }
        }

        // 15. Phase 4: structured content on store_memory includes id/project
        const probeStore = await send('tools/call', {
            name: 'store_memory',
            arguments: { content: 'probe-' + Date.now(), metadata: { project: 'probe' } }
        });
        const sc = probeStore.result?.structuredContent;
        if (!sc || typeof sc.id !== 'number' || sc.project !== 'probe') {
            failures.push('store_memory missing structuredContent.id/project');
        }

    } catch (err) {
        failures.push(`Exception: ${err.message}`);
    } finally {
        child.stdin.end();
        child.kill();
        try { fs.unlinkSync(dbPath); } catch (_) {}
    }

    if (stdoutCorruption) failures.push(`Stdout corruption detected at end: ${stdoutCorruption}`);

    if (failures.length) {
        console.error('[FAIL] MCP smoke test failures:');
        for (const f of failures) console.error('  -', f);
        process.exit(1);
    } else {
        console.log('[PASS] MCP stdio smoke test: all checks passed');
        process.exit(0);
    }
}

runSmoke().catch((err) => {
    console.error('[FAIL] Smoke test crashed:', err);
    process.exit(1);
});
