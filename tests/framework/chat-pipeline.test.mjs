import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assembleChatLlmMessages } from '../../lib/aistream/chat-pipeline.js';

describe('chat-pipeline', () => {
  it('assembleChatLlmMessages 串联 buildChatContext / merge / enhanced', async () => {
    const calls = [];
    const stream = {
      async buildChatContext(e, q) {
        calls.push('build');
        return [{ role: 'system', content: 's' }, { role: 'user', content: q?.text || 'hi' }];
      },
      async mergeMessageHistory(msgs) {
        calls.push('merge');
        return msgs;
      },
      async buildEnhancedContext(e, q, msgs) {
        calls.push('enhanced');
        return [...msgs, { role: 'user', content: 'mem' }];
      },
    };

    const out = await assembleChatLlmMessages(stream, { group_id: 1 }, { text: 'hello' });
    assert.deepEqual(calls, ['build', 'merge', 'enhanced']);
    assert.equal(out.length, 3);
    assert.equal(out[2].content, 'mem');
  });
});
