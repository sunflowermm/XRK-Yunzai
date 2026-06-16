/**
 * Agent 工作区路径约定（对齐 XRK-AGT system-Core）。
 */
import path from 'node:path';
import { FileUtils } from './file-utils.js';
import { getAistreamConfigOptional } from './aistream-config.js';
import { isPathInside, realpathSyncOrResolve } from './path-guards.js';
import { DATA_AI_WORKSPACE_DIR, resolveProjectPath } from '../config/config-constants.js';

export const AGENTS_MD = 'AGENTS.md';

export const WORKSPACE_TEMPLATE_RELS = [
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'ENV.md',
  'HEARTBEAT.md',
];

export const LONG_TERM_MEMORY_REL = 'memory/MEMORY.md';
export const WORKSPACE_BUNDLE_DIR_REL = 'agents/workspace';
export const PROJECT_SKILLS_STANDARD_REL = 'skills/standard';
export const WORKSPACE_SKILLS_DIR = 'skills';
export const DEFAULT_WORKSPACE_ID = 'default';

function copyTreeMissingOnly(srcDir, destDir) {
  if (!FileUtils.existsSync(srcDir)) return;
  FileUtils.ensureDirSync(destDir);
  for (const entry of FileUtils.readDirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyTreeMissingOnly(src, dest);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!FileUtils.existsSync(dest)) {
      FileUtils.copyFileSync(src, dest);
    }
  }
}

export function getProjectRoot() {
  return resolveProjectPath();
}

export function normalizeWorkspaceId(raw) {
  const id = String(raw || DEFAULT_WORKSPACE_ID).trim() || DEFAULT_WORKSPACE_ID;
  return id.replace(/[^\w.\u4e00-\u9fa5-]/g, '_').slice(0, 64) || DEFAULT_WORKSPACE_ID;
}

export function getConfiguredDefaultWorkspaceId() {
  const cfg = getAistreamConfigOptional();
  const raw = cfg?.workspace?.defaultId;
  if (raw != null && String(raw).trim() !== '') {
    return normalizeWorkspaceId(raw);
  }
  return DEFAULT_WORKSPACE_ID;
}

export function getAgentWorkspacesRoot() {
  return resolveProjectPath(DATA_AI_WORKSPACE_DIR);
}

export function getAgentWorkspaceAbs(id = DEFAULT_WORKSPACE_ID) {
  return path.join(getAgentWorkspacesRoot(), normalizeWorkspaceId(id));
}

export function isAgentDataWorkspaceAbs(absPath) {
  if (!absPath) return false;
  try {
    const wsRoot = realpathSyncOrResolve(getAgentWorkspacesRoot());
    return isPathInside(wsRoot, realpathSyncOrResolve(absPath));
  } catch {
    return false;
  }
}

export function seedWorkspaceFromBundle(workspaceAbs) {
  if (!isAgentDataWorkspaceAbs(workspaceAbs)) return;
  FileUtils.ensureDirSync(workspaceAbs);
  FileUtils.ensureDirSync(path.join(workspaceAbs, 'memory'));
  for (const sub of ['docs', 'downloads', 'output', 'tmp']) {
    FileUtils.ensureDirSync(path.join(workspaceAbs, sub));
  }

  const bundleDir = path.join(getProjectRoot(), WORKSPACE_BUNDLE_DIR_REL);
  const seedNames = [AGENTS_MD, ...WORKSPACE_TEMPLATE_RELS];

  for (const name of seedNames) {
    const dest = path.join(workspaceAbs, name);
    if (FileUtils.existsSync(dest)) continue;
    const src = path.join(bundleDir, name);
    if (FileUtils.existsSync(src)) {
      FileUtils.copyFileSync(src, dest);
    }
  }

  const bundleMemory = path.join(bundleDir, LONG_TERM_MEMORY_REL);
  const wsMemory = path.join(workspaceAbs, LONG_TERM_MEMORY_REL);
  if (!FileUtils.existsSync(wsMemory) && FileUtils.existsSync(bundleMemory)) {
    FileUtils.copyFileSync(bundleMemory, wsMemory);
  }

  const standardSkills = path.join(getProjectRoot(), PROJECT_SKILLS_STANDARD_REL);
  copyTreeMissingOnly(standardSkills, path.join(workspaceAbs, WORKSPACE_SKILLS_DIR));

  if (!FileUtils.existsSync(path.join(workspaceAbs, AGENTS_MD))) {
    const label = path.basename(workspaceAbs) === DEFAULT_WORKSPACE_ID ? '默认工作区' : path.basename(workspaceAbs);
    FileUtils.writeFileSync(
      path.join(workspaceAbs, AGENTS_MD),
      `# ${label}\n\n在此编写 Agent 规则（AGENTS.md）。\n`,
      'utf8'
    );
  }
}

export function resolveAgentWorkspaceAbs(cfgRoot = '') {
  if (cfgRoot != null && String(cfgRoot).trim() !== '') {
    const raw = String(cfgRoot).trim();
    const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(getProjectRoot(), raw);
    FileUtils.ensureDirSync(abs);
    return abs;
  }
  const abs = getAgentWorkspaceAbs(getConfiguredDefaultWorkspaceId());
  seedWorkspaceFromBundle(abs);
  return abs;
}

export function ensureAgentWorkspaceSync(id = DEFAULT_WORKSPACE_ID) {
  const abs = getAgentWorkspaceAbs(normalizeWorkspaceId(id));
  seedWorkspaceFromBundle(abs);
  return abs;
}

/** @param {object} [context] */
export function resolveWorkspaceIdFromContext(context = {}) {
  const wsObj = context?.config?.workspace;
  if (wsObj && typeof wsObj === 'object' && wsObj.id != null && String(wsObj.id).trim()) {
    return normalizeWorkspaceId(wsObj.id);
  }
  if (context?.workspaceId != null && String(context.workspaceId).trim()) {
    return normalizeWorkspaceId(context.workspaceId);
  }
  const e = context?.e;
  const map = context?.config?.workspaceMappings;
  if (map && typeof map === 'object' && e) {
    if (e.group_id != null && map.groups?.[String(e.group_id)]) {
      return normalizeWorkspaceId(map.groups[String(e.group_id)]);
    }
    if (e.user_id != null && map.users?.[String(e.user_id)]) {
      return normalizeWorkspaceId(map.users[String(e.user_id)]);
    }
  }
  return getConfiguredDefaultWorkspaceId();
}

/** @param {object} [context] */
export function resolveWorkspaceAbsFromContext(context = {}) {
  const agentRoot = context?.config?.agentWorkspace?.root;
  if (agentRoot != null && String(agentRoot).trim()) {
    return resolveAgentWorkspaceAbs(String(agentRoot).trim());
  }
  return ensureAgentWorkspaceSync(resolveWorkspaceIdFromContext(context));
}
