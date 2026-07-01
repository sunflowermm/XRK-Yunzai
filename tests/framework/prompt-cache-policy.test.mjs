import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPromptCacheKey,
  applyPromptCachePolicy,
  isPromptCacheEnabled,
  pickPromptCacheOverrides,
} from '../../lib/utils/llm/prompt-cache-policy.js';

describe('prompt-cache-policy', () => {
  it('buildPromptCacheKey 按 workflow/model/会话稳定生成', () => {
    const k = buildPromptCacheKey({
      keyPrefix: 'xrk',
      streamName: 'chat',
      model: 'gpt-4o',
      selfId: 1,
      scopeId: 99,
    });
    assert.equal(k, 'xrk:chat:gpt-4o:1:99');
  });

  it('scopeInKey=false 时省略会话段（跨群共享前缀）', () => {
    const k = buildPromptCacheKey({
      keyPrefix: 'xrk',
      streamName: 'chat',
      model: 'gpt-4o',
      selfId: 1,
      scopeId: 99,
      scopeInKey: false,
    });
    assert.equal(k, 'xrk:chat:gpt-4o');
  });

  it('applyPromptCachePolicy 在未显式配置时注入 key', () => {
    const out = applyPromptCachePolicy(
      { model: 'gpt-4o', promptCache: { enabled: true, keyPrefix: 'test' } },
      { stream: { name: 'chat' }, e: { self_id: 1, group_id: 42 } }
    );
    assert.equal(out.prompt_cache_key, 'test:chat:gpt-4o:1:42');
    assert.equal(out.anthropic_prompt_cache, true);
  });

  it('pickPromptCacheOverrides 仅导出 client 所需字段', () => {
    const o = pickPromptCacheOverrides(
      { model: 'gpt-4o', promptCache: { enabled: true } },
      { stream: { name: 'http-v3' } }
    );
    assert.ok(o.prompt_cache_key);
    assert.equal(o.anthropic_prompt_cache, true);
  });

  it('显式 promptCacheKey 不被覆盖', () => {
    const out = applyPromptCachePolicy(
      { promptCacheKey: 'custom', promptCache: { enabled: true } },
      { stream: { name: 'chat' }, e: {} }
    );
    assert.equal(out.prompt_cache_key, undefined);
    assert.equal(out.promptCacheKey, 'custom');
  });

  it('isPromptCacheEnabled 读取 promptCache.enabled', () => {
    assert.equal(isPromptCacheEnabled({ promptCache: { enabled: true } }), true);
    assert.equal(isPromptCacheEnabled({ promptCache: { enabled: false } }), false);
  });
});
