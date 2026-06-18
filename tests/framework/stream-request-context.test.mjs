import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runWithStreamRequestContext,
  getStreamRequestContext
} from '../../lib/aistream/stream-request-context.js';
import { createUserVisibleTurnState } from '../../lib/utils/chat-user-visible-ack.js';

describe('stream request context', () => {
  it('isolates turnState between concurrent async chains', async () => {
    const results = await Promise.all([
      runWithStreamRequestContext({ e: { id: 'a' }, turnState: createUserVisibleTurnState() }, async () => {
        const turn = getStreamRequestContext().turnState;
        turn.hasSentReply = true;
        turn.lastReplySummary = 'reply-a';
        await new Promise((r) => setTimeout(r, 20));
        return turn.lastReplySummary;
      }),
      runWithStreamRequestContext({ e: { id: 'b' }, turnState: createUserVisibleTurnState() }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        const turn = getStreamRequestContext().turnState;
        return turn.hasSentReply ? turn.lastReplySummary : 'empty';
      })
    ]);
    assert.equal(results[0], 'reply-a');
    assert.equal(results[1], 'empty');
  });
});
