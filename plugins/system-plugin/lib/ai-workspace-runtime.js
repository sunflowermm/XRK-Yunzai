import path from 'node:path';
import { FileUtils } from '../../../lib/utils/file-utils.js';
import { isPathInside, realpathSyncOrResolve } from '../../../lib/utils/path-guards.js';
import { expandHomePath } from '../../../lib/utils/workspace-run-command.js';
import { readTextFileUnderWorkspaceRoot } from '../../../lib/utils/safe-workspace-read.js';
import { BaseTools } from '../../../lib/utils/base-tools.js';
import {
  AGENTS_MD,
  DEFAULT_WORKSPACE_ID,
  getAgentWorkspaceAbs,
  getAgentWorkspacesRoot,
  getConfiguredDefaultWorkspaceId,
  getProjectRoot,
  normalizeWorkspaceId,
  ensureAgentWorkspaceSync,
  seedWorkspaceFromBundle
} from '../../../lib/utils/agent-workspace-paths.js'

export { getConfiguredDefaultWorkspaceId }

const BUILTIN_PROJECT = {
  id: 'project',
  label: '项目根目录',
  description: 'Bot 项目根，含代码与 data',
  kind: 'project'
};

function resolvePathInput(raw, projectRoot) {
  if (raw == null || String(raw).trim() === '') return projectRoot;
  const w = expandHomePath(String(raw).trim());
  if (path.isAbsolute(w)) return path.normalize(w);
  return path.resolve(projectRoot, w);
}

export function normalizePresetId(presetId) {
  const id = String(presetId || DEFAULT_WORKSPACE_ID).trim() || DEFAULT_WORKSPACE_ID;
  if (id === 'project') return 'project';
  return normalizeWorkspaceId(id);
}

export function listAgentWorkspaceIds() {
  ensureAgentWorkspaceSync(DEFAULT_WORKSPACE_ID);
  const root = getAgentWorkspacesRoot();
  try {
    const entries = FileUtils.readDirSync(root, { withFileTypes: true });
    const ids = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => {
        if (a === DEFAULT_WORKSPACE_ID) return -1;
        if (b === DEFAULT_WORKSPACE_ID) return 1;
        return a.localeCompare(b, 'zh-CN');
      });
    return ids.length ? ids : [DEFAULT_WORKSPACE_ID];
  } catch (err) {
    Bot.makeLog?.('debug', `listAgentWorkspaceIds: ${err?.message || err}`, 'AIWorkspace');
    return [DEFAULT_WORKSPACE_ID];
  }
}

export function createAgentWorkspace(id) {
  const safeId = normalizePresetId(id);
  if (safeId === 'project') throw new Error('不能使用保留名称 project');
  const abs = ensureAgentWorkspaceSync(safeId);
  return { id: safeId, path: abs, label: safeId === DEFAULT_WORKSPACE_ID ? '默认工作区' : safeId };
}

export function resolveWorkspacePreset(presetId = DEFAULT_WORKSPACE_ID) {
  const id = normalizePresetId(presetId);
  if (id === 'project') return BUILTIN_PROJECT;
  return {
    id,
    label: id === DEFAULT_WORKSPACE_ID ? '默认工作区' : id,
    description: `data/ai-workspace/${id}`,
    kind: 'agent'
  };
}

export function resolveConfiguredWorkspace(raw) {
  if (raw == null || String(raw).trim() === '') {
    return ensureAgentWorkspaceSync(getConfiguredDefaultWorkspaceId());
  }
  let w = String(raw).trim();
  if (w.startsWith('agent:')) {
    const id = normalizePresetId(w.slice(6));
    if (id === 'project') return getProjectRoot();
    return ensureAgentWorkspaceSync(id);
  }
  if (w === 'project') return getProjectRoot();
  return resolvePathInput(w, getProjectRoot());
}

export function listWorkspacePresets() {
  const agentIds = listAgentWorkspaceIds();
  const agentPresets = agentIds.map((id) => ({
    id,
    label: id === DEFAULT_WORKSPACE_ID ? '默认工作区' : id,
    description: `data/ai-workspace/${id}`,
    kind: 'agent'
  }));
  return [...agentPresets, { ...BUILTIN_PROJECT }];
}

export function resolvePresetOrThrow(presetId) {
  const id = normalizePresetId(presetId);
  if (id === 'project') return { ...BUILTIN_PROJECT };
  ensureAgentWorkspaceSync(id);
  return resolveWorkspacePreset(id);
}

function presetFileContext(presetId) {
  resolvePresetOrThrow(presetId);
  return parseRequestWorkspace({ workspace: { id: presetId } });
}

