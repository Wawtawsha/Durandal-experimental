# Durandal Memory MCP — architecture and capabilities

A technical reference for what the server does and how. For install and
quickstart, see `README.md`.

---

## What it is

A Model Context Protocol (MCP) server that gives Claude Code persistent,
searchable memory across sessions. Single Node.js process, single SQLite
database, stdio transport. Zero-config: first run creates
`~/.durandal-mcp/durandal-mcp-memory.db` and a matching log directory.

---

## Wire shape

```
┌────────────────────────┐       stdin/stdout JSON-RPC        ┌──────────────────────┐
│   Claude Code client   │ ←───────────────────────────────→ │   durandal-mcp       │
└────────────────────────┘   (MCP 1.29 over stdio)           │   (this server)      │
                                                              │                      │
                                                              │   ┌──────────────┐   │
                                                              │   │ McpServer    │   │ tool dispatch, Zod validation
                                                              │   │ (SDK 1.29)   │   │ annotations, outputSchema
                                                              │   └──────┬───────┘   │
                                                              │          │           │
                                                              │   ┌──────▼───────┐   │
                                                              │   │ handlers     │   │ prepareStoredMetadata,
                                                              │   │ + wrapHandler│   │ MCP log notifications
                                                              │   └──────┬───────┘   │
                                                              │          │           │
                                                              │   ┌──────▼───────┐   │
                                                              │   │ DatabaseAdpt │   │ thin facade
                                                              │   └──────┬───────┘   │
                                                              │          │           │
                                                              │   ┌──────▼───────┐   │
                                                              │   │ MCPDbClient  │   │ SQLite + FTS5
                                                              │   └──────┬───────┘   │
                                                              │          │           │
                                                              │   ┌──────▼───────┐   │
                                                              │   │ ~/.durandal- │   │
                                                              │   │ mcp/*.db     │   │
                                                              │   └──────────────┘   │
                                                              └──────────────────────┘
```

Everything non-protocol (logs, DB discovery banners, update notifications)
is routed to **stderr**. stdout is exclusively JSON-RPC.

---

## Storage

Single SQLite file. One table, one FTS5 virtual table, three triggers.

```sql
CREATE TABLE memories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    content    TEXT NOT NULL,
    metadata   TEXT,              -- JSON: project, session, importance, categories, keywords, ...
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_memories_created_at ON memories(created_at);
CREATE INDEX idx_memories_project    ON memories(json_extract(metadata, '$.project')) WHERE ...;
CREATE INDEX idx_memories_session    ON memories(json_extract(metadata, '$.session')) WHERE ...;

CREATE VIRTUAL TABLE memories_fts USING fts5(
    content, content='memories', content_rowid='id', tokenize='porter unicode61'
);
-- + AFTER INSERT / AFTER DELETE / AFTER UPDATE triggers keeping FTS in sync
```

Databases created before FTS existed are backfilled automatically via
`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')` on first open.

---

## MCP surface

Capabilities advertised in `initialize`:

| Capability | Notes |
|---|---|
| `tools` (20)                  | All validated by Zod; many declare `outputSchema` for typed responses |
| `resources`                   | URI template `durandal://memory/{id}` + list of 100 most recent |
| `prompts`                     | One template: `summarize_recent_memories` |
| `logging`                     | Server emits `notifications/message` on every tool call |

Tool results always carry `content[]` (text) and, where useful, `structuredContent` (typed payload). Tools also declare annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so clients can show appropriate UI guardrails.

---

## Tools

### Core memory operations

| Tool | What | How |
|---|---|---|
| `store_memory`   | Persist one memory | Defaults `project`/`session`, stamps `created_at`, enforces 64 KB metadata cap, inserts, returns DB autoincrement id |
| `get_memory`     | Fetch one by id | Single parameterized SELECT; metadata parsed defensively (`_parseRow`) |
| `update_memory`  | Edit content and/or metadata in place | Preserves original `created_at`; 64 KB cap re-applied |
| `delete_memory`  | Delete one by id | DELETE WHERE id=?; FTS trigger removes the match |
| `search_memories`| Full-text search with filters | FTS5 MATCH with BM25 ranking + `snippet()` highlighting; query tokenized on `[^\p{L}\p{N}_]+` and AND-joined; post-filters `importance_min/max` and `categories` in JS; returns `total` count for pagination; falls back to LIKE (`ESCAPE '\'`) if FTS unavailable or query empties |
| `get_context`    | Recent memories for a project/session with stats | `getRecentMemories` + one aggregated `stats()` call (total + in-project count) |
| `list_memories`  | Paginated browse without a query | `WHERE project/session/since/until` + `ORDER BY created_at DESC LIMIT ? OFFSET ?`; parallel `COUNT(*)` for `total` |

### Bulk operations

