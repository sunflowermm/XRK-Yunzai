/**
 * 知识库工作流
 * 业务层：plugins/system-plugin/stream/
 */
import AIStream from '../../../lib/aistream/aistream.js';
import BotUtil from '../../../lib/util.js';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';

export default class DatabaseStream extends AIStream {
  constructor() {
    super({
      name: 'database',
      description: '知识库工作流插件',
      version: '2.0.0',
      author: 'XRK',
      priority: 1,
      config: { enabled: true, temperature: 0.7, maxTokens: 2000 },
      embedding: { enabled: false }
    });
    this.dbDir = path.join(os.homedir(), '.xrk', 'knowledge');
    this.databases = new Map();
  }

  async init() {
    await super.init();
    await fs.mkdir(this.dbDir, { recursive: true });
    this.registerAllFunctions();
  }

  registerAllFunctions() {
    this.registerMCPTool('save_knowledge', {
      description: '保存知识到知识库。支持文本或 JSON 格式。',
      inputSchema: {
        type: 'object',
        properties: {
          db: { type: 'string', description: '知识库名称' },
          content: { type: 'string', description: '知识内容（文本或 JSON）' }
        },
        required: ['db', 'content']
      },
      handler: async (args = {}) => {
        const { db, content } = args;
        if (!db) return { success: false, error: '知识库名称不能为空' };
        if (!content) return { success: false, error: '知识内容不能为空' };
        await this.saveKnowledge(db, content);
        return { success: true, data: { db, message: '知识保存成功' } };
      },
      enabled: true
    });

    this.registerMCPTool('query_knowledge', {
      description: '从知识库查询知识。支持关键词搜索，不指定关键词则返回所有。',
      inputSchema: {
        type: 'object',
        properties: {
          db: { type: 'string', description: '知识库名称' },
          keyword: { type: 'string', description: '搜索关键词（可选）' }
        },
        required: ['db']
      },
      handler: async (args = {}) => {
        const { db, keyword } = args;
        if (!db) return { success: false, error: '知识库名称不能为空' };
        const results = await this.queryKnowledge(db, keyword);
        return {
          success: true,
          data: { db, keyword: keyword || '*', results, count: results.length }
        };
      },
      enabled: true
    });

    this.registerMCPTool('list_knowledge', {
      description: '列出所有可用的知识库。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const dbs = await this.listDatabases();
        return { success: true, data: { databases: dbs, count: dbs.length } };
      },
      enabled: true
    });

    this.registerMCPTool('delete_knowledge', {
      description: '从知识库删除知识。支持按 ID、条件或 "*" 删除全部。',
      inputSchema: {
        type: 'object',
        properties: {
          db: { type: 'string', description: '知识库名称' },
          condition: { type: 'string', description: '删除条件：ID、key=value 或 *' }
        },
        required: ['db']
      },
      handler: async (args = {}) => {
        const { db, condition } = args;
        if (!db) return { success: false, error: '知识库名称不能为空' };
        const count = await this.deleteKnowledge(db, condition || '*');
        return {
          success: true,
          data: { db, condition: condition || '*', deletedCount: count, message: `已删除 ${count} 条知识` }
        };
      },
      enabled: true
    });
  }

  async saveKnowledge(db, content) {
    const dbFile = path.join(this.dbDir, `${db}.json`);
    let records = [];
    try {
      const data = await fs.readFile(dbFile, 'utf8');
      records = JSON.parse(data);
    } catch {
      // 文件不存在
    }
    let knowledgeData;
    try {
      knowledgeData = JSON.parse(content);
    } catch {
      knowledgeData = { content, type: 'text' };
    }
    const record = {
      id: Date.now(),
      ...knowledgeData,
      createdAt: new Date().toISOString()
    };
    records.push(record);
    await fs.writeFile(dbFile, JSON.stringify(records, null, 2), 'utf8');
    this.databases.set(db, records);
    BotUtil.makeLog('info', `[${this.name}] 保存知识到知识库: ${db}`, 'DatabaseStream');
  }

  async queryKnowledge(db, keyword) {
    const dbFile = path.join(this.dbDir, `${db}.json`);
    let records = [];
    try {
      const data = await fs.readFile(dbFile, 'utf8');
      records = JSON.parse(data);
    } catch {
      return [];
    }
    if (!keyword || keyword === '*') return records;
    const kw = keyword.toLowerCase();
    return records.filter(record => {
      const content = JSON.stringify(record).toLowerCase();
      return content.includes(kw);
    });
  }

  async listDatabases() {
    try {
      const files = await fs.readdir(this.dbDir);
      return files.filter(file => file.endsWith('.json')).map(file => file.replace('.json', ''));
    } catch {
      return [];
    }
  }

  async deleteKnowledge(db, condition) {
    const dbFile = path.join(this.dbDir, `${db}.json`);
    let records = [];
    try {
      const data = await fs.readFile(dbFile, 'utf8');
      records = JSON.parse(data);
    } catch {
      return 0;
    }
    if (!condition || condition === '*') {
      records = [];
    } else {
      const id = parseInt(condition, 10);
      if (!Number.isNaN(id)) {
        const before = records.length;
        records = records.filter(r => r.id !== id);
        const deleted = before - records.length;
        await fs.writeFile(dbFile, JSON.stringify(records, null, 2), 'utf8');
        this.databases.set(db, records);
        return deleted;
      }
      const [key, value] = condition.split('=').map(s => s.trim());
      const before = records.length;
      records = records.filter(r => r[key] !== value);
      const deleted = before - records.length;
      await fs.writeFile(dbFile, JSON.stringify(records, null, 2), 'utf8');
      this.databases.set(db, records);
      return deleted;
    }
    await fs.writeFile(dbFile, JSON.stringify(records, null, 2), 'utf8');
    this.databases.set(db, records);
    return records.length;
  }

  buildSystemPrompt() {
    return '知识库工作流插件，提供知识存储和检索能力。';
  }

  getDatabasesSync() {
    try {
      const files = fsSync.readdirSync(this.dbDir);
      return files.filter(file => file.endsWith('.json')).map(file => file.replace('.json', ''));
    } catch {
      return [];
    }
  }

  async buildChatContext() {
    return [];
  }
}
