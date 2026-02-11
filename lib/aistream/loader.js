import path from 'path';
import { pathToFileURL } from 'url';
import fs from 'fs';
import BotUtil from '../common/util.js';
import { FileUtils } from '../utils/file-utils.js';
import { ObjectUtils } from '../utils/object-utils.js';

// 统一路径处理：支持跨平台
const _path = process.cwd();
const STREAMS_DIR = path.resolve(_path, 'plugins', 'stream');

/**
 * AI工作流加载器
 * 标准化初始化流程，避免重复加载
 */
class StreamLoader {
  constructor() {
    this.streams = new Map();
    this.streamClasses = new Map();
    this.loaded = false;
    this.embeddingConfigured = false;
    this.embeddingConfig = null;
    this._loadingPromise = null; // 防止并发加载
    this.loadStats = {
      streams: [],
      totalLoadTime: 0,
      startTime: 0,
      totalStreams: 0,
      failedStreams: 0
    };
  }

  /**
   * 配置Embedding设置（只配置，不初始化）
   */
  configureEmbedding(config = {}) {
    if (this.embeddingConfigured) {
      return;
    }

    this.embeddingConfig = {
      enabled: config.enabled || false,
      provider: config.provider || 'lightweight',
      onnxModel: config.onnxModel || 'Xenova/all-MiniLM-L6-v2',
      onnxQuantized: config.onnxQuantized !== false,
      hfToken: config.hfToken || null,
      hfModel: config.hfModel || 'sentence-transformers/all-MiniLM-L6-v2',
      fasttextModel: config.fasttextModel || 'cc.zh.300.bin',
      apiUrl: config.apiUrl || null,
      apiKey: config.apiKey || null,
      apiModel: config.apiModel || 'text-embedding-3-small',
      maxContexts: config.maxContexts || 5,
      similarityThreshold: config.similarityThreshold || 0.6,
      cacheExpiry: config.cacheExpiry || 86400,
      cachePath: config.cachePath || path.resolve(_path, 'data', 'models')
    };

    this.embeddingConfigured = true;
  }

  /**
   * 加载所有工作流（标准化流程）
   */
  async load(isRefresh = false) {
    // 防止重复加载
    if (!isRefresh && this.loaded) {
      return;
    }

    // 如果正在加载，等待加载完成
    if (this._loadingPromise) {
      return await this._loadingPromise;
    }

    // 创建加载Promise
    this._loadingPromise = this._doLoad(isRefresh);
    
    try {
      await this._loadingPromise;
    } finally {
      this._loadingPromise = null;
    }
  }

