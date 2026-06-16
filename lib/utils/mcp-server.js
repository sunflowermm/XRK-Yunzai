/**
 * Model Context Protocol (MCP) 服务器实现
 * 符合 MCP 规范，基于 JSON-RPC 2.0，统一管理所有工作流的工具并暴露给 LLM/HTTP
 */
import crypto from 'crypto';
import os from 'os';

const EMPTY_SCHEMA = { type: 'object', properties: {}, required: [] };

const MCP_TOOL_TEXT_MAX_JSON = 8000;

function formatSearchResultsForModel(data) {
  if (!data || typeof data !== 'object') return null;
  const results = Array.isArray(data.results) ? data.results : null;
  if (!results || results.length === 0) return null;
  const query = data.query != null ? String(data.query) : '';
  const lines = [`搜索${query ? `「${query}」` : ''}共 ${results.length} 条：`];
  const show = results.slice(0, 8);
  for (let i = 0; i < show.length; i++) {
    const r = show[i];
    const title = r?.title ? String(r.title).trim() : '无标题';
    const snippet = r?.snippet ? String(r.snippet).replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    const url = r?.url ? String(r.url) : '';
    lines.push(`${i + 1}. ${title}${snippet ? ` — ${snippet}` : ''}${url ? ` (${url})` : ''}`);
  }
  if (results.length > show.length) {
    lines.push(`…另有 ${results.length - show.length} 条未列出。请用中文概括后调用 reply，勿粘贴 JSON。`);
  }
  return lines.join('\n');
}

