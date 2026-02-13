/**
 * Model Context Protocol (MCP) 服务器实现
 * 符合 MCP 规范，基于 JSON-RPC 2.0，统一管理所有工作流的工具并暴露给 LLM/HTTP
 */
import BotUtil from '../util.js';
import os from 'os';

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

  async handleToolCall(request) {
    const { name, arguments: args } = request;

    if (!this.tools.has(name)) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: { code: -32601, message: `工具未找到: ${name}`, timestamp: Date.now() }
          }, null, 2)
        }],
        isError: true
      };
    }

    const tool = this.tools.get(name);
    try {
      if (tool.inputSchema?.properties) {
        this.validateArguments(args || {}, tool.inputSchema);
      }
      const result = await tool.handler(args || {});

      if (result && typeof result === 'object' && Array.isArray(result.content)) {
        return { content: result.content, isError: result.isError || false };
      }

      const isError = result && typeof result === 'object' && result.success === false;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result !== undefined && result !== null ? result : { success: true }, null, 2)
        }],
        isError
      };
    } catch (error) {
      BotUtil.makeLog('error', `MCP工具调用失败[${name}]: ${error.message}`, 'MCPServer');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: {
              code: -32603,
              message: error.message,
              data: { tool: name, arguments: args },
              timestamp: Date.now()
            }
          }, null, 2)
        }],
        isError: true
      };
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

  listTools(streamName = null) {
    const tools = Array.from(this.tools.values());
    if (streamName) {
      const prefix = `${streamName}.`;
      return tools
        .filter(tool => tool.name.startsWith(prefix))
        .map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema || { type: 'object', properties: {}, required: [] }
        }));
    }
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema || { type: 'object', properties: {}, required: [] }
    }));
  }

  listToolsByStream() {
    const groups = {};
    for (const tool of this.tools.values()) {
      const parts = tool.name.split('.');
      if (parts.length >= 2) {
        const streamName = parts[0];
        if (!groups[streamName]) groups[streamName] = [];
        groups[streamName].push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema || { type: 'object', properties: {}, required: [] }
        });
      }
    }
    return groups;
  }

  listStreams() {
    const streams = new Set();
    for (const tool of this.tools.values()) {
      const parts = tool.name.split('.');
      if (parts.length >= 2) streams.add(parts[0]);
    }
    return Array.from(streams);
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
    this.registerTool('system.info', {
      description: '获取系统信息（操作系统、CPU、内存等）',
      inputSchema: {
        type: 'object',
        properties: { detail: { type: 'boolean', description: '是否返回详细信息', default: false } },
        required: []
      },
      handler: async (args = {}) => {
        const { detail = false } = args;
        const memUsage = process.memoryUsage();
        const cpuInfo = os.cpus();
        const info = {
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          hostname: os.hostname(),
          cpu: { cores: cpuInfo.length, model: cpuInfo[0]?.model || 'Unknown' },
          memory: {
            total: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`,
            free: `${Math.round(os.freemem() / 1024 / 1024 / 1024)}GB`,
            usage: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100)
          },
          uptime: { seconds: Math.round(os.uptime()), hours: Math.round(os.uptime() / 3600) }
        };
        if (detail) {
          info.processMemory = {
            rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
            heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`
          };
        }
        return info;
      }
    });

    this.registerTool('time.now', {
      description: '获取当前时间信息',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['iso', 'locale', 'timestamp', 'unix'], default: 'locale' }
        },
        required: []
      },
      handler: async (args = {}) => {
        const { format = 'locale' } = args;
        const now = new Date();
        return {
          format,
          time: now.toLocaleString('zh-CN'),
          timestamp: now.getTime(),
          unix: Math.floor(now.getTime() / 1000),
          iso: now.toISOString()
        };
      }
    });
  }
}
