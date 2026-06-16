/**
 * MCP 工具适配器
 *
 * 将 StreamLoader.mcpServer 上的工具转换为 OpenAI tools 格式，并处理 tool_calls 调用。
 */
import StreamLoader from '../../aistream/loader.js';
import { tryParseJson } from '../json-utils.js';

export class MCPToolAdapter {
  // 缓存：工具名称列表，用于减少重复日志
  static _toolsCache = new Map();

  /**
   * OpenAI Chat Completions 要求 tools[].function.name 匹配 ^[a-zA-Z0-9_-]+$；
   * MCP 常用 `stream.tool` 等形式含 `.`，此处登记「合法名 -> 原始 MCP 名」，供 handleToolCalls 反查。
   */
  static _openAiToolNameToMcp = new Map();

  static getMCPServer() {
    return StreamLoader.mcpServer;
  }

  /** OpenAI Chat Completions：tools[].function.name 须匹配 */
  static OPENAI_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

  /**
   * 是否需在注入请求前改写（已合法且长度≤64 则否；MCP convert 已产出的名通常不必再改）
   */
  static needsOpenAIToolNameSanitize(name) {
    const s = String(name ?? '');
    if (!s.length) return true;
    if (s.length > 64) return true;
    return !this.OPENAI_TOOL_NAME_PATTERN.test(s);
  }

  /**
   * 将原始 MCP 工具名规范为 OpenAI 允许的 function.name（最长 64，参考 XiaomiMiMo / XRK-AGT）
   */
  static _baseSanitizeOpenAIToolName(originalName) {
    let s = String(originalName ?? 'tool')
      .replace(/\./g, '_')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    if (!s.length) s = 'tool';
    if (/^\d/.test(s)) s = `t_${s}`;
    return s.slice(0, 64);
  }

  /**
   * 单次 convert 批次内保证合法名唯一；登记映射供 resolveOpenAiToolNameToMcp 使用
   */
  static _allocateUniqueOpenAIToolName(originalName, usedInBatch) {
    const base = this._baseSanitizeOpenAIToolName(originalName);
    let candidate = base;
    let i = 2;
    while (usedInBatch.has(candidate)) {
      const suf = `_${i}`;
      const maxBaseLen = Math.max(1, 64 - suf.length);
      candidate = (base.slice(0, maxBaseLen) + suf).slice(0, 64);
      i++;
    }
    usedInBatch.add(candidate);
    const raw = String(originalName);
    this._openAiToolNameToMcp.set(candidate, raw);
    return candidate;
  }

  /** 模型返回的 function.name -> MCP handleToolCall 使用的原始名 */
  static resolveOpenAiToolNameToMcp(openAiName) {
    const k = String(openAiName ?? '');
    return this._openAiToolNameToMcp.get(k) ?? openAiName;
  }

  /**
   * 是否为「已通过 MCP 发往当前会话」的 reply 工具（工作流注册名为 `stream.reply`，`stream.name==='mcp'` 时为 `reply`）
   */
  static isReplySendOpenAiOrMcpName(name) {
    const resolved = this.resolveOpenAiToolNameToMcp(String(name ?? ''));
    const mcp = String(resolved || name || '').trim();
    if (!mcp) return false;
    return mcp === 'reply' || mcp.endsWith('.reply');
  }

  /**
   * 单次请求内为「正文里解析出的 toolcall」等场景登记合法名（与 convert 共用映射表）
   * @param {string} originalName - 原始工具名（可含 `.` 等）
   * @param {Set<string>} usedInBatch - 本轮已占用的合法名，避免与 tools 列表撞名
   */
  static allocateOpenAiToolNameForRound(originalName, usedInBatch) {
    const used = usedInBatch instanceof Set ? usedInBatch : new Set();
    return this._allocateUniqueOpenAIToolName(originalName, used);
  }

