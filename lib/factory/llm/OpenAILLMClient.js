import fetch from 'node-fetch';
import { buildFetchOptionsWithProxy } from '../../utils/llm/proxy-utils.js';
import { MCPToolAdapter } from '../../utils/llm/mcp-tool-adapter.js';
import {
  createReplyTrack,
  noteReplyFromModelCalls,
  packNonStreamReturn,
  packToolRoundsExhausted
} from '../../utils/llm/llm-nonstream-reply.js';
import { buildOpenAIChatCompletionsBody, applyOpenAITools, extractOpenAIAssistantText } from '../../utils/llm/openai-chat-utils.js';
import { consumeOpenAIChatStream } from '../../utils/llm/sse-utils.js';
import { prepareOpenAIChatVisionMessages } from '../../utils/llm/image-utils.js';

/**
 * OpenAI 官方 LLM 客户端（Chat Completions）
 *
 * - 默认：
 *   - baseUrl: https://api.openai.com/v1
 *   - path: /chat/completions
 *   - 认证：Authorization: Bearer ${apiKey}
 * - 支持多模态：messages[].content 可以是 text + image_url（含 base64 data URL）
 * - tool calling：使用 OpenAI tools/tool_calls 协议 + MCPToolAdapter 多轮执行
 */
export default class OpenAILLMClient {
  constructor(config = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = config.timeout || 360000;
  }

  normalizeEndpoint(config) {
    const base = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const path = (config.path || '/chat/completions').replace(/^\/?/, '/');
    return `${base}${path}`;
  }

  get timeout() {
    return this._timeout || 360000;
  }

  buildHeaders(extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...extra
    };

    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${String(this.config.apiKey).trim()}`;
    }

    if (this.config.headers) {
      Object.assign(headers, this.config.headers);
    }

    return headers;
  }

  async transformMessages(messages) {
    return prepareOpenAIChatVisionMessages(messages, this.config, { timeoutMs: this.timeout });
  }

  buildBody(messages, overrides = {}) {
    const body = buildOpenAIChatCompletionsBody(messages, this.config, overrides, 'gpt-4o-mini');
    applyOpenAITools(body, this.config, overrides);
    return body;
  }

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
          body: JSON.stringify(this.buildBody(currentMessages, { ...overrides })),
          signal: AbortSignal.timeout(this.timeout)
        })
      );

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`OpenAI LLM 请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
      }

      const result = await resp.json();
      const message = result?.choices?.[0]?.message;
      if (!message) break;

      if (message.tool_calls?.length > 0) {
        noteReplyFromModelCalls(replyTracker, message.tool_calls);
        currentMessages.push(message);
        currentMessages.push(...await MCPToolAdapter.handleToolCalls(message.tool_calls));
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
        throw new Error(`OpenAI LLM 流式请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
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
