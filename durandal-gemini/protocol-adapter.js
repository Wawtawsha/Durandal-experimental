/**
 * Protocol Adapter for Multi-Client MCP Support
 *
 * Converts between different AI client message formats:
 * - MCP (Model Context Protocol) - Standard format
 * - Gemini Function Calling - Google's format
 * - OpenAI Function Calling - OpenAI's format
 */

class ProtocolAdapter {
    constructor(sourceProtocol, targetProtocol, logger = null) {
        this.sourceProtocol = sourceProtocol;
        this.targetProtocol = targetProtocol;
        this.logger = logger;
    }

    /**
     * Adapt request from source to target protocol
     */
    adaptRequest(request) {
        const conversionKey = `${this.sourceProtocol}->${this.targetProtocol}`;

        this.logger?.debug(`[ADAPTER] Converting request: ${conversionKey}`);

        switch (conversionKey) {
            case 'gemini->mcp':
                return this.geminiToMCPRequest(request);
            case 'mcp->gemini':
                return this.mcpToGeminiRequest(request);
            case 'openai->mcp':
                return this.openaiToMCPRequest(request);
            case 'mcp->openai':
                return this.mcpToOpenAIRequest(request);
            default:
                // If same protocol or unknown, pass through
                return request;
        }
    }

    /**
     * Adapt response from target back to source protocol
     */
    adaptResponse(response) {
        const conversionKey = `${this.targetProtocol}->${this.sourceProtocol}`;

        this.logger?.debug(`[ADAPTER] Converting response: ${conversionKey}`);

        switch (conversionKey) {
            case 'mcp->gemini':
                return this.mcpToGeminiResponse(response);
            case 'gemini->mcp':
                return this.geminiToMCPResponse(response);
            case 'mcp->openai':
                return this.mcpToOpenAIResponse(response);
            case 'openai->mcp':
                return this.openaiToMCPResponse(response);
            default:
                return response;
        }
    }

    /**
     * Convert Gemini function call to MCP tool call
     */
    geminiToMCPRequest(geminiRequest) {
        // Gemini function calling format
        // {
        //   "function_call": {
        //     "name": "store_memory",
        //     "arguments": {
        //       "content": "...",
        //       "metadata": {...}
        //     }
        //   }
        // }

        if (geminiRequest.function_call) {
            return {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: geminiRequest.function_call.name,
                    arguments: geminiRequest.function_call.arguments || {}
                },
                id: geminiRequest.id || Date.now()
            };
        }

