import { MCPToolAdapter } from './mcp-tool-adapter.js';

/**
 * OpenAI-like Chat Completions 参数归一化（字段与 OpenAI 官方 Chat Completions API 对齐）
 */

function pick(overrides, config, keys) {
  for (const k of keys) {
    if (overrides != null && Object.hasOwn(overrides, k) && overrides[k] !== undefined) return overrides[k];
    if (config != null && Object.hasOwn(config, k) && config[k] !== undefined) return config[k];
  }
  return undefined;
}

function applyOptionalFields(body, overrides, config, mapping) {
  for (const item of mapping) {
    const v = pick(overrides, config, item.from);
    if (v !== undefined) body[item.to] = v;
  }
}

export function buildOpenAIChatCompletionsBody(messages, config = {}, overrides = {}, defaultModel = 'gpt-4o-mini') {
  const temperature = pick(overrides, config, ['temperature']);
  const maxCompletionTokensExplicit = pick(overrides, config, ['maxCompletionTokens', 'max_completion_tokens']);
  const maxTokensCompat = pick(overrides, config, ['maxTokens', 'max_tokens']);
  const maxCompletionTokens = maxCompletionTokensExplicit ?? maxTokensCompat;
  const tokenField = pick(overrides, config, ['tokenField', 'token_field']);
  const stream = pick(overrides, config, ['stream', 'enableStream']);

  const body = {
    model: pick(overrides, config, ['model', 'chatModel']) || defaultModel,
    messages,
    stream: stream ?? false
  };

  if (temperature !== undefined) {
    body.temperature = temperature;
  }

  if (maxCompletionTokens !== undefined) {
    const want = (tokenField || '').toString().trim().toLowerCase();
    const useBoth = want === 'both';
    const useMaxCompletionTokens =
      want === 'max_completion_tokens'
      || (!want && maxCompletionTokensExplicit !== undefined);

    if (useBoth) {
      body.max_completion_tokens = maxCompletionTokens;
      body.max_tokens = maxCompletionTokens;
    } else if (useMaxCompletionTokens) {
      body.max_completion_tokens = maxCompletionTokens;
    } else {
      body.max_tokens = maxCompletionTokens;
    }
  }

  applyOptionalFields(body, overrides, config, [
    { to: 'top_p', from: ['topP', 'top_p'] },
    { to: 'presence_penalty', from: ['presencePenalty', 'presence_penalty'] },
    { to: 'frequency_penalty', from: ['frequencyPenalty', 'frequency_penalty'] },
    { to: 'stop', from: ['stop'] },
    { to: 'response_format', from: ['response_format', 'responseFormat'] },
    { to: 'stream_options', from: ['stream_options', 'streamOptions'] },
    { to: 'seed', from: ['seed'] },
    { to: 'user', from: ['user'] },
    { to: 'n', from: ['n'] },
    { to: 'logit_bias', from: ['logit_bias', 'logitBias'] },
    { to: 'logprobs', from: ['logprobs'] },
    { to: 'top_logprobs', from: ['top_logprobs', 'topLogprobs'] },
    { to: 'service_tier', from: ['service_tier', 'serviceTier'] },
    { to: 'prompt_cache_key', from: ['prompt_cache_key', 'promptCacheKey'] },
    { to: 'prompt_cache_retention', from: ['prompt_cache_retention', 'promptCacheRetention'] },
    { to: 'safety_identifier', from: ['safety_identifier', 'safetyIdentifier'] },
    { to: 'reasoning_effort', from: ['reasoning_effort', 'reasoningEffort'] }
  ]);

  for (const o of [config.extraBody, pick(overrides, config, ['extraBody'])]) {
    if (o && typeof o === 'object') Object.assign(body, o);
  }

  if (typeof body.response_format === 'string' && body.response_format.trim()) {
    body.response_format = { type: body.response_format.trim() };
  }

  return body;
}

/** 从 Chat Completions choices[].message 提取 assistant 可见正文 */
export function extractOpenAIAssistantText(message) {
  const content = message?.content;
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(p => p?.type === 'text').map(p => p.text).filter(Boolean).join('');
  }
  return '';
}

export function applyOpenAITools(body, config = {}, overrides = {}) {
  let tools = overrides.tools ?? config.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    if (config.enableTools === false || !MCPToolAdapter.hasTools()) return body;
    tools = MCPToolAdapter.convertMCPToolsToOpenAI(overrides.streams);
    if (!tools.length) return body;
  }

  body.tools = MCPToolAdapter.ensureOpenAICompatibleToolDefinitions(tools);
  body.tool_choice = overrides.tool_choice ?? config.tool_choice ?? config.toolChoice ?? 'auto';
  const parallel = overrides.parallel_tool_calls ?? config.parallel_tool_calls ?? config.parallelToolCalls;
  if (parallel !== undefined) body.parallel_tool_calls = parallel;
  return body;
}
