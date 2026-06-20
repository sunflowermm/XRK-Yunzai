import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

/**
 * 统一的文件操作工具类
 * 提供文件存在性检查、目录创建、文件读写等常用操作
 */
export class FileUtils {
  /**
   * 是否像本地文件路径（排除二进制误填进 file 段、过长字符串等）
   * @param {unknown} filePath
   * @returns {boolean}
   */
  static isPathLike(filePath) {
    if (filePath == null || typeof filePath !== 'string') return false;
    const s = filePath.trim();
    if (!s || s.length > 4096) return false;
    const head = s.slice(0, 12);
    if (
      head.startsWith('GIF8')
      || head.startsWith('\x89PNG')
      || head.startsWith('RIFF')
      || head.startsWith('\xFF\xD8\xFF')
      || head.startsWith('PK\u0003')
    ) return false;
    for (let i = 0; i < Math.min(s.length, 256); i++) {
      const c = s.charCodeAt(i);
      if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13)) return false;
    }
    if (/^file:\/\//i.test(s)) return true;
    if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
    if (s.startsWith('/') || s.startsWith('./') || s.startsWith('../')) return true;
    if (s.includes('/') || s.includes('\\')) return true;
    if (/^[\w{}.+-]+\.(jpg|jpeg|png|gif|webp|bmp|mp4|amr|silk|ogg|bin)$/i.test(s)) return true;
    return false;
  }

  /**
   * file 段误存为二进制串时还原 Buffer（NapCat 直传字节 / 历史词条）
   * @param {unknown} ref
   * @returns {Buffer|null}
   */
  static inlineBinaryFromRef(ref) {
    const s = String(ref ?? '');
    if (!s || s.length < 12 || s.startsWith('base64://') || /^https?:\/\//i.test(s.trim())) return null;
    const head = s.slice(0, 12);
    if (
      head.startsWith('GIF8')
      || head.startsWith('\x89PNG')
      || head.startsWith('RIFF')
      || head.startsWith('\xFF\xD8\xFF')
    ) {
      return Buffer.from(s, 'latin1');
    }
    return null;
  }

  /** @private 日志中截断过长或二进制路径，避免刷屏 */
  static _formatFsDebugPath(filePath) {
    const s = String(filePath ?? '');
    if (s.length <= 120) return s;
    return `${s.slice(0, 48)}…[+${s.length - 48} chars]`;
  }

  /** @private FS 失败 debug 日志（避免循环依赖 BotUtil） */
  static _logFsDebug(op, filePath, err) {
    try {
      const pathHint = FileUtils._formatFsDebugPath(filePath);
      Bot.makeLog('debug', `[FileUtils] ${op} 失败: ${pathHint} | ${err?.message || err}`, 'FileUtils');
    } catch {
      // noop
    }
  }

  /**
   * 确保目录存在（不存在则创建）
   * @param {string} dirPath - 目录路径
   * @returns {Promise<void>}
   */
  static async ensureDir(dirPath) {
    try {
      await fs.access(dirPath);
    } catch {
      await fs.mkdir(dirPath, { recursive: true });
    }
  }

  /**
   * 同步确保目录存在
   * @param {string} dirPath - 目录路径
   */
  static ensureDirSync(dirPath) {
    if (dirPath == null || (typeof dirPath !== "string" && !Buffer.isBuffer(dirPath))) return;
    if (!fsSync.existsSync(dirPath)) fsSync.mkdirSync(dirPath, { recursive: true });
  }

  /**
   * 检查文件是否存在
   * @param {string} filePath - 文件路径
   * @returns {Promise<boolean>}
   */
  static async exists(filePath) {
    if (!FileUtils.isPathLike(filePath)) return false;
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /** 同步检查路径是否存在，非法类型不调用 fs 避免 DEP0187 */
  static existsSync(filePath) {
    if (filePath == null) return false;
    if (typeof filePath !== "string" && !Buffer.isBuffer(filePath) && typeof filePath?.href !== "string") return false;
    if (typeof filePath === 'string' && !FileUtils.isPathLike(filePath)) return false;
    return fsSync.existsSync(filePath);
  }

  /**
   * 读取文件内容（自动处理错误）
   * @param {string} filePath - 文件路径
   * @param {string} encoding - 编码（默认'utf8'）
   * @returns {Promise<string|null>} 文件内容，失败返回null
   */
  static async readFile(filePath, encoding = 'utf8') {
    try {
      return await fs.readFile(filePath, encoding);
    } catch (err) {
      FileUtils._logFsDebug('readFile', filePath, err);
      return null;
    }
  }

  /**
   * 读取二进制文件
   * @param {string} filePath
   * @returns {Promise<Buffer|null>}
   */
  static async readFileBuffer(filePath) {
    try {
      return await fs.readFile(filePath);
    } catch (err) {
      FileUtils._logFsDebug('readFileBuffer', filePath, err);
      return null;
    }
  }

  /**
   * 同步读取文件内容
   * @param {string} filePath - 文件路径
   * @param {string} encoding - 编码（默认'utf8'）
   * @returns {string|null} 文件内容，失败返回null
   */
  static readFileSync(filePath, encoding = 'utf8') {
    try {
      return fsSync.readFileSync(filePath, encoding);
    } catch (err) {
      FileUtils._logFsDebug('readFileSync', filePath, err);
      return null;
    }
  }

  static readFileBufferSync(filePath) {
    try {
      return fsSync.readFileSync(filePath);
    } catch (err) {
      FileUtils._logFsDebug('readFileBufferSync', filePath, err);
      return null;
    }
  }

  /**
   * 同步获取路径 stat，失败返回 null
   * @param {string} filePath
   * @returns {import('fs').Stats|null}
   */
  static statSync(filePath) {
    if (filePath == null || typeof filePath !== 'string') return null;
    if (!FileUtils.isPathLike(filePath)) return null;
    try {
      return fsSync.statSync(filePath);
    } catch (err) {
      if (err?.code !== 'ENOENT') FileUtils._logFsDebug('statSync', filePath, err);
      return null;
    }
  }

  /**
   * 同步 realpath，失败返回 null
   * @param {string} filePath
   * @returns {string|null}
   */
  static realpathSync(filePath) {
    if (filePath == null || typeof filePath !== 'string') return null;
    try {
      return fsSync.realpathSync(filePath);
    } catch (err) {
      if (err?.code !== 'ENOENT') FileUtils._logFsDebug('realpathSync', filePath, err);
      return null;
    }
  }

  /**
   * 修改文件权限（非 Windows）
   * @param {string} filePath
   * @param {number} mode
   * @returns {Promise<boolean>}
   */
  static async chmod(filePath, mode) {
    try {
      await fs.chmod(filePath, mode);
      return true;
    } catch (err) {
      FileUtils._logFsDebug('chmod', filePath, err);
      return false;
    }
  }

  /**
   * @param {string} filePath
   * @returns {Promise<import('fs').Stats|null>}
   */
  static async stat(filePath) {
    if (!FileUtils.isPathLike(filePath)) return null;
    try {
      return await fs.stat(filePath);
    } catch (err) {
      if (err?.code !== 'ENOENT') FileUtils._logFsDebug('stat', filePath, err);
      return null;
    }
  }

  /**
   * @param {string} filePath
   * @param {import('fs').RmOptions} [options]
   * @returns {Promise<boolean>}
   */
  static async rm(filePath, options = { force: true, recursive: true }) {
    try {
      await fs.rm(filePath, options);
      return true;
    } catch (err) {
      if (err?.code === 'ENOENT') return true;
      FileUtils._logFsDebug('rm', filePath, err);
      return false;
    }
  }

  /**
   * @param {string} filePath
   * @returns {Promise<boolean>}
   */
  static async unlink(filePath) {
    try {
      await fs.unlink(filePath);
      return true;
    } catch (err) {
      FileUtils._logFsDebug('unlink', filePath, err);
      return false;
    }
  }

  /**
   * 写入文件（自动创建目录）
   * @param {string} filePath - 文件路径
   * @param {string} content - 文件内容
   * @param {string} encoding - 编码（默认'utf8'）
   * @returns {Promise<boolean>} 是否成功
   */
  static async writeFile(filePath, content, encoding = 'utf8') {
    try {
      await this.ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, content, encoding);
      return true;
    } catch (err) {
      FileUtils._logFsDebug('writeFile', filePath, err);
      return false;
    }
  }

  /**
   * 写入二进制文件
   * @param {string} filePath
   * @param {Buffer|Uint8Array} data
   * @returns {Promise<boolean>}
   */
  static async writeFileBuffer(filePath, data) {
    try {
      await this.ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, data);
      return true;
    } catch (err) {
      FileUtils._logFsDebug('writeFileBuffer', filePath, err);
      return false;
    }
  }

  /**
   * 追加写入文本文件
   * @param {string} filePath
   * @param {string} content
   * @param {string} [encoding='utf8']
   * @returns {Promise<boolean>}
   */
  static async appendFile(filePath, content, encoding = 'utf8') {
    try {
      await this.ensureDir(path.dirname(filePath));
      await fs.appendFile(filePath, content, encoding);
      return true;
    } catch (err) {
      FileUtils._logFsDebug('appendFile', filePath, err);
      return false;
    }
  }

  /**
   * 同步写入文件
   * @param {string} filePath - 文件路径
   * @param {string} content - 文件内容
   * @param {string} encoding - 编码（默认'utf8'）
   * @returns {boolean} 是否成功
   */
  static writeFileSync(filePath, content, encoding = 'utf8') {
    try {
      this.ensureDirSync(path.dirname(filePath));
      fsSync.writeFileSync(filePath, content, encoding);
      return true;
    } catch (err) {
      FileUtils._logFsDebug('writeFileSync', filePath, err);
      return false;
    }
  }

  /**
   * 复制文件
   * @param {string} source - 源文件路径
   * @param {string} target - 目标文件路径
   * @returns {Promise<boolean>} 是否成功
   */
  static async copyFile(source, target) {
    try {
      const content = await this.readFile(source);
      if (content === null) return false;
      return await this.writeFile(target, content);
    } catch (err) {
      FileUtils._logFsDebug('copyFile', `${source} -> ${target}`, err);
      return false;
    }
  }

  /**
   * 同步复制文件
   * @param {string} source - 源文件路径
   * @param {string} target - 目标文件路径
   * @returns {boolean} 是否成功
   */
  static copyFileSync(source, target) {
    try {
      const content = this.readFileSync(source);
      if (content === null) return false;
      return this.writeFileSync(target, content);
    } catch (err) {
      FileUtils._logFsDebug('copyFileSync', `${source} -> ${target}`, err);
      return false;
    }
  }

  /**
   * 同步读取目录内容
   * @param {string} dirPath - 目录路径
   * @param {object} [options] - 选项（透传给 fs.readdirSync，例如 { withFileTypes: true }）
   * @returns {Array} 目录条目数组，失败时返回空数组
   */
  static readDirSync(dirPath, options = {}) {
    try {
      return fsSync.readdirSync(dirPath, options);
    } catch (err) {
      if (err?.code !== 'ENOENT') FileUtils._logFsDebug('readDirSync', dirPath, err);
      return [];
    }
  }

  /**
   * 异步读取目录内容
   * @param {string} dirPath
   * @param {object} [options]
   * @returns {Promise<Array>}
   */
  static async readDir(dirPath, options = {}) {
    try {
      return await fs.readdir(dirPath, options);
    } catch (err) {
      if (err?.code !== 'ENOENT') FileUtils._logFsDebug('readDir', dirPath, err);
      return [];
    }
  }

  /**
   * 将绝对路径转为可 dynamic import 的 file URL
   * @param {string} absPath
   * @param {object} [options]
   * @param {boolean} [options.cacheBust=true]
   * @returns {string}
   */
  static toImportUrl(absPath, options = {}) {
    const { cacheBust = true } = options;
    const url = pathToFileURL(path.resolve(absPath)).href;
    return cacheBust ? `${url}?t=${Date.now()}` : url;
  }

  static createWriteStream(filePath, options) {
    this.ensureDirSync(path.dirname(filePath));
    return fsSync.createWriteStream(filePath, options);
  }

  /**
   * 创建可读文件流（供 HTTP/2 push 等基础设施使用）
   * @param {string} filePath
   * @param {object} [options]
   * @returns {import('fs').ReadStream}
   */
  static createReadStream(filePath, options) {
    return fsSync.createReadStream(filePath, options);
  }

  /**
   * 删除目录中超过指定时长的文件（按 mtime），不删子目录本身
   * @param {string} dirPath - 目录路径
   * @param {number} maxAgeMs - 最大保留时长（毫秒）
   * @param {boolean} [recursive=false] - 是否递归子目录
   * @returns {Promise<number>} 删除的文件数
   */
  static async cleanDirByMaxAge(dirPath, maxAgeMs, recursive = false) {
    if (dirPath == null || typeof dirPath !== 'string' || maxAgeMs <= 0) return 0;
    if (!this.existsSync(dirPath)) return 0;
    let deleted = 0;
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const now = Date.now();
      for (const ent of entries) {
        const full = path.join(dirPath, ent.name);
        if (ent.isDirectory() && recursive) {
          deleted += await this.cleanDirByMaxAge(full, maxAgeMs, true);
          const left = await fs.readdir(full).catch((err) => {
            FileUtils._logFsDebug('readdir', full, err);
            return null;
          });
          if (left?.length === 0) {
            await fs.rmdir(full).catch((err) => {
              if (err?.code !== 'ENOENT') FileUtils._logFsDebug('rmdir', full, err);
            });
          }
        } else if (ent.isFile()) {
          const stat = await fs.stat(full).catch(() => null);
          if (stat && now - stat.mtimeMs > maxAgeMs) {
            if (await fs.unlink(full).then(() => true).catch(() => false)) deleted++;
          }
        }
      }
    } catch {
      return deleted;
    }
    return deleted;
  }
}
