import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

/**
 * 统一的文件操作工具类
 * 提供文件存在性检查、目录创建、文件读写等常用操作
 */
export class FileUtils {
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
    if (!fsSync.existsSync(dirPath)) {
      fsSync.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * 检查文件是否存在
   * @param {string} filePath - 文件路径
   * @returns {Promise<boolean>}
   */
  static async exists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 同步检查文件是否存在
   * @param {string} filePath - 文件路径
   * @returns {boolean}
   */
  static existsSync(filePath) {
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
    } catch {
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
    } catch {
      return null;
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
    } catch {
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
    } catch {
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
    } catch {
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
    } catch {
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
    } catch {
      return [];
    }
  }
}
