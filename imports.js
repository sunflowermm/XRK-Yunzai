/**
 * @file imports-manager.js
 * @description 动态导入映射管理器
 * @author XRK
 * @copyright 2025 XRK Studio
 * @license MIT
 * 
 * 功能特性：
 * - 从 JSON 文件动态加载导入映射
 * - 自动生成代理模块文件
 * - 支持热重载和缓存管理
 * - 完整的错误处理和日志记录
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

/** 获取当前模块的目录路径 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 导入管理器配置
 * @readonly
 * @enum {string}
 */
const CONFIG = {
  /** 导入配置文件目录 */
  IMPORTS_JSON_DIR: './data/importsJson',
  /** 生成的代理模块目录 */
  PROXY_MODULES_DIR: './node_modules/.imports-proxy',
  /** 映射缓存文件 */
  CACHE_FILE: './node_modules/.imports-proxy/.cache.json',
  /** 是否启用调试日志 */
  DEBUG: false
};

/**
 * 导入管理器类
 * 负责处理动态导入映射
 * 
 * @class ImportsManager
 */
class ImportsManager {
  constructor() {
    /** @type {Map<string, string>} 导入映射表 */
    this.importMappings = new Map();
    /** @type {Map<string, string>} 文件哈希缓存 */
    this.hashCache = new Map();
    /** @type {boolean} 是否已初始化 */
    this.initialized = false;
  }

  /**
   * 输出调试日志
   * @private
   * @param {string} message - 日志消息
   */
  debug(message) {
    if (CONFIG.DEBUG) {
      console.log(`[ImportsManager] ${message}`);
    }
  }

  /**
   * 初始化导入管理器
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) return;

    try {
      // 确保必要的目录存在
      await this.ensureDirectories();
      
      // 加载所有导入映射
      await this.loadImportMappings();
      
      // 生成代理模块
      await this.generateProxyModules();
      
      this.initialized = true;
      this.debug('导入管理器初始化完成');
    } catch (error) {
      console.error('导入管理器初始化失败:', error);
      throw error;
    }
  }

  /**
   * 确保必要的目录存在
   * @private
   * @returns {Promise<void>}
   */
  async ensureDirectories() {
    await fs.mkdir(CONFIG.IMPORTS_JSON_DIR, { recursive: true });
    await fs.mkdir(CONFIG.PROXY_MODULES_DIR, { recursive: true });
  }

  /**
   * 加载所有导入映射配置
   * @private
   * @returns {Promise<void>}
   */
  async loadImportMappings() {
    try {
      const files = await fs.readdir(CONFIG.IMPORTS_JSON_DIR);
      const jsonFiles = files.filter(file => file.endsWith('.json'));
      
      this.debug(`找到 ${jsonFiles.length} 个配置文件`);
      
      for (const file of jsonFiles) {
        await this.loadSingleMapping(file);
      }
      
      this.debug(`总共加载了 ${this.importMappings.size} 个导入映射`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.debug('导入配置目录不存在，跳过加载');
      } else {
        throw error;
      }
    }
  }

