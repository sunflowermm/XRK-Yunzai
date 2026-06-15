import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GLOBAL_CONFIG_NAMES,
  PORT_CONFIG_NAMES,
} from '../../lib/config/config-constants.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultConfigDir = path.join(root, 'config/default_config');
const systemJsPath = path.join(root, 'plugins/system-plugin/commonconfig/system.js');

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

describe('配置三件套：默认模板存在', () => {
  for (const name of [...GLOBAL_CONFIG_NAMES, ...PORT_CONFIG_NAMES]) {
    it(`${name}.yaml 存在于 config/default_config`, () => {
      const file = path.join(defaultConfigDir, `${name}.yaml`);
      assert.ok(fs.existsSync(file), `缺少默认模板: ${file}`);
    });
  }
});

describe('system.js schema 覆盖全局与端口配置段', () => {
  const systemSrc = readText(systemJsPath);
  for (const name of [...GLOBAL_CONFIG_NAMES, ...PORT_CONFIG_NAMES]) {
    it(`schema 含 ${name} 段`, () => {
      assert.match(systemSrc, new RegExp(`\\b${name}:\\s*\\{`));
    });
  }
});

describe('已移除的 ASR/TTS 默认模板不应存在', () => {
  for (const name of ['volcengine_asr', 'volcengine_tts']) {
    it(`无 ${name}.yaml`, () => {
      const file = path.join(defaultConfigDir, `${name}.yaml`);
      assert.ok(!fs.existsSync(file), `应已删除: ${file}`);
    });
  }
});
