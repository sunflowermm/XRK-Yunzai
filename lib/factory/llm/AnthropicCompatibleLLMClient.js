import fetch from 'node-fetch';
import { buildFetchOptionsWithProxy } from '../../utils/llm/proxy-utils.js';
import {
  prepareOpenAIChatVisionMessages,
  resolveAnthropicBodyImagePlaceholders,
  visionDataUrlToAnthropicImageBlock,
  VISION_IMAGE_OMITTED_TEXT
} from '../../utils/llm/image-utils.js';
import { iterateSSE } from '../../utils/llm/sse-utils.js';
import { resolveLlmModel } from '../../utils/llm/openai-chat-utils.js';
import { tryParseJson } from '../../utils/json-utils.js';
import { logPromptCacheUsage } from '../../utils/llm/prompt-cache-policy.js';

export default class AnthropicCompatibleLLMClient {
  constructor(config = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = config.timeout ?? 360000;
  }

  normalizeEndpoint(config) {
    const base = (config.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    const path = (config.path || '/messages').replace(/^\/?/, '/');
    return `${base}${path}`;
  }

  get timeout() {
    return this._timeout ?? 360000;
  }

  buildHeaders(extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (this.config.apiKey) headers['x-api-key'] = String(this.config.apiKey).trim();
    headers['anthropic-version'] = String(this.config.anthropicVersion || '2023-06-01');
    if (this.config.headers) Object.assign(headers, this.config.headers);
    return headers;
  }

  async transformMessages(messages) {
    return prepareOpenAIChatVisionMessages(messages, this.config, { timeoutMs: this.timeout });
  }

  buildBody(messages, overrides = {}) {
    const systemTexts = [];
    const anthMessages = [];

    for (const m of messages ?? []) {
      const role = (m.role ?? '').toLowerCase();
      if (role === 'system') {
        const text = (typeof m.content === 'string' ? m.content : (m.content?.text ?? m.content?.content ?? '')).toString();
        if (text) systemTexts.push(text);
        continue;
      }

      const blocks = [];
      if (typeof m.content === 'string') {
        if (m.content) blocks.push({ type: 'text', text: String(m.content) });
      } else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p?.type === 'text' && p.text) blocks.push({ type: 'text', text: String(p.text) });
          if (p?.type === 'image_url' && p.image_url?.url) {
            const url = String(p.image_url.url);
            if (url.startsWith('data:')) {
              const imgBlock = visionDataUrlToAnthropicImageBlock(url);
              if (imgBlock) blocks.push(imgBlock);
              else blocks.push({ type: 'text', text: VISION_IMAGE_OMITTED_TEXT });
            } else {
              blocks.push({ type: '__image_url__', url });
            }
          }
        }
      } else if (m.content && typeof m.content === 'object') {
        const text = (m.content.text ?? m.content.content ?? '').toString();
        if (text) blocks.push({ type: 'text', text });
      }

      if (!blocks.length) continue;
      anthMessages.push({ role: role === 'assistant' ? 'assistant' : 'user', content: blocks });
    }

    const body = {
      model: resolveLlmModel(this.config, overrides),
      max_tokens: (overrides.maxTokens ?? overrides.max_tokens) ?? (this.config.maxTokens ?? this.config.max_tokens) ?? 2048,
      temperature: overrides.temperature ?? this.config.temperature ?? 0.7,
      messages: anthMessages
    };

    if (systemTexts.length > 0) {
      const useCache = overrides.anthropic_prompt_cache === true
        || this.config.anthropic_prompt_cache === true;
      if (useCache) {
        body.system = [{
          type: 'text',
          text: systemTexts.join('\n'),
          cache_control: { type: 'ephemeral' },
        }];
      } else {
        body.system = systemTexts.join('\n');
      }
    }
    if (this.config.extraBody && typeof this.config.extraBody === 'object') Object.assign(body, this.config.extraBody);
    if (overrides.extraBody && typeof overrides.extraBody === 'object') Object.assign(body, overrides.extraBody);

    return body;
  }

  extractText(json) {
    const parts = json?.content;
    if (!Array.isArray(parts)) return '';
    return parts.map((p) => (p?.type === 'text' ? (p.text ?? '') : '')).join('');
  }

  async chat(messages, overrides = {}) {
    const transformed = await this.transformMessages(messages);
    const body = this.buildBody(transformed, overrides);
    await resolveAnthropicBodyImagePlaceholders(body, this.config, { timeoutMs: this.timeout });

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
      throw new Error(`anthropic_compat 请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
    }

    const json = await resp.json();
    logPromptCacheUsage(json?.usage, 'AnthropicCompatible');
    return this.extractText(json);
  }

  async chatStream(messages, onDelta, overrides = {}) {
    const transformed = await this.transformMessages(messages);
    const body = this.buildBody(transformed, overrides);
    await resolveAnthropicBodyImagePlaceholders(body, this.config, { timeoutMs: this.timeout });
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

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(`anthropic_compat 流式请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
    }

    for await (const { data } of iterateSSE(resp, { stopOnDone: false })) {
      if (!data) continue;
      const json = tryParseJson(data);
      if (!json) continue;
      let deltaText = '';
      if (json?.type === 'content_block_delta') {
        deltaText = json?.delta?.text ?? '';
      } else if (json?.type === 'content_block_start' && json?.content_block?.type === 'text') {
        deltaText = json?.content_block?.text ?? '';
      }
      if (deltaText && typeof onDelta === 'function') onDelta(deltaText);
    }
  }
}
