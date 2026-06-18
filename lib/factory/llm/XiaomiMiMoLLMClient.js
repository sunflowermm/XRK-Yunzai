import fetch from 'node-fetch';
import { MCPToolAdapter } from '../../utils/llm/mcp-tool-adapter.js';
import {
  createReplyTrack,
  noteReplyFromModelCalls,
  packNonStreamReturn,
  packToolRoundsExhausted
} from '../../utils/llm/llm-nonstream-reply.js';
import { prepareOpenAIChatVisionMessages } from '../../utils/llm/image-utils.js';
import { buildFetchOptionsWithProxy } from '../../utils/llm/proxy-utils.js';
import { iterateSSE } from '../../utils/llm/sse-utils.js';
import { tryParseJson } from '../../utils/json-utils.js';
import {
  buildOpenAIChatCompletionsBody,
  applyOpenAITools,
  extractOpenAIAssistantText
} from '../../utils/llm/openai-chat-utils.js';

const DEFAULT_MODEL = 'mimo-v2.5-pro';
const MAX_COMPLETION_TOKENS = 131072;

function clamp(val, min, max) {
  const n = Number(val);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function normalizeMimoResponseFormat(value) {
  if (value === '' || value == null) return undefined;
  if (typeof value === 'string') {
    return value.toLowerCase() === 'text' ? { type: 'text' } : undefined;
  }
  if (typeof value === 'object' && value?.type === 'text') return value;
  return undefined;
}

function normalizeMimoStop(stop) {
  if (stop == null) return undefined;
  if (Array.isArray(stop)) return stop.length > 0 ? stop.slice(0, 4) : undefined;
  return stop;
}

/**
 * 小米 MiMo 官方 LLM 客户端（OpenAI Chat Completions 兼容）
 *
 * 文档：https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call
 * - baseUrl: https://api.xiaomimimo.com/v1（按量）或 https://token-plan-cn.xiaomimimo.com/v1（Token Plan）
 * - path: /chat/completions
 * - 认证：api-key 头（官方 curl 示例）
 * - 输出上限：max_completion_tokens（勿发 max_tokens）
 * - 多模态：与 OpenAI Chat 相同（image_url + data URL 内联，Bot 侧解析 QQ hash / base64://）
 * - 思考模式多轮 tool：assistant 消息需保留 reasoning_content
 */
export default class XiaomiMiMoLLMClient {
  constructor(config = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = config.timeout || 360000;
  }

  normalizeEndpoint(config) {
    const base = (config.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
    const path = (config.path || '/chat/completions').replace(/^\/?/, '/');
    return `${base}${path}`;
  }

  get timeout() {
    return this._timeout || 360000;
  }

  buildHeaders(extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (this.config.apiKey) {
      const mode = String(this.config.authMode || 'api-key').toLowerCase();
      const apiKey = String(this.config.apiKey).trim();
      if (mode === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
      else headers['api-key'] = apiKey;
    }
    if (this.config.headers) Object.assign(headers, this.config.headers);
    return headers;
  }

  async transformMessages(messages) {
    return prepareOpenAIChatVisionMessages(messages, this.config, { timeoutMs: this.timeout });
  }

  buildBody(messages, overrides = {}) {
    const mergedConfig = {
      ...this.config,
      tokenField: this.config.tokenField || 'max_completion_tokens'
    };
    const body = buildOpenAIChatCompletionsBody(messages, mergedConfig, overrides, DEFAULT_MODEL);
    applyOpenAITools(body, mergedConfig, overrides);
    return this._finalizeMimoBody(body, overrides);
  }

  _finalizeMimoBody(body, overrides = {}) {
    delete body.max_tokens;

    const parsedMax = Number(body.max_completion_tokens ?? this.config.maxTokens ?? 65536);
    const maxCompletionTokens = clamp(
      Math.floor(Number.isFinite(parsedMax) ? parsedMax : 65536),
      0,
      MAX_COMPLETION_TOKENS
    );

    const thinkingType = overrides.thinkingType ?? this.config.thinkingType ?? overrides.thinking ?? this.config.thinking;
    const thinkingEnabled = thinkingType === 'enabled';

    const out = {
      model: body.model || DEFAULT_MODEL,
      messages: body.messages,
      temperature: clamp(body.temperature ?? this.config.temperature ?? 1.0, 0, 1.5),
      top_p: clamp(body.top_p ?? this.config.topP ?? 0.95, 0.01, 1),
      frequency_penalty: clamp(body.frequency_penalty ?? this.config.frequencyPenalty ?? 0, -2, 2),
      presence_penalty: clamp(body.presence_penalty ?? this.config.presencePenalty ?? 0, -2, 2),
      max_completion_tokens: maxCompletionTokens,
      stream: body.stream ?? this.config.enableStream ?? false,
      thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' }
    };

    const responseFormat = normalizeMimoResponseFormat(body.response_format ?? this.config.responseFormat ?? this.config.response_format);
    if (responseFormat) out.response_format = responseFormat;

    const stop = normalizeMimoStop(body.stop ?? this.config.stop);
    if (stop !== undefined) out.stop = stop;

    if (Array.isArray(body.tools) && body.tools.length > 0) {
      out.tools = body.tools;
      out.tool_choice = 'auto';
    }

    for (const extra of [this.config.extraBody, overrides.extraBody]) {
      if (extra && typeof extra === 'object') Object.assign(out, extra);
    }

    return out;
  }

  _assistantMessageFromStream({ content, reasoning_content, tool_calls }) {
    const msg = { role: 'assistant', content: content || null };
    if (reasoning_content) msg.reasoning_content = reasoning_content;
    if (tool_calls?.length) msg.tool_calls = tool_calls;
    return msg;
  }

  /** MiMo 思考模式流式：额外累积 reasoning_content（仅本工厂使用，不改通用 sse-utils） */
  async _consumeMimoChatStream(resp, onDelta, options = {}) {
    const mcpToolMode = options?.mcpToolMode || 'execute';
    let fullContent = '';
    let fullReasoningContent = '';
    const toolCallsAcc = [];

    for await (const { data } of iterateSSE(resp)) {
      if (data === '[DONE]') break;
      const json = tryParseJson(data);
      if (!json) continue;
      const choice = json?.choices?.[0];
      const delta = choice?.delta;
      const content = delta?.content ?? choice?.message?.content ?? null;
      const reasoningContent = delta?.reasoning_content ?? choice?.message?.reasoning_content ?? null;
      const toolCalls = delta?.tool_calls;
      const finishReason = choice?.finish_reason ?? null;

      if (typeof content === 'string' && content) {
        fullContent += content;
        if (typeof onDelta === 'function') onDelta(content);
      }
      if (typeof reasoningContent === 'string' && reasoningContent) {
        fullReasoningContent += reasoningContent;
      }
      if (Array.isArray(toolCalls)) {
        for (const d of toolCalls) {
          const i = d.index ?? toolCallsAcc.length;
          if (!toolCallsAcc[i]) toolCallsAcc[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (d.id) toolCallsAcc[i].id = d.id;
          if (d.function?.name) toolCallsAcc[i].function.name = d.function.name;
          if (d.function?.arguments) toolCallsAcc[i].function.arguments += d.function.arguments;
        }
        if (mcpToolMode === 'passthrough' && typeof onDelta === 'function' && toolCalls.length > 0) {
          onDelta('', { tool_calls: toolCalls });
        }
      }
      if (finishReason === 'tool_calls') break;
    }

    const list = toolCallsAcc.filter(t => t && t.id);
    return {
      content: fullContent,
      reasoning_content: fullReasoningContent || undefined,
      tool_calls: list.length ? list : undefined
    };
  }

  async chat(messages, overrides = {}) {
    const transformedMessages = await this.transformMessages(messages);
    const maxToolRounds = this.config.maxToolRounds || 5;
    let currentMessages = [...transformedMessages];
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

      const message = (await resp.json())?.choices?.[0]?.message;
      if (!message) break;

      if (message.tool_calls?.length > 0) {
        noteReplyFromModelCalls(replyTracker, message.tool_calls);
        currentMessages.push(message);
        currentMessages.push(...await MCPToolAdapter.handleToolCalls(message.tool_calls, overrides));
        continue;
      }

      return packNonStreamReturn(replyTracker, extractOpenAIAssistantText(message));
    }

    return packToolRoundsExhausted(replyTracker);
  }

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

      const { content, reasoning_content, tool_calls } = await this._consumeMimoChatStream(resp, onDelta, overrides);
      if (tool_calls?.length > 0) {
        const assistantMessage = this._assistantMessageFromStream({ content, reasoning_content, tool_calls });
        const toolResults = await MCPToolAdapter.handleToolCalls(tool_calls, overrides);
        MCPToolAdapter.emitMcpToolsToStream(tool_calls, toolResults, onDelta);
        currentMessages = [...currentMessages, assistantMessage, ...toolResults];
        continue;
      }

      return;
    }
  }
}
