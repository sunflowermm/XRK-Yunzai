/**
 * Model Context Protocol (MCP) 服务器实现
 * 符合 MCP 规范，基于 JSON-RPC 2.0，统一管理所有工作流的工具并暴露给 LLM/HTTP
 */
import BotUtil from '../util.js';
import crypto from 'crypto';
import os from 'os';

const EMPTY_SCHEMA = { type: 'object', properties: {}, required: [] };

export class MCPServer {
  constructor() {
    this.tools = new Map();
    this.resources = new Map();
    this.prompts = new Map();
    this.initialized = false;
    this.serverInfo = {
      name: 'xrk-yunzai-mcp-server',
      version: '1.0.0',
      protocolVersion: '2025-11-25'
    };
    this.registerCoreTools();
  }

  registerTool(name, tool) {
    this.tools.set(name, {
      name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || {},
      handler: tool.handler
    });
  }

  registerResource(uri, resource) {
    this.resources.set(uri, {
      uri,
      name: resource.name || uri,
      description: resource.description || '',
      mimeType: resource.mimeType || 'text/plain',
      handler: resource.handler
    });
  }

  registerPrompt(name, prompt) {
    this.prompts.set(name, {
      name,
      description: prompt.description || '',
      arguments: prompt.arguments || [],
      handler: prompt.handler
    });
  }

