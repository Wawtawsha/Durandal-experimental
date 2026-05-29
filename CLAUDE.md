# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

**Durandal Memory MCP** (`durandal-memory-mcp`, v4) is a zero-config Model
Context Protocol server that gives Claude Code persistent, **hybrid-searchable**
memory across sessions. It stores memories in a single SQLite file and retrieves
them by fusing **lexical** full-text search (FTS5/BM25) with **semantic** search
(local embeddings + `sqlite-vec` cosine KNN). Writes are **consolidated**:
near-duplicate memories supersede older ones (hidden, not deleted).

Everything is local — no API keys, no network after a one-time embedding-model
download, no per-operation cost.

## Development Commands

- `npm start` / `node durandal-mcp-server.js` — start the MCP server (stdio)
- `npm test` — behavioural unit suite (runs against a temp DB; safe)
- `npm run test:smoke` / `node test-mcp-smoke.js` — end-to-end stdio JSON-RPC test
- `durandal-mcp` — installed global CLI

Add to Claude Code: `claude mcp add durandal-memory -- cmd /c durandal-mcp`
(Windows) or `claude mcp add durandal-memory -- durandal-mcp` (macOS/Linux).

## Architecture

- **`durandal-mcp-server.js`** — MCP server: registers 20 tools (Zod-validated),
  resources, and a prompt; `wrapHandler` does uniform logging + error wrapping +
  MCP log notifications; also the admin CLI (`--test`, `--status`, etc.).
- **`db.js` (`MemoryDB`)** — the engine. better-sqlite3 (synchronous) + FTS5 +
  sqlite-vec. Owns: storage primitives, hybrid search (RRF fusion), write-time
  consolidation, non-destructive schema migration, stats/admin. Holds an `Embedder`.
- **`embeddings.js` (`Embedder`)** — local CPU embeddings via transformers.js
  (`all-MiniLM-L6-v2`, 384-d). Lazy singleton; returns `null` when unavailable.
- **`logger.js`** — stderr-only console + JSON-lines file logging with rotation.
- **`errors.js`** — `MCPError` hierarchy + SQLite-code-aware recovery hints.

## Schema (single SQLite file)

```sql
memories(id, content, metadata TEXT, created_at, updated_at, superseded_by)
memories_fts  -- FTS5 external-content index (+ 3 sync triggers)
vec_memories  -- sqlite-vec vec0(memory_id, embedding FLOAT[384] cosine, project), if vec loads
```

`memories` is the source of truth. `importance`, `categories`, `keywords`,
`project`, `session` live inside the `metadata` JSON — they are NOT columns.
Filters and `superseded_by` are always re-checked against `memories`, so the FTS
and vector indexes can't return stale/superseded rows.

## Environment Variables (all optional)

- `DATABASE_PATH` — DB location (default `~/.durandal-mcp/durandal-mcp-memory.db`)
- `DURANDAL_EMBEDDINGS` — `false` forces lexical-only
- `DURANDAL_EMBED_MODEL` — embedding model id (default `Xenova/all-MiniLM-L6-v2`)
- `DURANDAL_SEMANTIC_MIN_SIM` — min cosine similarity for a semantic hit (0.35)
- `DURANDAL_DEDUP_DISTANCE` — max cosine distance for near-duplicate consolidation (0.08)
- `CONSOLE_LOG_LEVEL` / `FILE_LOG_LEVEL` — log levels
- `NO_UPDATE_CHECK` — skip npm-registry update check

## Invariants — DO NOT break these

- **stdout is JSON-RPC only.** All logs/banners/model-load output go to stderr.
  The embedder sets transformers.js `logLevel` silent and passes no progress
  callback. Never `console.log` from server/db code.
- **Never worse than lexical.** Every semantic path must degrade gracefully when
  `vecAvailable` or `embedder.available` is false. Null-check every embedding.
- **No theater.** Every feature must measurably change behaviour and have a test.
  (The v3 "RAMR cache" was knobs wired to nothing; it was correctly removed.)
- **better-sqlite3 transactions are synchronous** — never `await` inside a
  `db.transaction(...)` callback. Compute embeddings before the transaction.
- **Verbatim storage.** No LLM in the write path; consolidation is near-duplicate
  detection only and is reversible (superseded rows are retained).

## Testing

`npm test` (`test-runner.js`) asserts real behaviour: lexical search, **semantic
recall** (paraphrase finds unrelated wording), consolidation/supersede, SQL-level
filters with filter-aware totals, and graceful degradation with embeddings off.
Semantic tests SKIP (don't fail) if the model can't load. `test-mcp-smoke.js`
spawns the server and exercises ~32 scenarios over raw JSON-RPC, including
stdout-purity.

## legacy/

`legacy/` holds the pre-v4 application (the original RAMR/context-manager
assistant) and design docs. It is NOT shipped in the npm package and is not on
the server's code path. The old in-memory "RAMR cache" was removed deliberately —
it cached cheap local computation, not the expensive work, and was never wired
to its consumer. The valuable idea (selective attention) lives now as the
consolidation + hybrid-ranking layer, not as a cache.