function capToolText(text, maxLen = MCP_TOOL_TEXT_MAX_JSON) {
  const s = String(text ?? '');
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}\n…(工具输出已截断 ${s.length} 字符，请概括要点后用 reply 回复用户)`;
}

/** 将工具返回值整理为 AI 可读文本（LLM 工具轮与群聊历史摘要共用） */
export function summarizeToolResultText(result, maxLen = MCP_TOOL_TEXT_MAX_JSON) {
  if (result == null) return '已执行';
  if (typeof result !== 'object') return capToolText(String(result), maxLen);
  if (result.success === false) {
    const err = result.error;
    const out = typeof err === 'string' ? err : (err?.message || JSON.stringify(err));
    return capToolText(out, maxLen);
  }
  if (typeof result.raw === 'string' && result.raw.trim()) {
    const raw = result.raw.trim();
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw);
        const searchText = formatSearchResultsForModel(parsed);
        if (searchText) return capToolText(searchText, maxLen);
      } catch {
        /* 非 JSON 的 raw 原文 */
      }
    }
    return capToolText(raw, maxLen);
  }
  const msg = result.message;
  const data = result.data;
  if (msg != null && msg !== '') {
    return capToolText(String(msg), maxLen);
  }
  if (data != null) {
    const searchText = formatSearchResultsForModel(data);
    if (searchText) return capToolText(searchText, maxLen);
    if (typeof data === 'string') return capToolText(data, maxLen);
    try {
      const str = JSON.stringify(data);
      if (str && str !== '{}') return capToolText(str, maxLen);
    } catch {
      /* ignore */
    }
  }
  try {
    const str = JSON.stringify(result);
    if (str && str !== '{}') return capToolText(str, maxLen);
  } catch {
    /* ignore */
  }
  return '已执行';
}

const HISTORY_ARG_KEYS = ['command', 'query', 'path', 'url', 'messageId', 'limit', 'content', 'saveAs'];

/** 群聊历史中的工具摘要：工具名 + 关键参数 + 结果（较短，避免撑爆 prompt） */
export function summarizeToolForHistory(toolName, result, args = null, maxLen = 600) {
  const full = String(toolName || 'tool');
  const shortName = full.includes('.') ? full.split('.').slice(-2).join('.') : full;
  let argHint = '';
  if (args && typeof args === 'object') {
    for (const key of HISTORY_ARG_KEYS) {
      if (args[key] == null || args[key] === '') continue;
      const s = String(args[key]).replace(/\s+/g, ' ').trim();
      if (!s) continue;
      argHint = s.length > 100 ? `${s.slice(0, 100)}…` : s;
      break;
    }
  }
  const head = argHint ? `${shortName}「${argHint}」` : shortName;
  if (result && typeof result === 'object' && result.success === false) {
    const err = typeof result.error === 'string'
      ? result.error
      : (result.error?.message || summarizeToolResultText(result, 200));
    return capToolText(`${head} → 失败: ${String(err).slice(0, 220)}`, maxLen);
  }
  const body = summarizeToolResultText(result, maxLen - head.length - 4);
  return `${head} → ${body}`.slice(0, maxLen + 80);
}

export class MCPServer {
  tools = new Map();
  resources = new Map();
  prompts = new Map();
  initialized = false;
  serverInfo = {
    name: 'xrk-yunzai-mcp-server',
    version: '1.0.0',
    protocolVersion: '2025-11-25'
  };

  constructor() {
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

  /** 将工具返回值整理为 AI 可读文本（含远程 MCP 的 raw） */
  _toolResultToText(result) {
    if (result == null) {
      Bot.makeLog('debug', '[MCP] _toolResultToText result=null → 已执行', 'MCPServer');
      return '已执行';
    }
    const text = summarizeToolResultText(result);
    if (result && typeof result === 'object' && result.success === false) {
      Bot.makeLog('debug', `[MCP] _toolResultToText success=false → ${text}`, 'MCPServer');
    } else if (typeof result?.raw === 'string' && result.raw.trim()) {
      Bot.makeLog('debug', `[MCP] _toolResultToText 使用 raw len=${result.raw.length}`, 'MCPServer');
    }
    return text;
  }

  /** 处理工具调用，返回 { content: [{ type: 'text', text }], isError } */
  async handleToolCall(request) {
    const { name, arguments: args } = request;
    const argsStr = args != null && typeof args === 'object' ? JSON.stringify(args) : '';
    Bot.makeLog('info', `[MCP] handleToolCall 入口 ${name} args=${argsStr.slice(0, 2000)}`, 'MCP');

    if (!this.tools.has(name)) {
      Bot.makeLog('warn', `[MCP] handleToolCall 工具未找到: ${name}`, 'MCP');
      return this._errorContent(-32601, `工具未找到: ${name}`);
    }

    const tool = this.tools.get(name);
    try {
      if (tool.inputSchema?.properties) this.validateArguments(args || {}, tool.inputSchema);
      Bot.makeLog('debug', `[MCP] handleToolCall 执行 handler ${name}`, 'MCP');
      const result = await tool.handler(args || {});
      Bot.makeLog('debug', `[MCP] handleToolCall handler 返回 ${name} hasResult=${!!result} success=${result?.success} hasContent=${!!result?.content} hasRaw=${!!result?.raw}`, 'MCP');

      if (result && typeof result === 'object' && Array.isArray(result.content)) {
        Bot.makeLog('debug', `[MCP] handleToolCall 直接返回 content 数组 len=${result.content?.length}`, 'MCP');
        return { content: result.content, isError: result.isError || false };
      }
      const isError = result && typeof result === 'object' && result.success === false;
      const text = this._toolResultToText(result);
      Bot.makeLog('debug', `[MCP] handleToolCall 返回 ${name} textLen=${text?.length ?? 0} isError=${isError} 前1000字=${(text || '').slice(0, 1000)}`, 'MCP');
      return { content: [{ type: 'text', text }], isError };
    } catch (error) {
      Bot.makeLog('error', `[MCP] handleToolCall 失败 ${name}: ${error.message}`, 'MCP');
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

  // 缓存：streamName -> 工具名称列表，用于减少重复日志
  _toolsListCache = new Map();

  /** 获取工具列表。streamName 为空时排除 chat 工作流；否则只返回该工作流工具 */
  listTools(streamName = null, logEnabled = true) {
    const tools = Array.from(this.tools.values());
    const filtered = streamName
      ? tools.filter(t => t.name.startsWith(`${streamName}.`))
      : tools.filter(t => !t.name.startsWith('chat.'));
    const result = filtered.map(t => this._toolToDef(t));
    
    // 只在工具列表变化时打印日志
    if (logEnabled) {
      const toolNames = result.map(t => t.name).sort().join(',');
      const cacheKey = streamName ?? 'all';
      const cached = this._toolsListCache.get(cacheKey);
      if (cached !== toolNames) {
        this._toolsListCache.set(cacheKey, toolNames);
        Bot.makeLog('debug', `[MCPServer] listTools streamName=${cacheKey} 工具数=${result.length}`, 'MCPServer');
      }
    }
    
    return result;
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
      Bot.makeLog('error', `MCP JSON-RPC处理失败[${method}]: ${error.message}`, 'MCPServer');
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
