import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { FileUtils } from '../../lib/utils/file-utils.js';
import {
  appendWorkspaceMemory,
  containsLikelySecret,
  isAllowedMemoryRel,
  readWorkspaceMemory,
  searchWorkspaceMemory,
  writeWorkspaceMemory
} from '../../lib/utils/agent-workspace-memory.js';
import {
  resolveWorkspaceAbsFromContext,
  resolveWorkspaceIdFromContext
} from '../../lib/utils/agent-workspace-paths.js';
import { DEFAULT_WORKSPACE_ID } from '../../lib/utils/agent-workspace-paths.js';

describe('agent-workspace-resolve', () => {
  it('默认上下文解析为 default', () => {
    assert.equal(resolveWorkspaceIdFromContext({}), DEFAULT_WORKSPACE_ID);
    assert.equal(resolveWorkspaceIdFromContext({ e: { group_id: 123 } }), DEFAULT_WORKSPACE_ID);
  });

  it('显式 workspace.id 优先', () => {
    assert.equal(
      resolveWorkspaceIdFromContext({ config: { workspace: { id: 'lab' } } }),
      'lab'
    );
  });

  it('resolveWorkspaceAbsFromContext 返回绝对路径', () => {
    const abs = resolveWorkspaceAbsFromContext({});
    assert.match(abs, /ai-workspace[\\/]default$/);
  });
});

describe('agent-workspace-memory', () => {
  const ws = path.join(os.tmpdir(), `xrk-mem-${Date.now()}`);

  it('isAllowedMemoryRel 仅允许 memory/ 下白名单路径', () => {
    assert.equal(isAllowedMemoryRel('memory/MEMORY.md'), true);
    assert.equal(isAllowedMemoryRel('memory/2026-06-16.md'), true);
    assert.equal(isAllowedMemoryRel('memory/groups/12345.md'), true);
    assert.equal(isAllowedMemoryRel('memory/../AGENTS.md'), false);
    assert.equal(isAllowedMemoryRel('AGENTS.md'), false);
  });

  it('append / read / search 基本流程', async () => {
    FileUtils.ensureDirSync(path.join(ws, 'memory'));
    await appendWorkspaceMemory(ws, '用户不喜欢吃辣', { target: 'MEMORY' });
    const { content, exists } = await readWorkspaceMemory(ws, 'MEMORY');
    assert.equal(exists, true);
    assert.match(content, /不喜欢吃辣/);
    const hits = await searchWorkspaceMemory(ws, '吃辣');
    assert.ok(hits.length >= 1);
  });

  it('拒绝疑似密钥', () => {
    assert.equal(containsLikelySecret('api_key=sk-abcdef123456789012345678'), true);
    assert.equal(containsLikelySecret('喜欢喝咖啡'), false);
  });

  it('MEMORY.md 禁止整文件覆盖', async () => {
    await assert.rejects(
      () => writeWorkspaceMemory(ws, 'hack', { target: 'MEMORY' }),
      /append_memory/
    );
  });

  it('允许覆盖当日流水', async () => {
    const data = await writeWorkspaceMemory(ws, '# today\n', { target: 'today' });
    assert.match(data.rel, /memory\/\d{4}-\d{2}-\d{2}\.md/);
  });
});
