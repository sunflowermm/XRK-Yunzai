// loader.js - API加载器，负责加载和管理API模块
// 修改为使用Fastify，确保注册路由无问题
// 标准化注释，提供完整实现
// 修复：移除热重载警告日志

import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import HttpApi from './http.js';
import BotUtil from '../common/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * API加载器类，负责加载、管理和注册API模块到Fastify
 * @class ApiLoader
 */
class ApiLoader {
  /**
   * 构造函数，初始化属性
   */
  constructor() {
    /** @type {Map<string, HttpApi>} 所有 API 实例 */
    this.apis = new Map();

    /** @type {Array<HttpApi>} 按优先级排序的 API 列表 */
    this.priority = [];

    /** @type {Object} API 文件监视器 */
    this.watcher = {};

    /** @type {boolean} 加载状态 */
    this.loaded = false;

    /** @type {Object} Fastify 实例 */
    this.fastify = null;

    /** @type {Object} Bot 实例 */
    this.bot = null;

    /** @type {Map<string, Array>} 路由映射表 */
    this.routeMap = new Map();
  }

  /**
   * 加载所有 API 模块
   * @returns {Promise<Map>} API 集合
   */
  async load() {
    const startTime = Date.now();
    BotUtil.makeLog('mark', '━━━━━ 开始加载API模块 ━━━━━', 'ApiLoader');

    const apiDir = path.join(process.cwd(), 'plugins/api');

    try {
      // 确保目录存在
      await fs.mkdir(apiDir, { recursive: true });

      // 读取所有 JS 文件
      const files = await this.getApiFiles(apiDir);

      if (files.length === 0) {
        BotUtil.makeLog('warn', '未找到任何API模块文件', 'ApiLoader');
        this.loaded = true;
        return this.apis;
      }

      // 加载每个 API 文件
      let successCount = 0;
      let failCount = 0;

      for (const file of files) {
        const result = await this.loadApi(file);
        if (result) {
          successCount++;
        } else {
          failCount++;
        }
      }

      // 按优先级排序
      this.sortByPriority();

      this.loaded = true;
      const loadTime = Date.now() - startTime;

      BotUtil.makeLog(
        'info',
        `✓ 加载完成: ${successCount} 个成功, ${failCount} 个失败, 耗时 ${loadTime}ms`,
        'ApiLoader'
      );
      BotUtil.makeLog('mark', '━━━━━━━━━━━━━━━━━━━━━━━', 'ApiLoader');

      return this.apis;
    } catch (error) {
      BotUtil.makeLog('error', `加载失败: ${error.message}`, 'ApiLoader');
      throw error;
    }
  }

