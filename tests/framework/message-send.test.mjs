import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTargetId,
  normalizeMessageType,
  buildSendMessage,
} from '../../lib/http/utils/messageSend.js';
import { sanitizeErrorMessage } from '../../lib/http/utils/helpers.js';
import {
  registerUploadedFile,
  deleteUploadedFile,
} from '../../lib/http/utils/uploadedFiles.js';

describe('messageSend utils', () => {
  it('normalizeTargetId converts numeric strings', () => {
    assert.equal(normalizeTargetId('123456789'), 123456789);
  });

  it('normalizeMessageType aliases friend to private', () => {
    assert.equal(normalizeMessageType('friend'), 'private');
  });

  it('buildSendMessage parses text', async () => {
    assert.equal(await buildSendMessage({ message: 'hello' }), 'hello');
  });

  it('buildSendMessage attaches uploaded file_id', async () => {
    registerUploadedFile({
      id: 'test-file',
      path: '/tmp/test.png',
      name: 'test.png',
      is_media: true,
    });
    const msg = await buildSendMessage({ file_id: 'test-file' });
    assert.ok(Array.isArray(msg));
    assert.equal(msg[0].type, 'image');
    assert.equal(msg[0].data.file, '/tmp/test.png');
    deleteUploadedFile('test-file');
  });

  it('sanitizeErrorMessage hides NapCat internals', () => {
    const text = sanitizeErrorMessage(new Error(
      'EventChecker Failed: EventRet:\n{"result":120,"errMsg":""}\n'
    ), '发送失败');
    assert.match(text, /QQ 拒绝|发送失败/);
    assert.doesNotMatch(text, /EventChecker|NodeIKernel/);
  });
});
