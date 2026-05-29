# Durandal Memory MCP — architecture and capabilities (v4)

A technical reference for what the server does and how. For install and
quickstart, see `README.md`.

---

## What it is

A Model Context Protocol (MCP) server that gives Claude Code persistent,
**hybrid-searchable** memory across sessions. Single Node.js process, single
SQLite database, stdio transport. Zero-config: first run creates
`~/.durandal-mcp/durandal-mcp-memory.db`, a log directory, and (on first
embedding) downloads a small local embedding model to `~/.durandal-mcp/.model-cache`.

Retrieval is **hybrid**: lexical full-text (SQLite FTS5 / BM25) and semantic
(local embeddings + cosine KNN via `sqlite-vec`) candidate lists are fused with
Reciprocal Rank Fusion. Lexical nails exact tokens (identifiers, error strings,
file paths); semantic catches paraphrase — searching `"compilation failing"`
finds a memory that says `"the build is broken"`, which lexical search alone
never would.

Writes are **consolidated**: a new memory that is a near-duplicate of an
existing one (same project, cosine distance ≤ a conservative threshold) marks
the older one *superseded* — hidden from results, never deleted, and reported
back to the caller. This is the "selective attention" the project always
intended, implemented as a curation layer rather than a cache.

**Everything is local.** No API keys, no network after the one-time model
download, no per-operation cost. The embedding model runs on CPU.

---

## Wire shape

```
┌────────────────────────┐       stdin/stdout JSON-RPC        ┌──────────────────────┐
│   Claude Code client   │ ←───────────────────────────────→ │   durandal-mcp        │
└────────────────────────┘   (MCP 1.29 over stdio)           │   (this server)       │
                                                              │   ┌──────────────┐    │
                                                              │   │ McpServer    │    │ tool dispatch, Zod
                                                              │   │ (SDK 1.29)   │    │ validation, outputSchema
                                                              │   └──────┬───────┘    │
                                                              │   ┌──────▼───────┐    │
                                                              │   │ handlers     │    │ wrapHandler: logging,
                                                              │   │ + wrapHandler│    │ MCP log notifications
                                                              │   └──────┬───────┘    │
                                                              │   ┌──────▼───────┐    │
                                                              │   │ MemoryDB     │    │ hybrid search + consolidation
                                                              │   │ (db.js)      │    │
                                                              │   └──┬────────┬──┘    │
                                                              │      │        │       │
                                                              │  ┌───▼──┐  ┌──▼─────┐ │
                                                              │  │better│  │Embedder│ │ all-MiniLM-L6-v2
                                                              │  │sqlite│  │(local) │ │ (transformers.js)
                                                              │  │ +vec │  └────────┘ │
                                                              │  │ +fts │             │
                                                              │  └──┬───┘             │
                                                              │  ┌──▼──────────┐      │
                                                              │  │ ~/.durandal-│      │
                                                              │  │ mcp/*.db    │      │
                                                              │  └─────────────┘      │
                                                              └──────────────────────┘
```

Everything non-protocol (logs, DB banners, model-load messages, update
notifications) is routed to **stderr**. stdout is exclusively JSON-RPC.

---

## Storage

Single SQLite file. One source-of-truth table, one FTS5 virtual table, one
`sqlite-vec` vector table, three FTS sync triggers.

```sql
CREATE TABLE memories (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    content       TEXT NOT NULL,
    metadata      TEXT,              -- JSON: project, session, importance, categories, keywords, ...
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME,          -- stamped on insert/update
    superseded_by INTEGER            -- id of the memory that replaced this one; NULL = active
);
CREATE INDEX idx_memories_created_at ON memories(created_at);
CREATE INDEX idx_memories_superseded ON memories(superseded_by);
CREATE INDEX idx_memories_project    ON memories(json_extract(metadata,'$.project')) WHERE ...;
CREATE INDEX idx_memories_session    ON memories(json_extract(metadata,'$.session')) WHERE ...;

CREATE VIRTUAL TABLE memories_fts USING fts5(
    content, content='memories', content_rowid='id', tokenize='porter unicode61'
);
-- + AFTER INSERT / DELETE / UPDATE triggers keep FTS in sync

CREATE VIRTUAL TABLE vec_memories USING vec0(   -- only if sqlite-vec loads
    memory_id INTEGER PRIMARY KEY,               -- == memories.id
    embedding FLOAT[384] distance_metric=cosine, -- all-MiniLM-L6-v2
    project   TEXT                               -- for same-project consolidation KNN
);
```

