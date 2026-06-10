import { MCPToolAdapter } from '../../utils/llm/mcp-tool-adapter.js';
import {
  createReplyTrack,
  noteReplyFromModelCalls,
  packNonStreamReturn
} from '../../utils/llm/llm-nonstream-reply.js';
import { buildOpenAIChatCompletionsBody, applyOpenAITools } from '../../utils/llm/openai-chat-utils.js';
import { transformOpenAIStyleVisionMessages } from '../../utils/llm/message-transform.js';
import { buildFetchOptionsWithProxy } from '../../utils/llm/proxy-utils.js';
import { prepareOpenAIChatVisionMessages } from '../../utils/llm/image-utils.js';
import BotUtil from '../../util.js';
import { iterateSSE } from '../../utils/llm/sse-utils.js';
import { tryParseJson } from '../../utils/json-utils.js';

/**
 * New-API / CherryIN 等「OpenAI Chat Completions 路径 + 增量 tool_calls SSE」共用实现。
 * 通过 config.factoryType（如 newapi_compat_llm / cherryin_compat_llm）区分日志与错误前缀。
 */
export default class OpenAIPathCompatLLMClient {
  constructor(config = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = config.timeout ?? 360000;
  }

  get _label() {
    return String(this.config.factoryType || 'openapi_path_compat').replace(/_llm$/i, '') || 'openapi_path_compat';
  }

  normalizeEndpoint(config) {
    const base = (config.baseUrl ?? '').replace(/\/+$/, '');
    const path = (config.path || '/v1/chat/completions').replace(/^\/?/, '/');
    if (!base) throw new Error(`${this._label}: 未配置 baseUrl`);
    return `${base}${path}`;
  }

  get timeout() {
    return this._timeout ?? 360000;
  }

  buildHeaders(extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (this.config.apiKey) {
      const mode = String(this.config.authMode || 'bearer').toLowerCase();
      const apiKey = String(this.config.apiKey).trim();
      if (mode === 'api-key') headers['api-key'] = apiKey;
      else if (mode === 'header') {
        const name = String(this.config.authHeaderName ?? '').trim();
        if (!name) throw new Error(`${this._label}: authMode=header 时必须提供 authHeaderName`);
        headers[name] = apiKey;
      } else headers.Authorization = `Bearer ${apiKey}`;
    }
    if (this.config.headers) Object.assign(headers, this.config.headers);
    return headers;
  }

  async transformMessages(messages) {
    return transformOpenAIStyleVisionMessages(messages, this.config);
  }

  buildBody(messages, overrides = {}) {
    const body = buildOpenAIChatCompletionsBody(messages, this.config, overrides, 'gpt-4o-mini');
    applyOpenAITools(body, this.config, overrides);
    return body;
  }

  _buildRequestOptions(messages, overrides = {}, stream = false) {
    return buildFetchOptionsWithProxy(this.config, {
      method: 'POST',
      headers: this.buildHeaders(overrides.headers),
      body: JSON.stringify(this.buildBody(messages, { ...overrides, stream })),
      signal: AbortSignal.timeout(this.timeout)
    });
  }

  _normalizeToolCall(toolCall, index) {
    const normalized = {
      id: toolCall?.id,
      type: toolCall?.type || 'function',
      function: {
        name: toolCall?.function?.name || '',
        arguments: toolCall?.function?.arguments || ''
      }
    };
    if (!normalized.id || typeof normalized.id !== 'string') {
      normalized.id = `call_${index}_${(normalized.function.name || 'tool').replace(/\W/g, '_')}`;
    }
    return normalized;
  }

  _buildMcpToolsPayload(toolCalls, toolResults) {
    return toolCalls.map((tc, idx) => ({
      name: tc.function?.name || `工具${idx + 1}`,
      arguments: tc.function?.arguments || {},
      result: toolResults[idx]?.content ?? ''
    }));
  }

  async _executeToolCalls(toolCalls, overrides = {}, onDelta) {
    if (!Array.isArray(toolCalls) || !toolCalls.length) return [];
    const normalizedToolCalls = toolCalls.map((tc, idx) => this._normalizeToolCall(tc, idx));
    const streams = Array.isArray(overrides.streams) ? overrides.streams : null;
    const toolResults = await MCPToolAdapter.handleToolCalls(normalizedToolCalls, { streams });
    if (typeof onDelta === 'function') {
      const mcpTools = this._buildMcpToolsPayload(normalizedToolCalls, toolResults);
      onDelta('', { mcp_tools: mcpTools });
    }
    return toolResults;
  }

