import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MCPServer } from '../../lib/utils/mcp-server.js';

describe('MCP validateArguments', () => {
  const server = new MCPServer();

  it('accepts JSON integer values for integer schema fields', () => {
    assert.doesNotThrow(() => {
      server.validateArguments(
        { maxDepth: 2, startLine: 1 },
        {
          properties: {
            maxDepth: { type: 'integer' },
            startLine: { type: 'integer' }
          }
        }
      );
    });
  });

  it('rejects non-integer numbers for integer fields', () => {
    assert.throws(
      () => {
        server.validateArguments(
          { maxDepth: 1.5 },
          { properties: { maxDepth: { type: 'integer' } } }
        );
      },
      /类型不匹配.*integer/
    );
  });

  it('accepts union types', () => {
    assert.doesNotThrow(() => {
      server.validateArguments(
        { limit: null },
        { properties: { limit: { type: ['integer', 'null'] } } }
      );
    });
  });
});
