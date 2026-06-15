/**
 * 路径包含判断 + realpath 回退（对齐 XRK-AGT system-Core）
 */
import path from 'path';
import { FileUtils } from './file-utils.js';

/**
 * @param {string} p
 * @returns {string}
 */
export function realpathSyncOrResolve(p) {
  return FileUtils.realpathSync(p) ?? path.resolve(p);
}

function normalizeWindowsPathForComparison(input) {
  let normalized = path.win32.normalize(input);
  if (normalized.startsWith('\\\\?\\')) {
    normalized = normalized.slice(4);
    if (normalized.toUpperCase().startsWith('UNC\\')) {
      normalized = `\\\\${normalized.slice(4)}`;
    }
  }
  return normalized.replaceAll('/', '\\').toLowerCase();
}

/**
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isPathInside(root, target) {
  if (process.platform === 'win32') {
    const rootForCompare = normalizeWindowsPathForComparison(path.win32.resolve(root));
    const targetForCompare = normalizeWindowsPathForComparison(path.win32.resolve(target));
    const relative = path.win32.relative(rootForCompare, targetForCompare);
    return relative === '' || (!relative.startsWith('..') && !path.win32.isAbsolute(relative));
  }
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