  /**
   * 加载单个映射配置文件
   * @private
   * @param {string} filename - 文件名
   * @returns {Promise<void>}
   */
  async loadSingleMapping(filename) {
    const filePath = path.join(CONFIG.IMPORTS_JSON_DIR, filename);
    
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const config = JSON.parse(content);
      
      // 处理 imports 字段
      if (config.imports && typeof config.imports === 'object') {
        for (const [key, value] of Object.entries(config.imports)) {
          // 验证导入键必须以 # 开头
          if (!key.startsWith('#')) {
            console.warn(`警告: 导入键 "${key}" 必须以 # 开头，已跳过`);
            continue;
          }
          
          // 解析路径为绝对路径
          const absolutePath = path.resolve(value);
          this.importMappings.set(key, absolutePath);
          this.debug(`加载映射: ${key} -> ${absolutePath}`);
        }
      }
      
      // 处理其他可能的配置格式
      if (config.mappings && Array.isArray(config.mappings)) {
        for (const mapping of config.mappings) {
          if (mapping.from && mapping.to) {
            if (!mapping.from.startsWith('#')) {
              console.warn(`警告: 导入键 "${mapping.from}" 必须以 # 开头，已跳过`);
              continue;
            }
            const absolutePath = path.resolve(mapping.to);
            this.importMappings.set(mapping.from, absolutePath);
            this.debug(`加载映射: ${mapping.from} -> ${absolutePath}`);
          }
        }
      }
    } catch (error) {
      console.error(`加载配置文件 ${filename} 失败:`, error.message);
    }
  }

  /**
   * 生成代理模块文件
   * @private
   * @returns {Promise<void>}
   */
  async generateProxyModules() {
    const cache = await this.loadCache();
    let generatedCount = 0;
    
    for (const [importKey, targetPath] of this.importMappings) {
      const generated = await this.generateSingleProxy(importKey, targetPath, cache);
      if (generated) generatedCount++;
    }
    
    if (generatedCount > 0) {
      await this.saveCache();
      this.debug(`生成了 ${generatedCount} 个代理模块`);
    }
  }

  /**
   * 生成单个代理模块
   * @private
   * @param {string} importKey - 导入键（如 #miao）
   * @param {string} targetPath - 目标路径
   * @param {Object} cache - 缓存对象
   * @returns {Promise<boolean>} 是否生成了新模块
   */
  async generateSingleProxy(importKey, targetPath, cache) {
    // 将导入键转换为安全的文件名
    const safeFileName = this.getSafeFileName(importKey);
    const proxyFilePath = path.join(CONFIG.PROXY_MODULES_DIR, `${safeFileName}.js`);
    
    // 生成代理模块内容
    const proxyContent = this.generateProxyContent(importKey, targetPath);
    const contentHash = this.getContentHash(proxyContent);
    
    // 检查是否需要更新
    if (cache[importKey] === contentHash) {
      try {
        await fs.access(proxyFilePath);
        this.debug(`代理模块 ${importKey} 已是最新`);
        return false;
      } catch {
        // 文件不存在，需要生成
      }
    }
    
    // 写入代理模块文件
    await fs.writeFile(proxyFilePath, proxyContent, 'utf-8');
    this.hashCache.set(importKey, contentHash);
    this.debug(`生成代理模块: ${proxyFilePath}`);
    
    return true;
  }

  /**
   * 生成代理模块内容
   * @private
   * @param {string} importKey - 导入键
   * @param {string} targetPath - 目标路径
   * @returns {string} 代理模块代码
   */
  generateProxyContent(importKey, targetPath) {
    // 将绝对路径转换为相对于代理模块的路径
    const relativePath = path.relative(CONFIG.PROXY_MODULES_DIR, targetPath)
      .replace(/\\/g, '/'); // 确保使用正斜杠
    
    return `/**
 * @file ${importKey}-proxy.js
 * @description 自动生成的代理模块
 * @warning 此文件由 imports-manager.js 自动生成，请勿手动修改
 * 
 * 导入映射：${importKey} -> ${targetPath}
 * 生成时间：${new Date().toISOString()}
 */

// 重新导出目标模块的所有内容
export * from '${relativePath}';

// 导出默认导出（如果存在）
import targetModule from '${relativePath}';
export default targetModule;

// 提供元信息
export const __proxyMetadata = {
  importKey: '${importKey}',
  targetPath: '${targetPath}',
  generatedAt: '${new Date().toISOString()}'
};
`;
  }

  /**
   * 将导入键转换为安全的文件名
   * @private
   * @param {string} importKey - 导入键
   * @returns {string} 安全的文件名
   */
  getSafeFileName(importKey) {
    return importKey
      .replace(/^#/, '')           // 移除开头的 #
      .replace(/[^a-zA-Z0-9_-]/g, '-') // 替换特殊字符
      .toLowerCase();
  }

  /**
   * 计算内容哈希
   * @private
   * @param {string} content - 内容
   * @returns {string} 哈希值
   */
  getContentHash(content) {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * 加载缓存
   * @private
   * @returns {Promise<Object>} 缓存对象
   */
  async loadCache() {
    try {
      const content = await fs.readFile(CONFIG.CACHE_FILE, 'utf-8');
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  /**
   * 保存缓存
   * @private
   * @returns {Promise<void>}
   */
  async saveCache() {
    const cache = Object.fromEntries(this.hashCache);
    await fs.writeFile(CONFIG.CACHE_FILE, JSON.stringify(cache, null, 2));
  }

  /**
   * 获取导入映射信息
   * @param {string} importKey - 导入键
   * @returns {string|null} 目标路径或 null
   */
  getMapping(importKey) {
    return this.importMappings.get(importKey) || null;
  }

  /**
   * 获取所有导入映射
   * @returns {Map<string, string>} 导入映射表
   */
  getAllMappings() {
    return new Map(this.importMappings);
  }

  /**
   * 添加或更新导入映射
   * @param {string} importKey - 导入键
   * @param {string} targetPath - 目标路径
   * @returns {Promise<void>}
   */
  async addMapping(importKey, targetPath) {
    if (!importKey.startsWith('#')) {
      throw new Error('导入键必须以 # 开头');
    }
    
    const absolutePath = path.resolve(targetPath);
    this.importMappings.set(importKey, absolutePath);
    
    // 立即生成代理模块
    const cache = await this.loadCache();
    await this.generateSingleProxy(importKey, absolutePath, cache);
    await this.saveCache();
  }

  /**
   * 从文件重新加载映射
   * @returns {Promise<void>}
   */
  async reload() {
    this.importMappings.clear();
    this.hashCache.clear();
    this.initialized = false;
    await this.initialize();
  }

  /**
   * 清理生成的代理模块
   * @returns {Promise<void>}
   */
  async cleanup() {
    try {
      await fs.rm(CONFIG.PROXY_MODULES_DIR, { recursive: true, force: true });
      this.debug('清理代理模块完成');
    } catch (error) {
      console.error('清理代理模块失败:', error);
    }
  }
}

/**
 * 单例实例
 * @type {ImportsManager}
 */
let instance = null;

/**
 * 获取导入管理器实例
 * @returns {ImportsManager} 导入管理器实例
 */
export function getImportsManager() {
  if (!instance) {
    instance = new ImportsManager();
  }
  return instance;
}

/**
 * 初始化导入管理器
 * @returns {Promise<void>}
 */
export async function initializeImports() {
  const manager = getImportsManager();
  await manager.initialize();
  return manager;
}

/**
 * 默认导出
 */
export default ImportsManager;