  _toolToDef(tool) {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema || EMPTY_SCHEMA
    };
  }

  _errorContent(code, message, data = null) {
    const payload = { success: false, error: { code, message, timestamp: Date.now() } };
    if (data != null) payload.error.data = data;
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      isError: true
    };
  }

  _textContent(obj, isError = false) {
    const text = JSON.stringify(obj !== undefined && obj !== null ? obj : { success: true }, null, 2);
    return { content: [{ type: 'text', text }], isError };
  }

  /** 处理工具调用，返回 { content: [{ type: 'text', text }], isError } */
  async handleToolCall(request) {
    const { name, arguments: args } = request;

    if (!this.tools.has(name)) {
      return this._errorContent(-32601, `工具未找到: ${name}`);
    }

    const tool = this.tools.get(name);
    const argsStr = typeof args === 'object' && args !== null ? JSON.stringify(args) : '';
    BotUtil.makeLog('info', `${name} ${argsStr}`.trim(), 'MCP');

    try {
      if (tool.inputSchema?.properties) this.validateArguments(args || {}, tool.inputSchema);
      const result = await tool.handler(args || {});

      if (result && typeof result === 'object' && Array.isArray(result.content)) {
        return { content: result.content, isError: result.isError || false };
      }
      const isError = result && typeof result === 'object' && result.success === false;
      return this._textContent(result, isError);
    } catch (error) {
      BotUtil.makeLog('error', `MCP工具调用失败[${name}]: ${error.message}`, 'MCPServer');
      return this._errorContent(-32603, error.message, { tool: name, arguments: args });
    }
  }

  validateArguments(args, schema) {
    if (!schema.properties) return;
    if (schema.required) {
      for (const required of schema.required) {
        if (!(required in args)) throw new Error(`缺少必需参数: ${required}`);
      }
    }
    for (const [key, value] of Object.entries(args)) {
      const propSchema = schema.properties[key];
      if (propSchema?.type) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (actualType !== propSchema.type && propSchema.type !== 'object') {
          throw new Error(`参数 ${key} 类型不匹配: 期望 ${propSchema.type}, 实际 ${actualType}`);
        }
      }
    }
  }

  /** 获取工具列表。streamName 为空时排除 chat 工作流；否则只返回该工作流工具 */
  listTools(streamName = null) {
    const tools = Array.from(this.tools.values());
    const filtered = streamName
      ? tools.filter(t => t.name.startsWith(`${streamName}.`))
      : tools.filter(t => !t.name.startsWith('chat.'));
    return filtered.map(t => this._toolToDef(t));
  }

  listToolsByStream() {
    const groups = {};
    for (const tool of this.tools.values()) {
      const parts = tool.name.split('.');
      if (parts.length < 2) continue;
      const streamName = parts[0];
      if (!groups[streamName]) groups[streamName] = [];
      groups[streamName].push(this._toolToDef(tool));
    }
    return groups;
  }

  listStreams() {
    const set = new Set();
    for (const name of this.tools.keys()) {
      const stream = name.split('.')[0];
      if (stream) set.add(stream);
    }
    return Array.from(set);
  }

  listResources() {
    return Array.from(this.resources.values()).map(r => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType
    }));
  }

  async getResource(uri) {
    if (!this.resources.has(uri)) throw new Error(`资源未找到: ${uri}`);
    const resource = this.resources.get(uri);
    const content = resource.handler ? await resource.handler() : '';
    return {
      uri,
      mimeType: resource.mimeType,
      text: typeof content === 'string' ? content : JSON.stringify(content)
    };
  }

  listPrompts() {
    return Array.from(this.prompts.values()).map(p => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments || []
    }));
  }

  async getPrompt(name, args = {}) {
    if (!this.prompts.has(name)) throw new Error(`提示词未找到: ${name}`);
    const prompt = this.prompts.get(name);
    const content = prompt.handler ? await prompt.handler(args) : {};
    return {
      name,
      description: prompt.description,
      messages: Array.isArray(content.messages)
        ? content.messages
        : [{ role: 'user', content: typeof content === 'string' ? content : JSON.stringify(content) }]
    };
  }

  async handleJSONRPC(request, options = {}) {
    const { jsonrpc, id, method, params } = request;
    const { stream } = options;

    if (jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' } };
    }

    try {
      let result;
      switch (method) {
        case 'initialize':
          result = await this.handleInitialize(params);
          this.initialized = true;
          break;
        case 'tools/list':
          result = { tools: stream ? this.listTools(stream) : this.listTools() };
          break;
        case 'tools/call':
          if (!params?.name) throw new Error('工具名称不能为空');
          result = await this.handleToolCall({
            name: params.name,
            arguments: params.arguments || {}
          });
          break;
        case 'resources/list':
          result = { resources: this.listResources() };
          break;
        case 'resources/read':
          if (!params?.uri) throw new Error('资源URI不能为空');
          result = await this.getResource(params.uri);
          break;
        case 'prompts/list':
          result = { prompts: this.listPrompts() };
          break;
        case 'prompts/get':
          if (!params?.name) throw new Error('提示词名称不能为空');
          result = await this.getPrompt(params.name, params.arguments || {});
          break;
        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      BotUtil.makeLog('error', `MCP JSON-RPC处理失败[${method}]: ${error.message}`, 'MCPServer');
      return { jsonrpc: '2.0', id, error: { code: -32603, message: error.message } };
    }
  }

  async handleInitialize() {
    return {
      protocolVersion: this.serverInfo.protocolVersion,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: this.serverInfo.name, version: this.serverInfo.version }
    };
  }

  registerCoreTools() {
    const gb = (n) => `${Math.round(n / 1024 / 1024 / 1024)}GB`;
    const mb = (n) => `${Math.round(n / 1024 / 1024)}MB`;
    this.registerTool('system.info', {
      description: '获取系统信息（操作系统、CPU、内存、平台等）',
      inputSchema: {
        type: 'object',
        properties: { detail: { type: 'boolean', default: false } },
        required: []
      },
      handler: (args) => {
        const { detail = false } = args;
        const mem = process.memoryUsage();
        const cpus = os.cpus();
        const total = os.totalmem();
        const free = os.freemem();
        const info = {
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          hostname: os.hostname(),
          cpu: { cores: cpus.length, model: cpus[0]?.model || 'Unknown' },
          memory: {
            total: gb(total),
            free: gb(free),
            used: gb(total - free),
            usage: Math.round(((total - free) / total) * 100)
          },
          uptime: { seconds: Math.round(os.uptime()), hours: Math.round(os.uptime() / 3600), days: Math.round(os.uptime() / 86400) }
        };
        if (detail) {
          info.processMemory = { rss: mb(mem.rss), heapTotal: mb(mem.heapTotal), heapUsed: mb(mem.heapUsed), external: mb(mem.external) };
          info.networkInterfaces = Object.keys(os.networkInterfaces()).length;
        }
        return info;
      }
    });

    // 工具2：时间工具（跨平台）
    this.registerTool('time.now', {
      description: '获取当前时间信息（支持多种格式和时区）',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['iso', 'locale', 'timestamp', 'unix'], default: 'locale' },
          timezone: { type: 'string', description: '时区，如 Asia/Shanghai' }
        },
        required: []
      },
      handler: (args) => {
        const { format = 'locale', timezone } = args;
        const now = new Date();
        const opts = timezone ? { timeZone: timezone } : {};
        const ts = now.getTime();
        const unix = Math.floor(ts / 1000);
        const iso = now.toISOString();
        const base = { format, timestamp: ts, unix, iso };

        if (format === 'iso') return { ...base, time: iso };
        if (format === 'timestamp') return base;
        if (format === 'unix') return base;
        return {
          ...base,
          time: now.toLocaleString('zh-CN', opts),
          date: now.toLocaleDateString('zh-CN', opts),
          timeOnly: now.toLocaleTimeString('zh-CN', opts)
        };
      }
    });

    // 工具3：UUID 生成
    const genUuid = () => (crypto.randomUUID && crypto.randomUUID()) ||
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    this.registerTool('util.uuid', {
      description: '生成 UUID（v4）',
      inputSchema: {
        type: 'object',
        properties: { version: { type: 'string', enum: ['v4'], default: 'v4' }, count: { type: 'integer', minimum: 1, maximum: 100, default: 1 } },
        required: []
      },
      handler: (args) => {
        const { version = 'v4', count = 1 } = args;
        const n = Math.min(count, 100);
        const uuids = Array.from({ length: n }, genUuid);
        return { version, count: uuids.length, uuids: n === 1 ? uuids[0] : uuids };
      }
    });

    // 工具4：哈希计算
    this.registerTool('util.hash', {
      description: '计算字符串哈希（md5/sha1/sha256/sha512）',
      inputSchema: {
        type: 'object',
        properties: { data: { type: 'string' }, algorithm: { type: 'string', enum: ['md5', 'sha1', 'sha256', 'sha512'], default: 'sha256' } },
        required: ['data']
      },
      handler: (args) => {
        const { data, algorithm = 'sha256' } = args;
        if (!data) throw new Error('数据不能为空');
        const hex = crypto.createHash(algorithm).update(data).digest('hex');
        return { algorithm, hash: hex, length: hex.length };
      }
    });
  }
}
