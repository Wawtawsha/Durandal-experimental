# Durandal MCP Server - Gemini Integration Plan

## Executive Summary

Google Gemini **natively supports MCP** as of 2025, making integration feasible. This plan outlines three approaches to add Gemini support to the Durandal MCP server, from quick solutions to comprehensive native integration.

## Current Architecture Analysis

### Transport Layer
- **Current**: Uses `StdioServerTransport` exclusively (line 10 in durandal-mcp-server-v3.js)
- **Issue**: Gemini typically uses HTTP/REST transport, not stdio
- **Solution**: Abstract transport layer to support multiple protocols

### Key Integration Points
```javascript
// Current implementation (durandal-mcp-server-v3.js, lines 9-10)
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

// Need to abstract to support:
// - StdioServerTransport (Claude)
// - HttpServerTransport (Gemini)
// - WebSocketTransport (Future)
```

## Option 1: Quick Bridge Solution (1-2 Days)

### Approach
Use an existing MCP-Gemini bridge without modifying Durandal code.

### Implementation Steps
1. Install gemini-bridge alongside Durandal:
```bash
npm install -g gemini-bridge
npm install -g durandal-memory-mcp
```

2. Configure bridge to connect to Durandal:
```json
// gemini-bridge-config.json
{
  "backend": "stdio",
  "command": "durandal-mcp",
  "gemini_api_key": "YOUR_GEMINI_API_KEY",
  "transport": "http",
  "port": 8080
}
```

3. Start bridge:
```bash
gemini-bridge --config gemini-bridge-config.json
```

### Pros
- No code changes to Durandal
- Immediate availability
- Maintained by community

### Cons
- Additional process overhead
- Potential feature limitations
- Dependency on external project

## Option 2: Transport Adapter Pattern (5-7 Days)

### Approach
Create a transport abstraction layer while keeping core logic unchanged.

### Implementation Code

#### 1. Create Transport Factory (new file: transport-factory.js)
```javascript
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { HttpServerTransport } = require('@modelcontextprotocol/sdk/server/http.js');

class TransportFactory {
    static create(config = {}) {
        const transportType = config.transport || process.env.MCP_TRANSPORT || 'stdio';

        switch (transportType) {
            case 'stdio':
                return new StdioServerTransport();

            case 'http':
                return new HttpServerTransport({
                    port: config.port || process.env.MCP_PORT || 8080,
                    host: config.host || process.env.MCP_HOST || 'localhost',
                    apiKey: config.apiKey || process.env.GEMINI_API_KEY
                });

            case 'hybrid':
                // Support both simultaneously
                return new HybridTransport({
                    stdio: new StdioServerTransport(),
                    http: new HttpServerTransport({ ...config })
                });

            default:
                throw new Error(`Unknown transport: ${transportType}`);
        }
    }
}

module.exports = TransportFactory;
```

#### 2. Create Protocol Adapter (new file: protocol-adapter.js)
```javascript
class ProtocolAdapter {
    constructor(sourceProtocol, targetProtocol) {
        this.sourceProtocol = sourceProtocol;
        this.targetProtocol = targetProtocol;
    }

    adaptRequest(request) {
        if (this.sourceProtocol === 'gemini' && this.targetProtocol === 'mcp') {
            return this.geminiToMCP(request);
        } else if (this.sourceProtocol === 'mcp' && this.targetProtocol === 'gemini') {
            return this.mcpToGemini(request);
        }
        return request; // Pass through if same protocol
    }

    geminiToMCP(geminiRequest) {
        // Convert Gemini function calling format to MCP tool format
        return {
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
                name: geminiRequest.function_call.name,
                arguments: geminiRequest.function_call.arguments
            }
        };
    }

    mcpToGemini(mcpResponse) {
        // Convert MCP response to Gemini function response
        return {
            function_response: {
                name: mcpResponse.result.toolName,
                response: mcpResponse.result.content
            }
        };
    }
}

module.exports = ProtocolAdapter;
```

#### 3. Update Main Server (modify durandal-mcp-server-v3.js)
```javascript
// Replace lines 9-10 with:
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const TransportFactory = require('./transport-factory');
const ProtocolAdapter = require('./protocol-adapter');

class DurandalMCPServer extends EventEmitter {
    constructor(options = {}) {
        super();

        // ... existing initialization ...

        // Create transport based on configuration
        this.transport = TransportFactory.create({
            transport: options.transport || process.env.MCP_TRANSPORT,
            port: options.port,
            host: options.host,
            apiKey: options.apiKey
        });

        // Create protocol adapter if needed
        const clientType = process.env.CLIENT_TYPE || 'claude';
        if (clientType === 'gemini') {
            this.protocolAdapter = new ProtocolAdapter('gemini', 'mcp');
        }

        // ... rest of constructor ...
    }

    // Add adapter to request handling
    async handleToolRequest(request) {
        // Adapt request if needed
        if (this.protocolAdapter) {
            request = this.protocolAdapter.adaptRequest(request);
        }

        // Process request normally
        const result = await this.processToolRequest(request);

        // Adapt response if needed
        if (this.protocolAdapter) {
            return this.protocolAdapter.adaptResponse(result);
        }

        return result;
    }
}
```

#### 4. Environment Configuration
```bash
# .env for Claude (default)
MCP_TRANSPORT=stdio

# .env for Gemini
MCP_TRANSPORT=http
MCP_PORT=8080
GEMINI_API_KEY=your-api-key
CLIENT_TYPE=gemini

# .env for both simultaneously
MCP_TRANSPORT=hybrid
```

## Option 3: Native Multi-Client Support (9-15 Days)

