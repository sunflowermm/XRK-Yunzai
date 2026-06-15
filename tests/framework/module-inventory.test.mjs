import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SYSTEM_PLUGIN_BASELINE,
  SYSTEM_PLUGIN_DIR,
  listSystemPluginJs,
  systemPluginStreamBasenames,
} from '../helpers/system-plugin-baseline.mjs';

describe('system-plugin 模块数量（框架基准）', () => {
  it('HTTP API', () => {
    assert.equal(listSystemPluginJs('http').length, SYSTEM_PLUGIN_BASELINE.http);
  });

  it('AI 工作流', () => {
    assert.equal(listSystemPluginJs('stream').length, SYSTEM_PLUGIN_BASELINE.stream);
  });

  it('内置插件', () => {
    assert.equal(listSystemPluginJs('plugin').length, SYSTEM_PLUGIN_BASELINE.plugin);
  });

  it('events', () => {
    assert.equal(listSystemPluginJs('events').length, SYSTEM_PLUGIN_BASELINE.events);
  });

  it('adapter', () => {
    assert.equal(listSystemPluginJs('adapter').length, SYSTEM_PLUGIN_BASELINE.adapter);
  });

  it('磁盘 plugin 数不少于 git 基准', () => {
    const pluginDir = path.join(SYSTEM_PLUGIN_DIR, 'plugin');
    const onDisk = fs.readdirSync(pluginDir).filter((f) => f.endsWith('.js'));
    const official = listSystemPluginJs('plugin');
    assert.ok(onDisk.length >= official.length);
  });
});

describe('stream 工作流命名', () => {
  it('不含已删除的 device 语音流', () => {
    const names = systemPluginStreamBasenames();
    assert.ok(!names.includes('device'), `stream 不应含 device: ${names.join(', ')}`);
    assert.deepEqual([...names].sort(), ['browser', 'chat', 'database', 'desktop', 'memory', 'tools', 'web']);
  });
});
