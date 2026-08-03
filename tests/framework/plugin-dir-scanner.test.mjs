import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PluginDirScanner } from '../../lib/utils/plugin-dir-scanner.js';
import { resolveProjectPath, PLUGINS_DIR } from '../../lib/config/config-constants.js';

describe('PluginDirScanner.listWorkflowDirs', () => {
  const pluginsRoot = resolveProjectPath(PLUGINS_DIR);

  it('仅返回 plugins/<名>/workflow（不扫 stream/streams）', () => {
    const dirs = PluginDirScanner.listWorkflowDirs(pluginsRoot);
    assert.ok(dirs.length > 0);
    for (const dir of dirs) {
      assert.ok(dir.endsWith(`${path.sep}workflow`), `非法工作流目录: ${dir}`);
      assert.ok(!dir.includes(`${path.sep}streams`), `不得扫描 streams/: ${dir}`);
      assert.ok(!dir.endsWith(`${path.sep}stream`), `不得扫描 stream/: ${dir}`);
    }
  });
});
