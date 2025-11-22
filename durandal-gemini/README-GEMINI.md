# Durandal MCP Server - Multi-Client Support (v4.0.0-gemini)

## 🎉 Now Supporting Google Gemini!

The Durandal MCP Server now supports multiple AI clients through a flexible transport layer. Connect from Claude Code, Google Gemini, or both simultaneously!

## Quick Start

### For Claude Code Users (No Changes!)
```bash
# Install as usual
npm install -g durandal-memory-mcp

# Use with Claude Code
claude mcp add durandal-memory -- durandal-mcp
```

### For Google Gemini Users (NEW!)
```bash
# Install the multi-client version
npm install -g durandal-memory-mcp@4.0.0-gemini

# Start server for Gemini
MCP_TRANSPORT=http MCP_CLIENT=gemini durandal-mcp

# Or use the convenience script
npm run start:gemini
```

## Configuration

### Option 1: Environment Variables
```bash
# For Claude (stdio)
export MCP_TRANSPORT=stdio
export MCP_CLIENT=claude

# For Gemini (HTTP)
export MCP_TRANSPORT=http
export MCP_CLIENT=gemini
export MCP_PORT=8080
export GEMINI_API_KEY=your-api-key

# For both simultaneously
export MCP_TRANSPORT=hybrid
```

### Option 2: Configuration Files
Use one of the provided configuration files:
- `.env.claude` - Claude Code configuration
- `.env.gemini` - Google Gemini configuration
- `.env.hybrid` - Both clients simultaneously

```bash
# Copy and customize
cp .env.gemini .env
# Edit .env with your settings
durandal-mcp
```

## Using with Google Gemini

### Python Example
```python
import google.generativeai as genai
import requests

# Configure Gemini
genai.configure(api_key="YOUR_GEMINI_API_KEY")

# Connect to Durandal MCP Server
def call_durandal_tool(tool_name, arguments):
    response = requests.post(
        f"http://localhost:8080/v1/tools/{tool_name}",
        json={"arguments": arguments}
    )
    return response.json()

# Store a memory
result = call_durandal_tool("store_memory", {
    "content": "User prefers dark mode interfaces",
    "metadata": {"importance": 0.9, "category": "preferences"}
})

# Search memories
memories = call_durandal_tool("search_memories", {
    "query": "user preferences",
    "limit": 5
})

# Get context
context = call_durandal_tool("get_context", {})
```

### JavaScript/Node.js Example
```javascript
const axios = require('axios');

class DurandalClient {
    constructor(baseURL = 'http://localhost:8080') {
        this.baseURL = baseURL;
    }

    async callTool(toolName, args) {
        const response = await axios.post(
            `${this.baseURL}/v1/tools/${toolName}`,
            { arguments: args }
        );
        return response.data;
    }

    async storeMemory(content, metadata = {}) {
        return this.callTool('store_memory', { content, metadata });
    }

    async searchMemories(query, limit = 10) {
        return this.callTool('search_memories', { query, limit });
    }
}

// Usage
const durandal = new DurandalClient();
await durandal.storeMemory('Project uses TypeScript and React');
const memories = await durandal.searchMemories('technology stack');
```

## Available MCP Tools

All tools work identically across Claude and Gemini:

### 1. store_memory
Store information with metadata and automatic categorization.
```javascript
{
    "content": "Important information to remember",
    "metadata": {
        "importance": 0.8,
        "category": "technical",
        "project": "my-project"
    }
}
```

### 2. search_memories
Search stored memories with powerful filtering.
```javascript
{
    "query": "search terms",
    "limit": 10,
    "filters": {
        "categories": ["technical"],
        "importance_min": 0.5
    }
}
```

### 3. get_context
Get recent memories and statistics.
```javascript
{
    "limit": 10,
    "include_stats": true
}
```

### 4. optimize_memory
Run maintenance and optimization.
```javascript
{
    "operations": ["cache_optimization", "retention_review"]
}
```

### 5. get_status
Get system status and health.
```javascript
{}
```

### 6. configure_logging
Adjust logging levels at runtime.
```javascript
{
    "console_level": "info",
    "file_level": "debug"
}
```