The `memories` table is the single source of truth. The FTS and vector tables
are indexes over it; `superseded_by` (and all metadata filters) are always
re-checked against `memories` when assembling results, so the indexes can never
return a stale or superseded row.

Pre-v4 databases (which had only `id/content/metadata/created_at`) are migrated
non-destructively on first open: `updated_at` and `superseded_by` are added via
`ALTER TABLE`, the FTS index is backfilled if empty, and existing rows can be
embedded on demand with the `backfill_embeddings` optimize operation.

---

## Retrieval: hybrid search

`search_memories(query, filters?, limit?)`:

1. **Lexical candidates** — FTS5 `MATCH` with BM25 ranking + `snippet()`
   highlighting, restricted to active rows and the metadata filters (in SQL).
   Query tokenized on `[^\p{L}\p{N}_]+`, AND-joined.
2. **Semantic candidates** — embed the query, KNN over `vec_memories` (cosine),
   keep only hits with similarity ≥ `SEMANTIC_MIN_SIM` (default 0.35) so a small
   store doesn't return everything just because vectors always have a nearest
   point.
3. **Fusion** — the two ranked id-lists are combined with Reciprocal Rank Fusion
   (`score = Σ 1/(k + rank)`, `k=60`). With one signal present this reduces to
   that signal's order.
4. **Fetch + filter** — full rows for the fused ids are fetched in one query that
   re-applies *all* filters and `superseded_by IS NULL`. Each result is tagged
   with the `signals` that matched (`lexical` / `semantic` / `substring`).
5. **Tiebreak** — near-equal fused scores are broken by importance, then recency.

`total` is the count of **lexical matches passing the filters** — a well-defined
pagination number. (Semantic neighbours can add related results within the
returned window; "total semantic matches" is not well-defined since everything
has *some* cosine similarity.)

**Fallbacks, in order:** FTS unavailable → LIKE substring (wildcards escaped).
Query tokenizes to nothing and no embeddings → LIKE. Embeddings unavailable →
lexical only. **The server is never worse than a pure FTS5/BM25 store.**

---

## Writes: consolidation

`store_memory`:

1. Embed the content (before any transaction — better-sqlite3 transactions are
   synchronous).
2. In one transaction: insert the row; insert its embedding; find the nearest
   *active, same-project* neighbour; if its cosine distance ≤ `NEAR_DUP_DISTANCE`
   (default 0.08 ≈ similarity 0.92), set that neighbour's `superseded_by` to the
   new id.
3. Return the new id and the superseded id (if any).

Consolidation is conservative and **reversible** — superseded rows are retained
(fetchable by id, restored if their superseder is deleted) and the action is
always reported. It exists to stop near-duplicate / restated facts from piling
up, not to make irreversible judgements. Contradiction detection beyond near-
duplication is intentionally out of scope (it would require an LLM in the write
path; see "Not in scope").

---

## MCP surface

| Capability | Notes |
|---|---|
| `tools` (20)  | Zod-validated; many declare `outputSchema` for typed responses |
| `resources`   | `durandal://memory/{id}` + list of 100 most recent |
| `prompts`     | `summarize_recent_memories` |
| `logging`     | `notifications/message` emitted per tool call |

### Tools

**Core:** `store_memory` (embed + consolidate), `search_memories` (hybrid),
`get_context`, `get_memory`, `update_memory` (re-embeds on content change),
`delete_memory` (removes the vector too), `list_memories`.

**Bulk:** `store_memories_batch` (embeds the batch; skips consolidation),
`export_memories` (lossless — includes superseded), `import_memories`,
`rename_project`, `delete_memories_where` (filter required).

**Discovery:** `find_similar` (semantic KNN, lexical fallback),
`list_projects_sessions`, `tag_memory`.

**Admin:** `optimize_memory` (`vacuum`/`analyze`/`integrity_check`/
`wal_checkpoint`/`backfill_embeddings`), `backup_database` (`VACUUM INTO`),
`get_status` (now includes semantic-search health + vector count),
`configure_logging`, `get_logs`.

---

## Configuration

All optional.

