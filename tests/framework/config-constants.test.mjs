import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GLOBAL_CONFIG_NAMES,
  PORT_CONFIG_NAMES,
  DEFAULT_CONFIG_NAMES,
  FACTORY_CONFIG_SUFFIXES,
  isFactoryConfig,
  isGlobalConfig,
  getServerConfigPath,
} from '../../lib/config/config-constants.js';

describe('config-constants 分类', () => {
  it('DEFAULT_CONFIG_NAMES = PORT + GLOBAL', () => {
    assert.deepEqual(
      [...DEFAULT_CONFIG_NAMES].sort(),
      [...PORT_CONFIG_NAMES, ...GLOBAL_CONFIG_NAMES].sort()
    );
  });

  it('FACTORY_CONFIG_SUFFIXES 仅 LLM 相关', () => {
    assert.deepEqual(FACTORY_CONFIG_SUFFIXES, ['_llm', '_compat_llm']);
    assert.ok(!FACTORY_CONFIG_SUFFIXES.some((s) => s.includes('asr') || s.includes('tts')));
  });

  it('isFactoryConfig 识别 LLM 配置名', () => {
    assert.ok(isFactoryConfig('openai_llm'));
    assert.ok(isFactoryConfig('openai_compat_llm'));
    assert.ok(!isFactoryConfig('bot'));
    assert.ok(!isFactoryConfig('volcengine_asr'));
  });

  it('isGlobalConfig 与 getServerConfigPath', () => {
    assert.ok(isGlobalConfig('device'));
    assert.match(getServerConfigPath(8086, 'device'), /data\/server_bots\/device\.yaml$/);
    assert.match(getServerConfigPath(8086, 'bot'), /data\/server_bots\/8086\/bot\.yaml$/);
    assert.match(getServerConfigPath(null, 'bot'), /config\/default_config\/bot\.yaml$/);
  });
});
