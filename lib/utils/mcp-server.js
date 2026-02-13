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

  /**
   * 注册MCP工具
   * @param {string} name - 工具名称
   * @param {Object} tool - 工具定义
   * @param {string} tool.description - 工具描述
   * @param {Object} tool.inputSchema - 输入参数schema（JSON Schema格式）
   * @param {Function} tool.handler - 工具处理函数
   */
  registerTool(name, tool) {
    // 静默覆盖已存在的工具（避免热重载时的重复警告）
    // 工具注册前应该先清空旧工具，这里只记录调试信息
    if (this.tools.has(name) && process.env.DEBUG_MCP_TOOLS) {
      BotUtil.makeLog('debug', `MCP工具已存在，将被覆盖: ${name}`, 'MCPServer');
    }
    
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

  /**
   * 处理MCP工具调用请求（符合MCP标准）
   * 
   * 返回格式说明：
   * - 标准MCP格式：{ content: [{ type: 'text', text: string }], isError: boolean }
   * - 工具handler返回的结构化数据会被转换为JSON字符串放入text字段
   * - 如果工具返回{ success: false }，isError会被设置为true
   * 
   * @param {Object} request - MCP请求
   * @param {string} request.name - 工具名称
   * @param {Object} request.arguments - 工具参数
   * @returns {Promise<Object>} MCP响应（符合MCP标准格式）
   */
  async handleToolCall(request) {
    const { name, arguments: args } = request;

    if (!this.tools.has(name)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: {
                code: -32601,
                message: `工具未找到: ${name}`,
                timestamp: Date.now()
              }
            }, null, 2)
          }
        ],
        isError: true
      };
    }

    const tool = this.tools.get(name);
    const isRemote = name.startsWith('remote-mcp.');

    BotUtil.makeLog(
      'info',
      `MCP 工具调用开始: ${name}${isRemote ? ' (remote)' : ''}`,
      'MCPServer'
    );

    try {
      // 验证参数schema（如果提供）
      if (tool.inputSchema && tool.inputSchema.properties) {
        this.validateArguments(args || {}, tool.inputSchema);
      }

      // 调用工具handler
      const result = await tool.handler(args || {});
      
      // 格式化响应（符合MCP标准）
      // 如果result已经是MCP标准格式（有content数组），直接返回
      if (result && typeof result === 'object' && Array.isArray(result.content)) {
        return {
          content: result.content,
          isError: result.isError || false
        };
      }
      
      // 检查是否为错误结果
      const isError = result && typeof result === 'object' && result.success === false;

      BotUtil.makeLog(
        isError ? 'warn' : 'info',
        `MCP 工具调用完成: ${name}${isRemote ? ' (remote)' : ''}, isError=${isError}`,
        'MCPServer'
      );
      
      // 直接返回结果，不做增强（AI无法使用MCP，增强逻辑无用）
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result !== undefined && result !== null ? result : { success: true }, null, 2)
          }
        ],
        isError
      };
    } catch (error) {
      BotUtil.makeLog('error', `MCP工具调用失败[${name}]: ${error.message}`, 'MCPServer');
      
      return {
        content: [
          {
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
          }
        ],
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

  /**
   * 获取所有可用工具列表（符合MCP标准）
   * @param {string} streamName - 可选：工作流名称，如果提供则只返回该工作流的工具
   * @returns {Array} 工具列表
   */
  listTools(streamName = null) {
    const tools = Array.from(this.tools.values());

    // 如果指定了工作流名称，只返回该工作流的工具
    if (streamName) {
      const prefix = `${streamName}.`;
      return tools
        .filter(tool => tool.name.startsWith(prefix))
        .map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema || {
            type: 'object',
            properties: {},
            required: []
          }
        }));
    }

    // 默认情况下，全局工具列表中隐藏 chat 工作流的 MCP 工具，
    // 避免在标准 JSON-RPC 接口和 LLM 工具注入时暴露群管相关能力。
    return tools
      .filter(tool => !tool.name.startsWith('chat.'))
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema || {
          type: 'object',
          properties: {},
          required: []
        }
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

  /**
   * 注册跨平台通用核心工具
   */
  registerCoreTools() {
    // 工具1：系统信息（跨平台）
    this.registerTool('system.info', {
      description: '获取系统信息（操作系统、CPU、内存、平台等）',
      inputSchema: {
        type: 'object',
        properties: {
          detail: {
            type: 'boolean',
            description: '是否返回详细信息（默认false）',
            default: false
          }
        },
        required: []
      },
      handler: async (args) => {
        const { detail = false } = args;
        const memUsage = process.memoryUsage();
        const cpuInfo = os.cpus();
        
        const info = {
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          hostname: os.hostname(),
          cpu: {
            cores: cpuInfo.length,
            model: cpuInfo[0]?.model || 'Unknown'
          },
          memory: {
            total: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`,
            free: `${Math.round(os.freemem() / 1024 / 1024 / 1024)}GB`,
            used: `${Math.round((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024)}GB`,
            usage: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100)
          },
          uptime: {
            seconds: Math.round(os.uptime()),
            hours: Math.round(os.uptime() / 3600),
            days: Math.round(os.uptime() / 86400)
          }
        };
        
        if (detail) {
          info.processMemory = {
            rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
            heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
            heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
            external: `${Math.round(memUsage.external / 1024 / 1024)}MB`
          };
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
          format: {
            type: 'string',
            enum: ['iso', 'locale', 'timestamp', 'unix'],
            description: '时间格式: iso(ISO 8601), locale(本地格式), timestamp(毫秒时间戳), unix(秒时间戳)',
            default: 'locale'
          },
          timezone: {
            type: 'string',
            description: '时区（可选，例如: Asia/Shanghai, America/New_York）'
          }
        },
        required: []
      },
      handler: async (args) => {
        const { format = 'locale', timezone } = args;
        const now = new Date();
        const options = timezone ? { timeZone: timezone } : {};

        switch (format) {
          case 'iso':
            return {
              format: 'iso',
              time: now.toISOString(),
              timestamp: now.getTime(),
              unix: Math.floor(now.getTime() / 1000)
            };
          case 'timestamp':
            return {
              format: 'timestamp',
              timestamp: now.getTime(),
              unix: Math.floor(now.getTime() / 1000),
              iso: now.toISOString()
            };
          case 'unix':
            return {
              format: 'unix',
              unix: Math.floor(now.getTime() / 1000),
              timestamp: now.getTime(),
              iso: now.toISOString()
            };
          case 'locale':
          default:
            return {
              format: 'locale',
              time: now.toLocaleString('zh-CN', options),
              date: now.toLocaleDateString('zh-CN', options),
              timeOnly: now.toLocaleTimeString('zh-CN', options),
              timestamp: now.getTime(),
              unix: Math.floor(now.getTime() / 1000),
              iso: now.toISOString()
            };
        }
      }
    });

    // 工具3：UUID生成（跨平台）
    this.registerTool('util.uuid', {
      description: '生成UUID（通用唯一标识符）',
      inputSchema: {
        type: 'object',
        properties: {
          version: {
            type: 'string',
            enum: ['v4'],
            description: 'UUID版本: v4(随机UUID)',
            default: 'v4'
          },
          count: {
            type: 'integer',
            description: '生成数量（1-100）',
            minimum: 1,
            maximum: 100,
            default: 1
          }
        },
        required: []
      },
      handler: async (args) => {
        const { version = 'v4', count = 1 } = args;
        const crypto = await import('crypto');
        
        const generateUUID = () => {
          // 使用crypto.randomUUID() (Node.js 14.17.0+)
          if (crypto.randomUUID) {
            return crypto.randomUUID();
          }
          // 降级方案：手动生成v4 UUID
          return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
          });
        };
        
        const uuids = [];
        for (let i = 0; i < Math.min(count, 100); i++) {
          uuids.push(generateUUID());
        }
        
        return {
          version,
          count: uuids.length,
          uuids: count === 1 ? uuids[0] : uuids
        };
      }
    });

    // 工具4：哈希计算（跨平台）
    this.registerTool('util.hash', {
      description: '计算字符串或数据的哈希值（支持多种算法）',
      inputSchema: {
        type: 'object',
        properties: {
          data: {
            type: 'string',
            description: '要计算哈希的数据'
          },
          algorithm: {
            type: 'string',
            enum: ['md5', 'sha1', 'sha256', 'sha512'],
            description: '哈希算法',
            default: 'sha256'
          }
        },
        required: ['data']
      },
      handler: async (args) => {
        const { data, algorithm = 'sha256' } = args;
        if (!data) {
          throw new Error('数据不能为空');
        }

        const crypto = await import('crypto');
        const hash = crypto.createHash(algorithm);
        hash.update(data);
        
        return {
          algorithm,
          hash: hash.digest('hex'),
          length: hash.digest('hex').length
        };
      }
    });
  }
}
