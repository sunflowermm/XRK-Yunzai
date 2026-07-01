import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentSessionKey,
  bumpAgentSessionRevision,
  bumpAgentSessionForEvent,
  getAgentSessionRevision,
  isSideEffectStream,
  resetAgentSessionRevisions,
} from '../../lib/aistream/agent-session.js';
import {
  buildStreamCacheKey,
  shouldCacheStreamResult,
  clearStreamResultCache,
} from '../../lib/aistream/stream-cache.js';

describe('agent-session revision', () => {
  it('buildAgentSessionKey 区分群聊与私聊', () => {
    assert.equal(
      buildAgentSessionKey({ self_id: 1, group_id: 99 }),
      'g:1:99'
    );
    assert.equal(
      buildAgentSessionKey({ self_id: 1, user_id: 42 }),
      'p:1:42'
    );
  });

  it('bump 后 revision 单调递增', () => {
    resetAgentSessionRevisions();
    const key = 'g:1:99';
    assert.equal(getAgentSessionRevision(key), 0);
    assert.equal(bumpAgentSessionRevision(key), 1);
    assert.equal(bumpAgentSessionRevision(key), 2);
    bumpAgentSessionForEvent({ self_id: 1, group_id: 99 });
    assert.equal(getAgentSessionRevision(key), 3);
  });
});

describe('stream-cache 与会话 revision', () => {
  it('有副作用的 chat 流默认不缓存', () => {
    const stream = { name: 'chat', config: {}, mcpTools: new Map([['reply', {}]]) };
    const e = { self_id: 1, group_id: 99, user_id: 2 };
    assert.equal(shouldCacheStreamResult(stream, e, '你好', {}), false);
  });

  it('无工具流在全局 cache 未启用时不缓存', () => {
    const stream = { name: 'summarize', config: { cache: true }, mcpTools: new Map(), functions: new Map() };
    const e = { self_id: 1, user_id: 2 };
    assert.equal(shouldCacheStreamResult(stream, e, '摘要这段', {}), false);
  });

  it('会话 revision 变化会改变 cache key', () => {
    resetAgentSessionRevisions();
    clearStreamResultCache();
    const e = { self_id: 1, group_id: 99, user_id: 2 };
    const k1 = buildStreamCacheKey('summarize', e, 'q', {});
    bumpAgentSessionForEvent(e);
    const k2 = buildStreamCacheKey('summarize', e, 'q', {});
    assert.notEqual(k1, k2);
  });

  it('isSideEffectStream 识别 MCP 工具', () => {
    assert.equal(isSideEffectStream({ name: 'x', mcpTools: new Map([['a', {}]]) }), true);
    assert.equal(isSideEffectStream({ name: 'x', mcpTools: new Map(), functions: new Map() }), false);
  });
});
