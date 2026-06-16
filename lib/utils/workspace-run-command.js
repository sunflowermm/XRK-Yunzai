import path from 'path';
import os from 'os';
import { isPathInside, realpathSyncOrResolve } from './path-guards.js';

/** 展开 `~` / `~/foo` 为绝对路径；非 tilde 路径原样返回 */
export function expandHomePath(input) {
  const s = String(input ?? '').trim();
  if (!s) return s;
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) {
    return path.normalize(path.join(os.homedir(), s.slice(2)));
  }
  return s;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveUnderWorkspace(rawPath, workspaceRoot) {
  const expanded = expandHomePath(rawPath);
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.normalize(path.join(workspaceRoot, expanded));
}

function toWorkspaceRelativeIfInside(absPath, workspaceRoot) {
  try {
    const root = realpathSyncOrResolve(workspaceRoot);
    const target = realpathSyncOrResolve(absPath);
    if (!isPathInside(root, target)) return null;
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith('..')) return null;
    return rel.split(path.sep).join('/');
  } catch {
    const root = path.resolve(workspaceRoot);
    const target = path.resolve(absPath);
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith('..')) return null;
    return rel.split(path.sep).join('/');
  }
}

function extractWorkspaceRelativeFromTildePath(rawPath, workspaceRoot) {
  const wsBase = path.basename(path.resolve(workspaceRoot));
  const posix = String(rawPath).replace(/\\/g, '/');
  const needle = `/ai-workspace/${wsBase}/`;
  const idx = posix.indexOf(needle);
  if (idx >= 0) return posix.slice(idx + needle.length);
  return null;
}

function rewriteQuotedPath(inner, workspaceRoot) {
  const trimmed = String(inner ?? '').trim();
  if (!trimmed) return inner;

  if (trimmed.startsWith('~')) {
    const fromTilde = extractWorkspaceRelativeFromTildePath(trimmed, workspaceRoot);
    if (fromTilde) return fromTilde;
  }

  const needsRewrite =
    trimmed.startsWith('~') ||
    trimmed.includes('ai-workspace') ||
    path.isAbsolute(trimmed);
  if (!needsRewrite) return inner;

  const abs = resolveUnderWorkspace(trimmed, workspaceRoot);
  const rel = toWorkspaceRelativeIfInside(abs, workspaceRoot);
  return rel != null ? rel : inner;
}

/**
 * 规范化 tools.run 命令：去掉多余 cd、把引号内 ~/ 或工作区绝对路径改为相对路径。
 * exec 的 cwd 应设为 workspace，勿再包一层 cd。
 */
export function normalizeToolsRunCommand(command, workspaceRoot) {
  let cmd = String(command ?? '').trim();
  if (!cmd) return cmd;

  const ws = path.resolve(workspaceRoot);
  const wsPosix = ws.replace(/\\/g, '/');

  const cdPrefixPatterns = [
    new RegExp(`^cd\\s+['"]?${escapeRegex(wsPosix)}['"]?\\s*&&\\s*`, 'i'),
    new RegExp(`^cd\\s+['"]?${escapeRegex(ws)}['"]?\\s*&&\\s*`, 'i'),
    /^cd\s+['"]?[^'"]*ai-workspace[^'"]*['"]?\s*&&\s*/i
  ];
  for (const re of cdPrefixPatterns) {
    cmd = cmd.replace(re, '');
  }

  cmd = cmd.replace(/(['"])([^'"]*)\1/g, (full, quote, inner) => {
    const rewritten = rewriteQuotedPath(inner, ws);
    return rewritten === inner ? full : `${quote}${rewritten}${quote}`;
  });

  cmd = cmd.replace(/(^|\s)(~\/[^\s;&|]+)/g, (match, prefix, segment) => {
    const fromTilde = extractWorkspaceRelativeFromTildePath(segment, ws);
    if (fromTilde) return `${prefix}${fromTilde}`;
    const rel = toWorkspaceRelativeIfInside(resolveUnderWorkspace(segment, ws), ws);
    return rel != null ? `${prefix}${rel}` : match;
  });

  return cmd.trim();
}
