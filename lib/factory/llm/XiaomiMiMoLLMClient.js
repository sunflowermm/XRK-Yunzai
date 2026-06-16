import fetch from 'node-fetch';
import { MCPToolAdapter } from '../../utils/llm/mcp-tool-adapter.js';
import {
  createReplyTrack,
  noteReplyFromModelCalls,
  packNonStreamReturn,
  packToolRoundsExhausted
} from '../../utils/llm/llm-nonstream-reply.js';
import { transformMessagesWithVision } from '../../utils/llm/message-transform.js';
import { buildFetchOptionsWithProxy } from '../../utils/llm/proxy-utils.js';
import { consumeOpenAIChatStream } from '../../utils/llm/sse-utils.js';
import { buildOpenAIChatCompletionsBody, applyOpenAITools } from '../../utils/llm/openai-chat-utils.js';

function clamp(val, min, max) {
  const n = Number(val);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * 小米 MiMo LLM 客户端
 *
 * 默认使用 OpenAI 兼容 Chat Completions 接口：
 * - baseUrl: https://api.xiaomimimo.com/v1
 * - path: /chat/completions
 * - 认证头：api-key: $MIMO_API_KEY
 *
 * 模型本身是纯文本的，图片由上游转为简单的占位文本后再交给 MiMo 处理（不再依赖独立的识图工厂）。
 */
export default class XiaomiMiMoLLMClient {
  constructor(config = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = config.timeout || 360000;
  }

  /**
   * 规范化端点地址
   */
  normalizeEndpoint(config) {
    const base = (config.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
    const path = (config.path || '/chat/completions').replace(/^\/?/, '/');
    return `${base}${path}`;
  }

  /**
   * 获取超时时间
   */
  get timeout() {
    return this._timeout || 360000;
  }

  /**
   * 构建请求头
   */
  buildHeaders(extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...extra
    };

    // 小米 MiMo 支持两种认证方式：api-key 或 Authorization: Bearer
    if (this.config.apiKey) {
      const mode = (this.config.authMode || 'api-key').toLowerCase();
      if (mode === 'bearer') {
        headers.Authorization = `Bearer ${this.config.apiKey}`;
      } else {
        headers['api-key'] = this.config.apiKey;
      }
    }

    if (this.config.headers) {
      Object.assign(headers, this.config.headers);
    }

    return headers;
  }

  async transformMessages(messages) {
    // MiMo 当前仅文本，退化为 text_only，占位拼接图片 URL / base64 方便调试
    return await transformMessagesWithVision(messages, this.config, { mode: 'text_only' });
  }

  /**
   * 兜底解析：某些实现不返回 tool_calls，而是把工具调用写进正文
   * 例：
   * <toolcall>
   * <function=emotion>
   * <parameter=emotion>开心</parameter>
   * </function>
   * </toolcall>
   */
  extractToolCallsFromText(text) {
    const raw = String(text || '');
    if (!raw.includes('<toolcall')) return { tool_calls: [], cleaned: raw };
    const blocks = [];
    const reBlock = /<toolcall\b[^>]*>([\s\S]*?)<\/toolcall>/gi;
    let m;
    while ((m = reBlock.exec(raw))) {
      blocks.push({ full: m[0], inner: m[1] || '' });
    }
    if (blocks.length === 0) return { tool_calls: [], cleaned: raw };

    const tool_calls = [];
    const usedOpenAiNames = new Set();
    for (const b of blocks) {
      // function name: <function=xxx>...</function>
      const fn = /<function\s*=\s*([a-zA-Z0-9_.-]+)\s*>/i.exec(b.inner)?.[1];
      if (!fn) continue;
      const args = {};
      const reParam = /<parameter\s*=\s*([a-zA-Z0-9_.-]+)\s*>([\s\S]*?)<\/parameter>/gi;
      let pm;
      while ((pm = reParam.exec(b.inner))) {
        const key = pm[1];
        const val = (pm[2] ?? '').trim();
        if (key) args[key] = val;
      }
      const id = `tc_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
      tool_calls.push({
        id,
        type: 'function',
        function: {
          name: MCPToolAdapter.allocateOpenAiToolNameForRound(fn, usedOpenAiNames),
          arguments: JSON.stringify(args)
        }
      });
    }

    // 清理正文：移除 toolcall 块，避免直接 reply
    let cleaned = raw;
    for (const b of blocks) cleaned = cleaned.replace(b.full, '');
    cleaned = cleaned.trim();
    return { tool_calls, cleaned };
  }

  /**
   * 构建请求体（仅包含 MiMo 官方文档字段，避免冗余与兼容问题）
   * 文档：https://api.xiaomimimo.com，OpenAI 兼容 Chat Completions
   * - 使用 max_completion_tokens（范围 [0, 131072]），不发送 max_tokens
   * - temperature [0, 1.5] 默认 0.3；top_p [0.01, 1] 默认 0.95
   * - thinking 默认 disabled；tool_choice 仅支持 auto
   */
  buildBody(messages, overrides = {}) {
    const body = buildOpenAIChatCompletionsBody(
      messages,
      this.config,
      overrides,
      'mimo-v2-flash'
    );
    applyOpenAITools(body, this.config, overrides);

    // MiMo 使用 max_completion_tokens，且不发送 max_tokens
    const maxTokens = body.max_tokens ?? this.config.maxTokens;
    delete body.max_tokens;
    const parsedMax = Number(maxTokens);
    const maxCompletionTokens = Math.min(
      131072,
      Math.max(0, Math.floor(Number.isFinite(parsedMax) ? parsedMax : 65536))
    );

    // 工具 function.name：由 applyOpenAITools → MCPToolAdapter.ensureOpenAICompatibleToolDefinitions 统一处理
    // 文档：tool_choice 仅支持 auto，非 auto 时后端可能移除该字段
    if (body.tool_choice && body.tool_choice !== 'auto') {
      body.tool_choice = 'auto';
    }

    // 只保留 MiMo 文档列出的字段，并应用文档默认值与范围
    const temperature = clamp(body.temperature ?? this.config.temperature ?? 0.3, 0, 1.5);
    const topP = clamp(body.top_p ?? this.config.topP ?? 0.95, 0.01, 1);
    const frequencyPenalty = clamp(body.frequency_penalty ?? this.config.frequencyPenalty ?? 0, -2, 2);
    const presencePenalty = clamp(body.presence_penalty ?? this.config.presencePenalty ?? 0, -2, 2);

    // MiMo 文档：response_format.type 仅为 text（如需扩展可用 extraBody 透传）
    let responseFormat = body.response_format ?? this.config.response_format ?? this.config.responseFormat;
    if (responseFormat === '' || responseFormat === undefined) responseFormat = undefined;
    else if (typeof responseFormat === 'string') {
      responseFormat = responseFormat.toLowerCase() === 'text' ? { type: 'text' } : undefined;
    } else if (typeof responseFormat === 'object') {
      responseFormat = responseFormat?.type === 'text' ? responseFormat : undefined;
    } else {
      responseFormat = undefined;
    }

    const thinkingType = (overrides.thinkingType ?? this.config.thinkingType ?? overrides.thinking ?? this.config.thinking) === 'enabled' ? 'enabled' : 'disabled';

    const stop = body.stop ?? this.config.stop;
    const stopVal = Array.isArray(stop)
      ? (stop.length > 0 ? stop.slice(0, 4) : undefined)
      : stop;

    const out = {
      model: body.model || 'mimo-v2-flash',
      messages: body.messages,
      temperature,
      top_p: topP,
      frequency_penalty: frequencyPenalty,
      presence_penalty: presencePenalty,
      max_completion_tokens: maxCompletionTokens,
      stream: body.stream ?? this.config.enableStream ?? false,
      thinking: { type: thinkingType }
    };
    if (responseFormat !== undefined) out.response_format = responseFormat;
    if (stopVal !== undefined && stopVal !== null) out.stop = stopVal;
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      out.tools = body.tools;
      out.tool_choice = 'auto';
    }
    return out;
  }

  /**
   * 非流式调用（支持工具调用）
   * @param {Array} messages - 消息数组
   * @param {Object} overrides - 覆盖配置
   * @returns {Promise<string>} AI 回复文本
   */
  async chat(messages, overrides = {}) {
    const transformedMessages = await this.transformMessages(messages);
    const maxToolRounds = this.config.maxToolRounds || 5;
    const currentMessages = [...transformedMessages];
    const replyTracker = createReplyTrack();

    for (let round = 0; round < maxToolRounds; round++) {
      const resp = await fetch(
        this.endpoint,
        buildFetchOptionsWithProxy(this.config, {
          method: 'POST',
          headers: this.buildHeaders(overrides.headers),
          body: JSON.stringify(this.buildBody(currentMessages, overrides)),
          signal: AbortSignal.timeout(this.timeout)
        })
      );

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`小米 MiMo LLM 请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
      }

      const data = await resp.json();
      const message = data?.choices?.[0]?.message;
      if (!message) break;

      if (message.tool_calls?.length > 0) {
        noteReplyFromModelCalls(replyTracker, message.tool_calls);
        currentMessages.push(message);
        currentMessages.push(...await MCPToolAdapter.handleToolCalls(message.tool_calls));
        continue;
      }

      // 兜底：把正文里的 <toolcall> 解析为 tool_calls 执行，避免原样 reply
      const contentText = message.content || '';
      const extracted = this.extractToolCallsFromText(contentText);
      if (extracted.tool_calls.length > 0) {
        // 工具关闭时：仅清理掉 toolcall 块
        if (this.config.enableTools === false || !MCPToolAdapter.hasTools()) {
          return packNonStreamReturn(replyTracker, extracted.cleaned || '');
        }
        noteReplyFromModelCalls(replyTracker, extracted.tool_calls);
        currentMessages.push({ role: 'assistant', content: extracted.cleaned || null, tool_calls: extracted.tool_calls });
        currentMessages.push(...await MCPToolAdapter.handleToolCalls(extracted.tool_calls));
        continue;
      }

      return packNonStreamReturn(replyTracker, contentText);
    }

    return packToolRoundsExhausted(replyTracker);
  }

  /**
   * 流式调用
   * @param {Array} messages - 消息数组
   * @param {Function} onDelta - 流式回调
   * @param {Object} overrides - 覆盖配置
   */
  async chatStream(messages, onDelta, overrides = {}) {
    let currentMessages = await this.transformMessages(messages);
    const maxToolRounds = this.config.maxToolRounds || 5;

    for (let round = 0; round < maxToolRounds; round++) {
      const resp = await fetch(
        this.endpoint,
        buildFetchOptionsWithProxy(this.config, {
          method: 'POST',
          headers: this.buildHeaders(overrides.headers),
          body: JSON.stringify(this.buildBody(currentMessages, { ...overrides, stream: true })),
          signal: AbortSignal.timeout(this.timeout)
        })
      );
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => '');
        throw new Error(`小米 MiMo LLM 流式请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
      }
      const { content, tool_calls } = await consumeOpenAIChatStream(resp, onDelta);
      if (Array.isArray(tool_calls) && tool_calls.length > 0) {
        const assistantMessage = { role: 'assistant', content: content || null, tool_calls };
        const toolResults = await MCPToolAdapter.handleToolCalls(tool_calls);
        MCPToolAdapter.emitMcpToolsToStream(tool_calls, toolResults, onDelta);
        currentMessages = [...currentMessages, assistantMessage, ...toolResults];
        continue;
      }

      // 兜底：流式正文里出现 <toolcall> 时也执行（并向流推送 mcp_tools）
      const extracted = this.extractToolCallsFromText(content || '');
      if (extracted.tool_calls.length > 0 && this.config.enableTools !== false && MCPToolAdapter.hasTools()) {
        const assistantMessage = { role: 'assistant', content: extracted.cleaned || null, tool_calls: extracted.tool_calls };
        const toolResults = await MCPToolAdapter.handleToolCalls(extracted.tool_calls);
        MCPToolAdapter.emitMcpToolsToStream(extracted.tool_calls, toolResults, onDelta);
        currentMessages = [...currentMessages, assistantMessage, ...toolResults];
        continue;
      }

      return;
    }
  }
}
