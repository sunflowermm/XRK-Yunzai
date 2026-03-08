import fetch from 'node-fetch';
import { MCPToolAdapter } from '../../utils/llm/mcp-tool-adapter.js';
import { buildOpenAIChatCompletionsBody, applyOpenAITools } from '../../utils/llm/openai-chat-utils.js';
import { consumeOpenAIChatStream } from '../../utils/llm/sse-utils.js';
import { transformMessagesWithVision } from '../../utils/llm/message-transform.js';
import { buildFetchOptionsWithProxy } from '../../utils/llm/proxy-utils.js';

/**
 * GPTGod LLM 客户端（OpenAI Chat Completions 兼容）
 * 支持：多模态、tools/tool_choice/parallel_tool_calls（标准 OpenAI 协议）
 */
export default class GPTGodLLMClient {
  constructor(config = {}) {
    this.config = config;
    this.endpoint = (config.baseUrl || 'https://api.gptgod.online/v1').replace(/\/+$/, '')
      + (config.path || '/chat/completions').replace(/^\/?/, '/');
    this._timeout = config.timeout || 360000;
  }

  get timeout() {
    return this._timeout || 360000;
  }

  _headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (this.config.apiKey) h.Authorization = `Bearer ${String(this.config.apiKey).trim()}`;
    if (this.config.headers) Object.assign(h, this.config.headers);
    return h;
  }

  _body(messages, overrides = {}) {
    const body = buildOpenAIChatCompletionsBody(messages, this.config, overrides, 'gemini-exp-1114');
    applyOpenAITools(body, this.config, overrides);
    return body;
  }

  async transformMessages(messages) {
    return await transformMessagesWithVision(messages, this.config, { mode: 'openai' });
  }

  async _request(messages, overrides, stream = false) {
    const body = this._body(messages, { ...overrides, stream });
    const resp = await fetch(this.endpoint, buildFetchOptionsWithProxy(this.config, {
      method: 'POST',
      headers: this._headers(overrides.headers),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout)
    }));
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`GPTGod LLM 请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
    }
    return resp;
  }

  async chat(messages, overrides = {}) {
    let msgs = await this.transformMessages(messages);
    const maxRounds = this.config.maxToolRounds || 5;

    for (let i = 0; i < maxRounds; i++) {
      const resp = await this._request(msgs, overrides, false);
      const data = await resp.json();
      const msg = data?.choices?.[0]?.message;
      if (!msg) break;

      if (msg.tool_calls?.length > 0) {
        msgs = [...msgs, msg, ...await MCPToolAdapter.handleToolCalls(msg.tool_calls)];
        continue;
      }
      return msg.content ?? '';
    }
    return msgs[msgs.length - 1]?.content ?? '';
  }

  async chatStream(messages, onDelta, overrides = {}) {
    let msgs = await this.transformMessages(messages);
    const maxRounds = this.config.maxToolRounds || 5;

    for (let i = 0; i < maxRounds; i++) {
      const resp = await this._request(msgs, overrides, true);
      if (!resp.body) throw new Error('GPTGod LLM 流式请求失败: 无响应体');
      const { content, tool_calls } = await consumeOpenAIChatStream(resp, onDelta);
      if (!Array.isArray(tool_calls) || tool_calls.length === 0) return;
      const assistant = { role: 'assistant', content: content ?? null, tool_calls };
      const results = await MCPToolAdapter.handleToolCalls(tool_calls);
      MCPToolAdapter.emitMcpToolsToStream(tool_calls, results, onDelta);
      msgs = [...msgs, assistant, ...results];
    }
  }
}