        // Handle array of function calls
        if (geminiRequest.function_calls && Array.isArray(geminiRequest.function_calls)) {
            return geminiRequest.function_calls.map(call => ({
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: call.name,
                    arguments: call.arguments || {}
                },
                id: call.id || Date.now()
            }));
        }

        // Direct tool call format (simplified)
        if (geminiRequest.tool && geminiRequest.arguments) {
            return {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: geminiRequest.tool,
                    arguments: geminiRequest.arguments
                },
                id: geminiRequest.id || Date.now()
            };
        }

        return geminiRequest;
    }

    /**
     * Convert MCP response to Gemini function response
     */
    mcpToGeminiResponse(mcpResponse) {
        // MCP response format
        // {
        //   "jsonrpc": "2.0",
        //   "result": {
        //     "toolName": "store_memory",
        //     "content": [{"type": "text", "text": "..."}]
        //   },
        //   "id": 123
        // }

        if (mcpResponse.result) {
            const result = mcpResponse.result;

            // Extract text content from MCP content array
            let responseText = '';
            if (Array.isArray(result.content)) {
                responseText = result.content
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join('\n');
            } else if (typeof result.content === 'string') {
                responseText = result.content;
            } else if (typeof result === 'string') {
                responseText = result;
            }

            return {
                function_response: {
                    name: result.toolName || 'unknown',
                    response: responseText,
                    metadata: {
                        success: true,
                        id: mcpResponse.id
                    }
                }
            };
        }

        // Handle error responses
        if (mcpResponse.error) {
            return {
                function_response: {
                    name: 'error',
                    response: mcpResponse.error.message || 'Unknown error',
                    metadata: {
                        success: false,
                        error_code: mcpResponse.error.code,
                        id: mcpResponse.id
                    }
                }
            };
        }

        return mcpResponse;
    }

    /**
     * Convert OpenAI function call to MCP tool call
     */
    openaiToMCPRequest(openaiRequest) {
        // OpenAI function calling format
        // {
        //   "function": {
        //     "name": "store_memory",
        //     "parameters": {
        //       "content": "..."
        //     }
        //   }
        // }

        if (openaiRequest.function) {
            return {
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: openaiRequest.function.name,
                    arguments: openaiRequest.function.parameters || {}
                },
                id: openaiRequest.id || Date.now()
            };
        }

        // Handle tool_calls array format (newer OpenAI format)
        if (openaiRequest.tool_calls && Array.isArray(openaiRequest.tool_calls)) {
            return openaiRequest.tool_calls.map(call => ({
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: call.function.name,
                    arguments: JSON.parse(call.function.arguments || '{}')
                },
                id: call.id || Date.now()
            }));
        }

        return openaiRequest;
    }

    /**
     * Convert MCP response to OpenAI function response
     */
    mcpToOpenAIResponse(mcpResponse) {
        if (mcpResponse.result) {
            const result = mcpResponse.result;

            // Extract text content
            let content = '';
            if (Array.isArray(result.content)) {
                content = result.content
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join('\n');
            } else if (typeof result.content === 'string') {
                content = result.content;
            }

            return {
                role: 'function',
                name: result.toolName || 'unknown',
                content: content
            };
        }

        // Handle error
        if (mcpResponse.error) {
            return {
                role: 'function',
                name: 'error',
                content: JSON.stringify({
                    error: mcpResponse.error.message,
                    code: mcpResponse.error.code
                })
            };
        }

        return mcpResponse;
    }

    /**
     * Reverse conversions (less common but included for completeness)
     */
    mcpToGeminiRequest(mcpRequest) {
        if (mcpRequest.method === 'tools/call' && mcpRequest.params) {
            return {
                function_call: {
                    name: mcpRequest.params.name,
                    arguments: mcpRequest.params.arguments
                },
                id: mcpRequest.id
            };
        }
        return mcpRequest;
    }

    geminiToMCPResponse(geminiResponse) {
        if (geminiResponse.function_response) {
            return {
                jsonrpc: '2.0',
                result: {
                    toolName: geminiResponse.function_response.name,
                    content: [{
                        type: 'text',
                        text: geminiResponse.function_response.response
                    }]
                },
                id: geminiResponse.function_response.metadata?.id || Date.now()
            };
        }
        return geminiResponse;
    }

    mcpToOpenAIRequest(mcpRequest) {
        if (mcpRequest.method === 'tools/call' && mcpRequest.params) {
            return {
                function: {
                    name: mcpRequest.params.name,
                    parameters: mcpRequest.params.arguments
                },
                id: mcpRequest.id
            };
        }
        return mcpRequest;
    }

    openaiToMCPResponse(openaiResponse) {
        if (openaiResponse.role === 'function') {
            return {
                jsonrpc: '2.0',
                result: {
                    toolName: openaiResponse.name,
                    content: [{
                        type: 'text',
                        text: openaiResponse.content
                    }]
                },
                id: Date.now()
            };
        }
        return openaiResponse;
    }

    /**
     * Helper method to detect protocol from message format
     */
    static detectProtocol(message) {
        // Check for MCP format
        if (message.jsonrpc && message.method) {
            return 'mcp';
        }

        // Check for Gemini format
        if (message.function_call || message.function_calls || message.function_response) {
            return 'gemini';
        }

        // Check for OpenAI format
        if (message.function || message.tool_calls || (message.role === 'function')) {
            return 'openai';
        }

        // Default to MCP
        return 'mcp';
    }

    /**
     * Create adapter based on detected protocols
     */
    static createAutoAdapter(logger = null) {
        return {
            adaptRequest: (request) => {
                const sourceProtocol = ProtocolAdapter.detectProtocol(request);
                if (sourceProtocol === 'mcp') {
                    return request; // Already in MCP format
                }
                const adapter = new ProtocolAdapter(sourceProtocol, 'mcp', logger);
                return adapter.adaptRequest(request);
            },
            adaptResponse: (response, targetProtocol = null) => {
                if (!targetProtocol) {
                    return response; // No conversion needed
                }
                if (targetProtocol === 'mcp') {
                    return response; // Already in MCP format
                }
                const adapter = new ProtocolAdapter('mcp', targetProtocol, logger);
                return adapter.adaptResponse(response);
            }
        };
    }
}

module.exports = ProtocolAdapter;