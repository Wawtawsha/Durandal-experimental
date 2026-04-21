const MCPDatabaseClient = require('./mcp-db-client');

/**
 * DatabaseAdapter - Thin facade over MCPDatabaseClient.
 *
 * This used to carry a lot of PostgreSQL-shaped methods (`$1` placeholders, NOW(),
 * ILIKE, RETURNING against multi-table joins) that were never reachable against
 * the SQLite MCP schema. Those paths have been deleted — the MCP server only
 * stores and searches a single `memories` table.
 */
class DatabaseAdapter {
    constructor() {
        this.db = new MCPDatabaseClient();
    }

    async testConnection() {
        return await this.db.testConnection();
    }

    async storeMemory(content, metadata = {}) {
        return await this.db.storeMemory(content, metadata);
    }

    async searchMemories(query, options = {}, limit) {
        return await this.db.searchMemories(query, options, limit);
    }

    async getRecentMemories(limit, project, session) {
        return await this.db.getRecentMemories(limit, project, session);
    }

    async getMemoryById(id) {
        return await this.db.getMemoryById(id);
    }

    async deleteMemoryById(id) {
        return await this.db.deleteMemoryById(id);
    }

    async storeMemoriesBatch(items) {
        return await this.db.storeMemoriesBatch(items);
    }

    async updateMemory(id, patch) {
        return await this.db.updateMemory(id, patch);
    }

    async listMemories(filters) {
        return await this.db.listMemories(filters);
    }

    async exportAll() {
        return await this.db.exportAll();
    }

    async renameProject(from, to) {
        return await this.db.renameProject(from, to);
    }

    async countAll() {
        return await this.db.countAll();
    }

    async backupTo(destPath) {
        return await this.db.backupTo(destPath);
    }

    async deleteMemoriesWhere(filters) {
        return await this.db.deleteMemoriesWhere(filters);
    }

    async close() {
        if (this.db?.close) await this.db.close();
    }
}

module.exports = DatabaseAdapter;
