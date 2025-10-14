import path from 'path';
import { pathToFileURL } from 'url';
import fs from 'fs';
import BotUtil from '../common/util.js';

const _path = process.cwd();
const STREAMS_DIR = path.join(_path, 'plugins/stream');

/**
 * AI工作流加载器（优化版）
 * 负责加载和管理所有工作流，支持Embedding配置
 */
class StreamLoader {
  constructor() {
    this.streams = new Map();
    this.loaded = false;
    this.embeddingConfig = null;
  }

  /**
   * 配置Embedding设置
   * @param {object} config - Embedding配置
   */
  configureEmbedding(config = {}) {
    this.embeddingConfig = {
      enabled: config.enabled || false,
      provider: config.provider || 'none', // 'tensorflow', 'api', 'none'
      apiUrl: config.apiUrl || null,
      apiKey: config.apiKey || null,
      apiModel: config.apiModel || 'text-embedding-ada-002',
      maxContexts: config.maxContexts || 5,
      similarityThreshold: config.similarityThreshold || 0.6,
      cacheExpiry: config.cacheExpiry || 86400,
      autoInit: config.autoInit !== false // 是否自动初始化
    };

    BotUtil.makeLog('info', 
      `Embedding配置: ${this.embeddingConfig.enabled ? '✓启用' : '✗禁用'} | 提供商: ${this.embeddingConfig.provider}`,
      'StreamLoader'
    );

    // 如果已加载工作流，更新它们的配置
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

      // 如果启用且需要自动初始化
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
  async load() {
    if (this.loaded) {
      BotUtil.makeLog('warn', '工作流已加载，跳过重复加载', 'StreamLoader');
      return;
    }

    try {
      // 确保目录存在
      if (!fs.existsSync(STREAMS_DIR)) {
        fs.mkdirSync(STREAMS_DIR, { recursive: true });
        BotUtil.makeLog('info', '创建工作流目录', 'StreamLoader');
      }

      // 加载所有工作流文件
      const files = await BotUtil.glob(path.join(STREAMS_DIR, '*.js'));
      
      for (const file of files) {
        await this.loadStream(file);
      }

      // 应用Embedding配置
      if (this.embeddingConfig) {
        this.updateStreamsEmbedding();
      }

      this.loaded = true;
      BotUtil.makeLog('success', 
        `✓ 加载了 ${this.streams.size} 个工作流`,
        'StreamLoader'
      );
      
      // 显示工作流列表
      this.listStreams();
    } catch (error) {
      BotUtil.makeLog('error', `工作流加载失败: ${error.message}`, 'StreamLoader');
    }
  }

  /**
   * 加载单个工作流
   */
  async loadStream(file) {
    try {
      const fileUrl = pathToFileURL(file).href;
      const module = await import(fileUrl);
      const StreamClass = module.default;

      if (!StreamClass || typeof StreamClass !== 'function') {
        BotUtil.makeLog('warn', `工作流文件无效: ${path.basename(file)}`, 'StreamLoader');
        return;
      }

      const stream = new StreamClass();
      
      if (!stream.name) {
        BotUtil.makeLog('warn', `工作流缺少name属性: ${path.basename(file)}`, 'StreamLoader');
        return;
      }

      // 应用全局Embedding配置
      if (this.embeddingConfig) {
        stream.embeddingConfig = {
          ...stream.embeddingConfig,
          ...this.embeddingConfig
        };
      }

      this.streams.set(stream.name, stream);
      BotUtil.makeLog('info', 
        `✓ 加载工作流: ${stream.name} v${stream.version}`,
        'StreamLoader'
      );
    } catch (error) {
      BotUtil.makeLog('error', 
        `加载工作流失败[${path.basename(file)}]: ${error.message}`,
        'StreamLoader'
      );
    }
  }

  /**
   * 重新加载工作流
   */
  async reload() {
    // 清理现有工作流
    for (const stream of this.streams.values()) {
      if (typeof stream.cleanup === 'function') {
        await stream.cleanup().catch(err => {
          BotUtil.makeLog('warn', `清理工作流[${stream.name}]失败: ${err.message}`, 'StreamLoader');
        });
      }
    }

    this.streams.clear();
    this.loaded = false;
    await this.load();
  }

  /**
   * 获取工作流
   */
  getStream(name) {
    return this.streams.get(name);
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
      const funcCount = stream.functions.size;
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
    const totalFunctions = this.getAllStreams().reduce((sum, s) => sum + s.functions.size, 0);
    const embeddingEnabled = this.getAllStreams().filter(s => s.embeddingConfig?.enabled).length;
    const embeddingReady = this.getAllStreams().filter(s => s.embeddingReady).length;

    return {
      total,
      enabled,
      disabled: total - enabled,
      totalFunctions,
      embedding: {
        enabled: embeddingEnabled,
        ready: embeddingReady,
        provider: this.embeddingConfig?.provider || 'none'
      }
    };
  }

  /**
   * 检查Embedding依赖
   * @returns {object} 依赖检查结果
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
   * @returns {object} 推荐配置
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

    BotUtil.makeLog('success', '所有工作流资源已清理', 'StreamLoader');
  }
}

export default new StreamLoader();