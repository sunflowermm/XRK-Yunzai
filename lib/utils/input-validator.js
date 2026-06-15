import path from 'path';
import { isPathInside, realpathSyncOrResolve } from './path-guards.js';

/**
 * 输入验证器（对齐 XRK-AGT system-Core 免费工具安全层）
 */
export class InputValidator {
  static validatePath(filePath, baseDir = process.cwd()) {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('路径必须是字符串');
    }
    const normalized = path.normalize(filePath);
    if (normalized.includes('..') || path.isAbsolute(normalized)) {
      throw new Error(`无效的路径: ${filePath}`);
    }
    const resolved = path.resolve(baseDir, normalized);
    const baseResolved = path.resolve(baseDir);
    if (!resolved.startsWith(baseResolved)) {
      throw new Error(`路径超出允许范围: ${filePath}`);
    }
    return resolved;
  }

  static assertPathUnderRoots(filePath, allowedRoots) {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('路径必须是字符串');
    }
    const normalized = path.normalize(filePath);
    if (!path.isAbsolute(normalized)) {
      throw new Error('只支持绝对路径');
    }
    const resolved = realpathSyncOrResolve(normalized);
    const roots = (allowedRoots || []).map((r) => realpathSyncOrResolve(r));
    const allowed = roots.some((base) => isPathInside(base, resolved));
    if (!allowed) {
      throw new Error('访问被拒绝：路径不在允许的数据目录内');
    }
    return resolved;
  }

  static validateCommand(command) {
    if (!command || typeof command !== 'string') {
      throw new Error('命令必须是字符串');
    }
    const dangerousPatterns = [
      /rm\s+-rf/i,
      /format\s+/i,
      /del\s+\/f/i,
      /rmdir\s+\/s/i,
      /mkfs/i,
      /dd\s+if=/i,
      />\s*\/dev/i,
      /\|\s*sh\s*$/i,
      /\|\s*bash\s*$/i
    ];
    for (const pattern of dangerousPatterns) {
      if (pattern.test(command)) {
        throw new Error(`禁止执行危险命令: ${command}`);
      }
    }
    return command.trim();
  }
}
