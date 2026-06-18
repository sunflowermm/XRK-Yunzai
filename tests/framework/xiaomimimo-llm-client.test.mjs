import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import XiaomiMiMoLLMClient from '../../lib/factory/llm/XiaomiMiMoLLMClient.js';

describe('XiaomiMiMoLLMClient', () => {
  const client = new XiaomiMiMoLLMClient({
    apiKey: 'sk-test',
    model: 'mimo-v2.5-pro',
    maxTokens: 1024,
    tokenField: 'max_completion_tokens',
    thinkingType: 'enabled'
  });

  it('buildBody matches official OpenAI-compatible fields', () => {
    const body = client.buildBody([{ role: 'user', content: 'hi' }]);
    assert.equal(body.model, 'mimo-v2.5-pro');
    assert.equal(body.max_completion_tokens, 1024);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.thinking.type, 'enabled');
    assert.equal(body.tool_choice, undefined);
    assert.ok(body.temperature >= 0 && body.temperature <= 1.5);
    assert.ok(body.top_p >= 0.01 && body.top_p <= 1);
  });

  it('forces tool_choice auto when tools are present', () => {
    const body = client.buildBody([{ role: 'user', content: 'hi' }], {
      tools: [{ type: 'function', function: { name: 'demo', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'required'
    });
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.tools.length, 1);
  });

  it('defaults endpoint to official pay-as-you-go baseUrl', () => {
    assert.equal(client.endpoint, 'https://api.xiaomimimo.com/v1/chat/completions');
  });
});
