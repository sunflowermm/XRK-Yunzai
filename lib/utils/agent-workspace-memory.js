/**
 * Agent 工作区 memory/ 目录的受限读写（仅 Markdown，路径沙箱）。
 */
import path from 'node:path';
import { FileUtils } from './file-utils.js';
import { isPathInside, realpathSyncOrResolve } from './path-guards.js';
import { LONG_TERM_MEMORY_REL } from './agent-workspace-paths.js';

export const MEMORY_DIR_REL = 'memory';
export const MAX_MEMORY_FILE_BYTES = 512 * 1024;
export const MAX_APPEND_BYTES = 16 * 1024;

const DAILY_NAME_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const SCOPED_NAME_RE = /^(groups|users)\/[a-zA-Z0-9_-]{1,64}\.md$/;

const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{20,}\b/,
  /\b(api[_-]?key|apikey|secret|token|password|passwd)\s*[:=]\s*\S+/i,
  /\bBearer\s+[a-zA-Z0-9._-]{20,}\b/,
];

function todayRel() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${MEMORY_DIR_REL}/${y}-${m}-${day}.md`;
}

/**
 * @param {string} rel - 相对工作区根，如 memory/MEMORY.md
 */
export function isAllowedMemoryRel(rel) {
  if (!rel || typeof rel !== 'string') return false;
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized.startsWith(`${MEMORY_DIR_REL}/`)) return false;
  const base = normalized.slice(`${MEMORY_DIR_REL}/`.length);
  if (!base || base.includes('..')) return false;
  if (base === 'MEMORY.md') return true;
  if (DAILY_NAME_RE.test(base)) return true;
  if (SCOPED_NAME_RE.test(base)) return true;
  return false;
}

/**
 * @param {'MEMORY'|'today'|'group'|'user'|string} target
 * @param {{ groupId?: string|number, userId?: string|number }} [scope]
 * @returns {string}
 */
export function resolveMemoryRel(target = 'MEMORY', scope = {}) {
  const t = String(target || 'MEMORY').trim();
  if (t === 'MEMORY' || t === 'memory/MEMORY.md') return LONG_TERM_MEMORY_REL;
  if (t === 'today' || t === 'daily') return todayRel();
  if (t === 'group' && scope.groupId != null) {
    const gid = String(scope.groupId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    return `${MEMORY_DIR_REL}/groups/${gid}.md`;
  }
  if (t === 'user' && scope.userId != null) {
    const uid = String(scope.userId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    return `${MEMORY_DIR_REL}/users/${uid}.md`;
  }
  let rel = t.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel.startsWith(`${MEMORY_DIR_REL}/`)) {
    rel = `${MEMORY_DIR_REL}/${rel}`;
  }
  return rel;
}

/**
 * @param {string} workspaceRoot
 * @param {string} rel
 */
export function resolveMemoryAbs(workspaceRoot, relOrTarget) {
  const raw = String(relOrTarget || '').trim();
  let safeRel = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!safeRel.startsWith(`${MEMORY_DIR_REL}/`)) {
    safeRel = resolveMemoryRel(raw);
  }
  if (!isAllowedMemoryRel(safeRel)) {
    throw new Error(`不允许的记忆路径: ${relOrTarget}`);
  }
  const root = realpathSyncOrResolve(workspaceRoot);
  const abs = path.resolve(root, safeRel);
  const memoryRoot = path.resolve(root, MEMORY_DIR_REL);
  if (!isPathInside(root, abs) || !isPathInside(memoryRoot, abs)) {
    throw new Error('记忆路径超出工作区范围');
  }
  return { abs, rel: safeRel };
}

export function containsLikelySecret(text) {
  if (!text || typeof text !== 'string') return false;
  return SECRET_PATTERNS.some((re) => re.test(text));
}

function formatAppendBlock(content, scope = {}) {
  const ts = new Date().toISOString();
  const tags = [];
  if (scope.userId != null) tags.push(`user=${scope.userId}`);
  if (scope.groupId != null) tags.push(`group=${scope.groupId}`);
  const header = tags.length ? `\n\n## ${ts} (${tags.join(', ')})\n` : `\n\n## ${ts}\n`;
  return `${header}${String(content).trim()}\n`;
}

/**
 * @param {string} workspaceRoot
 * @param {string} target
 * @param {{ groupId?: string|number, userId?: string|number }} [scope]
 */
export async function readWorkspaceMemory(workspaceRoot, target = 'MEMORY', scope = {}) {
  const { abs, rel } = resolveMemoryAbs(workspaceRoot, resolveMemoryRel(target, scope));
  if (!FileUtils.existsSync(abs)) {
    return { rel, content: '', exists: false };
  }
  const content = (await FileUtils.readFile(abs, 'utf8')) || '';
  return { rel, content, exists: true };
}

