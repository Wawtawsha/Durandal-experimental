/**
 * Transport Factory for Multi-Client MCP Support
 *
 * Provides abstraction layer for different transport mechanisms:
 * - stdio: For Claude Code (default)
 * - http: For Google Gemini
 * - hybrid: For simultaneous support
 */

const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const express = require('express');
const { EventEmitter } = require('events');

/**
 * HTTP Server Transport for MCP
 * Implements the same interface as StdioServerTransport but over HTTP
 */
class HttpServerTransport extends EventEmitter {
    constructor(options = {}) {
        super();
        this.port = options.port || process.env.MCP_PORT || 8080;
        this.host = options.host || process.env.MCP_HOST || 'localhost';
        this.apiKey = options.apiKey || process.env.GEMINI_API_KEY;
        this.app = null;
        this.server = null;
        this.logger = options.logger;
    }

    async start() {
        this.app = express();
        this.app.use(express.json({ limit: '50mb' }));

        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok', transport: 'http', mcp: true });
        });

        // Main MCP endpoint
        this.app.post('/mcp', (req, res) => {
            this.handleRequest(req, res);
        });

        // Tool-specific endpoints for Gemini compatibility
        this.app.post('/v1/tools/:tool', (req, res) => {
            const { tool } = req.params;
            const mcpRequest = {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: tool,
                    arguments: req.body.arguments || req.body
                },
                id: Date.now()
            };
            this.handleRequest({ body: mcpRequest }, res);
        });

        return new Promise((resolve) => {
            this.server = this.app.listen(this.port, this.host, () => {
                this.logger?.info(`[HTTP] MCP server listening on http://${this.host}:${this.port}`);
                resolve();
            });
        });
    }

    handleRequest(req, res) {
        // Emit the request for the MCP server to handle
        this.emit('message', req.body);

        // Listen for the response
        this.once('response', (response) => {
            res.json(response);
        });
    }

    send(message) {
        // Send response back to the waiting HTTP request
        this.emit('response', message);
    }

    async close() {
        if (this.server) {
            return new Promise((resolve) => {
                this.server.close(() => {
                    this.logger?.info('[HTTP] Server closed');
                    resolve();
                });
            });
        }
    }
}

/**
 * Hybrid Transport that supports both stdio and HTTP simultaneously
 */
class HybridTransport extends EventEmitter {
    constructor(options = {}) {
        super();
        this.stdio = new StdioServerTransport();
        this.http = new HttpServerTransport(options);
        this.logger = options.logger;
        this.setupRouting();
    }

    setupRouting() {
        // Route stdio messages
        this.stdio.on('message', (message) => {
            message._transport = 'stdio';
            this.emit('message', message);
        });

        // Route HTTP messages
        this.http.on('message', (message) => {
            message._transport = 'http';
            this.emit('message', message);
        });
    }

    async start() {
        await Promise.all([
            this.stdio.start(),
            this.http.start()
        ]);
        this.logger?.info('[HYBRID] Both transports started successfully');
    }

    send(message) {
        // Route response to appropriate transport based on request origin
        if (message._transport === 'stdio') {
            this.stdio.send(message);
        } else if (message._transport === 'http') {
            this.http.send(message);
        } else {
            // Default to stdio if origin unknown
            this.stdio.send(message);
        }
    }

    async close() {
        await Promise.all([
            this.stdio.close?.() || Promise.resolve(),
            this.http.close()
        ]);
    }
}

/**
 * Transport Factory
 * Creates appropriate transport based on configuration
 */
class TransportFactory {
    static create(config = {}) {
        const transportType = config.transport || process.env.MCP_TRANSPORT || 'stdio';
        const logger = config.logger;

        logger?.info(`[TRANSPORT] Creating ${transportType} transport`);

        switch (transportType.toLowerCase()) {
            case 'stdio':
                return new StdioServerTransport();

            case 'http':
                return new HttpServerTransport({
                    port: config.port,
                    host: config.host,
                    apiKey: config.apiKey,
                    logger: logger
                });

            case 'hybrid':
                return new HybridTransport({
                    port: config.port,
                    host: config.host,
                    apiKey: config.apiKey,
                    logger: logger
                });

            default:
                throw new Error(`Unknown transport type: ${transportType}`);
        }
    }

    /**
     * Detect client type based on environment and configuration
     */
    static detectClient() {
        // Check environment variables for client hints
        if (process.env.CLAUDE_CODE_VERSION || process.env.MCP_CLIENT === 'claude') {
            return 'claude';
        }
        if (process.env.GEMINI_SDK_VERSION || process.env.MCP_CLIENT === 'gemini') {
            return 'gemini';
        }
        if (process.env.OPENAI_API_KEY || process.env.MCP_CLIENT === 'openai') {
            return 'openai';
        }

        // Check transport type as a hint
        const transport = process.env.MCP_TRANSPORT;
        if (transport === 'http') {
            return 'gemini'; // HTTP typically means Gemini
        }

        // Default to Claude for stdio
        return 'claude';
    }

    /**
     * Get recommended transport for a client type
     */
    static getRecommendedTransport(clientType) {
        const recommendations = {
            'claude': 'stdio',
            'gemini': 'http',
            'openai': 'http',
            'universal': 'hybrid'
        };
        return recommendations[clientType] || 'stdio';
    }
}

module.exports = {
    TransportFactory,
    HttpServerTransport,
    HybridTransport
};