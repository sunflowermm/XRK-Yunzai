import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSameValue } from '../../plugins/system-plugin/www/xrk/modules/utils.js';
import { fillMissingSchemaDefaults } from '../../plugins/system-plugin/www/xrk/modules/config-manager.js';

describe('config form utils', () => {
  it('isSameValue treats missing and empty array as equal', () => {
    assert.equal(isSameValue(undefined, []), true);
    assert.equal(isSameValue([], undefined), true);
    assert.equal(isSameValue(null, []), true);
  });

  it('isSameValue treats missing and empty object as equal', () => {
    assert.equal(isSameValue(undefined, {}), true);
    assert.equal(isSameValue({}, undefined), true);
  });

  it('fillMissingSchemaDefaults fills missing array fields with []', () => {
    const schema = [
      { path: 'providers', type: 'array', meta: { itemType: 'object' } },
      { path: 'providers[].key', type: 'string', meta: {} }
    ];
    const filled = fillMissingSchemaDefaults(schema, {});
    assert.deepEqual(filled, { providers: [] });
  });
});
