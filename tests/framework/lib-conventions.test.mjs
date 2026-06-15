import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const libRoot = path.join(root, 'lib');

function walkJsFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkJsFiles(full, out);
    else if (ent.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const libFiles = walkJsFiles(libRoot);

describe('lib 底层约定', () => {
  it('无 ASR/TTS / createDeviceClient 残留', () => {
    const bad = /getASRConfig|getTTSConfig|ASRFactory|TTSFactory|createDeviceClient/;
    for (const file of libFiles) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!bad.test(text), `${path.relative(root, file)} 含已移除 API`);
    }
  });

  it('直接 import fs 仅限 file-utils.js', () => {
    const allow = path.join(libRoot, 'utils', 'file-utils.js');
    for (const file of libFiles) {
      const text = fs.readFileSync(file, 'utf8');
      const hits = text.match(/from ['"]node:fs['"]|from ['"]fs['"]/g);
      if (!hits) continue;
      assert.equal(
        path.normalize(file),
        path.normalize(allow),
        `${path.relative(root, file)} 不应直接 import fs`
      );
    }
  });

  it('FileUtils 提供 createReadStream 与 realpathSync', () => {
    const text = fs.readFileSync(path.join(libRoot, 'utils', 'file-utils.js'), 'utf8');
    assert.match(text, /static createReadStream\(/);
    assert.match(text, /static realpathSync\(/);
  });

  it('bot.js 经 FileUtils 读流，不直接 import node:fs', () => {
    const text = fs.readFileSync(path.join(libRoot, 'bot.js'), 'utf8');
    assert.ok(!/from ['"]node:fs['"]/.test(text));
    assert.match(text, /FileUtils\.createReadStream/);
    assert.match(text, /_shutdownLoaders/);
  });

  it('Runtime._mysInfo 为类字段', () => {
    const text = fs.readFileSync(path.join(libRoot, 'plugins', 'runtime.js'), 'utf8');
    assert.match(text, /_mysInfo\s*=\s*\{\}/);
    assert.ok(!/constructor\([^)]*\)[\s\S]{0,120}this\._mysInfo/.test(text));
  });

  it('StreamLoader.cleanupAll 停止监视', () => {
    const text = fs.readFileSync(path.join(libRoot, 'aistream', 'loader.js'), 'utf8');
    const block = text.slice(text.indexOf('async cleanupAll'), text.indexOf('async cleanupAll') + 400);
    assert.match(block, /await this\.watch\(false\)/);
  });

  it('cfg.setConfig 未设端口时拒绝写入', () => {
    const text = fs.readFileSync(path.join(libRoot, 'config', 'config.js'), 'utf8');
    assert.match(text, /if \(port == null\)/);
    assert.match(text, /禁止写入默认模板/);
  });

  it('HotReloadBase 无 lodash 依赖，提供统一关闭与 debounce 常量', () => {
    const text = fs.readFileSync(path.join(libRoot, 'utils', 'hot-reload-base.js'), 'utf8');
    assert.ok(!/from ['"]lodash['"]/.test(text));
    assert.match(text, /static WATCH_DEBOUNCE_MS = 300/);
    assert.match(text, /static async closeWatcher\(/);
    assert.match(text, /static async closeWatchers\(/);
  });

  it('ListenerLoader 使用 ObjectUtils.isArray，不 import lodash', () => {
    const text = fs.readFileSync(path.join(libRoot, 'listener', 'loader.js'), 'utf8');
    assert.ok(!/from ['"]lodash['"]/.test(text));
    assert.match(text, /ObjectUtils\.isArray/);
  });

  it('模块 Loader watch(false) 经 HotReloadBase.closeWatcher(s)', () => {
    const loaders = [
      'http/loader.js',
      'listener/loader.js',
      'commonconfig/loader.js',
      'aistream/loader.js',
    ];
    for (const rel of loaders) {
      const text = fs.readFileSync(path.join(libRoot, rel), 'utf8');
      assert.match(text, /HotReloadBase\.closeWatchers?/);
    }
  });

  it('模块 Loader 热重载 debounce 使用 WATCH_DEBOUNCE_MS', () => {
    const loaders = [
      'http/loader.js',
      'listener/loader.js',
      'commonconfig/loader.js',
      'aistream/loader.js',
    ];
    for (const rel of loaders) {
      const text = fs.readFileSync(path.join(libRoot, rel), 'utf8');
      assert.match(text, /HotReloadBase\.WATCH_DEBOUNCE_MS/);
      assert.ok(!/debounceMs:\s*300/.test(text), `${rel} 应使用 WATCH_DEBOUNCE_MS 常量`);
    }
  });

  it('lib 业务代码不使用 global.Bot/cfg/segment 前缀', () => {
    const allow = new Set([
      path.normalize(path.join(libRoot, 'util.js')),
    ]);
    const bad = /global\.(Bot|cfg|segment|ConfigManager)\b/;
    for (const file of libFiles) {
      if (allow.has(path.normalize(file))) continue;
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!bad.test(text), `${path.relative(root, file)} 应使用裸名 Bot/cfg/segment 或 import cfg`);
    }
  });

  it('lib 业务日志统一 Bot.makeLog（实现层 util/log 除外）', () => {
    const allowLogger = new Set([
      path.normalize(path.join(libRoot, 'config', 'log.js')),
      path.normalize(path.join(libRoot, 'util.js')),
    ]);
    const badBotUtilMakeLog = /BotUtil\.makeLog/;
    const badLoggerLevel = /logger\.(trace|debug|info|warn|error|fatal|mark|success)\(/;

    for (const file of libFiles) {
      const norm = path.normalize(file);
      if (allowLogger.has(norm)) continue;
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!badBotUtilMakeLog.test(text), `${path.relative(root, file)} 应使用 Bot.makeLog`);
      assert.ok(!badLoggerLevel.test(text), `${path.relative(root, file)} 应使用 Bot.makeLog 替代 logger.*`);
    }
  });
});