export async function listPresetFiles(presetId, { subdir = '', limit = 120 } = {}) {
  const ctx = presetFileContext(presetId);
  try {
    const result = listWorkspaceFiles(ctx.fileRootAbs, subdir);
    const cap = Math.min(200, Math.max(1, Number(limit) || 120));
    if (result.files.length > cap) result.files = result.files.slice(0, cap);
    return result;
  } catch (err) {
    return {
      root: ctx.fileRootAbs,
      dir: String(subdir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
      files: [],
      error: err?.message || '无法读取目录'
    };
  }
}

export async function readPresetAgents(presetId) {
  const ctx = presetFileContext(presetId);
  return readWorkspaceAgents(ctx.agentRootAbs);
}

export async function writePresetAgents(presetId, content) {
  const ctx = presetFileContext(presetId);
  return writeWorkspaceAgents(ctx.agentRootAbs, content);
}

export async function resolvePresetDownload(presetId, filePath) {
  const ctx = presetFileContext(presetId);
  const { abs, name } = openWorkspaceFileDownload(ctx.fileRootAbs, filePath);
  return { abs, basename: name };
}

export function parseRequestWorkspace(body = {}) {
  const ws = body?.workspace && typeof body.workspace === 'object' ? body.workspace : {};
  const presetId = normalizePresetId(ws.id || ws.preset || getConfiguredDefaultWorkspaceId());
  const projectRoot = getProjectRoot();

  if (presetId === 'project') {
    const fileRootAbs = ws.fileRoot
      ? resolvePathInput(ws.fileRoot, projectRoot)
      : projectRoot;
    const agentRootAbs = ws.agentRoot
      ? resolvePathInput(ws.agentRoot, projectRoot)
      : ensureAgentWorkspaceSync(getConfiguredDefaultWorkspaceId());
    return {
      presetId,
      preset: BUILTIN_PROJECT,
      projectRoot,
      agentRootAbs,
      fileRootAbs
    };
  }

  const fileRootAbs = ensureAgentWorkspaceSync(presetId);
  return {
    presetId,
    preset: resolveWorkspacePreset(presetId),
    projectRoot,
    agentRootAbs: fileRootAbs,
    fileRootAbs
  };
}

export function buildAiWorkflowCfgForAgentRoot(aiWorkflowCfg = {}, agentRootAbs) {
  if (!agentRootAbs) return aiWorkflowCfg || {};
  const projectRoot = getProjectRoot();
  let rel = '';
  try {
    rel = path.relative(projectRoot, agentRootAbs);
    if (rel.startsWith('..')) rel = agentRootAbs;
  } catch {
    rel = agentRootAbs;
  }
  return {
    ...aiWorkflowCfg,
    agentWorkspace: {
      ...(aiWorkflowCfg?.agentWorkspace || {}),
      root: rel
    }
  };
}

export function applyRequestWorkspaceToWorkflows(AiWorkflowLoader, fileWorkspaceAbs) {
  if (!fileWorkspaceAbs || !AiWorkflowLoader?.getWorkflow) return () => {};

  const snapshots = [];
  for (const name of ['tools', 'desktop', 'memory']) {
    const stream = AiWorkflowLoader.getWorkflow(name);
    if (!stream) continue;
    snapshots.push({
      stream,
      workspace: stream.workspace,
      tools: stream.tools
    });
    stream.workspace = fileWorkspaceAbs;
    if (stream.tools instanceof BaseTools) {
      stream.tools = new BaseTools(fileWorkspaceAbs);
    }
  }

  return () => {
    for (const snap of snapshots) {
      snap.stream.workspace = snap.workspace;
      snap.stream.tools = snap.tools;
    }
  };
}

function resolveDirUnderRoot(rootAbs, dirRel = '') {
  const rootReal = realpathSyncOrResolve(rootAbs);
  const target = path.resolve(rootReal, String(dirRel || '').replace(/\\/g, '/'));
  const targetReal = realpathSyncOrResolve(target);
  if (!isPathInside(rootReal, targetReal)) {
    throw new Error('目录超出工作区范围');
  }
  return targetReal;
}

export function listWorkspaceFiles(fileRootAbs, dirRel = '') {
  const dirAbs = resolveDirUnderRoot(fileRootAbs, dirRel);
  let entries;
  try {
    entries = FileUtils.readDirSync(dirAbs, { withFileTypes: true });
  } catch (err) {
    throw new Error(err?.message || '无法读取目录');
  }

  const relBase = String(dirRel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const files = entries
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const relPath = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) {
        return { name: e.name, path: relPath, type: 'dir' };
      }
      if (e.isFile()) {
        const size = FileUtils.statSync(path.join(dirAbs, e.name))?.size ?? 0;
        return { name: e.name, path: relPath, type: 'file', size };
      }
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });

  return { root: fileRootAbs, dir: relBase, files };
}

function resolveFileUnderRoot(fileRootAbs, relPath = '') {
  const rootReal = realpathSyncOrResolve(fileRootAbs);
  const abs = path.resolve(rootReal, String(relPath || '').replace(/\\/g, '/'));
  const fileReal = realpathSyncOrResolve(abs);
  if (!isPathInside(rootReal, fileReal)) {
    throw new Error('文件路径超出工作区范围');
  }
  return fileReal;
}

export function readWorkspaceAgents(agentRootAbs) {
  seedWorkspaceFromBundle(agentRootAbs);
  const abs = path.join(agentRootAbs, AGENTS_MD);
  const result = readTextFileUnderWorkspaceRoot(agentRootAbs, abs);
  if (result.ok) {
    return { path: AGENTS_MD, content: result.content };
  }
  return { path: AGENTS_MD, content: '' };
}

export function writeWorkspaceAgents(agentRootAbs, content = '') {
  const rel = AGENTS_MD;
  const abs = path.join(agentRootAbs, rel);
  const rootReal = realpathSyncOrResolve(agentRootAbs);
  const dir = path.dirname(abs);
  if (!isPathInside(rootReal, realpathSyncOrResolve(dir))) {
    throw new Error('无法写入工作区外路径');
  }
  FileUtils.ensureDirSync(dir);
  FileUtils.writeFileSync(abs, String(content ?? ''), 'utf8');
  return { path: rel };
}

export function openWorkspaceFileDownload(fileRootAbs, relPath) {
  const fileReal = resolveFileUnderRoot(fileRootAbs, relPath);
  const st = FileUtils.statSync(fileReal);
  if (!st?.isFile()) throw new Error('不是文件');
  return { abs: fileReal, name: path.basename(fileReal) };
}

export function sanitizeWorkspaceUploadName(name) {
  const base = path.basename(String(name || 'file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'));
  return base.slice(0, 200) || 'file';
}