/**
 * @param {string} workspaceRoot
 * @param {string} content
 * @param {{ target?: string, groupId?: string|number, userId?: string|number, scene?: string }} [options]
 */
export async function appendWorkspaceMemory(workspaceRoot, content, options = {}) {
  if (!content || !String(content).trim()) {
    throw new Error('记忆内容不能为空');
  }
  if (String(content).length > MAX_APPEND_BYTES) {
    throw new Error(`单次追加不得超过 ${MAX_APPEND_BYTES} 字符`);
  }
  if (containsLikelySecret(content)) {
    throw new Error('内容疑似含密钥或 token，请勿写入记忆文件');
  }

  const scope = { groupId: options.groupId, userId: options.userId };
  let target = options.target || 'MEMORY';
  if (!options.target && options.scene === 'group' && options.groupId != null) {
    target = 'group';
  }

  const { abs, rel } = resolveMemoryAbs(workspaceRoot, resolveMemoryRel(target, scope));
  FileUtils.ensureDirSync(path.dirname(abs));

  const block = formatAppendBlock(content, scope);
  let existing = '';
  if (FileUtils.existsSync(abs)) {
    existing = (await FileUtils.readFile(abs, 'utf8')) || '';
    if (existing.length + block.length > MAX_MEMORY_FILE_BYTES) {
      throw new Error(`记忆文件 ${rel} 将超过大小上限`);
    }
  }

  await FileUtils.writeFile(abs, existing + block, 'utf8');
  return { rel, appendedChars: block.length };
}

/**
 * 整文件覆盖（仅 MEMORY 或当日流水；群/用户 scoped 文件允许）。
 * @param {string} workspaceRoot
 * @param {string} content
 * @param {{ target?: string, groupId?: string|number, userId?: string|number, allowOverwrite?: boolean }} [options]
 */
export async function writeWorkspaceMemory(workspaceRoot, content, options = {}) {
  if (content == null) throw new Error('记忆内容不能为空');
  const text = String(content);
  if (text.length > MAX_MEMORY_FILE_BYTES) {
    throw new Error(`记忆文件不得超过 ${MAX_MEMORY_FILE_BYTES} 字符`);
  }
  if (containsLikelySecret(text)) {
    throw new Error('内容疑似含密钥或 token，请勿写入记忆文件');
  }

  const scope = { groupId: options.groupId, userId: options.userId };
  const target = options.target || 'MEMORY';
  const { abs, rel } = resolveMemoryAbs(workspaceRoot, resolveMemoryRel(target, scope));

  if (rel === LONG_TERM_MEMORY_REL && !options.allowOverwrite) {
    throw new Error('MEMORY.md 请用 append_memory 追加，勿整文件覆盖');
  }

  FileUtils.ensureDirSync(path.dirname(abs));
  await FileUtils.writeFile(abs, text, 'utf8');
  return { rel, bytes: text.length };
}

/**
 * @param {string} workspaceRoot
 */
export function listWorkspaceMemoryFiles(workspaceRoot) {
  const memoryDir = path.join(workspaceRoot, MEMORY_DIR_REL);
  if (!FileUtils.existsSync(memoryDir)) return [];

  /** @type {string[]} */
  const out = [];

  function walk(dir, prefix = '') {
    for (const ent of FileUtils.readDirSync(dir, { withFileTypes: true })) {
      const name = ent.name;
      const full = path.join(dir, name);
      const relPart = prefix ? `${prefix}/${name}` : name;
      const rel = `${MEMORY_DIR_REL}/${relPart}`.replace(/\\/g, '/');
      if (ent.isDirectory()) {
        walk(full, relPart);
        continue;
      }
      if (!ent.isFile() || !name.endsWith('.md')) continue;
      if (isAllowedMemoryRel(rel)) out.push(rel);
    }
  }

  walk(memoryDir);
  return out.sort();
}

/**
 * @param {string} workspaceRoot
 * @param {string} keyword
 * @param {number} [limit]
 */
export async function searchWorkspaceMemory(workspaceRoot, keyword, limit = 20) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return [];

  const files = listWorkspaceMemoryFiles(workspaceRoot);
  /** @type {Array<{ rel: string, snippet: string, score: number }>} */
  const hits = [];

  for (const rel of files) {
    const { abs } = resolveMemoryAbs(workspaceRoot, rel);
    if (!FileUtils.existsSync(abs)) continue;
    const content = (await FileUtils.readFile(abs, 'utf8')) || '';
    const lower = content.toLowerCase();
    if (!lower.includes(kw)) continue;
    const idx = lower.indexOf(kw);
    const start = Math.max(0, idx - 80);
    const end = Math.min(content.length, idx + kw.length + 120);
    const snippet = content.slice(start, end).replace(/\s+/g, ' ').trim();
    hits.push({ rel, snippet, score: (content.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
