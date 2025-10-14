import path from 'path';
import { pathToFileURL } from 'url';
import fs from 'fs';
import BotUtil from '../common/util.js';

const _path = process.cwd();
const STREAMS_DIR = path.join(_path, 'plugins/stream');

/**
 * AI工作流加载器（优化版 - 参考PluginsLoader设计）
 * 负责加载和管理所有工作流，确保init只执行一次
 */
class StreamLoader {
  constructor() {
    this.streams = new Map();           // 工作流实例Map
    this.streamClasses = new Map();     // 工作流类Map
    this.loaded = false;
    this.embeddingConfig = null;
    this.loadStats = {
      streams: [],
      totalLoadTime: 0,
      startTime: 0,
      totalStreams: 0,
      failedStreams: 0
    };
  }

  /**
   * 配置Embedding设置
   */
  configureEmbedding(config = {}) {
    this.embeddingConfig = {
      enabled: config.enabled || false,
      provider: config.provider || 'none',
      apiUrl: config.apiUrl || null,
      apiKey: config.apiKey || null,
      apiModel: config.apiModel || 'text-embedding-ada-002',
      maxContexts: config.maxContexts || 5,
      similarityThreshold: config.similarityThreshold || 0.6,
      cacheExpiry: config.cacheExpiry || 86400,
      autoInit: config.autoInit !== false
    };

    BotUtil.makeLog('info', 
      `Embedding配置: ${this.embeddingConfig.enabled ? '✓启用' : '✗禁用'} | 提供商: ${this.embeddingConfig.provider}`,
      'StreamLoader'
    );

    if (this.loaded) {
      this.updateStreamsEmbedding();
    }
  }

  /**
   * 更新所有工作流的Embedding配置
   */
  updateStreamsEmbedding() {
    if (!this.embeddingConfig) return;

    for (const stream of this.streams.values()) {
      stream.embeddingConfig = {
        ...stream.embeddingConfig,
        ...this.embeddingConfig
      };

      if (this.embeddingConfig.enabled && this.embeddingConfig.autoInit) {
        stream.initEmbedding().catch(err => {
          BotUtil.makeLog('warn', 
            `工作流[${stream.name}]初始化Embedding失败: ${err.message}`,
            'StreamLoader'
          );
        });
      }
    }

    BotUtil.makeLog('success', 
      `已更新${this.streams.size}个工作流的Embedding配置`,
      'StreamLoader'
    );
  }

