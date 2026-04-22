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

    // Iter 3 abstractions — handlers no longer need to reach this.db.db.*
    async findSimilar(id, opts) { return await this.db.findSimilar(id, opts); }
    async tagMemory(id, ops) { return await this.db.tagMemory(id, ops); }
    async stats(opts) { return await this.db.stats(opts); }
    async countSearchMatches(query, opts) { return await this.db.countSearchMatches(query, opts); }
    async countList(opts) { return await this.db.countList(opts); }
    async groupSummary(field, opts) { return await this.db.groupSummary(field, opts); }
    async listTables() { return await this.db.listTables(); }
    async tableColumns(t) { return await this.db.tableColumns(t); }
    async integrityCheck() { return await this.db.integrityCheck(); }
    async exec(sql) { return await this.db.exec(sql); }
    async pragma(sql) { return await this.db.pragma(sql); }
    get dbPath() { return this.db.dbPath; }
    get ftsAvailable() { return this.db.ftsAvailable === true; }

    async close() {
        if (this.db?.close) await this.db.close();
    }
}

module.exports = DatabaseAdapter;
