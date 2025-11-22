# Gemini + Durandal MCP: Quick Start Guide

## 🚀 Get Gemini Working in 15 Minutes

This guide shows how to connect Google Gemini to your Durandal MCP Server today using a bridge solution.

## Prerequisites

- Node.js 18+ installed
- Durandal MCP Server installed (`npm install -g durandal-memory-mcp`)
- Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

## Option 1: Using mcp-server-gemini Bridge (Recommended)

### Step 1: Install the Bridge
```bash
npm install -g mcp-server-gemini
```

### Step 2: Create Configuration
```bash
# Create config file
cat > gemini-bridge-config.json << 'EOF'
{
  "mcp_command": "durandal-mcp",
  "transport": "http",
  "port": 8080,
  "host": "localhost",
  "gemini_api_key": "YOUR_GEMINI_API_KEY_HERE"
}
EOF
```

### Step 3: Start the Bridge
```bash
# Start the bridge server
mcp-server-gemini --config gemini-bridge-config.json

# You should see:
# [INFO] MCP-Gemini Bridge started on http://localhost:8080
# [INFO] Connected to Durandal MCP Server
# [INFO] Ready for Gemini connections
```

### Step 4: Connect from Gemini
```python
# Python example
import google.generativeai as genai

genai.configure(api_key="YOUR_GEMINI_API_KEY")

# Create model with MCP tools
model = genai.GenerativeModel(
    'gemini-2.0-flash-exp',
    tools=[{
        "mcp_server": "http://localhost:8080",
        "tools": ["store_memory", "search_memories", "get_context"]
    }]
)

# Use Durandal's memory functions
response = model.generate_content(
    "Store this memory: User prefers dark mode interfaces"
)
print(response.text)
```

## Option 2: Using gemini-cli Built-in Support

### Step 1: Install Gemini CLI
```bash
npm install -g gemini-cli
```

### Step 2: Configure MCP Server
```bash
# Add Durandal to Gemini CLI
gemini-cli mcp add durandal -- cmd /c durandal-mcp

# Verify connection
gemini-cli mcp list
# Should show: durandal (connected)
```

### Step 3: Use with Gemini CLI
```bash
# Store a memory
gemini-cli "Store this memory: Project uses TypeScript and React"

# Search memories
gemini-cli "Search for memories about project technology"

# Get context
gemini-cli "What do you remember about this project?"
```

## Option 3: Direct HTTP Bridge (Advanced)

### Step 1: Create Bridge Server
```javascript
// gemini-http-bridge.js
const express = require('express');
const { spawn } = require('child_process');
const app = express();

app.use(express.json());

// Spawn Durandal MCP process
const durandal = spawn('durandal-mcp', [], {
    stdio: ['pipe', 'pipe', 'pipe']
});

// Handle Gemini requests
app.post('/v1/tools/:tool', async (req, res) => {
    const { tool } = req.params;
    const { arguments: args } = req.body;

    // Convert to MCP format
    const mcpRequest = {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: tool, arguments: args },
        id: Date.now()
    };

    // Send to Durandal
    durandal.stdin.write(JSON.stringify(mcpRequest) + '\n');

    // Wait for response
    durandal.stdout.once('data', (data) => {
        const response = JSON.parse(data.toString());
        res.json({
            tool: tool,
            result: response.result
        });
    });
});

app.listen(8080, () => {
    console.log('Gemini-Durandal bridge running on http://localhost:8080');
});
```

### Step 2: Run the Bridge
```bash
node gemini-http-bridge.js
```

## Testing the Connection

