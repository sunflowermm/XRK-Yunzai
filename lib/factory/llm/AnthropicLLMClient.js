import fetch from 'node-fetch';
import { transformOpenAIStyleVisionMessages } from '../../utils/llm/message-transform.js';
import { buildFetchOptionsWithProxy } from '../../utils/llm/proxy-utils.js';
import { resolveAnthropicBodyImagePlaceholders } from '../../utils/llm/image-utils.js';
import { tryParseJson } from '../../utils/json-utils.js';

/**
 * Anthropic 官方 LLM 客户端（Messages API）
 *
 * 默认：
 * - baseUrl: https://api.anthropic.com/v1
 * - path: /messages
 * - 认证：x-api-key
 *
 * 说明：
 * - 内部配置使用 model 指定真实模型名
 * - 图片由上游统一转换为纯文本占位描述（不再通过独立的识图工厂），保证消息结构简单稳定
 * - Anthropic 工具调用协议不同，本实现默认不注入 MCP tools（建议 enableTools=false）
 */
export default class AnthropicLLMClient {
  constructor(config = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = config.timeout || 360000;
  }

  normalizeEndpoint(config) {
    const base = (config.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    const path = (config.path || '/messages').replace(/^\/?/, '/');
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
      headers['x-api-key'] = String(this.config.apiKey).trim();
    }

    // Anthropic 要求提供版本头
    headers['anthropic-version'] = String(this.config.anthropicVersion || '2023-06-01');

    if (this.config.headers) {
      Object.assign(headers, this.config.headers);
    }

    return headers;
  }

  async transformMessages(messages) {
    return transformOpenAIStyleVisionMessages(messages, this.config);
  }

  /**
   * OpenAI-like messages -> Anthropic messages
   * - system: 单独提取为 system 字符串
   * - user/assistant: messages[{role, content}]
   */
  buildBody(messages, overrides = {}) {
    const systemTexts = [];
    const anthMessages = [];

    for (const m of messages || []) {
      const role = (m.role || '').toLowerCase();
      if (role === 'system') {
        const text = (typeof m.content === 'string' ? m.content : (m.content?.text || m.content?.content || '')).toString();
        if (text) systemTexts.push(text);
        continue;
      }

      const blocks = [];
      if (typeof m.content === 'string') {
        const text = m.content.toString();
        if (text) blocks.push({ type: 'text', text });
      } else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p?.type === 'text' && p.text) {
            blocks.push({ type: 'text', text: String(p.text) });
          } else if (p?.type === 'image_url' && p.image_url?.url) {
            // 这里保持同步结构，实际转换在 chat/chatStream 前进行（buildBody 是纯构建函数）
            blocks.push({ type: '__image_url__', url: String(p.image_url.url) });
          }
        }
      } else if (m.content && typeof m.content === 'object') {
        const text = (m.content.text || m.content.content || '').toString();
        if (text) blocks.push({ type: 'text', text });
      }

      if (blocks.length === 0) continue;

      anthMessages.push({
        role: role === 'assistant' ? 'assistant' : 'user',
        content: blocks
      });
    }

    const temperature = overrides.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = overrides.maxTokens ?? this.config.maxTokens ?? 2048;

    const body = {
      model: overrides.model ?? this.config.model ?? 'claude-3-5-sonnet-latest',
      max_tokens: maxTokens,
      temperature,
      messages: anthMessages
    };

    if (systemTexts.length > 0) {
      body.system = systemTexts.join('\n');
    }

    if (this.config.extraBody && typeof this.config.extraBody === 'object') {
      Object.assign(body, this.config.extraBody);
    }
    if (overrides.extraBody && typeof overrides.extraBody === 'object') {
      Object.assign(body, overrides.extraBody);
    }

    return body;
  }

  extractText(json) {
    // Anthropic: content: [{type:'text', text:'...'}]
    const parts = json?.content;
    if (!Array.isArray(parts)) return '';
    return parts.map(p => (p?.type === 'text' ? (p.text || '') : '')).join('');
  }

  async chat(messages, overrides = {}) {
    const transformedMessages = await this.transformMessages(messages);
    const body = this.buildBody(transformedMessages, overrides);
    await resolveAnthropicBodyImagePlaceholders(body, this.config);

    const resp = await fetch(
      this.endpoint,
      buildFetchOptionsWithProxy(this.config, {
        method: 'POST',
        headers: this.buildHeaders(overrides.headers),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout)
      })
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Anthropic 请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
    }

    const data = await resp.json();
    return this.extractText(data);
  }

  async chatStream(messages, onDelta, overrides = {}) {
    // Anthropic 支持 SSE：stream=true
    const transformedMessages = await this.transformMessages(messages);
    const body = this.buildBody(transformedMessages, overrides);
    await resolveAnthropicBodyImagePlaceholders(body, this.config);
    body.stream = true;

    const resp = await fetch(
      this.endpoint,
      buildFetchOptionsWithProxy(this.config, {
        method: 'POST',
        headers: this.buildHeaders(overrides.headers),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout)
      })
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Anthropic 流式请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
    }

    const parseChunk = (chunk) => {
      const lines = chunk.split('\n').map(l => l.trim()).filter(Boolean);
      const dataLine = lines.find(l => l.startsWith('data:'));
      if (!dataLine) return;
      const payload = dataLine.slice(5).trim();
      if (!payload) return;
      const json = tryParseJson(payload);
      if (!json) return;
      const deltaText = json?.delta?.text || json?.content_block?.text || '';
      if (deltaText && typeof onDelta === 'function') onDelta(deltaText);
    };

    if (resp.body && typeof resp.body.getReader === 'function') {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          parseChunk(buffer.slice(0, sep));
          buffer = buffer.slice(sep + 2);
        }
      }
      return;
    }

    const text = await resp.text();
    const parts = text.split('\n\n');
    for (const part of parts) parseChunk(part);
  }
}