  /**
   * 对 config/overrides 传入的自定义 tools 补全合法 function.name，并登记映射供 handleToolCalls 使用。
   * MCP convert 产出的名通常已合法，原样跳过以免覆盖映射。
   */
  static ensureOpenAICompatibleToolDefinitions(tools) {
    if (!Array.isArray(tools) || !tools.length) return tools;
    const used = new Set();
    return tools.map(tool => {
      if (tool?.type !== 'function' || tool.function?.name == null) return tool;
      const raw = tool.function.name;
      const validShape = typeof raw === 'string' && raw.length && !this.needsOpenAIToolNameSanitize(raw);
      if (validShape && !used.has(raw)) {
        used.add(raw);
        return tool;
      }
      const safe = this._allocateUniqueOpenAIToolName(raw, used);
      return {
        ...tool,
        function: { ...tool.function, name: safe }
      };
    });
  }

  /** 将 MCP 工具转为 OpenAI tools。streams 为工作流白名单；未传时 listTools(null)（不含 chat） */
  static convertMCPToolsToOpenAI(streamsOrOptions = []) {
    const mcpServer = this.getMCPServer();
    if (!mcpServer) return [];

    let list = [];
    if (Array.isArray(streamsOrOptions)) {
      list = streamsOrOptions.filter(Boolean).map((s) => String(s).trim());
    } else if (streamsOrOptions && typeof streamsOrOptions === 'object' && Array.isArray(streamsOrOptions.streams)) {
      list = streamsOrOptions.streams.filter(Boolean).map((s) => String(s).trim());
    }

    const streamsKey = list.length ? list.join(',') : 'default';
    const mcpTools = list.length > 0
      ? (() => {
          const uniq = new Map();
          for (const streamName of list) {
            for (const t of mcpServer.listTools(streamName, false)) {
              if (!uniq.has(t.name)) uniq.set(t.name, t);
            }
          }
          return Array.from(uniq.values());
        })()
      : mcpServer.listTools(null, false);

    const toolNames = mcpTools.map(t => t.name).sort().join(',');
    const cached = this._toolsCache.get(streamsKey);
    if (cached !== toolNames) {
      this._toolsCache.set(streamsKey, toolNames);
      Bot.makeLog('debug', `[MCPToolAdapter] 工具列表 streams=[${streamsKey}] 工具数=${mcpTools.length}`, 'MCPToolAdapter');
    }

    const usedNames = new Set();
    return mcpTools.map(tool => ({
      type: 'function',
      function: {
        name: this._allocateUniqueOpenAIToolName(tool.name, usedNames),
        description: tool.description || '',
        parameters: this.convertSchemaToOpenAI(tool.inputSchema || {})
      }
    }));
  }

  /**
   * 将 JSON Schema 转换为 OpenAI function.parameters 定义
   * 兼容 Gemini 等上游：array 类型必须带 items，否则 400
   * @param {Object} schema - JSON Schema
   * @returns {Object} OpenAI schema
   */
  static convertSchemaToOpenAI(schema) {
    const s = schema && typeof schema === 'object' ? schema : {};
    const result = {
      type: s.type || 'object',
      properties: {},
      required: s.required || []
    };
    if (s.properties) {
      for (const [key, prop] of Object.entries(s.properties)) {
        const type = prop.type || 'string';
        const out = {
          type,
          description: prop.description || ''
        };
        if (prop.enum) out.enum = prop.enum;
        if (prop.default !== undefined) out.default = prop.default;
        if (type === 'array') {
          out.items = prop.items && typeof prop.items === 'object'
            ? this._normalizeSchemaItem(prop.items)
            : { type: 'string' };
        }
        result.properties[key] = out;
      }
    }
    return result;
  }

  /** 规范化 array 的 items 为单层 schema，避免嵌套缺 items 再报 400 */
  static _normalizeSchemaItem(item) {
    if (!item || typeof item !== 'object') return { type: 'string' };
    const type = item.type || 'string';
    const out = { type, description: item.description || '' };
    if (item.enum) out.enum = item.enum;
    if (type === 'array' && !item.items) out.items = { type: 'string' };
    if (type === 'array' && item.items) out.items = this._normalizeSchemaItem(item.items);
    return out;
  }

