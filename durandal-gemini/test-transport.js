#!/usr/bin/env node

/**
 * Multi-Transport Test Suite for Durandal MCP Server
 *
 * Tests the new transport abstraction layer and protocol adaptation
 * for Claude, Gemini, and hybrid configurations.
 */

const { TransportFactory, HttpServerTransport, HybridTransport } = require('./transport-factory');
const ProtocolAdapter = require('./protocol-adapter');
const assert = require('assert');
const http = require('http');

class TestRunner {
    constructor() {
        this.tests = [];
        this.passed = 0;
        this.failed = 0;
    }

    addTest(name, testFn) {
        this.tests.push({ name, testFn });
    }

    async run() {
        console.log('🧪 Multi-Transport Test Suite\n');
        console.log('=' .repeat(50));

        for (const test of this.tests) {
            try {
                await test.testFn();
                this.passed++;
                console.log(`✅ ${test.name}`);
            } catch (error) {
                this.failed++;
                console.log(`❌ ${test.name}`);
                console.log(`   Error: ${error.message}`);
            }
        }

        console.log('\n' + '=' .repeat(50));
        console.log(`\nResults: ${this.passed} passed, ${this.failed} failed`);

        return this.failed === 0;
    }
}

// Initialize test runner
const runner = new TestRunner();

// Test 1: Transport Factory - Claude (stdio)
runner.addTest('Transport Factory creates stdio transport for Claude', () => {
    process.env.MCP_TRANSPORT = 'stdio';
    const transport = TransportFactory.create();
    assert(transport.constructor.name === 'StdioServerTransport', 'Should create StdioServerTransport');
});

// Test 2: Transport Factory - Gemini (HTTP)
runner.addTest('Transport Factory creates HTTP transport for Gemini', () => {
    process.env.MCP_TRANSPORT = 'http';
    const transport = TransportFactory.create();
    assert(transport instanceof HttpServerTransport, 'Should create HttpServerTransport');
});

// Test 3: Transport Factory - Hybrid
runner.addTest('Transport Factory creates hybrid transport', () => {
    process.env.MCP_TRANSPORT = 'hybrid';
    const transport = TransportFactory.create();
    assert(transport instanceof HybridTransport, 'Should create HybridTransport');
});

// Test 4: Client Detection - Claude
runner.addTest('Detects Claude client correctly', () => {
    process.env.MCP_CLIENT = 'claude';
    const client = TransportFactory.detectClient();
    assert(client === 'claude', 'Should detect Claude client');
});

// Test 5: Client Detection - Gemini
runner.addTest('Detects Gemini client correctly', () => {
    process.env.MCP_CLIENT = 'gemini';
    const client = TransportFactory.detectClient();
    assert(client === 'gemini', 'Should detect Gemini client');
});

// Test 6: Protocol Adapter - Gemini to MCP
runner.addTest('Converts Gemini request to MCP format', () => {
    const adapter = new ProtocolAdapter('gemini', 'mcp');
    const geminiRequest = {
        function_call: {
            name: 'store_memory',
            arguments: {
                content: 'Test memory',
                metadata: { importance: 0.8 }
            }
        }
    };

    const mcpRequest = adapter.adaptRequest(geminiRequest);
    assert(mcpRequest.method === 'tools/call', 'Should have MCP method');
    assert(mcpRequest.params.name === 'store_memory', 'Should preserve tool name');
    assert(mcpRequest.params.arguments.content === 'Test memory', 'Should preserve arguments');
});

// Test 7: Protocol Adapter - MCP to Gemini
runner.addTest('Converts MCP response to Gemini format', () => {
    const adapter = new ProtocolAdapter('mcp', 'gemini');
    const mcpResponse = {
        jsonrpc: '2.0',
        result: {
            toolName: 'store_memory',
            content: [{ type: 'text', text: 'Memory stored successfully' }]
        },
        id: 123
    };

    const geminiResponse = adapter.adaptResponse(mcpResponse);
    assert(geminiResponse.function_response, 'Should have function_response');
    assert(geminiResponse.function_response.name === 'store_memory', 'Should preserve tool name');
    assert(geminiResponse.function_response.response.includes('Memory stored'), 'Should preserve response text');
});

// Test 8: Protocol Adapter - OpenAI to MCP
runner.addTest('Converts OpenAI request to MCP format', () => {
    const adapter = new ProtocolAdapter('openai', 'mcp');
    const openaiRequest = {
        function: {
            name: 'search_memories',
            parameters: {
                query: 'test query',
                limit: 10
            }
        }
    };

    const mcpRequest = adapter.adaptRequest(openaiRequest);
    assert(mcpRequest.method === 'tools/call', 'Should have MCP method');
    assert(mcpRequest.params.name === 'search_memories', 'Should preserve tool name');
    assert(mcpRequest.params.arguments.query === 'test query', 'Should preserve parameters');
});

