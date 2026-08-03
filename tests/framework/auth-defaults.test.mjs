import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('server.auth 默认值（对齐 XRK-AGT）', () => {
  const server = yaml.parse(
    fs.readFileSync(path.join(root, 'config/default_config/server.yaml'), 'utf8')
  );

  it('whitelist 默认为空数组', () => {
    assert.deepEqual(server.auth?.whitelist, []);
  });

  it('loopbackExempt 默认 false', () => {
    assert.equal(server.auth?.loopbackExempt, false);
  });

  it('requireLoopbackAuthWhenToolsRun 默认 true', () => {
    assert.equal(server.auth?.requireLoopbackAuthWhenToolsRun, true);
  });

  it('onebot.requireLoopbackAuth 默认 true', () => {
    assert.equal(server.auth?.onebot?.requireLoopbackAuth, true);
  });

  it('apiKey 默认启用', () => {
    assert.equal(server.auth?.apiKey?.enabled, true);
  });
});

describe('ai-workflow.tools.file 默认值', () => {
  const cfg = yaml.parse(
    fs.readFileSync(path.join(root, 'config/default_config/ai-workflow.yaml'), 'utf8')
  );

  it('runEnabled 默认 false', () => {
    assert.equal(cfg.tools?.file?.runEnabled, false);
  });
});
