import path from 'path';
import { FileUtils } from './file-utils.js';
import { PluginDirScanner } from './plugin-dir-scanner.js';

/**
 * 文件加载器工具
 * 提供目录扫描与文件过滤
 */
export class FileLoader {
  /**
   * 读取目录中的文件
   * @param {string} dir - 目录路径
   * @param {Object} options - 选项
   * @param {string} [options.ext='.js'] - 文件扩展名
   * @param {boolean} [options.recursive=false] - 是否递归
   * @param {Array<string>} [options.ignore=['.', '_']] - 忽略的文件名前缀
   * @param {Array<string>} [options.exclude=[]] - 文件名需排除的子串（如 .test.）
   * @returns {Promise<Array<string>>} 文件路径数组
   */
  static async readFiles(dir, options = {}) {
    const {
      ext = '.js',
      recursive = false,
      ignore = ['.', '_'],
      exclude = []
    } = options;
    const files = [];

    if (!FileUtils.existsSync(dir)) {
      return files;
    }

    if (!recursive && ext === '.js') {
      return PluginDirScanner.listJsFiles(dir, { exclude });
    }

    try {
      const entries = await FileUtils.readDir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory() && recursive) {
          const subFiles = await this.readFiles(fullPath, options);
          files.push(...subFiles);
        } else if (entry.isFile() && entry.name.endsWith(ext)) {
          const shouldIgnore = ignore.some(prefix => entry.name.startsWith(prefix));
          const shouldExclude = exclude.some(pat => entry.name.includes(pat));
          if (!shouldIgnore && !shouldExclude) {
            files.push(fullPath);
          }
        }
      }
    } catch (err) {
      Bot.makeLog('debug', `[FileLoader] 读取目录失败: ${dir} | ${err?.message || err}`, 'FileLoader');
    }

    return files;
  }
}

export default FileLoader;
