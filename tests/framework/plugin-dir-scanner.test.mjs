import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PluginDirScanner } from '../../lib/utils/plugin-dir-scanner.js';
import { resolveProjectPath, PLUGINS_DIR } from '../../lib/config/config-constants.js';

describe('PluginDirScanner.listStreamDirs', () => {
  const pluginsRoot = resolveProjectPath(PLUGINS_DIR);

  it('仅返回 plugins/<名>/stream 目录', () => {
    const dirs = PluginDirScanner.listStreamDirs(pluginsRoot);
    assert.ok(dirs.length > 0);
    for (const dir of dirs) {
      assert.ok(dir.endsWith(`${path.sep}stream`), `非法工作流目录: ${dir}`);
      assert.ok(!dir.includes(`${path.sep}streams`), `不得扫描 streams/: ${dir}`);
    }
  });

  it('与 scanSubdirs("stream") 路径一致', () => {
    const fromList = PluginDirScanner.listStreamDirs(pluginsRoot).sort();
    const fromScan = PluginDirScanner.listSubdirPaths('stream', pluginsRoot).sort();
    assert.deepEqual(fromList, fromScan);
  });
});
