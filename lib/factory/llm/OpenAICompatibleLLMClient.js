import fetch from 'node-fetch';
import BotUtil from '../../util.js';
import { MCPToolAdapter } from '../../utils/llm/mcp-tool-adapter.js';
import { buildOpenAIChatCompletionsBody, applyOpenAITools } from '../../utils/llm/openai-chat-utils.js';
import { consumeOpenAIChatStream } from '../../utils/llm/sse-utils.js';
import { transformMessagesWithVision } from '../../utils/llm/message-transform.js';
import { buildFetchOptionsWithProxy } from '../../utils/llm/proxy-utils.js';

/**
 * OpenAI 兼容第三方 LLM 客户端（OpenAI-like / OpenAI-Compatible）
 *
 * 目标：
 * - 用一个 provider 接入各种第三方"OpenAI 协议"接口（自定义 baseUrl/path/headers/认证/额外参数）
 * - 统一多模态消息结构：通过 `transformMessagesWithVision` 构造 text + image_url（含 base64 data URL）
 * - 支持 MCP tool calling（OpenAI tools/tool_calls 协议）
 *
 * 常用配置：
 * - baseUrl: 第三方 API base（例如 https://xxx.com/v1）
 * - path: 默认 /chat/completions
 * - apiKey: 密钥
 * - authMode:
 *   - bearer（默认）：Authorization: Bearer ${apiKey}
 *   - api-key：api-key: ${apiKey}
 *   - header：使用 authHeaderName 指定头名
 * - authHeaderName: authMode=header 时使用（例如 X-Api-Key）
 * - extraBody: 额外请求体字段（原样透传到下游）
 */
export default class OpenAICompatibleLLMClient {
  constructor(config = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = config.timeout || 360000;
  }

  normalizeEndpoint(config) {
    const base = (config.baseUrl || '').replace(/\/+$/, '');
    const path = (config.path || '/chat/completions').replace(/^\/?/, '/');
    if (!base) {
      throw new Error('openai_compat: 未配置 baseUrl（第三方 OpenAI 兼容接口地址）');
    }
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
      const mode = String(this.config.authMode || 'bearer').toLowerCase();
      const apiKey = String(this.config.apiKey).trim();
      if (mode === 'api-key') {
        headers['api-key'] = apiKey;
      } else if (mode === 'header') {
        const name = String(this.config.authHeaderName || '').trim();
        if (!name) {
          throw new Error('openai_compat: authMode=header 时必须提供 authHeaderName');
        }
        headers[name] = apiKey;
      } else {
        headers.Authorization = `Bearer ${apiKey}`;
      }
    }

    if (this.config.headers) {
      Object.assign(headers, this.config.headers);
    }

