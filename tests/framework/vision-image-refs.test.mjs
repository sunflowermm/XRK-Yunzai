import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOneBotBase64Ref,
  parseDataUrl,
  ensureMessagesImagesDataUrl,
  VISION_IMAGE_OMITTED_TEXT,
  visionPayloadToOpenAiDataUrl
} from '../../lib/utils/llm/image-utils.js';

describe('vision image refs', () => {
  it('parseOneBotBase64Ref strips base64:// prefix', () => {
    assert.equal(parseOneBotBase64Ref('base64://aGVsbG8='), 'aGVsbG8=');
    assert.equal(parseOneBotBase64Ref('https://x/y.jpg'), null);
    assert.equal(parseOneBotBase64Ref('4C21A673.jpg'), null);
  });

  it('ensureMessagesImagesDataUrl inlines base64:// and omits unresolvable refs', async () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'base64://aGVsbG8=' } },
          { type: 'image_url', image_url: { url: 'not-a-real-image-ref' } }
        ]
      }
    ];

    await ensureMessagesImagesDataUrl(messages, { timeoutMs: 1000 });

    const dataPart = messages[0].content.find((p) => p?.type === 'image_url');
    assert.ok(dataPart);
    assert.match(String(dataPart.image_url.url), /^data:image\//);

    const omitted = messages[0].content.find((p) => p?.type === 'text' && p.text === VISION_IMAGE_OMITTED_TEXT);
    assert.ok(omitted);
  });

  it('visionPayloadToOpenAiDataUrl round-trips via parseDataUrl', () => {
    const url = visionPayloadToOpenAiDataUrl({ mimeType: 'image/png', base64: 'aGVsbG8=' });
    const parsed = parseDataUrl(url);
    assert.equal(parsed.mimeType, 'image/png');
    assert.equal(parsed.base64, 'aGVsbG8=');
  });
});
