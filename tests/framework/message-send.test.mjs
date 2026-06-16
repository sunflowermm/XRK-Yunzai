import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTargetId,
  normalizeSendMessage,
  normalizeMessageType,
  parseAdapterSendError,
} from '../../lib/http/utils/messageSend.js';

describe('messageSend utils', () => {
  it('normalizeTargetId converts numeric strings', () => {
    assert.equal(normalizeTargetId('123456789'), 123456789);
    assert.equal(normalizeTargetId(123456789), 123456789);
  });

  it('normalizeSendMessage parses JSON segments', () => {
    const segs = normalizeSendMessage('[{"type":"text","text":"hi"}]');
    assert.ok(Array.isArray(segs));
    assert.equal(segs[0].type, 'text');
    assert.equal(segs[0].data.text, 'hi');
  });

  it('normalizeSendMessage keeps plain text', () => {
    assert.equal(normalizeSendMessage('hello'), 'hello');
  });

  it('normalizeMessageType aliases friend to private', () => {
    assert.equal(normalizeMessageType('friend'), 'private');
  });

  it('parseAdapterSendError extracts NapCat hints', () => {
    const err = parseAdapterSendError(new Error(
      'EventChecker Failed: EventRet:\n{"result":120,"errMsg":""}\n'
    ));
    assert.match(err, /QQ 拒绝/);
  });
});
