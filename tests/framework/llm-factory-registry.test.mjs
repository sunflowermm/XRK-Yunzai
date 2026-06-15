import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LLM_FACTORY_CONFIG_KEYS,
  LLM_FACTORY_REGISTRY
} from '../../lib/factory/llm/factory-registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const commonconfigDir = path.join(root, 'plugins/system-plugin/commonconfig');
const defaultConfigDir = path.join(root, 'config/default_config');

describe('LLM 工厂注册表对齐', () => {
  it('registry 与 configKey 列表一致', () => {
    assert.deepEqual(
      LLM_FACTORY_REGISTRY.map((row) => row.configKey).sort(),
      [...LLM_FACTORY_CONFIG_KEYS].sort()
    );
  });

  for (const configKey of LLM_FACTORY_CONFIG_KEYS) {
    it(`${configKey} 有 commonconfig 入口与默认 yaml`, () => {
      const entryFile = path.join(commonconfigDir, `${configKey}.js`);
      const yamlFile = path.join(defaultConfigDir, `${configKey}.yaml`);
      assert.ok(fs.existsSync(entryFile), `缺少 ${entryFile}`);
      assert.ok(fs.existsSync(yamlFile), `缺少 ${yamlFile}`);
    });
  }
});
