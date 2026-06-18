import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatEmotionDeliveredAck,
  formatEmotionSkippedAck,
  isOverlappingUserVisible
} from '../../lib/utils/chat-user-visible-ack.js';

describe('chat user-visible ack', () => {
  it('emotion delivered ack states what user sees', () => {
    const ack = formatEmotionDeliveredAck('群 1', '伤心', '');
    assert.match(ack, /你已在群 1发出表情包\(伤心\)/);
    assert.match(ack, /用户在 QQ 里已能看到/);
    assert.match(ack, /已送达/);
  });

  it('duplicate ack references prior send', () => {
    const ack = formatEmotionSkippedAck('群 1', '表情包(伤心)');
    assert.match(ack, /你已在本次对话中向群 1发出过/);
    assert.match(ack, /本次 emotion 未再发送/);
  });

  it('overlap detects repeat reply after emotion caption', () => {
    const prev = '呜呜，橘子人宝宝怎么啦，不要不开心嘛';
    const next = '[回复:1] 呜呜，橘子人宝宝怎么啦 | 雅雅给你一个大大的抱抱，不要不开心嘛~';
    assert.equal(isOverlappingUserVisible(next, prev), true);
  });
});
