import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'node:url';
import { isPathInside, realpathSyncOrResolve } from '../../lib/utils/path-guards.js';
import { InputValidator } from '../../lib/utils/input-validator.js';
import { formatBytes, formatDuration } from '../../lib/utils/byte-size.js';
import { getDefaultDesktopDirSync } from '../../lib/utils/user-dirs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('lib 工具模块（对齐 AGT system-Core）', () => {
  it('path-guards isPathInside 阻止目录穿越', () => {
    const base = path.join(os.tmpdir(), 'xrk-guard-test');
    const inside = path.join(base, 'a.txt');
    const outside = path.join(path.dirname(base), 'escape.txt');
    assert.equal(isPathInside(base, inside), true);
    assert.equal(isPathInside(base, outside), false);
  });

  it('realpathSyncOrResolve 回退 resolve', () => {
    const p = path.join(root, 'package.json');
    assert.equal(typeof realpathSyncOrResolve(p), 'string');
  });

  it('InputValidator.validateCommand 拦截危险命令', () => {
    assert.throws(() => InputValidator.validateCommand('rm -rf /'), /禁止执行危险命令/);
    assert.equal(InputValidator.validateCommand('echo ok'), 'echo ok');
  });

  it('formatBytes / formatDuration', () => {
    assert.match(formatBytes(1024), /KB/);
    assert.match(formatDuration(3661), /分钟/);
  });

  it('getDefaultDesktopDirSync 返回绝对路径', () => {
    const desktop = getDefaultDesktopDirSync();
    assert.ok(path.isAbsolute(desktop));
  });
});