| Tool | What | How |
|---|---|---|
| `store_memories_batch` | Insert N memories in one transaction | `BEGIN` + prepared statement looped + `COMMIT`, rolls back on any error |
| `export_memories`      | Dump every row as JSON | Single SELECT ordered by id; payload in `structuredContent` only (not inlined in text to keep response size sane) |
| `import_memories`      | Reload from an export payload | Runs each item through `prepareStoredMetadata(false)` (size cap only — preserves original `created_at` and defaults); produces non-fatal warnings for out-of-range values |
| `rename_project`       | Move every row under `from` to `to` | Single `UPDATE ... SET metadata = json_set(metadata, '$.project', ?)` — no row-by-row read |
| `delete_memories_where`| Bulk delete by filter | DELETE with at-least-one-filter guard; refuses unfiltered bulk deletes |
| `tag_memory`           | Add/remove categories | Reads existing metadata, set-unions add, set-removes remove, writes back — preserves all other fields |

### Discovery

| Tool | What | How |
|---|---|---|
| `find_similar`           | "More like this" given a memory id | Tokenizes the source's content, drops words under 3 chars, takes top 12, OR-joins them as an FTS query, excludes source id, BM25-ranks; LIKE fallback on first 64 chars if FTS unavailable |
| `list_projects_sessions` | Project/session summary with counts and samples | Single GROUP BY query for aggregates; samples via one batched `ROW_NUMBER() OVER (PARTITION BY ...)` query (not N+1) |

### Admin and maintenance

| Tool | What | How |
|---|---|---|
| `optimize_memory`   | Run SQLite maintenance | Dispatches `vacuum` / `analyze` / `integrity_check` / `wal_checkpoint`; reports size-before/size-after |
| `backup_database`   | Atomic snapshot | `VACUUM INTO 'path'` — consistent even under concurrent writes; no downtime |
| `get_status`        | Health + stats dashboard | Reads DB size + row counts via `stats()`, FTS availability flag, log paths, process metrics |
| `configure_logging` | Set log levels at runtime | Writes to `~/.durandal-mcp/.env` (same file server reads on startup); anchored `^KEY=...$` regex |
| `get_logs`          | Recent log entries | Streams log file via `readline` into a rolling ring buffer sized `max(lines×4, 100)`; avoids loading 10+ MB logs whole |

### Resources

| URI pattern | Produces | How |
|---|---|---|
| `durandal://memory/{id}` | JSON blob of one memory | Parses `id` as integer, validates positive, calls `getMemoryById`, returns `contents[].text` as pretty-printed JSON. `list()` returns the 100 most recent as resource descriptors. |

### Prompt templates

| Name | What | How |
|---|---|---|
| `summarize_recent_memories` | User-role prompt ready to send to Claude | Takes `project?` and `limit?`, fetches those recent rows, formats as a `role:user` message asking Claude to summarize and flag follow-ups |

---

## Request lifecycle

Every tool call flows through one wrapper (`wrapHandler`):

1. **Logger.startMCPTool** — record name, args, generate request id.
2. **MCP log notification** (`debug`, `tool_call_start`) — sent to client over protocol.
3. **Zod validation** happens before this wrapper runs (inside the SDK). Bad input returns `isError: true` with Zod's "expected X, received Y" text.
4. **Handler executes** — all DB access via `DatabaseAdapter` methods.
5. **Success path**: logger records completion + duration; MCP log (`info`, `tool_call_complete`).
6. **Error path**: `ErrorHandler.handle` wraps the error, attaches recovery hint from `errors.js` SQLITE-code-aware mapping; response is `{ isError: true, content: [{ type: 'text', text: '[ERR] … Recovery: …' }] }`; MCP log (`error`, `tool_call_error`).

Protocol log notifications are best-effort: a disconnected transport never aborts a handler.

---

## Startup sequence

```
┌────────────────────────────────────────────────────────────────────┐
│ 1. loadPersistedConfig()                                            │
│    reads ~/.durandal-mcp/.env, sets process.env defaults            │
├────────────────────────────────────────────────────────────────────┤
│ 2. new Logger(...)                                                  │
│    opens ~/.durandal-mcp/logs/durandal-YYYY-MM-DD.log (append)      │
│    rotates if > 10 MB                                               │
├────────────────────────────────────────────────────────────────────┤
│ 3. new McpServer(...)                                               │
│    declares tools/resources/prompts/logging capabilities            │
├────────────────────────────────────────────────────────────────────┤
│ 4. new DatabaseAdapter()                                            │
│    resolves DB path (DATABASE_PATH env > known locations > fresh)   │
│    opens sqlite3 handle, exposes `ready` promise                    │
│    initializes schema + FTS triggers + backfills FTS if needed      │
├────────────────────────────────────────────────────────────────────┤
│ 5. this.ready = runDatabaseStartupCheck()                           │
│    connectivity → schema → read/write → integrity_check (awaited    │
│    by anything that needs ordering; failures flag but don't abort)  │
├────────────────────────────────────────────────────────────────────┤
│ 6. registerTools() — all 20 + resource template + prompt template   │
├────────────────────────────────────────────────────────────────────┤
│ 7. server.connect(stdio transport) — start serving                  │
├────────────────────────────────────────────────────────────────────┤
│ 8. checkForUpdates() — fire-and-forget; notifies via stderr only    │
└────────────────────────────────────────────────────────────────────┘
```

