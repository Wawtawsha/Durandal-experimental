# Durandal Memory MCP Server

[![NPM Version](https://img.shields.io/npm/v/durandal-memory-mcp.svg)](https://npmjs.org/package/durandal-memory-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

**Zero-config AI memory system for Claude Code via Model Context Protocol (MCP)**

Give Claude Code persistent memory that remembers across sessions. Store information, search memories, and maintain context automatically.

## Quick Start

### 1. Install
```bash
npm install -g durandal-memory-mcp
```

### 2. Add to Claude Code
```bash
# For Windows
claude mcp add durandal-memory -- cmd /c durandal-mcp

# For macOS/Linux
claude mcp add durandal-memory -- durandal-mcp
```

### 3. Verify Setup
```bash
claude mcp list
# Should show: durandal-memory: ... - Connected
```

**That's it!** No configuration files, no API keys, no database setup required.

## How to Use

Just talk naturally to Claude Code. The memory system activates automatically:

### Store Memories
- *"Remember that I prefer React with TypeScript"*
- *"Store this API endpoint for later: https://api.example.com"*
- *"I need you to remember my coding style preferences"*

### Retrieve Memories
- *"What do you remember about my preferences?"*
- *"Search my memories for React"*
- *"Do you recall anything about TypeScript?"*

### Get Context
- *"What context do you have about this project?"*
- *"Show me recent memories"*
- *"What's in my memory system?"*

### Optimize Memory
- *"Optimize my memories"*
- *"Clean up memory storage"*

## Features

- **Persistent memory** across Claude Code sessions.
- **Full-text search** (SQLite FTS5) with BM25 relevance ranking and
  snippet highlighting — `"react typescript"` correctly matches rows with
  both tokens.
- **Zero configuration** — SQLite database is created automatically at
  `~/.durandal-mcp/durandal-mcp-memory.db` on first use.
- **Structured tool responses** — every tool returns `structuredContent`
  alongside text for typed clients.
- **MCP resources and prompts** — memories are also addressable via
  `durandal://memory/{id}` and come with a ready-made summarization prompt.
- **Safe by default** — bulk deletes require a filter, metadata is size-
  capped and type-checked, one corrupt row can't wipe your result set.
- **Local-only** — all data stays on your machine.

## MCP Tools Available

The server exposes the following tools to Claude Code:

**Core memory operations**
- `store_memory(content, metadata?)` — store a memory; returns the new id.
- `get_memory(id)` — fetch one memory by id.
- `update_memory(id, content?, metadata?)` — edit an existing memory.
- `delete_memory(id)` — delete one memory.
- `search_memories(query, filters?, limit?)` — full-text search with BM25
  relevance ranking (tokenized AND-match; `"react typescript"` requires both).
- `get_context(project?, session?, limit?, include_stats?)` — recent memories
  scoped to a project/session.
- `list_memories(project?, session?, since?, until?, limit, offset)` —
  paginated browse without a search query.

**Bulk operations**
- `store_memories_batch(items)` — transactional bulk insert.
- `export_memories()` — dump all memories as JSON for backup.
- `import_memories(items)` — insert memories from a JSON array.
- `rename_project(from, to)` — rename a project across all rows.
- `delete_memories_where(project?, session?, older_than?)` — bulk delete
  (requires at least one filter).

**Maintenance and admin**
- `optimize_memory(operations)` — run SQLite maintenance
  (`vacuum`, `analyze`, `integrity_check`, `wal_checkpoint`).
- `backup_database(destination)` — atomic snapshot via `VACUUM INTO`.
- `get_status()` — server status, database stats, FTS availability.
- `list_projects_sessions(type?, include_samples?, limit?)` — summary of
  distinct projects and sessions.
- `configure_logging(console_level?, file_level?)` — runtime log level.
- `get_logs(lines?, level_filter?, search?)` — recent log entries.

**MCP resources and prompts**
- Resource template `durandal://memory/{id}` — URI-addressable memories.
- Prompt `summarize_recent_memories(project?, limit?)` — ready-made prompt
  that embeds recent memories for Claude to summarize.

## File Structure

After installation, the server creates:
- `durandal-mcp-memory.db` - SQLite database (auto-created)
- `~/.durandal-mcp/logs/` - Session history logs (auto-created)
- Memory data organized by:
  - Content and metadata
  - Categories and keywords
  - Importance scores
  - Timestamps

## Configuration (Optional)

The system works with zero configuration, but you can customize:

```bash
# Copy the minimal config template
cp node_modules/durandal-memory-mcp/.env.mcp-minimal .env

# Edit if needed (all settings are optional):
DATABASE_PATH=./my-custom-memory.db
CONSOLE_LOG_LEVEL=warn  # Terminal output: error, warn, info, debug
FILE_LOG_LEVEL=info     # Log file detail: error, warn, info, debug
```

## Advanced Usage

### Check Server Status
```bash
durandal-mcp --help
```

### Run Standalone Test
```bash
durandal-mcp --test
```

### Configure Logging Levels
```bash
durandal-mcp --configure
```

### Different Working Directory
The MCP server creates its database in the current working directory where Claude Code is running.

## Troubleshooting

### MCP Server Not Connecting
```bash
# Check if server is configured
claude mcp list

# Remove and re-add if needed
claude mcp remove durandal-memory
claude mcp add durandal-memory -- cmd /c durandal-mcp
```

### Database Issues
```bash
# The database is auto-created, but if you have permission issues:
# Make sure the directory is writable
# Delete the .db file to recreate: rm durandal-mcp-memory.db
```

### Memory Not Working
- Make sure you're using natural language (not technical commands)
- Try: *"Remember this:"* followed by your content
- Check that Claude Code shows the MCP server as connected

### Debugging Issues
- Session logs are stored at: `~/.durandal-mcp/logs/durandal-YYYY-MM-DD.log`
- Send log files to support for assistance
- Use `get_logs` MCP tool to retrieve recent entries
- Configure log levels with `configure_logging` MCP tool

## Requirements

- **Node.js**: 18.0.0 or higher
- **Claude Code**: Latest version
- **Operating System**: Windows, macOS, or Linux

## Support

- **Issues/Feedback**: stephen.leonard@entdna.com

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

**Zero-config persistent memory for Claude Code**