  /**
   * 获取 API 文件列表（递归）
   * @param {string} dir - 目录路径
   * @param {Array} [fileList=[]] - 文件列表累积器
   * @returns {Promise<Array<string>>} 文件路径数组
   */
  async getApiFiles(dir, fileList = []) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // 跳过特殊目录
          if (entry.name.startsWith('.') || entry.name.startsWith('_')) {
            continue;
          }
          // 递归读取子目录
          await this.getApiFiles(fullPath, fileList);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
          // 跳过以 . 或 _ 开头的文件
          if (!entry.name.startsWith('.') && !entry.name.startsWith('_')) {
            fileList.push(fullPath);
          }
        }
      }
    } catch (error) {
      BotUtil.makeLog('error', `读取目录失败: ${dir}`, 'ApiLoader');
      throw error;
    }

    return fileList;
  }

  /**
   * 加载单个 API 文件
   * @param {string} filePath - 文件路径
   * @returns {Promise<boolean>} 是否加载成功
   */
  async loadApi(filePath) {
    try {
      // 获取相对路径作为 key
      const key = path
        .relative(path.join(process.cwd(), 'plugins/api'), filePath)
        .replace(/\\/g, '/')
        .replace(/\.js$/, '');

      // 如果已加载，先卸载
      if (this.apis.has(key)) {
        await this.unloadApi(key);
      }

      // 动态导入模块（添加时间戳避免缓存）
      const fileUrl = `file://${filePath}?t=${Date.now()}`;
      const module = await import(fileUrl);

      // 检查是否是有效的 API 模块
      if (!module.default) {
        BotUtil.makeLog('warn', `✗ 无效模块: ${key} (缺少 default 导出)`, 'ApiLoader');
        return false;
      }

      let apiInstance;

      // 支持类和对象两种导出方式
      if (typeof module.default === 'function') {
        // 尝试作为类实例化
        try {
          apiInstance = new module.default();
        } catch (e) {
          // 如果不能实例化，可能是普通函数
          BotUtil.makeLog('warn', `✗ 无法实例化: ${key}`, 'ApiLoader');
          return false;
        }
      } else if (typeof module.default === 'object' && module.default !== null) {
        // 对象导出，转换为 HttpApi 实例
        apiInstance = new HttpApi(module.default);
      } else {
        BotUtil.makeLog('warn', `✗ 导出类型错误: ${key}`, 'ApiLoader');
        return false;
      }

      // 验证 API 实例
      if (!apiInstance || typeof apiInstance !== 'object') {
        BotUtil.makeLog('warn', `✗ 实例创建失败: ${key}`, 'ApiLoader');
        return false;
      }

      // 确保 API 实例继承自 HttpApi 或有必要的方法
      if (!(apiInstance instanceof HttpApi)) {
        // 如果不是 HttpApi 实例，检查是否有必要的方法
        if (
          typeof apiInstance.init !== 'function' &&
          typeof apiInstance.getInfo !== 'function'
        ) {
          BotUtil.makeLog('warn', `✗ API实例缺少必要方法: ${key}`, 'ApiLoader');
          return false;
        }

        // 添加缺失的方法
        if (typeof apiInstance.getInfo !== 'function') {
          apiInstance.getInfo = function () {
            return {
              name: this.name || key,
              dsc: this.dsc || '暂无描述',
              priority: this.priority || 100,
              routes: this.routes ? this.routes.length : 0,
              enable: this.enable !== false,
              createTime: this.createTime || Date.now()
            };
          };
        }
      }

      // 设置 API 的元数据
      apiInstance.key = key;
      apiInstance.filePath = filePath;

      // 存储 API 实例
      this.apis.set(key, apiInstance);

      const apiInfo = apiInstance.getInfo();
      const statusIcon = apiInfo.enable !== false ? '✓' : '○';
      BotUtil.makeLog(
        'debug',
        `${statusIcon} 加载: ${apiInfo.name} [优先级:${apiInfo.priority}] [路由:${apiInfo.routes || 0}]`,
        'ApiLoader'
      );

      return true;
    } catch (error) {
      const relativePath = path.relative(process.cwd(), filePath);
      BotUtil.makeLog('error', `✗ 加载失败: ${relativePath}`, 'ApiLoader');
      BotUtil.makeLog('error', error.message, 'ApiLoader');
      return false;
    }
  }

  /**
   * 卸载 API 模块
   * @param {string} key - API 键名
   * @returns {Promise<boolean>} 是否成功卸载
   */
  async unloadApi(key) {
    const api = this.apis.get(key);
    if (!api) {
      return false;
    }

    try {
      // 调用停止方法
      if (typeof api.stop === 'function') {
        await api.stop();
      }

      // 从路由映射中删除
      this.routeMap.delete(key);

      // 从集合中删除
      this.apis.delete(key);

      BotUtil.makeLog('debug', `✓ 卸载: ${api.name || key}`, 'ApiLoader');
      return true;
    } catch (error) {
      BotUtil.makeLog('error', `✗ 卸载失败: ${api.name || key}`, 'ApiLoader');
      return false;
    }
  }

  /**
   * 按优先级排序 API 列表
   * 优先级数字越大，越先执行
   */
  sortByPriority() {
    this.priority = Array.from(this.apis.values())
      .filter((api) => api && api.enable !== false)
      .sort((a, b) => {
        const priorityA = a.priority || 100;
        const priorityB = b.priority || 100;
        return priorityB - priorityA;
      });

    BotUtil.makeLog('debug', `✓ 排序完成: ${this.priority.length} 个活动API`, 'ApiLoader');
  }

  /**
   * 注册所有 API 到 Fastify 实例
   * @param {Object} fastify - Fastify 实例
   * @param {Object} bot - Bot 实例
   * @returns {Promise<void>}
   */
  async register(fastify, bot) {
    this.fastify = fastify;
    this.bot = bot;

    BotUtil.makeLog('mark', '━━━━━ 开始注册API路由 ━━━━━', 'ApiLoader');

    let registeredCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    // 按优先级顺序初始化 API
    for (const api of this.priority) {
      try {
        if (!api || api.enable === false) {
          skippedCount++;
          continue;
        }

        const apiName = api.name || api.key || 'undefined';

        // 初始化 API（这将注册路由）
        if (typeof api.init === 'function') {
          // 为每个 API 创建独立的插件作用域
          await fastify.register(
            async (fastifyInstance) => {
              // 将 bot 和 fastifyInstance 传递给 API
              await api.init(fastifyInstance, bot);
            },
            {
              prefix: api.prefix || '' // 支持 API 定义前缀
            }
          );

          registeredCount++;

          const apiInfo = api.getInfo();
          BotUtil.makeLog(
            'info',
            `✓ 注册: ${apiName} [优先级:${apiInfo.priority}] [路由:${apiInfo.routes || 0}]`,
            'ApiLoader'
          );
        } else {
          BotUtil.makeLog('warn', `✗ API缺少init方法: ${apiName}`, 'ApiLoader');
          failedCount++;
        }
      } catch (error) {
        const apiName = api?.name || api?.key || 'undefined';
        BotUtil.makeLog('error', `✗ 注册失败: ${apiName}`, 'ApiLoader');
        BotUtil.makeLog('error', error.message, 'ApiLoader');
        failedCount++;
      }
    }

    BotUtil.makeLog(
      'info',
      `✓ 注册完成: ${registeredCount} 个成功, ${skippedCount} 个跳过, ${failedCount} 个失败`,
      'ApiLoader'
    );
    BotUtil.makeLog('mark', '━━━━━━━━━━━━━━━━━━━━━━━', 'ApiLoader');
  }

  /**
   * 重载指定的 API 模块
   * @param {string} key - API 键名
   * @returns {Promise<boolean>} 是否重载成功
   */
  async changeApi(key) {
    const api = this.apis.get(key);
    if (!api) {
      BotUtil.makeLog('warn', `✗ API不存在: ${key}`, 'ApiLoader');
      return false;
    }

    try {
      const apiName = api.name || key;
      BotUtil.makeLog('info', `⟳ 重载中: ${apiName}`, 'ApiLoader');

      // 重新加载文件
      const loadResult = await this.loadApi(api.filePath);
      if (!loadResult) {
        BotUtil.makeLog('error', `✗ 重载失败: ${apiName} (加载失败)`, 'ApiLoader');
        return false;
      }

      // 重新排序
      this.sortByPriority();

      // 注意：Fastify 不支持动态卸载路由
      // 需要重启服务器才能完全重载 API
      BotUtil.makeLog(
        'warn',
        `⚠ ${apiName} 已重新加载，但路由需要重启服务器才能生效`,
        'ApiLoader'
      );
      BotUtil.makeLog('info', `✓ 重载成功: ${apiName}`, 'ApiLoader');
      return true;
    } catch (error) {
      const apiName = api?.name || key;
      BotUtil.makeLog('error', `✗ 重载失败: ${apiName}`, 'ApiLoader');
      BotUtil.makeLog('error', error.message, 'ApiLoader');
      return false;
    }
  }

  /**
   * 获取 API 列表信息
   * @returns {Array<Object>} API 信息数组
   */
  getApiList() {
    const apiList = [];

    for (const api of this.apis.values()) {
      if (!api) continue;

      try {
        // 获取 API 信息
        if (typeof api.getInfo === 'function') {
          apiList.push(api.getInfo());
        } else {
          // 构造基本信息
          apiList.push({
            name: api.name || api.key || 'undefined',
            dsc: api.dsc || '暂无描述',
            priority: api.priority || 100,
            routes: api.routes ? api.routes.length : 0,
            enable: api.enable !== false,
            createTime: api.createTime || Date.now(),
            key: api.key || ''
          });
        }
      } catch (error) {
        BotUtil.makeLog(
          'error',
          `获取API信息失败: ${api?.name || api?.key || 'undefined'}`,
          'ApiLoader'
        );
      }
    }

    // 按优先级排序
    return apiList.sort((a, b) => (b.priority || 100) - (a.priority || 100));
  }

  /**
   * 获取指定 API 实例
   * @param {string} key - API 键名
   * @returns {HttpApi|null} API 实例或 null
   */
  getApi(key) {
    return this.apis.get(key) || null;
  }

  /**
   * 检查 API 是否存在
   * @param {string} key - API 键名
   * @returns {boolean} 是否存在
   */
  hasApi(key) {
    return this.apis.has(key);
  }

  /**
   * 获取所有 API 的键名列表
   * @returns {Array<string>} 键名数组
   */
  getApiKeys() {
    return Array.from(this.apis.keys());
  }

  /**
   * 获取已启用的 API 数量
   * @returns {number} 数量
   */
  getEnabledCount() {
    return this.priority.length;
  }

  /**
   * 获取 API 总数
   * @returns {number} 数量
   */
  getTotalCount() {
    return this.apis.size;
  }

  /**
   * 启用或禁用文件监视
   * @param {boolean} [enable=true] - 是否启用
   * @returns {Promise<void>}
   */
  async watch(enable = true) {
    if (!enable) {
      // 停止所有监视器
      for (const key of Object.keys(this.watcher)) {
        const watcher = this.watcher[key];
        if (watcher && typeof watcher.close === 'function') {
          await watcher.close();
        }
      }
      this.watcher = {};
      BotUtil.makeLog('info', '✓ 文件监视已停止', 'ApiLoader');
      return;
    }

    const apiDir = path.join(process.cwd(), 'plugins/api');

    try {
      // 动态导入 chokidar
      const { watch } = await import('chokidar');

      // 创建监视器
      this.watcher.api = watch(apiDir, {
        ignored: /(^|[\/\\])\../, // 忽略以 . 开头的文件
        persistent: true,
        ignoreInitial: true, // 忽略初始扫描
        awaitWriteFinish: {
          stabilityThreshold: 300,
          pollInterval: 100
        }
      });

      // 监听文件添加
      this.watcher.api.on('add', async (filePath) => {
        if (!filePath.endsWith('.js')) return;

        BotUtil.makeLog(
          'info',
          `➕ 检测到新文件: ${path.basename(filePath)}`,
          'ApiLoader'
        );

        // 加载新 API
        const loadResult = await this.loadApi(filePath);
        if (loadResult) {
          this.sortByPriority();

          BotUtil.makeLog(
            'warn',
            '⚠ 新API已加载，需要重启服务器才能注册路由',
            'ApiLoader'
          );
        }
      });

      // 监听文件修改
      this.watcher.api.on('change', async (filePath) => {
        if (!filePath.endsWith('.js')) return;

        const key = path
          .relative(apiDir, filePath)
          .replace(/\\/g, '/')
          .replace(/\.js$/, '');

        BotUtil.makeLog(
          'info',
          `📝 检测到文件修改: ${path.basename(filePath)}`,
          'ApiLoader'
        );

        // 重载 API
        await this.changeApi(key);
      });

      // 监听文件删除
      this.watcher.api.on('unlink', async (filePath) => {
        if (!filePath.endsWith('.js')) return;

        const key = path
          .relative(apiDir, filePath)
          .replace(/\\/g, '/')
          .replace(/\.js$/, '');

        BotUtil.makeLog(
          'info',
          `🗑️  检测到文件删除: ${path.basename(filePath)}`,
          'ApiLoader'
        );

        // 卸载 API
        await this.unloadApi(key);
        this.sortByPriority();

        BotUtil.makeLog('warn', '⚠ API已卸载，需要重启服务器才能移除路由', 'ApiLoader');
      });

      // 监听错误
      this.watcher.api.on('error', (error) => {
        BotUtil.makeLog('error', '文件监视错误', 'ApiLoader');
        BotUtil.makeLog('error', error.message, 'ApiLoader');
      });

      BotUtil.makeLog('info', '✓ 文件监视已启动', 'ApiLoader');
      // 移除热重载警告日志
    } catch (error) {
      BotUtil.makeLog('error', '启动文件监视失败', 'ApiLoader');
      BotUtil.makeLog('error', error.message, 'ApiLoader');
    }
  }

  /**
   * 获取加载状态
   * @returns {boolean} 是否已加载
   */
  isLoaded() {
    return this.loaded;
  }

  /**
   * 获取统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      total: this.getTotalCount(),
      enabled: this.getEnabledCount(),
      disabled: this.getTotalCount() - this.getEnabledCount(),
      loaded: this.loaded,
      watching: Object.keys(this.watcher).length > 0
    };
  }

  /**
   * 清理所有资源
   * @returns {Promise<void>}
   */
  async cleanup() {
    BotUtil.makeLog('info', '开始清理API资源...', 'ApiLoader');

    // 停止文件监视
    await this.watch(false);

    // 卸载所有 API
    const keys = Array.from(this.apis.keys());
    for (const key of keys) {
      await this.unloadApi(key);
    }

    // 清空集合
    this.apis.clear();
    this.priority = [];
    this.routeMap.clear();
    this.loaded = false;
    this.fastify = null;
    this.bot = null;

    BotUtil.makeLog('info', '✓ API资源清理完成', 'ApiLoader');
  }
}

// 导出单例
export default new ApiLoader();