    return headers;
  }

  async transformMessages(messages) {
    // OpenAI 兼容第三方：假定支持 Chat Completions 多模态协议
    return await transformMessagesWithVision(messages, this.config, { mode: 'openai' });
  }

  buildBody(messages, overrides = {}) {
    const body = buildOpenAIChatCompletionsBody(messages, this.config, overrides, 'gpt-4o-mini');
    applyOpenAITools(body, this.config, overrides);
    return body;
  }

  async chat(messages, overrides = {}) {
    const transformedMessages = await this.transformMessages(messages);
    BotUtil.makeLog('debug', `[OpenAICompatible] chat 入口 messagesLen=${messages?.length} transformedLen=${transformedMessages?.length}`, 'OpenAICompatible');
    const maxToolRounds = this.config.maxToolRounds ?? 20;
    const mcpToolMode = overrides?.mcpToolMode || 'execute';
    const enableMcpTools = mcpToolMode !== 'passthrough';
    const currentMessages = [...transformedMessages];
    let didRunTools = false;

    for (let round = 0; round < maxToolRounds; round++) {
      BotUtil.makeLog('debug', `[OpenAICompatible] chat 轮次 round=${round + 1}/${maxToolRounds} currentMessagesLen=${currentMessages.length}`, 'OpenAICompatible');
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
        throw new Error(`openai_compat 请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
      }

      const raw = await resp.json();
      const result = raw?.body && typeof raw.body === 'object' ? raw.body : raw;
      if (raw?.status != null && String(raw.status) !== '200') {
        const errMsg = raw.msg || raw.message || raw.error?.message || `status ${raw.status}`;
        throw new Error(`openai_compat: ${errMsg}`);
      }

      const choice = result?.choices?.[0];
      const message = choice?.message;
      if (!message) {
        BotUtil.makeLog('debug', `[OpenAICompatible] chat 轮次=${round + 1} 无 message 退出`, 'OpenAICompatible');
        break;
      }

      const role = (message.role || '').toLowerCase();
      const content = message.content;
      const toolCalls = message.tool_calls;
      if (toolCalls?.length > 0 && enableMcpTools) {
        const names = toolCalls.map(t => t?.function?.name).filter(Boolean).join(',');
        BotUtil.makeLog('debug', `[OpenAICompatible] chat 轮次=${round + 1} tool_calls count=${toolCalls.length} names=[${names}]`, 'OpenAICompatible');
        currentMessages.push(message);
        const toolResults = await MCPToolAdapter.handleToolCalls(toolCalls);
        currentMessages.push(...toolResults);
        didRunTools = true;
        continue;
      }

      if (role !== 'assistant') {
        BotUtil.makeLog('debug', `[OpenAICompatible] chat 轮次=${round + 1} role=${role} 非 assistant 跳过`, 'OpenAICompatible');
        continue;
      }
      if (content == null) {
        BotUtil.makeLog('debug', `[OpenAICompatible] chat 轮次=${round + 1} content=null 跳过`, 'OpenAICompatible');
        continue;
      }
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter(p => p?.type === 'text').map(p => p.text).filter(Boolean).join('')
          : null;
      if (text != null && text.trim() !== '') {
        BotUtil.makeLog('debug', `[OpenAICompatible] chat 轮次=${round + 1} 返回正文 textLen=${text.length} text=${text}`, 'OpenAICompatible');
        return text;
      }
      BotUtil.makeLog('debug', `[OpenAICompatible] chat 轮次=${round + 1} 无有效 text 继续`, 'OpenAICompatible');
    }
    BotUtil.makeLog('debug', `[OpenAICompatible] chat 结束 didRunTools=${didRunTools} 返回${didRunTools ? '空（已执行工具）' : '空'}`, 'OpenAICompatible');
    return didRunTools ? '' : '';
  }

  async chatStream(messages, onDelta, overrides = {}) {
    let currentMessages = await this.transformMessages(messages);
    BotUtil.makeLog('debug', `[OpenAICompatible] chatStream 入口 messagesLen=${messages?.length} currentMessagesLen=${currentMessages?.length}`, 'OpenAICompatible');
    const maxToolRounds = this.config.maxToolRounds ?? 20;
    const mcpToolMode = overrides?.mcpToolMode || 'execute';
    const enableMcpTools = mcpToolMode !== 'passthrough';

    for (let round = 0; round < maxToolRounds; round++) {
      BotUtil.makeLog('debug', `[OpenAICompatible] chatStream 轮次 round=${round + 1}/${maxToolRounds} currentMessagesLen=${currentMessages?.length}`, 'OpenAICompatible');
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
        throw new Error(`openai_compat 流式请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
      }
      const { content, tool_calls } = await consumeOpenAIChatStream(resp, onDelta, overrides);
      if (!Array.isArray(tool_calls) || tool_calls.length === 0 || !enableMcpTools) {
        BotUtil.makeLog('debug', `[OpenAICompatible] chatStream 轮次=${round + 1} 无 tool_calls 返回`, 'OpenAICompatible');
        return;
      }
      const names = tool_calls.map(t => t?.function?.name).filter(Boolean).join(',');
      BotUtil.makeLog('debug', `[OpenAICompatible] chatStream 轮次=${round + 1} tool_calls count=${tool_calls.length} names=[${names}]`, 'OpenAICompatible');
      const assistantMessage = { role: 'assistant', content: content || null, tool_calls };
      const toolResults = await MCPToolAdapter.handleToolCalls(tool_calls);
      MCPToolAdapter.emitMcpToolsToStream(tool_calls, toolResults, onDelta);
      currentMessages = [...currentMessages, assistantMessage, ...toolResults];
      BotUtil.makeLog('debug', `[OpenAICompatible] chatStream 轮次=${round + 1} 追加后 currentMessagesLen=${currentMessages.length}`, 'OpenAICompatible');
    }
  }
}
