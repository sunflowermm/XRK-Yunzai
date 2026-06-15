import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeConfigLayers,
  applyDefaults,
  buildDefaultsFromSchema,
  deepMergeConfig,
} from '../../lib/commonconfig/config-utils.js';

describe('config-utils merge layers', () => {
  it('mergeConfigLayers: template → stored → schema default', () => {
    const template = { host: '0.0.0.0', port: 8086, nested: { a: 1 } };
    const stored = { port: 2537, nested: { b: 2 } };
    const schema = {
      fields: {
        newField: { type: 'string', default: 'from-schema' },
        nested: {
          type: 'object',
          fields: {
            c: { type: 'number', default: 99 },
          },
        },
      },
    };

    const result = mergeConfigLayers(template, stored, schema);
    assert.equal(result.host, '0.0.0.0');
    assert.equal(result.port, 2537);
    assert.equal(result.newField, 'from-schema');
    assert.equal(result.nested.a, 1);
    assert.equal(result.nested.b, 2);
    assert.equal(result.nested.c, 99);
  });

  it('applyDefaults fills missing scalar without overwriting stored value', () => {
    const schema = {
      fields: {
        timeout: { type: 'number', default: 30 },
        name: { type: 'string', default: 'bot' },
      },
    };
    const result = applyDefaults({ name: 'custom' }, schema);
    assert.equal(result.name, 'custom');
    assert.equal(result.timeout, 30);
  });

  it('buildDefaultsFromSchema builds nested defaults', () => {
    const schema = {
      fields: {
        providers: { type: 'array', default: [] },
        server: {
          type: 'object',
          fields: {
            host: { type: 'string', default: '127.0.0.1' },
          },
        },
      },
    };
    assert.deepEqual(buildDefaultsFromSchema(schema), {
      providers: [],
      server: { host: '127.0.0.1' },
    });
  });

  it('deepMergeConfig preserves existing non-empty when new value is empty string', () => {
    const schema = { fields: { port: { type: 'number' } } };
    const merged = deepMergeConfig({ port: 8086 }, { port: '' }, schema);
    assert.equal(merged.port, 8086);
  });
});