| Variable | Default | Effect |
|---|---|---|
| `DATABASE_PATH`            | `~/.durandal-mcp/durandal-mcp-memory.db` | DB location |
| `DURANDAL_EMBEDDINGS`      | `true`                | Set `false` to force lexical-only |
| `DURANDAL_EMBED_MODEL`     | `Xenova/all-MiniLM-L6-v2` | Embedding model id |
| `DURANDAL_SEMANTIC_MIN_SIM`| `0.35`                | Min cosine similarity for a semantic hit |
| `DURANDAL_DEDUP_DISTANCE`  | `0.08`                | Max cosine distance to treat as a near-duplicate |
| `DURANDAL_SEARCH_POOL`     | `50`                  | Candidate pool size per signal |
| `DURANDAL_RRF_K`           | `60`                  | RRF constant |
| `CONSOLE_LOG_LEVEL`        | `warn`                | Terminal output level (→ stderr) |
| `FILE_LOG_LEVEL`           | `info`                | File log detail |
| `NO_UPDATE_CHECK`          | `false`               | Skip npm-registry check |

CLI: `--help`, `--version`, `--test`, `--status`, `--discover`, `--migrate`,
`--configure`, `--update`, `--debug`, `--verbose`, `--log-file`, `--log-level`.

---

## Safety invariants

- **stdout is JSON-RPC only.** Logs, banners, model-load messages, update
  notifications all go to stderr. The embedder sets transformers.js `logLevel`
  to silent and never passes a progress callback.
- **Never worse than v3.** Every semantic path degrades to lexical if
  `sqlite-vec` or the embedding model is unavailable.
- **Metadata ≤ 64 KB, plain serializable object.** Rejected otherwise.
- **`content` ≤ 50,000 characters.**
- **Corrupt metadata in one row** degrades to `{ _corrupt: true }` for that row
  only; it never wipes a result set.
- **All user values are parameterized.** LIKE wildcards (`% _ \`) are escaped.
- **Vectors** are bound as little-endian float32 `Buffer`s; vec0 primary keys as
  `BigInt`.
- **Consolidation never deletes.** Superseding is reversible and reported.
- **Unfiltered bulk deletes refused.** `VACUUM INTO` destination must not contain
  single quotes.
- **Search failures throw** (the handler surfaces an error) rather than silently
  returning `[]` — you can tell "no matches" from "something broke".
- **`npm test` runs against a temp DB** in the OS temp dir; it can't touch the
  user's real memory.

---

## Files

```
durandal-mcp-server.js   main entry: MCP server + CLI commands
db.js                    MemoryDB: better-sqlite3 + FTS5 + sqlite-vec, hybrid search, consolidation
embeddings.js            local embedding provider (transformers.js, lazy singleton, graceful)
logger.js                stderr-only console, JSON-lines file, rotation
errors.js                MCPError + subclasses + SQLITE-code-aware recovery hints
update-checker.js        npm-registry polling, stderr-routed
test-runner.js           `npm test` — behavioural unit tests (incl. semantic recall)
test-mcp-smoke.js        end-to-end stdio JSON-RPC test, ~32 scenarios
db-discovery.js          --discover: filesystem search for legacy DBs
db-migrate.js            --migrate: merge multiple DBs into the canonical one
assign-projects.js       CLI: retroactively label orphaned memories
legacy/                  pre-v4 app + the removed RAMR cache — not in the npm package
```

---

## Dependencies

| Package | Why |
|---|---|
| `@modelcontextprotocol/sdk` | MCP server/transport |
| `better-sqlite3`            | Synchronous SQLite (replaces node-sqlite3; first-class extension loading) |
| `sqlite-vec`                | Vector search (`vec0`) inside the same SQLite file |
| `@huggingface/transformers` | Local CPU embeddings (all-MiniLM-L6-v2), no API |

Requires Node ≥ 20 (better-sqlite3 prebuilt binaries).

---

## Not in scope

- **No LLM in the write path.** Consolidation is near-duplicate detection, not
  LLM-judged contradiction resolution. Storage stays verbatim, deterministic,
  and free of extraction errors.
- **No cross-process sync.** One server, one DB file; multiple instances rely on
  SQLite/WAL locking.
- **No TTL / auto-purge.** Superseded rows are retained until explicitly deleted.
- **No HTTP transport.** Stdio only.
- **No reranker.** The hybrid pipeline is BM25 ⊕ vector via RRF; a cross-encoder
  reranking stage is a possible future addition.
```