// Test 9: Protocol Detection
runner.addTest('Detects protocol from message format', () => {
    // MCP format
    const mcpMsg = { jsonrpc: '2.0', method: 'tools/call' };
    assert(ProtocolAdapter.detectProtocol(mcpMsg) === 'mcp', 'Should detect MCP');

    // Gemini format
    const geminiMsg = { function_call: { name: 'test' } };
    assert(ProtocolAdapter.detectProtocol(geminiMsg) === 'gemini', 'Should detect Gemini');

    // OpenAI format
    const openaiMsg = { function: { name: 'test' } };
    assert(ProtocolAdapter.detectProtocol(openaiMsg) === 'openai', 'Should detect OpenAI');
});

// Test 10: HTTP Transport - Start/Stop
runner.addTest('HTTP Transport can start and stop', async () => {
    const transport = new HttpServerTransport({ port: 8081 });
    await transport.start();

    // Test if server is listening
    const isListening = await new Promise((resolve) => {
        const req = http.get('http://localhost:8081/health', (res) => {
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
    });

    assert(isListening, 'HTTP server should be listening');

    await transport.close();

    // Test if server stopped
    const isStopped = await new Promise((resolve) => {
        const req = http.get('http://localhost:8081/health', (res) => {
            resolve(false);
        });
        req.on('error', () => resolve(true));
    });

    assert(isStopped, 'HTTP server should be stopped');
});

// Test 11: Auto Adapter Creation
runner.addTest('Creates auto adapter for protocol detection', () => {
    const autoAdapter = ProtocolAdapter.createAutoAdapter();

    // Test Gemini to MCP
    const geminiReq = { function_call: { name: 'test' } };
    const adapted = autoAdapter.adaptRequest(geminiReq);
    assert(adapted.method === 'tools/call', 'Should auto-adapt Gemini to MCP');

    // Test MCP passthrough
    const mcpReq = { jsonrpc: '2.0', method: 'tools/call' };
    const passthrough = autoAdapter.adaptRequest(mcpReq);
    assert(passthrough === mcpReq, 'Should pass through MCP unchanged');
});

// Test 12: Environment Variable Configuration
runner.addTest('Respects environment variables for configuration', () => {
    process.env.MCP_PORT = '9090';
    process.env.MCP_HOST = 'example.com';
    process.env.GEMINI_API_KEY = 'test-key';

    const transport = TransportFactory.create({ transport: 'http' });
    assert(transport.port === '9090', 'Should use env port');
    assert(transport.host === 'example.com', 'Should use env host');
    assert(transport.apiKey === 'test-key', 'Should use env API key');

    // Cleanup
    delete process.env.MCP_PORT;
    delete process.env.MCP_HOST;
    delete process.env.GEMINI_API_KEY;
});

// Test 13: Error Handling in Protocol Adapter
runner.addTest('Handles errors in protocol conversion', () => {
    const adapter = new ProtocolAdapter('gemini', 'mcp');

    // Malformed request
    const badRequest = { invalid: 'format' };
    const result = adapter.adaptRequest(badRequest);
    assert(result === badRequest, 'Should return original on unknown format');

    // Error response conversion
    const errorResponse = {
        error: {
            message: 'Test error',
            code: -32000
        }
    };

    const converted = adapter.adaptResponse(errorResponse);
    assert(converted.function_response.metadata.success === false, 'Should mark as failed');
});

// Test 14: Recommended Transport Detection
runner.addTest('Recommends correct transport for client type', () => {
    assert(TransportFactory.getRecommendedTransport('claude') === 'stdio', 'Claude should use stdio');
    assert(TransportFactory.getRecommendedTransport('gemini') === 'http', 'Gemini should use HTTP');
    assert(TransportFactory.getRecommendedTransport('universal') === 'hybrid', 'Universal should use hybrid');
});

// Test 15: Multi-format Support
runner.addTest('Handles multiple function call formats', () => {
    const adapter = new ProtocolAdapter('gemini', 'mcp');

    // Array of function calls
    const multiRequest = {
        function_calls: [
            { name: 'store_memory', arguments: { content: 'First' } },
            { name: 'search_memories', arguments: { query: 'test' } }
        ]
    };

    const converted = adapter.adaptRequest(multiRequest);
    assert(Array.isArray(converted), 'Should convert to array');
    assert(converted.length === 2, 'Should preserve all calls');
    assert(converted[0].params.name === 'store_memory', 'Should convert first call');
    assert(converted[1].params.name === 'search_memories', 'Should convert second call');
});

// Run all tests
(async () => {
    const success = await runner.run();

    if (success) {
        console.log('\n✨ All tests passed! Multi-transport support is working correctly.');
        process.exit(0);
    } else {
        console.log('\n❗ Some tests failed. Please review the errors above.');
        process.exit(1);
    }
})();