  async _fetchChatJson(messages, overrides = {}) {
    const resp = await fetch(this.endpoint, this._buildRequestOptions(messages, overrides, false));
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`${this._label} 请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
    }
    return await resp.json();
  }

  async _fetchChatStream(messages, overrides = {}) {
    const resp = await fetch(this.endpoint, this._buildRequestOptions(messages, overrides, true));
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(`${this._label} 流式请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
    }
    return resp;
  }

  async _consumeSSEWithToolCalls(resp, onDelta) {
    const toolCallsMap = new Map();
    const result = { content: '', toolCalls: [], finishReason: null };

    for await (const { data } of iterateSSE(resp)) {
      const json = tryParseJson(data);
      if (!json) continue;
      const delta = json?.choices?.[0]?.delta;
      const finishReason = json?.choices?.[0]?.finish_reason;
      if (finishReason) result.finishReason = finishReason;
      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        result.content += delta.content;
        if (typeof onDelta === 'function') onDelta(delta.content);
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = tc.index;
          if (index === undefined || index === null) continue;
          if (!toolCallsMap.has(index)) {
            toolCallsMap.set(index, { id: '', type: 'function', function: { name: '', arguments: '' } });
          }
          const item = toolCallsMap.get(index);
          if (tc.id) item.id = tc.id;
          if (tc.function?.name) item.function.name = tc.function.name;
          if (tc.function?.arguments) item.function.arguments += tc.function.arguments;
        }
      }
    }

    if (toolCallsMap.size > 0) {
      const sorted = Array.from(toolCallsMap.keys()).sort((a, b) => a - b);
      result.toolCalls = sorted.map((i, idx) => this._normalizeToolCall(toolCallsMap.get(i), idx));
    }
    return result;
  }

  async _runWithToolRounds(initialMessages, overrides = {}, handlers = {}) {
    const maxToolRounds = this.config.maxToolRounds || 7;
    const state = { messages: [...initialMessages], replyTracker: createReplyTrack() };

    for (let round = 0; round < maxToolRounds; round++) {
      const roundResult = await handlers.requestRound(state.messages, overrides, state);
      const toolCalls = Array.isArray(roundResult?.toolCalls) ? roundResult.toolCalls : [];

      if (!toolCalls.length) {
        return packNonStreamReturn(state.replyTracker, roundResult?.content || '');
      }

      noteReplyFromModelCalls(state.replyTracker, toolCalls);

      state.messages.push({ role: 'assistant', content: roundResult?.content || null, tool_calls: toolCalls });
      const toolResults = await this._executeToolCalls(toolCalls, overrides, handlers.onDelta);
      state.messages.push(...toolResults);
    }

    BotUtil.makeLog('warn', `[OpenAIPathCompatLLMClient][${this._label}] 达到最大工具调用轮数: ${maxToolRounds}`, 'LLMFactory');
    return packNonStreamReturn(
      state.replyTracker,
      state.messages[state.messages.length - 1]?.content || ''
    );
  }

  async chat(messages, overrides = {}) {
    const transformed = await prepareOpenAIChatVisionMessages(messages, this.config, { timeoutMs: this.timeout });

    return this._runWithToolRounds(transformed, overrides, {
      requestRound: async (currentMessages, ov) => {
        const json = await this._fetchChatJson(currentMessages, ov);
        const message = json?.choices?.[0]?.message;
        return {
          content: message?.content || '',
          toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls : []
        };
      }
    });
  }

  async chatStream(messages, onDelta, overrides = {}) {
    const transformed = await prepareOpenAIChatVisionMessages(messages, this.config, { timeoutMs: this.timeout });

    await this._runWithToolRounds(transformed, overrides, {
      onDelta,
      requestRound: async (currentMessages, ov) => {
        const resp = await this._fetchChatStream(currentMessages, ov);
        return await this._consumeSSEWithToolCalls(resp, onDelta);
      }
    });
  }
}
