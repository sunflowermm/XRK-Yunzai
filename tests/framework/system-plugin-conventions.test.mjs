import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PLUGIN_DIR } from '../helpers/system-plugin-baseline.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BACKEND_SUBDIRS = ['http', 'stream', 'plugin', 'events', 'adapter', 'commonconfig'];

function walkBackendJs(out = []) {
  for (const sub of BACKEND_SUBDIRS) {
    const dir = path.join(SYSTEM_PLUGIN_DIR, sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.js')) out.push(path.join(dir, name));
    }
  }
  return out;
}

const backendFiles = walkBackendJs();

describe('system-plugin 底层约定', () => {
  it('无 ASR/TTS / device 语音流残留', () => {
    const bad = /getASRConfig|getTTSConfig|ASRFactory|TTSFactory|createDeviceClient|stream\/device\.js/;
    for (const file of backendFiles) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!bad.test(text), `${path.relative(root, file)} 含已移除 API`);
    }
  });

  it('后端模块不直连 fs', () => {
    for (const file of backendFiles) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!/from ['"]node:fs['"]|from ['"]fs['"]/.test(text), `${path.relative(root, file)} 应使用 FileUtils`);
      assert.ok(!/fs\.(existsSync|readFileSync|readdirSync|writeFileSync)/.test(text), `${path.relative(root, file)} 禁止 fs.*Sync`);
    }
  });

  it('不 import Bot / segment from oicq', () => {
    for (const file of backendFiles) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!/import\s+Bot\s+from/.test(text), `${path.relative(root, file)} 应使用全局 Bot`);
      assert.ok(!/import\s*\{[^}]*segment[^}]*\}\s*from\s*['"]oicq['"]/.test(text), `${path.relative(root, file)} 应使用全局 segment`);
    }
  });

  it('后端模块不使用 global.Bot/cfg/segment 前缀', () => {
    const bad = /global\.(Bot|cfg|segment|ConfigManager)\b/;
    for (const file of backendFiles) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!bad.test(text), `${path.relative(root, file)} 应使用裸名全局或 import cfg`);
    }
  });

  it('业务日志统一 Bot.makeLog', () => {
    const badBotUtilMakeLog = /BotUtil\.makeLog/;
    const badLoggerLevel = /logger\.(trace|debug|info|warn|error|fatal|mark|success)\(/;
    for (const file of backendFiles) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!badBotUtilMakeLog.test(text), `${path.relative(root, file)} 应使用 Bot.makeLog`);
      assert.ok(!badLoggerLevel.test(text), `${path.relative(root, file)} 应使用 Bot.makeLog`);
    }
  });

  it('后端模块无空 catch', () => {
    const emptyCatch =
      /catch\s*\(\s*\)\s*\{\s*\}|catch\s*\{\s*\}|catch\s*\(\s*_\w*\s*\)\s*\{\s*\}/;
    for (const file of backendFiles) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!emptyCatch.test(text), `${path.relative(root, file)} 禁止空 catch`);
    }
  });

  it('stream 工作流不在 constructor 内 new Map/{}', () => {
    const streamDir = path.join(SYSTEM_PLUGIN_DIR, 'stream');
    const bad = /constructor\s*\([^)]*\)\s*\{[\s\S]*?this\.\w+\s*=\s*(new Map\(\)|\{\})/;
    for (const name of fs.readdirSync(streamDir)) {
      if (!name.endsWith('.js')) continue;
      const file = path.join(streamDir, name);
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!bad.test(text), `${path.relative(root, file)} 可变状态应使用类字段`);
    }
  });

  it('工作流仅位于 stream/ 目录', () => {
    const streamsDir = path.join(SYSTEM_PLUGIN_DIR, 'streams');
    if (fs.existsSync(streamsDir)) {
      const stray = fs.readdirSync(streamsDir).filter((f) => f.endsWith('.js'));
      assert.equal(stray.length, 0, `不应存在 plugins/system-plugin/streams/ 工作流: ${stray.join(', ')}`);
    }
  });
});