  /** 解析 tool call arguments；非法 JSON 时保留 raw 字段 */
  static parseToolArguments(raw) {
    if (raw == null) return {};
    if (typeof raw !== 'string') return raw;
    return tryParseJson(raw) ?? { raw };
  }

  /**
   * 由 tool_calls + role=tool 结果构建 v3 流式 mcp_tools 载荷（供前端工具卡片展示）。
   * @param {Array} toolCalls - OpenAI 格式 tool_calls
   * @param {Array} toolResults - handleToolCalls 返回的 role=tool 消息列表
   * @returns {Array<{ name, arguments, result }>}
   */
  static buildMcpToolsPayload(toolCalls, toolResults) {
    const list = Array.isArray(toolCalls) ? toolCalls : [];
    return list.map((tc, i) => {
      let args = {};
      if (tc.function?.arguments) {
        args = this.parseToolArguments(tc.function.arguments);
      }
      return {
        name: tc.function?.name ?? 'tool',
        arguments: args,
        result: toolResults?.[i]?.content ?? ''
      };
    });
  }

  /**
   * 流式场景下向 HTTP 层发送 mcp_tools chunk（onDelta(delta, metadata) 中 metadata.mcp_tools）。
   * @param {Array} toolCalls - OpenAI 格式 tool_calls
   * @param {Array} toolResults - handleToolCalls 返回值
   * @param {Function} [onDelta] - (delta, metadata) => void
   */
  static emitMcpToolsToStream(toolCalls, toolResults, onDelta) {
    if (typeof onDelta !== 'function') return;
    const mcp_tools = this.buildMcpToolsPayload(toolCalls, toolResults);
    if (mcp_tools.length) onDelta('', { mcp_tools });
  }

  /** 并行执行 tool_calls，调用 MCP handleToolCall，返回 role=tool 消息列表 */
  static async handleToolCalls(toolCalls, _options = {}) {
    const list = Array.isArray(toolCalls) ? toolCalls : [];
    if (list.length === 0) return [];

    const mcpServer = this.getMCPServer();
    if (!mcpServer) {
      Bot.makeLog('warn', '[MCP] handleToolCalls MCP服务未启用', 'MCPToolAdapter');
      return list.map(tc => ({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify({ success: false, error: 'MCP服务未启用' })
      }));
    }

    return Promise.all(list.map(async (tc) => {
      const openAiName = tc.function?.name;
      const name = this.resolveOpenAiToolNameToMcp(openAiName);
      if (name !== openAiName) {
        Bot.makeLog('debug', `[MCPToolAdapter] 工具名映射 ${openAiName} -> ${name}`, 'MCPToolAdapter');
      }
      let args = {};
      if (tc.function?.arguments) {
        args = this.parseToolArguments(tc.function.arguments);
      }
      try {
        const result = await mcpServer.handleToolCall({ name, arguments: args });
        // 提取工具结果文本：优先使用 content[0].text，否则尝试其他格式
        let content = result?.content?.[0]?.text;
        if (typeof content !== 'string' || !content.length) {
          // 如果没有 text，尝试提取其他字段
          if (result?.content && Array.isArray(result.content)) {
            const textParts = result.content
              .filter(c => c?.type === 'text' && c?.text)
              .map(c => c.text);
            if (textParts.length > 0) {
              content = textParts.join('\n');
            }
          }
          // 如果还是没有，使用 JSON 字符串化
          if (typeof content !== 'string' || !content.length) {
            content = JSON.stringify(result != null ? result : { success: true });
          }
        }
        return { role: 'tool', tool_call_id: tc.id, content };
      } catch (err) {
        Bot.makeLog('error', `[MCP] handleToolCalls 失败 ${name}: ${err.message}`, 'MCPToolAdapter');
        const content = JSON.stringify({ success: false, error: err.message || String(err) });
        return { role: 'tool', tool_call_id: tc.id, content };
      }
    }));
  }

  static hasTools() {
    return !!(this.getMCPServer()?.tools?.size);
  }
}
