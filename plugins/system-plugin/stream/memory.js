/**
 * 记忆系统工作流
 * 业务层：plugins/system-plugin/stream/
 * 使用文件存储，不依赖 MemoryManager
 */
import AIStream from '../../../lib/aistream/aistream.js';
import BotUtil from '../../../lib/util.js';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

export default class MemoryStream extends AIStream {
  constructor() {
    super({
      name: 'memory',
      description: '记忆系统工作流插件',
      version: '1.0.5',
      author: 'XRK',
      priority: 1,
      config: { enabled: true, temperature: 0.7, maxTokens: 2000 },
      embedding: { enabled: false }
    });
    this.memoryDir = path.join(os.homedir(), '.xrk', 'memory');
    this.memories = new Map();
  }

  async init() {
    await super.init();
    await fs.mkdir(this.memoryDir, { recursive: true });
    this.registerAllFunctions();
    await this.loadMemories();
  }

  registerAllFunctions() {
    this.registerMCPTool('save_memory', {
      description: '保存长期记忆。记忆会跨会话持久化存储，与用户ID和场景关联。',
      inputSchema: {
        type: 'object',
        properties: { content: { type: 'string', description: '记忆内容' } },
        required: ['content']
      },
      handler: async (args = {}, context = {}) => {
        const { content } = args;
        if (!content) return { success: false, error: '记忆内容不能为空' };
        const memoryId = await this.saveMemory(content, context);
        return {
          success: true,
          data: { memoryId, message: '记忆保存成功', content: content.slice(0, 100) }
        };
      },
      enabled: true
    });

    this.registerMCPTool('query_memory', {
      description: '根据关键词查询相关的长期记忆。',
      inputSchema: {
        type: 'object',
        properties: { keyword: { type: 'string', description: '搜索关键词' } },
        required: ['keyword']
      },
      handler: async (args = {}, context = {}) => {
        const { keyword } = args;
        if (!keyword) return { success: false, error: '关键词不能为空' };
        const memories = await this.queryMemories(keyword, context);
        return {
          success: true,
          data: { keyword, memories, count: memories.length }
        };
      },
      enabled: true
    });

    this.registerMCPTool('list_memories', {
      description: '列出当前用户在当前场景下的所有记忆。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const memories = await this.listMemories(context);
        return { success: true, data: { memories, count: memories.length } };
      },
      enabled: true
    });

    this.registerMCPTool('delete_memory', {
      description: '根据记忆ID删除指定的长期记忆。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '记忆ID' } },
        required: ['id']
      },
      handler: async (args = {}, context = {}) => {
        const { id } = args;
        if (!id) return { success: false, error: '记忆ID不能为空' };
        const success = await this.deleteMemory(id, context);
        return {
          success: true,
          data: { id, message: success ? '记忆删除成功' : '记忆删除失败' }
        };
      },
      enabled: true
    });
  }

  getUserId(context) {
    return context?.e?.user_id || context?.e?.user?.id || 'default';
  }

  getScene(context) {
    return context?.e?.group_id ? 'group' : (context?.e?.user_id ? 'private' : 'default');
  }

  _userFile(userId) {
    return path.join(this.memoryDir, `user_${String(userId).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }

  async loadMemories() {
    try {
      const files = await fs.readdir(this.memoryDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const fullPath = path.join(this.memoryDir, file);
        const data = await fs.readFile(fullPath, 'utf8');
        const list = JSON.parse(data);
        for (const m of list) this.memories.set(String(m.id), m);
      }
    } catch {
      // ignore
    }
  }

  async saveMemory(content, context) {
    const userId = this.getUserId(context);
    const scene = this.getScene(context);
    const memoryId = String(Date.now());
    const memory = {
      id: memoryId,
      content,
      userId,
      scene,
      timestamp: Date.now(),
      createdAt: new Date().toISOString()
    };
    this.memories.set(memoryId, memory);
    const userFile = this._userFile(userId);
    let list = [];
    try {
      const data = await fs.readFile(userFile, 'utf8');
      list = JSON.parse(data);
    } catch {
      // new file
    }
    list.unshift(memory);
    await fs.writeFile(userFile, JSON.stringify(list, null, 2), 'utf8');
    return memoryId;
  }

  async queryMemories(keyword, context) {
    const userId = this.getUserId(context);
    const scene = this.getScene(context);
    const userFile = this._userFile(userId);
    let list = [];
    try {
      const data = await fs.readFile(userFile, 'utf8');
      list = JSON.parse(data);
    } catch {
      return [];
    }
    const kw = (keyword || '').toLowerCase();
    return list
      .filter(m => (m.userId === userId || !userId) && (m.scene === scene || !scene))
      .filter(m => (m.content || '').toLowerCase().includes(kw))
      .slice(0, 10);
  }

  async listMemories(context) {
    const userId = this.getUserId(context);
    const scene = this.getScene(context);
    const userFile = this._userFile(userId);
    let list = [];
    try {
      const data = await fs.readFile(userFile, 'utf8');
      list = JSON.parse(data);
    } catch {
      return [];
    }
    return list
      .filter(m => (m.userId === userId || !userId) && (m.scene === scene || !scene))
      .slice(0, 50);
  }

  async deleteMemory(id, context) {
    const userId = this.getUserId(context);
    const userFile = this._userFile(userId);
    let list = [];
    try {
      const data = await fs.readFile(userFile, 'utf8');
      list = JSON.parse(data);
    } catch {
      return false;
    }
    const before = list.length;
    list = list.filter(m => String(m.id) !== String(id));
    if (list.length === before) return false;
    await fs.writeFile(userFile, JSON.stringify(list, null, 2), 'utf8');
    this.memories.delete(String(id));
    return true;
  }

  buildSystemPrompt() {
    return '记忆工作流插件，提供长期记忆的保存与查询。';
  }

  async buildChatContext() {
    return [];
  }
}
