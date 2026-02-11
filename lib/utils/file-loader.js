import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';

/**
 * 文件加载器工具
 * 提供文件读取和过滤功能
 */
export class FileLoader {
  /**
   * 读取目录中的文件
   * @param {string} dir - 目录路径
   * @param {Object} options - 选项
   * @param {string} options.ext - 文件扩展名（如 '.js'）
   * @param {boolean} options.recursive - 是否递归
   * @param {Array<string>} options.ignore - 忽略的前缀（如 ['.', '_']）
   * @returns {Promise<Array<string>>} 文件路径数组
   */
  static async readFiles(dir, options = {}) {
    const { ext = '.js', recursive = false, ignore = [] } = options;
    const files = [];

    if (!existsSync(dir)) {
      return files;
    }

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory() && recursive) {
          const subFiles = await this.readFiles(fullPath, options);
          files.push(...subFiles);
        } else if (entry.isFile() && entry.name.endsWith(ext)) {
          const shouldIgnore = ignore.some(prefix => entry.name.startsWith(prefix));
          if (!shouldIgnore) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      // 忽略错误，返回已找到的文件
    }

    return files;
  }
}

export default FileLoader;
