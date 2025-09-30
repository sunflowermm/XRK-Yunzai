import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import cfg from '../config/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const _path = process.cwd();

/**
 * 工作流加载器
 * 负责管理和加载AI工作流
 */
class StreamLoader {
  constructor() {
    this.streams = new Map();
    this.streamDir = path.join(_path, cfg?.aistream?.streamDir || 'plugins/stream');
    this.cache = new Map();
    this.loadingPromise = null;
    this.executionQueue = [];
    this.activeExecutions = 0;
    
    // 配置项
    this.config = {
      maxConcurrent: cfg?.aistream?.global?.maxConcurrent || 5,
      maxTimeout: cfg?.aistream?.global?.maxTimeout || 30000,
      debug: cfg?.aistream?.global?.debug || false,
      cache: {
        enabled: cfg?.aistream?.cache?.enabled !== false,
        ttl: (cfg?.aistream?.cache?.ttl || 300) * 1000,
        maxSize: cfg?.aistream?.cache?.maxSize || 100
      }
    };
  }

  /**
   * 加载所有工作流
   */
  async load() {
    // 防止重复加载
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = this._doLoad();
    const result = await this.loadingPromise;
    this.loadingPromise = null;
    return result;
  }

  async _doLoad() {
    const startTime = Date.now();
    
    console.log(chalk.cyan('╔════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.yellow.bold('                    加载AI工作流系统                        ') + chalk.cyan('║'));
    console.log(chalk.cyan('╚════════════════════════════════════════════════════════════╝'));
    
    try {
      // 确保目录存在
      await this._ensureDirectory();
      
      // 扫描并加载工作流文件
      const files = await this._scanStreamFiles();
      const loadResults = await this._loadStreams(files);
      
      // 统计结果
      const successCount = loadResults.filter(r => r.success).length;
      const failureCount = loadResults.filter(r => !r.success).length;
      
      // 显示加载结果
      this._displayLoadResults(successCount, failureCount, Date.now() - startTime);
      
      // 初始化缓存清理
      if (this.config.cache.enabled) {
        this._initCacheCleanup();
      }
      
      return {
        success: successCount,
        failed: failureCount,
        total: loadResults.length
      };
      
    } catch (error) {
      console.log(chalk.red(`✗ 工作流系统加载失败: ${error.message}`));
      logger?.error(`[StreamLoader] 加载失败: ${error.stack}`);
      throw error;
    }
  }

  /**
   * 确保目录存在
   */
  async _ensureDirectory() {
    if (!fs.existsSync(this.streamDir)) {
      fs.mkdirSync(this.streamDir, { recursive: true });
      console.log(chalk.yellow(`📁 创建工作流目录: ${this.streamDir}`));
    }
  }

  /**
   * 扫描工作流文件
   */
  async _scanStreamFiles() {
    const files = fs.readdirSync(this.streamDir)
      .filter(file => file.endsWith('.js'))
      .sort(); // 按字母顺序排序
    
    if (files.length === 0) {
      console.log(chalk.yellow('⚠ 未找到任何工作流文件'));
    }
    
    return files;
  }

  /**
   * 批量加载工作流
   */
  async _loadStreams(files) {
    const results = [];
    
    for (const file of files) {
      const result = await this._loadSingleStream(file);
      results.push(result);
      
      if (result.success) {
        console.log(chalk.green(`✓ 加载工作流: ${result.name} v${result.version}`));
        if (result.description) {
          console.log(chalk.gray(`  └─ ${result.description}`));
        }
      } else {
        console.log(chalk.red(`✗ 加载失败 ${file}: ${result.error}`));
      }
    }
    
    return results;
  }

  /**
   * 加载单个工作流
   */
  async _loadSingleStream(file) {
    const filePath = path.join(this.streamDir, file);
    
    try {
      // 动态导入模块
      const module = await import(`file://${filePath}?t=${Date.now()}`);
      const StreamClass = module.default;
      
      if (!StreamClass) {
        return {
          success: false,
          file,
          error: '没有默认导出'
        };
      }
      
      // 创建实例
      const stream = new StreamClass();
      const streamName = stream.name || path.basename(file, '.js');
      
      // 验证工作流
      if (!this._validateStream(stream)) {
        return {
          success: false,
          file,
          error: '工作流验证失败'
        };
      }
      
      // 注册工作流
      this.streams.set(streamName, {
        instance: stream,
        file,
        loadTime: Date.now(),
        stats: {
          executions: 0,
          errors: 0,
          lastExecuted: null
        }
      });
      
      return {
        success: true,
        name: streamName,
        version: stream.version,
        description: stream.description
      };
      
    } catch (error) {
      return {
        success: false,
        file,
        error: error.message
      };
    }
  }

  /**
   * 验证工作流有效性
   */
  _validateStream(stream) {
    if (!stream || typeof stream !== 'object') return false;
    if (!stream.name || typeof stream.name !== 'string') return false;
    if (typeof stream.process !== 'function') return false;
    return true;
  }

  /**
   * 显示加载结果
   */
  _displayLoadResults(success, failed, duration) {
    console.log(chalk.cyan(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
    
    if (success > 0) {
      console.log(chalk.green(`✓ 成功加载 ${success} 个工作流`));
    }
    
    if (failed > 0) {
      console.log(chalk.yellow(`⚠ 失败 ${failed} 个`));
    }
    
    console.log(chalk.gray(`⏱ 加载耗时: ${duration}ms`));
    console.log(chalk.cyan(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
  }

  /**
   * 获取工作流
   * @param {string} name 工作流名称
   * @returns {Object|null} 工作流实例
   */
  getStream(name) {
    const streamData = this.streams.get(name);
    return streamData ? streamData.instance : null;
  }

  /**
   * 获取所有工作流
   * @returns {Array} 工作流实例数组
   */
  getAllStreams() {
    return Array.from(this.streams.values())
      .filter(data => data.instance.enabled !== false)
      .map(data => data.instance);
  }

  /**
   * 获取工作流统计信息
   * @param {string} name 工作流名称
   * @returns {Object} 统计信息
   */
  getStreamStats(name) {
    const streamData = this.streams.get(name);
    return streamData ? streamData.stats : null;
  }

  /**
   * 执行工作流（带并发控制）
   * @param {string} streamName 工作流名称
   * @param {string} response AI响应
   * @param {Object} context 上下文
   * @returns {Promise<Object>} 执行结果
   */
  async executeStream(streamName, response, context = {}) {
    const stream = this.getStream(streamName);
    if (!stream) {
      throw new Error(`工作流 ${streamName} 不存在`);
    }

    // 检查缓存
    if (this.config.cache.enabled) {
      const cacheKey = this._getCacheKey(streamName, response, context);
      const cached = this._getCache(cacheKey);
      if (cached) {
        if (this.config.debug) {
          logger?.debug(`[StreamLoader] 使用缓存: ${streamName}`);
        }
        return cached;
      }
    }

    // 并发控制
    if (this.activeExecutions >= this.config.maxConcurrent) {
      await this._waitForSlot();
    }

    this.activeExecutions++;
    
    try {
      // 执行工作流（带超时控制）
      const result = await this._executeWithTimeout(
        stream.process(response, context),
        this.config.maxTimeout
      );
      
      // 更新统计
      this._updateStats(streamName, true);
      
      // 缓存结果
      if (this.config.cache.enabled) {
        const cacheKey = this._getCacheKey(streamName, response, context);
        this._setCache(cacheKey, result);
      }
      
      return result;
      
    } catch (error) {
      this._updateStats(streamName, false);
      throw error;
    } finally {
      this.activeExecutions--;
      this._processQueue();
    }
  }

  /**
   * 带超时的执行
   */
  async _executeWithTimeout(promise, timeout) {
    return Promise.race([
      promise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('执行超时')), timeout)
      )
    ]);
  }

  /**
   * 等待执行槽位
   */
  _waitForSlot() {
    return new Promise(resolve => {
      this.executionQueue.push(resolve);
    });
  }

  /**
   * 处理执行队列
   */
  _processQueue() {
    if (this.executionQueue.length > 0 && this.activeExecutions < this.config.maxConcurrent) {
      const resolve = this.executionQueue.shift();
      resolve();
    }
  }

  /**
   * 更新统计信息
   */
  _updateStats(streamName, success) {
    const streamData = this.streams.get(streamName);
    if (streamData) {
      streamData.stats.executions++;
      if (!success) streamData.stats.errors++;
      streamData.stats.lastExecuted = Date.now();
    }
  }

  /**
   * 重载工作流
   * @param {string} streamName 工作流名称
   * @returns {Promise<boolean>} 是否成功
   */
  async reload(streamName) {
    try {
      const filePath = path.join(this.streamDir, `${streamName}.js`);
      
      if (!fs.existsSync(filePath)) {
        logger?.error(`[StreamLoader] 工作流文件不存在: ${streamName}`);
        return false;
      }
      
      // 清除缓存
      this._clearStreamCache(streamName);
      
      // 重新加载
      const result = await this._loadSingleStream(`${streamName}.js`);
      
      if (result.success) {
        logger?.info(`[StreamLoader] 重载工作流成功: ${streamName}`);
        console.log(chalk.green(`♻ 重载工作流: ${streamName} v${result.version}`));
        return true;
      } else {
        logger?.error(`[StreamLoader] 重载工作流失败: ${result.error}`);
        return false;
      }
      
    } catch (error) {
      logger?.error(`[StreamLoader] 重载异常: ${error.message}`);
      return false;
    }
  }

  /**
   * 重载所有工作流
   */
  async reloadAll() {
    console.log(chalk.cyan('♻ 重载所有工作流...'));
    this.streams.clear();
    this.cache.clear();
    return this.load();
  }

  /**
   * 缓存管理
   */
  _getCacheKey(streamName, response, context) {
    return `${streamName}:${Buffer.from(response).toString('base64').substring(0, 32)}`;
  }

  _getCache(key) {
    const cached = this.cache.get(key);
    if (!cached) return null;
    
    if (Date.now() - cached.time > this.config.cache.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return cached.data;
  }

  _setCache(key, data) {
    // 限制缓存大小
    if (this.cache.size >= this.config.cache.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, {
      data,
      time: Date.now()
    });
  }

  _clearStreamCache(streamName) {
    for (const [key] of this.cache) {
      if (key.startsWith(`${streamName}:`)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * 初始化缓存清理定时器
   */
  _initCacheCleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.cache) {
        if (now - value.time > this.config.cache.ttl) {
          this.cache.delete(key);
        }
      }
    }, 60000); // 每分钟清理一次
  }

  /**
   * 获取系统状态
   */
  getStatus() {
    return {
      loaded: this.streams.size,
      active: this.activeExecutions,
      queued: this.executionQueue.length,
      cached: this.cache.size,
      streams: Array.from(this.streams.entries()).map(([name, data]) => ({
        name,
        enabled: data.instance.enabled !== false,
        version: data.instance.version,
        stats: data.stats
      }))
    };
  }
}

export default new StreamLoader();