### Approach
Comprehensive redesign to natively support multiple AI clients.

### Architecture Changes

#### 1. Client Detection System
```javascript
class ClientDetector {
    static detectClient() {
        // Auto-detect based on environment
        if (process.env.CLAUDE_CODE_VERSION) return 'claude';
        if (process.env.GEMINI_SDK_VERSION) return 'gemini';
        if (process.env.OPENAI_API_KEY) return 'openai';

        // Detect based on parent process
        const parentProcess = process.ppid;
        // Check parent process name/path

        // Default fallback
        return 'claude';
    }
}
```

#### 2. Multi-Client Server Class
```javascript
class UniversalMCPServer {
    constructor(options = {}) {
        this.clients = new Map();
        this.setupClaudeClient();
        this.setupGeminiClient();
    }

    setupClaudeClient() {
        this.clients.set('claude', {
            transport: new StdioServerTransport(),
            protocol: 'mcp',
            adapter: null
        });
    }

    setupGeminiClient() {
        this.clients.set('gemini', {
            transport: new HttpServerTransport({ port: 8080 }),
            protocol: 'gemini-mcp',
            adapter: new GeminiAdapter()
        });
    }

    async start() {
        // Start all configured transports
        for (const [name, client] of this.clients) {
            await client.transport.start();
            this.logger.info(`Started ${name} transport`);
        }
    }
}
```

### Package.json Updates
```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.17.5",
    "@google/generative-ai": "^0.7.0",  // Add Gemini SDK
    "express": "^4.18.0",  // For HTTP transport
    "ws": "^8.0.0",  // For WebSocket transport
    "sqlite3": "^5.1.6"
  },
  "scripts": {
    "start": "node durandal-mcp-server-v3.js",
    "start:claude": "MCP_TRANSPORT=stdio node durandal-mcp-server-v3.js",
    "start:gemini": "MCP_TRANSPORT=http CLIENT_TYPE=gemini node durandal-mcp-server-v3.js",
    "start:hybrid": "MCP_TRANSPORT=hybrid node durandal-mcp-server-v3.js"
  }
}
```

## Testing Strategy

### 1. Unit Tests
```javascript
// test-multi-transport.js
describe('Multi-Transport Support', () => {
    test('Claude stdio transport works', async () => {
        const server = new DurandalMCPServer({ transport: 'stdio' });
        // Test stdio operations
    });

    test('Gemini HTTP transport works', async () => {
        const server = new DurandalMCPServer({ transport: 'http' });
        // Test HTTP operations
    });

    test('Protocol adaptation works', async () => {
        const adapter = new ProtocolAdapter('gemini', 'mcp');
        const geminiRequest = { function_call: { name: 'store_memory', arguments: {} }};
        const mcpRequest = adapter.adaptRequest(geminiRequest);
        expect(mcpRequest.method).toBe('tools/call');
    });
});
```

### 2. Integration Tests
```bash
# Test with Claude
claude mcp add durandal-test -- node durandal-mcp-server-v3.js
claude mcp test durandal-test

# Test with Gemini
export MCP_TRANSPORT=http CLIENT_TYPE=gemini
gemini-cli --mcp-server http://localhost:8080 test
```

## Recommended Approach: Option 2 (Transport Adapter)

### Why Option 2?
1. **Balanced complexity** - Not too simple, not over-engineered
2. **Maintains compatibility** - No breaking changes for Claude users
3. **Clean architecture** - Separation of concerns
4. **Reasonable timeline** - 5-7 days implementation
5. **Future-proof** - Easy to add more clients later

### Implementation Schedule

**Day 1-2: Transport Abstraction**
- Create TransportFactory
- Test with existing Claude setup
- Ensure no regression

**Day 3-4: Protocol Adaptation**
- Build ProtocolAdapter
- Map Gemini <-> MCP formats
- Handle edge cases

**Day 5: Integration**
- Wire up adapters
- Update configuration
- Test both transports

**Day 6-7: Testing & Documentation**
- Comprehensive testing
- Update README
- Create Gemini setup guide

## Migration Path

### For Existing Users
No changes required - Claude support continues to work by default.

### For Gemini Users
```bash
# Install updated package
npm install -g durandal-memory-mcp@latest

# Configure for Gemini
export MCP_TRANSPORT=http
export CLIENT_TYPE=gemini
export GEMINI_API_KEY=your-key

# Start server
durandal-mcp

# Or use with Gemini CLI
gemini-cli --mcp-server http://localhost:8080
```

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking Claude compatibility | High | Extensive regression testing |
| Protocol mismatch bugs | Medium | Comprehensive adapter tests |
| Performance overhead | Low | Benchmark and optimize |
| Gemini API changes | Medium | Version pinning, update monitoring |

## Success Metrics

1. **Compatibility**: Both Claude and Gemini can use all 7 MCP tools
2. **Performance**: <10ms overhead for protocol adaptation
3. **Reliability**: 99.9% uptime for both transports
4. **User Experience**: Zero configuration for Claude, minimal for Gemini

## Next Steps

1. **Review and approve approach** - Which option should we implement?
2. **Create feature branch** - `gemini-integration`
3. **Begin implementation** - Start with transport abstraction
4. **Regular testing** - Test both clients at each milestone
5. **Documentation** - Update as we implement

## Questions to Resolve

1. Should we support simultaneous Claude + Gemini connections?
2. Do we need rate limiting for HTTP transport?
3. Should we auto-detect the client or require explicit configuration?
4. How should we handle Gemini-specific features not in MCP?

---

**Recommendation**: Start with Option 2 (Transport Adapter) as it provides the best balance of functionality, maintainability, and development time while preserving full compatibility with existing Claude users.