  /**
   * 获取所有工作流目录
   * @private
   * @returns {Array<string>}
   */
  _getStreamDirs() {
    const dirs = [];
    const cwd = process.cwd();
    
    // 1. 默认工作流目录
    if (!FileUtils.existsSync(STREAMS_DIR)) {
      FileUtils.ensureDirSync(STREAMS_DIR);
    }
    dirs.push(STREAMS_DIR);
    
    // 2. 从 plugins 下的每个子目录加载 stream（每个插件可以有独立的工作流）
    const pluginsDir = path.join(cwd, 'plugins');
    if (FileUtils.existsSync(pluginsDir)) {
      try {
        const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            const streamDir = path.join(pluginsDir, entry.name, 'stream');
            if (FileUtils.existsSync(streamDir)) {
              dirs.push(streamDir);
            }
          }
        }
      } catch {
        // 忽略错误
      }
    }
    
    // 3. 从 core 目录加载（如果存在，兼容 XRK-AGT 结构）
    const coreDir = path.join(cwd, 'core');
    if (FileUtils.existsSync(coreDir)) {
      try {
        const entries = fs.readdirSync(coreDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            const streamDir = path.join(coreDir, entry.name, 'stream');
            if (FileUtils.existsSync(streamDir)) {
              dirs.push(streamDir);
            }
          }
        }
      } catch {
        // 忽略错误
      }
    }
    
    return dirs;
  }

  async _doLoad(isRefresh = false) {
    try {
      this.loadStats.startTime = Date.now();
      this.loadStats.streams = [];
      this.loadStats.failedStreams = 0;

      if (!isRefresh) {
        this.streams.clear();
        this.streamClasses.clear();
      }

      // 获取所有工作流目录
      const streamDirs = this._getStreamDirs();
      
      // 扫描所有目录中的工作流文件
      const files = [];
      for (const dir of streamDirs) {
        const dirFiles = this.scanStreamFiles(dir);
        files.push(...dirFiles);
      }
      
      if (files.length === 0) {
        this.loaded = true;
        return;
      }

      // 加载工作流类
      for (const file of files) {
        await this.loadStreamClass(file);
      }

      // 应用Embedding配置
      if (this.embeddingConfig && this.embeddingConfig.enabled) {
        await this.applyEmbeddingConfig();
      }

      this.loadStats.totalLoadTime = Date.now() - this.loadStats.startTime;
      this.loadStats.totalStreams = this.streams.size;
      this.loaded = true;

      // 显示加载结果（简化日志）
      this.displayLoadSummary();
    } catch (error) {
      BotUtil.makeLog('error', `工作流加载失败: ${error.message}`, 'StreamLoader');
      throw error;
    }
  }

  /**
   * 扫描工作流文件（通用方法，跨平台兼容）
   * @param {string} dir - 工作流目录路径
   * @returns {string[]} 工作流文件路径数组
   */
  scanStreamFiles(dir) {
    try {
      if (!FileUtils.existsSync(dir)) {
        return [];
      }

      const files = fs.readdirSync(dir);
      const streamFiles = files
        .filter(file => {
          // 只加载.js文件，排除测试文件和隐藏文件
          return file.endsWith('.js') && 
                 !file.startsWith('.') && 
                 !file.includes('.test.') &&
                 !file.includes('.spec.');
        })
        .map(file => path.resolve(dir, file))
        .filter(filePath => {
          // 确保是文件而不是目录
          try {
            const stat = fs.statSync(filePath);
            return stat.isFile();
          } catch {
            return false;
          }
        });

      return streamFiles;
    } catch (error) {
      BotUtil.makeLog('error', `扫描工作流目录失败: ${error.message}`, 'StreamLoader');
      return [];
    }
  }

  /**
   * 加载单个工作流类（只加载，不初始化Embedding）
   */
  async loadStreamClass(file) {
    const streamName = path.basename(file, '.js');
    const startTime = Date.now();

    try {
      // 动态导入（跨平台兼容）
      // 使用path.resolve确保路径标准化，然后转换为file:// URL
      const normalizedPath = path.resolve(file);
      const fileUrl = pathToFileURL(normalizedPath).href;
      const timestamp = Date.now();
      const module = await import(`${fileUrl}?t=${timestamp}`);
      const StreamClass = module.default;

      if (!ObjectUtils.isFunction(StreamClass)) {
        throw new Error('无效的工作流文件');
      }

      // 创建实例
      const stream = new StreamClass();
      
      if (!stream.name) {
        throw new Error('工作流缺少name属性');
      }

      // 应用Embedding配置（但禁用自动初始化）
      if (this.embeddingConfig) {
        stream.embeddingConfig = {
          ...stream.embeddingConfig,
          ...this.embeddingConfig,
          enabled: false // 暂时禁用，稍后统一初始化
        };
      }

      // 调用基础init（不包括Embedding初始化）
      if (typeof stream.init === 'function') {
        await stream.init();
      }

      // 保存
      this.streams.set(stream.name, stream);
      this.streamClasses.set(stream.name, StreamClass);

      const loadTime = Date.now() - startTime;
      this.loadStats.streams.push({
        name: stream.name,
        version: stream.version,
        loadTime: loadTime,
        success: true,
        priority: stream.priority,
        functions: stream.functions?.size || 0
      });

      // 简化日志输出
    } catch (error) {
      this.loadStats.failedStreams++;
      const loadTime = Date.now() - startTime;
      
      this.loadStats.streams.push({
        name: streamName,
        loadTime: loadTime,
        success: false,
        error: error.message
      });

      BotUtil.makeLog('error', 
        `工作流加载失败 ${streamName}: ${error.message}`, 
        'StreamLoader'
      );
    }
  }

  /**
   * 统一应用Embedding配置并初始化
   */
  async applyEmbeddingConfig() {
    let successCount = 0;
    let failCount = 0;

    for (const stream of this.streams.values()) {
      stream.embeddingConfig.enabled = true;

      try {
        await stream.initEmbedding();
        successCount++;
      } catch (err) {
        failCount++;
        BotUtil.makeLog('warn', `Embedding初始化失败 ${stream.name}: ${err.message}`, 'StreamLoader');
      }
    }

    if (successCount > 0) {
      BotUtil.makeLog('success', `Embedding初始化完成: ${successCount}个成功`, 'StreamLoader');
    }
  }

  /**
   * 显示加载摘要（简化版）
   */
  displayLoadSummary() {
    const successCount = this.streams.size;
    const failedCount = this.loadStats.failedStreams;
    const totalTime = (this.loadStats.totalLoadTime / 1000).toFixed(2);

    if (successCount > 0) {
      const streamNames = Array.from(this.streams.values())
        .map(s => `${s.name} v${s.version}`)
        .join(', ');
      BotUtil.makeLog('success', `工作流加载完成: ${streamNames} (${totalTime}s)`, 'StreamLoader');
    }
    
    if (failedCount > 0) {
      BotUtil.makeLog('error', `工作流加载失败: ${failedCount} 个`, 'StreamLoader');
    }
  }


  /**
   * 重新加载工作流
   */
  async reload() {
    BotUtil.makeLog('info', '🔄 开始重新加载...', 'StreamLoader');
    
    // 清理
    for (const stream of this.streams.values()) {
      if (typeof stream.cleanup === 'function') {
        await stream.cleanup().catch(() => {});
      }
    }

    this.streams.clear();
    this.streamClasses.clear();
    this.loaded = false;
    this.embeddingConfigured = false;
    
    // 重新加载
    await this.load();
    BotUtil.makeLog('success', '✅ 重新加载完成', 'StreamLoader');
  }

  /**
   * 切换所有工作流的Embedding
   */
  async toggleAllEmbedding(enabled) {
    if (!this.embeddingConfig) {
      BotUtil.makeLog('warn', '⚠️ Embedding未配置', 'StreamLoader');
      return false;
    }

    BotUtil.makeLog('info', `🔄 ${enabled ? '启用' : '禁用'}Embedding...`, 'StreamLoader');

    this.embeddingConfig.enabled = enabled;
    let successCount = 0;
    let failCount = 0;

    for (const stream of this.streams.values()) {
      stream.embeddingConfig.enabled = enabled;
      
      if (enabled) {
        try {
          await stream.initEmbedding();
          successCount++;
        } catch (err) {
          failCount++;
        }
      } else if (stream.embeddingReady) {
        await stream.cleanup().catch(() => {});
        successCount++;
      }
    }

    BotUtil.makeLog('success', 
      `✅ ${enabled ? '启用' : '禁用'}完成: ${successCount}成功, ${failCount}失败`, 
      'StreamLoader'
    );
    
    return true;
  }

  /**
   * 获取工作流
   */
  getStream(name) {
    return this.streams.get(name);
  }

  getStreamClass(name) {
    return this.streamClasses.get(name);
  }

  getAllStreams() {
    return Array.from(this.streams.values());
  }

  getEnabledStreams() {
    return this.getAllStreams().filter(s => s.config.enabled);
  }

  getStreamsByPriority() {
    return this.getAllStreams().sort((a, b) => a.priority - b.priority);
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const total = this.streams.size;
    const enabled = this.getEnabledStreams().length;
    const totalFunctions = this.getAllStreams().reduce(
      (sum, s) => sum + (s.functions?.size || 0), 0
    );
    const embeddingEnabled = this.getAllStreams().filter(
      s => s.embeddingConfig?.enabled
    ).length;
    const embeddingReady = this.getAllStreams().filter(
      s => s.embeddingReady
    ).length;

    return {
      total,
      enabled,
      disabled: total - enabled,
      totalFunctions,
      embedding: {
        enabled: embeddingEnabled,
        ready: embeddingReady,
        provider: this.embeddingConfig?.provider || 'none',
        configured: this.embeddingConfigured
      },
      loadStats: this.loadStats
    };
  }

  /**
   * 检查Embedding依赖
   */
  async checkEmbeddingDependencies() {
    const result = {
      onnx: false,
      hf: false,
      fasttext: false,
      api: false,
      redis: false,
      lightweight: true, // 总是可用
      errors: []
    };

    BotUtil.makeLog('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'StreamLoader');
    BotUtil.makeLog('info', '【检查 Embedding 依赖】', 'StreamLoader');

    // ONNX
    try {
      await import('onnxruntime-node');
      result.onnx = true;
      BotUtil.makeLog('success', '├─ ✅ ONNX Runtime', 'StreamLoader');
    } catch (error) {
      result.errors.push('ONNX Runtime 不可用');
      BotUtil.makeLog('warn', '├─ ❌ ONNX Runtime', 'StreamLoader');
      BotUtil.makeLog('info', '│  💡 pnpm add onnxruntime-node -w', 'StreamLoader');
    }

    // HF
    result.hf = !!this.embeddingConfig?.hfToken;
    if (result.hf) {
      BotUtil.makeLog('success', '├─ ✅ HF Token 已配置', 'StreamLoader');
    } else {
      result.errors.push('HF Token 未配置');
      BotUtil.makeLog('warn', '├─ ❌ HF Token 未配置', 'StreamLoader');
    }

    // FastText
    try {
      await import('fasttext.js');
      result.fasttext = true;
      BotUtil.makeLog('success', '├─ ✅ FastText.js', 'StreamLoader');
    } catch (error) {
      result.errors.push('FastText.js 不可用');
      BotUtil.makeLog('warn', '├─ ❌ FastText.js', 'StreamLoader');
    }

    // API
    result.api = !!(this.embeddingConfig?.apiUrl && this.embeddingConfig?.apiKey);
    if (result.api) {
      BotUtil.makeLog('success', '├─ ✅ 自定义 API', 'StreamLoader');
    } else {
      BotUtil.makeLog('warn', '├─ ❌ 自定义 API 未配置', 'StreamLoader');
    }

    // Lightweight
    BotUtil.makeLog('success', '├─ ✅ Lightweight (BM25)', 'StreamLoader');

    // Redis
    result.redis = redis !== null && redis !== undefined;
    if (result.redis) {
      BotUtil.makeLog('success', '└─ ✅ Redis 可用', 'StreamLoader');
    } else {
      result.errors.push('Redis 未启用');
      BotUtil.makeLog('error', '└─ ❌ Redis 不可用 (必需)', 'StreamLoader');
    }

    BotUtil.makeLog('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'StreamLoader');

    return result;
  }

  /**
   * 获取推荐配置
   */
  async getRecommendedEmbeddingConfig() {
    const deps = await this.checkEmbeddingDependencies();
    
    const recommendations = {
      available: [],
      recommended: null,
      instructions: []
    };

    if (deps.onnx && deps.redis) {
      recommendations.available.push('onnx');
      recommendations.recommended = 'onnx';
      recommendations.instructions.push(
        '🌟 ONNX Runtime（推荐）',
        '  ├─ 高性能，纯JS',
        '  └─ pnpm add onnxruntime-node -w'
      );
    }

    if (deps.hf && deps.redis) {
      recommendations.available.push('hf');
      if (!recommendations.recommended) recommendations.recommended = 'hf';
      recommendations.instructions.push(
        '✅ Hugging Face API',
        '  ├─ 零内存，免费',
        '  └─ Token: https://huggingface.co/settings/tokens'
      );
    }

    if (deps.fasttext && deps.redis) {
      recommendations.available.push('fasttext');
      if (!recommendations.recommended) recommendations.recommended = 'fasttext';
    }

    if (deps.api && deps.redis) {
      recommendations.available.push('api');
      if (!recommendations.recommended) recommendations.recommended = 'api';
    }

    if (deps.redis) {
      recommendations.available.push('lightweight');
      if (!recommendations.recommended) recommendations.recommended = 'lightweight';
      recommendations.instructions.push(
        '✅ Lightweight (BM25)',
        '  ├─ 零依赖，零内存',
        '  └─ 适合依赖安装失败时'
      );
    }

    if (!deps.redis) {
      recommendations.instructions.unshift(
        '❌ Redis 未启用（必需）'
      );
    }

    return recommendations;
  }

  /**
   * 清理所有资源
   */
  async cleanupAll() {
    BotUtil.makeLog('info', '🧹 清理资源...', 'StreamLoader');
    
    for (const stream of this.streams.values()) {
      if (typeof stream.cleanup === 'function') {
        await stream.cleanup().catch(() => {});
      }
    }

    this.streams.clear();
    this.streamClasses.clear();
    this.loaded = false;
    this.embeddingConfigured = false;

    BotUtil.makeLog('success', '✅ 清理完成', 'StreamLoader');
  }
}

export default new StreamLoader();