  /**
   * 加载所有工作流
   */
  async load(isRefresh = false) {
    if (!isRefresh && this.loaded) {
      BotUtil.makeLog('warn', '工作流已加载，跳过重复加载', 'StreamLoader');
      return;
    }

    try {
      this.loadStats.startTime = Date.now();
      this.loadStats.streams = [];
      this.loadStats.failedStreams = 0;

      // 重置状态
      if (!isRefresh) {
        this.streams.clear();
        this.streamClasses.clear();
      }

      BotUtil.makeLog('info', '━━━━━━━━━ 开始加载工作流 ━━━━━━━━━', 'StreamLoader');

      // 确保目录存在
      if (!fs.existsSync(STREAMS_DIR)) {
        fs.mkdirSync(STREAMS_DIR, { recursive: true });
        BotUtil.makeLog('info', '创建工作流目录', 'StreamLoader');
      }

      // 获取所有工作流文件
      const files = await BotUtil.glob(path.join(STREAMS_DIR, '*.js'));
      
      if (files.length === 0) {
        BotUtil.makeLog('warn', '未找到任何工作流文件', 'StreamLoader');
        this.loaded = true;
        return;
      }

      // 批量加载工作流
      const batchSize = 5;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        await Promise.allSettled(
          batch.map(file => this.loadStream(file))
        );
      }

      // 应用Embedding配置
      if (this.embeddingConfig) {
        this.updateStreamsEmbedding();
      }

      this.loadStats.totalLoadTime = Date.now() - this.loadStats.startTime;
      this.loadStats.totalStreams = this.streams.size;

      this.loaded = true;
      
      // 显示加载结果
      this.displayLoadResults();
      this.listStreams();
    } catch (error) {
      BotUtil.makeLog('error', `工作流加载失败: ${error.message}`, 'StreamLoader');
      throw error;
    }
  }

  /**
   * 加载单个工作流
   */
  async loadStream(file) {
    const streamName = path.basename(file, '.js');
    const startTime = Date.now();

    try {
      // 动态导入工作流模块
      const fileUrl = pathToFileURL(file).href;
      const timestamp = Date.now();
      const module = await import(`${fileUrl}?t=${timestamp}`);
      const StreamClass = module.default;

      if (!StreamClass || typeof StreamClass !== 'function') {
        throw new Error('工作流文件无效：缺少默认导出类');
      }

      // 创建工作流实例
      const stream = new StreamClass();
      
      if (!stream.name) {
        throw new Error('工作流缺少name属性');
      }

      // 应用全局Embedding配置
      if (this.embeddingConfig) {
        stream.embeddingConfig = {
          ...stream.embeddingConfig,
          ...this.embeddingConfig
        };
      }

      // ⭐ 关键：调用init方法初始化工作流（只执行一次）
      if (typeof stream.init === 'function') {
        await stream.init();
      } else {
        BotUtil.makeLog('warn', 
          `工作流[${stream.name}]没有init方法`,
          'StreamLoader'
        );
      }

      // 保存工作流实例和类
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

      BotUtil.makeLog('success', 
        `✓ 加载工作流: ${stream.name} v${stream.version} (${loadTime}ms)`,
        'StreamLoader'
      );
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
        `✗ 加载工作流失败: ${streamName} - ${error.message}`,
        'StreamLoader'
      );
      BotUtil.makeLog('error', error.stack, 'StreamLoader');
    }
  }

  /**
   * 显示加载结果
   */
  displayLoadResults() {
    const successCount = this.streams.size;
    const failedCount = this.loadStats.failedStreams;
    const totalTime = (this.loadStats.totalLoadTime / 1000).toFixed(4);

    BotUtil.makeLog('info', '━━━━━━━━━ 加载结果 ━━━━━━━━━', 'StreamLoader');
    BotUtil.makeLog('success', `成功加载: ${successCount} 个工作流`, 'StreamLoader');
    
    if (failedCount > 0) {
      BotUtil.makeLog('error', `加载失败: ${failedCount} 个工作流`, 'StreamLoader');
    }
    
    BotUtil.makeLog('success', `总耗时: ${totalTime}秒`, 'StreamLoader');
    
    // 显示最慢的3个工作流
    const slowest = [...this.loadStats.streams]
      .filter(s => s.success)
      .sort((a, b) => b.loadTime - a.loadTime)
      .slice(0, 3);
    
    if (slowest.length > 0) {
      BotUtil.makeLog('info', '最慢的工作流:', 'StreamLoader');
      slowest.forEach(s => {
        BotUtil.makeLog('info', `  ${s.name}: ${s.loadTime}ms`, 'StreamLoader');
      });
    }
  }

  /**
   * 重新加载工作流
   */
  async reload() {
    BotUtil.makeLog('info', '开始重新加载工作流...', 'StreamLoader');
    
    // 清理现有工作流
    for (const stream of this.streams.values()) {
      if (typeof stream.cleanup === 'function') {
        await stream.cleanup().catch(err => {
          BotUtil.makeLog('warn', 
            `清理工作流[${stream.name}]失败: ${err.message}`,
            'StreamLoader'
          );
        });
      }
    }

    this.streams.clear();
    this.streamClasses.clear();
    this.loaded = false;
    
    await this.load();
    BotUtil.makeLog('success', '工作流重新加载完成', 'StreamLoader');
  }

  /**
   * 获取工作流实例（用于执行）
   * 注意：这里返回的是已初始化的单例实例
   */
  getStream(name) {
    return this.streams.get(name);
  }

  /**
   * 获取工作流类（用于创建新实例，如果需要）
   */
  getStreamClass(name) {
    return this.streamClasses.get(name);
  }

  /**
   * 获取所有工作流
   */
  getAllStreams() {
    return Array.from(this.streams.values());
  }

  /**
   * 获取已启用的工作流
   */
  getEnabledStreams() {
    return this.getAllStreams().filter(s => s.config.enabled);
  }

  /**
   * 按优先级排序获取工作流
   */
  getStreamsByPriority() {
    return this.getAllStreams().sort((a, b) => a.priority - b.priority);
  }

  /**
   * 列出所有工作流
   */
  listStreams() {
    if (this.streams.size === 0) {
      BotUtil.makeLog('info', '暂无工作流', 'StreamLoader');
      return;
    }

    const streams = this.getStreamsByPriority();
    BotUtil.makeLog('info', '━━━━━━━━━ 工作流列表 ━━━━━━━━━', 'StreamLoader');
    
    for (const stream of streams) {
      const status = stream.config.enabled ? '✓' : '✗';
      const funcCount = stream.functions?.size || 0;
      const embStatus = stream.embeddingConfig?.enabled ? 
        `[Embedding:${stream.embeddingConfig.provider}]` : '';
      
      BotUtil.makeLog('info', 
        `${status} ${stream.name} v${stream.version} - ${stream.description} (${funcCount}功能) ${embStatus}`,
        'StreamLoader'
      );
    }
    
    BotUtil.makeLog('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'StreamLoader');
  }

  /**
   * 启用/禁用工作流
   */
  toggleStream(name, enabled) {
    const stream = this.streams.get(name);
    if (stream) {
      stream.config.enabled = enabled;
      BotUtil.makeLog('info', 
        `工作流[${name}]已${enabled ? '启用' : '禁用'}`,
        'StreamLoader'
      );
      return true;
    }
    return false;
  }

  /**
   * 启用/禁用所有工作流的Embedding
   */
  async toggleAllEmbedding(enabled) {
    if (!this.embeddingConfig) {
      BotUtil.makeLog('warn', '未配置Embedding', 'StreamLoader');
      return false;
    }

    this.embeddingConfig.enabled = enabled;
    
    for (const stream of this.streams.values()) {
      stream.embeddingConfig.enabled = enabled;
      
      if (enabled && this.embeddingConfig.autoInit) {
        await stream.initEmbedding().catch(err => {
          BotUtil.makeLog('warn', 
            `工作流[${stream.name}]初始化Embedding失败: ${err.message}`,
            'StreamLoader'
          );
        });
      } else if (!enabled && stream.embeddingReady) {
        await stream.cleanup().catch(() => {});
      }
    }

    BotUtil.makeLog('success', 
      `所有工作流Embedding已${enabled ? '启用' : '禁用'}`,
      'StreamLoader'
    );
    return true;
  }

  /**
   * 获取工作流统计信息
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
        provider: this.embeddingConfig?.provider || 'none'
      },
      loadStats: this.loadStats
    };
  }

  /**
   * 检查Embedding依赖
   */
  async checkEmbeddingDependencies() {
    const result = {
      tensorflow: false,
      redis: false,
      api: false
    };

    // 检查TensorFlow
    try {
      await import('@tensorflow/tfjs-node');
      await import('@tensorflow-models/universal-sentence-encoder');
      result.tensorflow = true;
    } catch {
      result.tensorflow = false;
    }

    // 检查Redis
    result.redis = typeof redis !== 'undefined' && redis !== null;

    // 检查API配置
    result.api = !!(this.embeddingConfig?.apiUrl && this.embeddingConfig?.apiKey);

    return result;
  }

  /**
   * 获取推荐的Embedding配置
   */
  async getRecommendedEmbeddingConfig() {
    const deps = await this.checkEmbeddingDependencies();
    
    const recommendations = {
      available: [],
      recommended: null,
      instructions: []
    };

    if (deps.tensorflow && deps.redis) {
      recommendations.available.push('tensorflow');
      recommendations.recommended = 'tensorflow';
      recommendations.instructions.push(
        '✓ TensorFlow.js本地模型（推荐）',
        '  - 优点：完全离线，免费，速度快',
        '  - 缺点：首次加载需要约200MB内存',
        '  - 适用：有足够内存的场景'
      );
    } else if (!deps.tensorflow) {
      recommendations.instructions.push(
        '✗ TensorFlow.js未安装',
        '  安装命令: pnpm add @tensorflow/tfjs-node @tensorflow-models/universal-sentence-encoder'
      );
    }

    if (deps.api && deps.redis) {
      recommendations.available.push('api');
      if (!recommendations.recommended) {
        recommendations.recommended = 'api';
      }
      recommendations.instructions.push(
        '✓ API方式（OpenAI兼容）',
        '  - 优点：零内存占用，效果好',
        '  - 缺点：需要API费用和网络',
        '  - 适用：低内存或要求最佳效果'
      );
    } else if (!deps.api) {
      recommendations.instructions.push(
        '✗ API未配置',
        '  需要配置: ai.embedding.apiUrl 和 apiKey'
      );
    }

    if (!deps.redis) {
      recommendations.instructions.push(
        '✗ Redis未启用',
        '  Embedding功能需要Redis存储向量'
      );
    }

    if (recommendations.available.length === 0) {
      recommendations.recommended = 'none';
      recommendations.instructions.unshift(
        '当前无可用的Embedding方案',
        '请安装依赖或配置API'
      );
    }

    return recommendations;
  }

  /**
   * 获取加载统计信息
   */
  getLoadStats() {
    return {
      ...this.loadStats,
      streams: this.streams.size,
      enabled: this.getEnabledStreams().length
    };
  }

  /**
   * 清理所有工作流资源
   */
  async cleanupAll() {
    BotUtil.makeLog('info', '正在清理所有工作流资源...', 'StreamLoader');
    
    for (const stream of this.streams.values()) {
      if (typeof stream.cleanup === 'function') {
        await stream.cleanup().catch(err => {
          BotUtil.makeLog('warn', 
            `清理工作流[${stream.name}]失败: ${err.message}`,
            'StreamLoader'
          );
        });
      }
    }

    this.streams.clear();
    this.streamClasses.clear();
    this.loaded = false;

    BotUtil.makeLog('success', '所有工作流资源已清理', 'StreamLoader');
  }
}

// 导出单例
export default new StreamLoader();