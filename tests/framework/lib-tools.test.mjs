import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'node:url';
import { isPathInside, realpathSyncOrResolve } from '../../lib/utils/path-guards.js';
import { InputValidator } from '../../lib/utils/input-validator.js';
import { formatBytes, formatDuration } from '../../lib/utils/byte-size.js';
import { getDefaultDesktopDirSync } from '../../lib/utils/user-dirs.js';
import { normalizeToolsRunCommand } from '../../lib/utils/workspace-run-command.js';

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

  it('normalizeToolsRunCommand 去掉多余 cd 并改写 ~/ 路径', () => {
    const ws = path.join(root, 'data/ai-workspace/default');
    const homeDoc = path.join(os.homedir(), 'XRK-Yunzai/data/ai-workspace/default/docs/长征实践报告.py');
    const raw = `cd ${ws} && python3 "${homeDoc.replace(os.homedir(), '~')}"`;
    const normalized = normalizeToolsRunCommand(raw, ws);
    assert.equal(normalized, 'python3 "docs/长征实践报告.py"');
  });

  it('normalizeToolsRunCommand 引号内绝对工作区路径改相对', () => {
    const ws = path.join(root, 'data/ai-workspace/default');
    const raw = `python3 "${path.join(ws, 'docs/foo.py')}"`;
    const normalized = normalizeToolsRunCommand(raw, ws);
    assert.equal(normalized, 'python3 "docs/foo.py"');
  });

});