### 7. get_logs
Retrieve session logs.
```javascript
{
    "lines": 50,
    "level_filter": "error"
}
```

### 8. list_projects_sessions
List all projects and sessions with memory counts.
```javascript
{
    "type": "both",
    "include_samples": true
}
```

## Running Multiple Transports

### Hybrid Mode (Experimental)
Serve both Claude and Gemini simultaneously:

```bash
# Start hybrid server
MCP_TRANSPORT=hybrid durandal-mcp

# Claude connects via stdio (default)
# Gemini connects via http://localhost:8080
```

### Separate Instances
Run separate instances for each client:

```bash
# Terminal 1: Claude
MCP_TRANSPORT=stdio durandal-mcp

# Terminal 2: Gemini (different database)
MCP_TRANSPORT=http DATABASE_PATH=./gemini.db durandal-mcp
```

## Testing

### Run Transport Tests
```bash
npm run test:transport
```

### Test HTTP Endpoint
```bash
# Health check
curl http://localhost:8080/health

# Test tool call
curl -X POST http://localhost:8080/v1/tools/get_status \
  -H "Content-Type: application/json" \
  -d '{"arguments": {}}'
```

## Architecture

### Transport Layer
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Claude    │     │   Gemini    │     │   OpenAI    │
│    Code     │     │     SDK     │     │  (Future)   │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │stdio              │HTTP               │HTTP
       │                   │                   │
┌──────▼───────────────────▼───────────────────▼──────┐
│            Transport Factory & Adapters              │
├──────────────────────────────────────────────────────┤
│              Durandal MCP Server Core                │
├──────────────────────────────────────────────────────┤
│                  SQLite Database                     │
└──────────────────────────────────────────────────────┘
```

### Protocol Adaptation
The server automatically converts between different protocol formats:
- **MCP** (Model Context Protocol) - Standard format
- **Gemini** - Function calling format
- **OpenAI** - Tool/function format

## Troubleshooting

### Port Already in Use
```bash
# Use a different port
MCP_PORT=8081 MCP_TRANSPORT=http durandal-mcp
```

### Gemini Not Connecting
1. Check server is running: `curl http://localhost:8080/health`
2. Verify API key is set: `echo $GEMINI_API_KEY`
3. Check logs: `LOG_LEVEL=debug durandal-mcp`

### Database Lock Issues
```bash
# Use separate databases for each transport
DATABASE_PATH=./claude.db MCP_TRANSPORT=stdio durandal-mcp
DATABASE_PATH=./gemini.db MCP_TRANSPORT=http durandal-mcp
```

## Migration Guide

### From v3.x to v4.0
No breaking changes for Claude users! The stdio transport remains the default.

### For New Gemini Integration
1. Update to v4.0.0-gemini
2. Set environment variables or use `.env.gemini`
3. Start server with HTTP transport
4. Connect from Gemini using HTTP endpoints

## Performance

### Latency Comparison
- **Claude (stdio)**: ~5ms per operation
- **Gemini (HTTP)**: ~10-15ms per operation
- **Hybrid**: No performance impact (separate channels)

### Memory Usage
- **Single transport**: ~50MB
- **Hybrid mode**: ~75MB

## Security

### API Key Management
- Store keys in environment variables or `.env` files
- Never commit `.env` files to version control
- Use different keys for production/development

### Network Security
- HTTP transport binds to localhost by default
- Configure firewall rules for external access
- Consider using reverse proxy with HTTPS

## Contributing

This is an experimental branch. Please report issues to:
https://github.com/Wawtawsha/Durandal-experimental/issues

## Roadmap

- [x] Claude Code support (stdio)
- [x] Google Gemini support (HTTP)
- [x] Protocol adaptation layer
- [x] Hybrid mode (both simultaneously)
- [ ] OpenAI GPT support
- [ ] WebSocket transport
- [ ] gRPC transport
- [ ] Authentication/authorization
- [ ] Rate limiting
- [ ] Multi-tenancy

## License

MIT License - See LICENSE file for details.

---

**Note**: This is an experimental release (v4.0.0-gemini). For production use, consider using the stable v3.x release for Claude-only support.