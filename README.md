# Durandal Memory MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)

**Zero-config, local-only AI memory for Claude Code — with hybrid lexical +
semantic search.**

Give Claude Code persistent memory across sessions. Store things, then find them
again whether you remember the exact words or not. Searching *"compilation
failing"* will surface a memory that says *"the build is broken"* — semantic
recall that plain keyword search can't do — while exact tokens (error codes,
file paths, identifiers) still match precisely.

Everything runs on your machine. **No API keys. No cloud. No per-use cost.**

## Quick Start

### 1. Install
```bash
npm install -g durandal-memory-mcp
```

### 2. Add to Claude Code
```bash
# Windows
claude mcp add durandal-memory -- cmd /c durandal-mcp
# macOS/Linux
claude mcp add durandal-memory -- durandal-mcp
```

### 3. Verify
```bash
claude mcp list   # should show: durandal-memory: ... - Connected
```

That's it. On first use the server creates its SQLite database and downloads a
small (~23 MB) embedding model once; after that it works fully offline.

> Requires **Node.js ≥ 20**.

## How it works

- **Hybrid retrieval.** Every search runs two engines and fuses them with
  Reciprocal Rank Fusion: SQLite **FTS5/BM25** for exact lexical matches, and a
  local **embedding model** (`all-MiniLM-L6-v2`) with **sqlite-vec** cosine
  search for meaning. You get exact-token precision *and* paraphrase recall.
- **Write-time consolidation.** Storing a near-duplicate of an existing memory
  marks the older one *superseded* — hidden from results, never deleted, and
  reported back — so restated facts don't pile up.
- **Graceful by design.** If the embedding model can't load (e.g. offline on the
  very first run), the server automatically falls back to lexical-only search.
  It is never worse than a plain full-text store.
- **Local & private.** All data and the model stay on your machine.

## How to use

Just talk to Claude Code naturally — it calls the tools for you:

- *"Remember that I prefer React with TypeScript."*
- *"What do you remember about my deployment setup?"*
- *"Did we hit a database error last week? Search my memories."*
- *"What context do you have on this project?"*

## MCP Tools

**Core:** `store_memory`, `search_memories` (hybrid), `get_context`,
`get_memory`, `update_memory`, `delete_memory`, `list_memories`

**Bulk:** `store_memories_batch`, `export_memories`, `import_memories`,
`rename_project`, `delete_memories_where`

**Discovery:** `find_similar` (semantic), `suggest_consolidations` (review similar memories for cleanup), `list_projects_sessions`, `tag_memory`

**Admin:** `optimize_memory` (vacuum/analyze/integrity_check/wal_checkpoint/
backfill_embeddings), `backup_database`, `get_status`, `configure_logging`,
`get_logs`

Memories are also addressable as the MCP resource `durandal://memory/{id}`, and a
`summarize_recent_memories` prompt is provided.

## Configuration (all optional)

The server is zero-config. To customise, set environment variables:

```bash
DATABASE_PATH=./my-memory.db          # database location
DURANDAL_EMBEDDINGS=false             # force lexical-only (skip the model)
DURANDAL_EMBED_MODEL=Xenova/bge-small-en-v1.5   # swap the embedding model
DURANDAL_SEMANTIC_MIN_SIM=0.35        # min similarity for a semantic match
DURANDAL_DEDUP_DISTANCE=0.08          # near-duplicate consolidation threshold
CONSOLE_LOG_LEVEL=warn                # error | warn | info | debug
```

See `.env.mcp-minimal` for the full list.

## CLI

```bash
durandal-mcp --status     # health, database stats, semantic-search status
durandal-mcp --test       # run the built-in test suite
durandal-mcp --version
durandal-mcp --help
```

## Upgrading from v3

v4 reads a v3 database in place — the schema is migrated non-destructively on
first open (new columns added, FTS rebuilt if needed). Your existing memories
keep working immediately with lexical search. To add semantic search over them,
run the `backfill_embeddings` operation once:

> *"Optimize my memory and backfill embeddings."*

(or call `optimize_memory` with the `backfill_embeddings` operation). New
memories are embedded automatically.

## Troubleshooting

**Not connecting?** `claude mcp remove durandal-memory` then re-add; check
`claude mcp list`.

**Semantic search shows as OFF in `--status`?** The embedding model couldn't
load (often no network on first run, or a blocked download). The server still
works with lexical search; it will retry the model on the next start. Force
lexical-only permanently with `DURANDAL_EMBEDDINGS=false`.

**Logs:** `~/.durandal-mcp/logs/durandal-YYYY-MM-DD.log`, or the `get_logs` tool.

## Requirements

- Node.js ≥ 20
- Claude Code (latest)
- Windows, macOS, or Linux (x64; the vector extension ships x64 binaries)

## Support

- Issues/Feedback: stephen.leonard@entdna.com

## License

MIT — see [LICENSE](LICENSE).

---

**Zero-config, local, hybrid-search memory for Claude Code.**
