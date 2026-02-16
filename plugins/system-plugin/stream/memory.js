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
      description: '【重要】当用户说出希望被记住的内容时调用此工具，将信息持久化到长期记忆。适用场景：用户说“记住/记一下/别忘了/帮我记着”、提到个人偏好（口味、习惯、生日）、约定（下次要做的事）、重要信息（名字、关系、地址）、或明确要求“以后要记得”。content 填一句简洁完整的记忆句子，不要只填关键词。',
      inputSchema: {
        type: 'object',
        properties: { content: { type: 'string', description: '一句完整可读的记忆内容，例如：用户不喜欢吃辣；用户生日是3月15日；约定下周六一起看电影' } },
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
      description: '根据关键词从长期记忆中检索相关内容。当需要“回忆/之前记过/你记得吗/查一下记忆”或回答与用户过去偏好、约定、个人信息相关的问题时，先调用此工具用 1～3 个关键词查询，再根据返回的记忆回复。keyword 用与主题相关的词，如：生日、口味、约定、名字。',
      inputSchema: {
        type: 'object',
        properties: { keyword: { type: 'string', description: '检索关键词，如：生日、不吃辣、约定、昵称' } },
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
      description: '列出当前用户在当前场景（群聊/私聊）下已保存的全部长期记忆。当用户问“你记得我什么/我有哪些记忆/看看你记了什么/记忆列表”时调用，无需参数。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const memories = await this.listMemories(context);
        return { success: true, data: { memories, count: memories.length } };
      },
      enabled: true
    });

    this.registerMCPTool('delete_memory', {
      description: '按记忆ID删除一条长期记忆。当用户说“删掉这条/忘记这个/取消记忆/那条记错了”并指向某条记忆时，先 list_memories 或 query_memory 拿到对应记忆的 id，再调用此工具传入该 id。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '要删除的记忆条目的 id，从 list_memories 或 query_memory 返回结果中获取' } },
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
    return [
      '你具备长期记忆能力，可以跨会话记住与用户相关的内容。',
      '· 用户说“记住/记一下/别忘了”或提到偏好、约定、重要信息时，使用 save_memory 保存。',
      '· 回答“你记得吗/之前记过什么”或需要回忆时，先用 query_memory 按关键词查，再结合结果回复。',
      '· 用户问“我有哪些记忆”时用 list_memories；要删除某条记忆时用 delete_memory 并传入该条 id。',
      '记忆按用户与场景（群/私聊）隔离，只读写当前用户在当前场景下的记忆。'
    ].join('\n');
  }

  async buildChatContext() {
    return [];
  }
}