Shutdown: idempotent, awaits in-flight startup check, runs
`PRAGMA wal_checkpoint(TRUNCATE)` so the `-wal` sibling doesn't grow
forever, closes handles, exits 0 (or 1 for `uncaughtException`).

---

## Configuration

All optional.

| Variable | Default | Effect |
|---|---|---|
| `DATABASE_PATH`     | `~/.durandal-mcp/durandal-mcp-memory.db` | Override DB location |
| `CONSOLE_LOG_LEVEL` | `warn`                                    | Terminal output level |
| `FILE_LOG_LEVEL`    | `info`                                    | File log detail level |
| `LOG_LEVEL`         | —                                         | Legacy: sets both |
| `LOG_FILE`          | `~/.durandal-mcp/logs/durandal-YYYY-MM-DD.log` | Override log path |
| `ERROR_LOG_FILE`    | —                                         | Optional separate error log |
| `VERBOSE`           | `false`                                   | Include full meta in logs |
| `DEBUG`             | `false`                                   | Force debug level |
| `LOG_MCP_TOOLS`     | `false`                                   | Log every tool call with args |
| `NO_UPDATE_CHECK`   | `false`                                   | Skip npm-registry check |

Persisted config file: `~/.durandal-mcp/.env` (same format, keys NOT overridden if already in `process.env`).

CLI: `--help`, `--version`, `--test`, `--status`, `--discover`, `--migrate`, `--configure`, `--update`, `--debug`, `--verbose`, `--log-file <path>`, `--log-level <lvl>`.

---

## Safety invariants

Guarantees enforced at the code level:

- **stdout is JSON-RPC only.** Every log, every DB banner, every update notification routes to stderr.
- **Metadata must be a plain object, serializable, ≤ 64 KB.** Rejected otherwise.
- **`content` ≤ 50,000 characters.** Rejected otherwise.
- **Circular-reference metadata** is caught and returns a clean ValidationError.
- **Corrupt metadata in one row** does not wipe the result set — `_parseRow` returns `{ _corrupt: true }` for that row and moves on.
- **LIKE wildcards in user queries** are escaped (`\%`, `\_`, `\\`) — "100%" doesn't match "anything with anything".
- **Unfiltered bulk deletes refused** at the DB layer.
- **VACUUM INTO destination** must not contain single quotes.
- **Shutdown is idempotent**, runs WAL checkpoint, exits nonzero on uncaught exceptions.
- **`npm test` runs against a temp DB** in OS temp dir (set via `DATABASE_PATH` before any client is constructed) — cannot pollute the user's real memory.

---

## Files

```
durandal-mcp-server-v3.js     main entry: MCP server + CLI commands
db-adapter.js                 thin facade over MCPDatabaseClient
mcp-db-client.js              SQLite + FTS5 + all DB primitives
logger.js                     stderr-only console, JSON-lines file, rotation
errors.js                     MCPError + subclasses + SQLITE-code-aware recovery hints
test-runner.js                `npm test` — 9 isolated unit tests
test-mcp-smoke.js             end-to-end stdio JSON-RPC test, ~32 scenarios
update-checker.js             npm-registry polling, stderr-routed notifications
db-discovery.js               `--discover` — filesystem search for legacy DBs
db-migrate.js                 `--migrate` — merges multiple DBs into the canonical one
assign-projects.js            CLI: retroactively label orphaned memories
.env.mcp-minimal              example config template
mcp-bundle.json               MCP metadata for bundler discovery
legacy/                       pre-v3 app, design docs, old integration tests — not in the npm package
```

---

## Testing

Two layers, both runnable with zero external setup.

**`npm test`** (`test-runner.js`): 9 unit tests. Points `DATABASE_PATH` at a fresh file in OS temp dir for isolation, cleans up (incl. `-wal`/`-shm` siblings) at the end. Covers DB connection, schema, store/search/recent, cache, MCP tool registry, error types, perf sanity.

**`node test-mcp-smoke.js`**: spawns the server as a subprocess, speaks raw JSON-RPC over stdin/stdout, verifies ~32 scenarios. Catches things unit tests can't: stdout pollution, Zod validation surfaces, structuredContent shape, FTS tokenization, LIKE-escape, resource/prompt registration, new-tool round-trips (`find_similar`, `tag_memory`, `backup_database`, etc.).

---

## Not in scope

Things deliberately absent:

- **No cross-process sync.** One server, one DB file. Multiple instances on the same file will rely on SQLite locking.
- **No retention policy.** DB grows until you run `delete_memories_where` or `delete_memory`. No TTL, no auto-purge.
- **No embedding-based semantic search.** FTS5 + BM25 is lexical. "react" and "React.js" both match; "frontend framework" won't match "react" automatically.
- **No multi-tenant isolation.** Metadata has a `project` field but the DB is shared. Use separate `DATABASE_PATH` per tenant if you need hard isolation.
- **No HTTP transport.** Stdio only. Adding SSE/streamable-HTTP would be a small change (SDK ships transports) but hasn't been done.
