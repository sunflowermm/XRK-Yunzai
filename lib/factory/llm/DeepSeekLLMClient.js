import fetch from 'node-fetch';
import { MCPToolAdapter } from '../../utils/llm/mcp-tool-adapter.js';
import {
  createReplyTrack,
  noteReplyFromModelCalls,
  packNonStreamReturn,
  packToolRoundsExhausted
} from '../../utils/llm/llm-nonstream-reply.js';
import { buildOpenAIChatCompletionsBody, applyOpenAITools } from '../../utils/llm/openai-chat-utils.js';
import { consumeOpenAIChatStream } from '../../utils/llm/sse-utils.js';
import { transformMessagesWithVision } from '../../utils/llm/message-transform.js';
import { buildFetchOptionsWithProxy } from '../../utils/llm/proxy-utils.js';

function normalizeDeepSeekReasoningEffort(value) {
  if (value === undefined || value === null || value === '') return;
  const v = String(value).trim().toLowerCase();
  if (v === 'max' || v === 'xhigh') return 'max';
  return 'high';
}

function resolveThinkingType(overrides, config) {
  const raw = overrides.thinkingType ?? overrides.thinking_type ?? config.thinkingType ?? config.thinking_type;
  if (raw === undefined || raw === null || raw === '') return 'enabled';
  const v = String(raw).trim().toLowerCase();
  return v === 'disabled' ? 'disabled' : 'enabled';
}

function applyResponseFormat(body, overrides, config) {
  const rf = overrides.response_format ?? overrides.responseFormat ?? config.response_format ?? config.responseFormat;
  if (rf !== undefined) {
    const type = typeof rf === 'string' ? rf.trim() : rf?.type;
    if (type) body.response_format = { type };
    else delete body.response_format;
    return;
  }
  if (typeof body.response_format === 'string') {
    const type = body.response_format.trim();
    if (type) body.response_format = { type };
    else delete body.response_format;
  }
}

/**
 * DeepSeek 官方 LLM 客户端
 * @see https://api-docs.deepseek.com/zh-cn/
 */
export default class DeepSeekLLMClient {
  constructor(config = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = config.timeout ?? 360000;
  }

  normalizeEndpoint(config) {
    const base = (config.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    const path = (config.path || '/chat/completions').replace(/^\/?/, '/');
    return `${base}${path}`;
  }

  get timeout() {
    return this._timeout ?? 360000;
  }

  buildHeaders(extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${String(this.config.apiKey).trim()}`;
    }
    if (this.config.headers) Object.assign(headers, this.config.headers);
    return headers;
  }

  buildBody(messages, overrides = {}) {
    const defaultModel = this.config.model || 'deepseek-v4-flash';
    const body = buildOpenAIChatCompletionsBody(messages, this.config, overrides, defaultModel);
    applyOpenAITools(body, this.config, overrides);

    const thinkingType = resolveThinkingType(overrides, this.config);
    body.thinking = { type: thinkingType };

    if (thinkingType === 'enabled') {
      delete body.temperature;
      delete body.top_p;
      delete body.presence_penalty;
      delete body.frequency_penalty;
      body.reasoning_effort = normalizeDeepSeekReasoningEffort(
        overrides.reasoning_effort ?? overrides.reasoningEffort ?? this.config.reasoningEffort ?? this.config.reasoning_effort
      ) || 'high';
    } else {
      delete body.reasoning_effort;
    }

    applyResponseFormat(body, overrides, this.config);

    const userId = overrides.user_id ?? overrides.userId ?? this.config.userId ?? this.config.user_id;
    if (userId !== undefined && userId !== null && String(userId).trim() !== '') {
      body.user_id = String(userId).trim();
    }

    return body;
  }

  async transformMessages(messages) {
    return transformMessagesWithVision(messages, this.config, { mode: 'text_only' });
  }

  async chat(messages, overrides = {}) {
    const transformedMessages = await this.transformMessages(messages);
    const maxToolRounds = this.config.maxToolRounds || 7;
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
        throw new Error(`DeepSeek LLM 请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
      }

      const message = (await resp.json())?.choices?.[0]?.message;
      if (!message) break;

      if (message.tool_calls?.length > 0) {
        noteReplyFromModelCalls(replyTracker, message.tool_calls);
        currentMessages.push(message);
        currentMessages.push(...await MCPToolAdapter.handleToolCalls(message.tool_calls));
        continue;
      }

      return packNonStreamReturn(replyTracker, message.content || '');
    }

    return packToolRoundsExhausted(replyTracker);
  }

  async chatStream(messages, onDelta, overrides = {}) {
    let currentMessages = await this.transformMessages(messages);
    const maxToolRounds = this.config.maxToolRounds || 7;

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
        throw new Error(`DeepSeek LLM 流式请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
      }

      const { content, tool_calls } = await consumeOpenAIChatStream(resp, onDelta);

      if (!Array.isArray(tool_calls) || tool_calls.length === 0) return;

      const assistantMessage = { role: 'assistant', content: content || null, tool_calls };
      const toolResults = await MCPToolAdapter.handleToolCalls(tool_calls);
      MCPToolAdapter.emitMcpToolsToStream(tool_calls, toolResults, onDelta);
      currentMessages = [...currentMessages, assistantMessage, ...toolResults];
    }
  }
}