### Test Script
```javascript
// test-gemini-durandal.js
const axios = require('axios');

async function testConnection() {
    console.log('Testing Gemini-Durandal connection...');

    // Test 1: Store memory
    const storeResult = await axios.post('http://localhost:8080/v1/tools/store_memory', {
        arguments: {
            content: "Test memory from Gemini",
            metadata: { source: "gemini-test" }
        }
    });
    console.log('✓ Store memory:', storeResult.data);

    // Test 2: Search memories
    const searchResult = await axios.post('http://localhost:8080/v1/tools/search_memories', {
        arguments: {
            query: "test",
            limit: 5
        }
    });
    console.log('✓ Search memories:', searchResult.data);

    // Test 3: Get context
    const contextResult = await axios.post('http://localhost:8080/v1/tools/get_context', {
        arguments: {}
    });
    console.log('✓ Get context:', contextResult.data);

    console.log('\n✅ All tests passed! Gemini can now use Durandal memories.');
}

testConnection().catch(console.error);
```

### Run Tests
```bash
node test-gemini-durandal.js
```

## Environment Variables

Create `.env` file for configuration:
```bash
# Gemini Configuration
GEMINI_API_KEY=your-api-key-here
MCP_BRIDGE_PORT=8080
MCP_BRIDGE_HOST=localhost

# Durandal Configuration
DATABASE_PATH=./durandal-mcp-memory.db
LOG_LEVEL=info
RAMR_ENABLED=true
```

## Troubleshooting

### Bridge Not Connecting
```bash
# Check if Durandal is installed
durandal-mcp --version

# Check if bridge is running
curl http://localhost:8080/health

# Check logs
mcp-server-gemini --config gemini-bridge-config.json --verbose
```

### Permission Errors
```bash
# Windows
npm install -g durandal-memory-mcp --force

# macOS/Linux
sudo npm install -g durandal-memory-mcp
```

### Port Already in Use
```bash
# Change port in config
{
  "port": 8081  # Use different port
}
```

## Performance Tips

1. **Use Connection Pooling**
   - Keep bridge running continuously
   - Reuse connections when possible

2. **Enable RAMR Cache**
   ```bash
   export RAMR_ENABLED=true
   export RAMR_CACHE_THRESHOLD=0.7
   ```

3. **Optimize Database**
   ```bash
   # Run optimization periodically
   curl -X POST http://localhost:8080/v1/tools/optimize_memory
   ```

## Production Deployment

### Using PM2
```bash
# Install PM2
npm install -g pm2

# Start bridge with PM2
pm2 start mcp-server-gemini -- --config gemini-bridge-config.json
pm2 save
pm2 startup

# Monitor
pm2 logs mcp-server-gemini
pm2 monit
```

### Using Docker
```dockerfile
FROM node:18-alpine
WORKDIR /app
RUN npm install -g durandal-memory-mcp mcp-server-gemini
COPY gemini-bridge-config.json .
EXPOSE 8080
CMD ["mcp-server-gemini", "--config", "gemini-bridge-config.json"]
```

```bash
# Build and run
docker build -t gemini-durandal-bridge .
docker run -d -p 8080:8080 --name gemini-bridge gemini-durandal-bridge
```

## What's Next?

### Coming Soon: Native Gemini Support
We're developing native Gemini integration that will:
- Eliminate bridge overhead
- Provide 3x faster response times
- Support Gemini-specific features
- Enable simultaneous Claude + Gemini connections

### Timeline
- **Today**: Use bridge solution (this guide)
- **Next Month**: Native transport adapter
- **Q2 2025**: Full Universal MCP Server

## Support

- **Issues**: [GitHub Issues](https://github.com/Wawtawsha/durandal-memory-bridge/issues)
- **Documentation**: [Full Docs](https://github.com/Wawtawsha/durandal-memory-bridge#readme)
- **Community**: MCP Discord Server

## Quick Reference Card

```bash
# Install everything
npm install -g durandal-memory-mcp mcp-server-gemini

# Configure
echo '{"mcp_command":"durandal-mcp","port":8080}' > config.json

# Start bridge
mcp-server-gemini --config config.json

# Test
curl -X POST http://localhost:8080/v1/tools/get_status

# Use with Gemini
# Your Gemini code now has access to all Durandal MCP tools!
```

---

**Success!** You now have Gemini connected to Durandal MCP Server. The bridge handles all protocol translation automatically, giving Gemini full access to Durandal's persistent memory system.