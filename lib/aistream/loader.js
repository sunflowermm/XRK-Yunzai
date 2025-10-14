import path from 'path';
import { pathToFileURL } from 'url';
import fs from 'fs';
import BotUtil from '../common/util.js';

const _path = process.cwd();
const STREAMS_DIR = path.join(_path, 'plugins/stream');

/**
 * AI工作流加载器
 */
class StreamLoader {
  constructor() {
    this.streams = new Map();
    this.streamClasses = new Map();
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
      provider: config.provider || 'onnx', // onnx | hf | fasttext | api | lightweight
      
      // ONNX Runtime 配置（推荐）
      onnxModel: config.onnxModel || 'Xenova/all-MiniLM-L6-v2',
      onnxQuantized: config.onnxQuantized !== false,
      
      // Hugging Face Inference API 配置（免费）
      hfToken: config.hfToken || null,
      hfModel: config.hfModel || 'sentence-transformers/all-MiniLM-L6-v2',
      
      // FastText 配置（轻量级）
      fasttextModel: config.fasttextModel || 'cc.zh.300.bin',
      
      // OpenAI/自定义 API 配置
      apiUrl: config.apiUrl || null,
      apiKey: config.apiKey || null,
      apiModel: config.apiModel || 'text-embedding-3-small',
      
      // 通用配置
      maxContexts: config.maxContexts || 5,
      similarityThreshold: config.similarityThreshold || 0.6,
      cacheExpiry: config.cacheExpiry || 86400,
      autoInit: config.autoInit !== false,
      cachePath: config.cachePath || path.join(_path, 'data/models')
    };

    BotUtil.makeLog('info', '━━━━━━━━━ Embedding 配置 ━━━━━━━━━', 'StreamLoader');
    BotUtil.makeLog('info', `状态: ${this.embeddingConfig.enabled ? '✅ 启用' : '❌ 禁用'}`, 'StreamLoader');
    BotUtil.makeLog('info', `提供商: ${this.embeddingConfig.provider}`, 'StreamLoader');
    
    const providerInfo = {
      onnx: `ONNX Runtime (${this.embeddingConfig.onnxModel})`,
      hf: `Hugging Face API (${this.embeddingConfig.hfModel})`,
      fasttext: `FastText (${this.embeddingConfig.fasttextModel})`,
      api: `自定义 API (${this.embeddingConfig.apiUrl || '未配置'})`,
      lightweight: 'BM25 (零依赖)'
    };
    
    BotUtil.makeLog('info', `方案: ${providerInfo[this.embeddingConfig.provider] || '未知'}`, 'StreamLoader');
    BotUtil.makeLog('info', `相似度阈值: ${this.embeddingConfig.similarityThreshold}`, 'StreamLoader');
    BotUtil.makeLog('info', `最大上下文: ${this.embeddingConfig.maxContexts}`, 'StreamLoader');
    BotUtil.makeLog('info', `缓存路径: ${this.embeddingConfig.cachePath}`, 'StreamLoader');
    BotUtil.makeLog('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'StreamLoader');

    // 如果已加载工作流，更新它们的配置
    if (this.loaded) {
      this.updateStreamsEmbedding();
    }
  }

  /**
   * 更新所有工作流的Embedding配置
   */
  async updateStreamsEmbedding() {
    if (!this.embeddingConfig) {
      BotUtil.makeLog('warn', '⚠️ Embedding未配置，跳过更新', 'StreamLoader');
      return;
    }

    BotUtil.makeLog('info', `🔄 正在更新 ${this.streams.size} 个工作流的Embedding配置...`, 'StreamLoader');

    let successCount = 0;
    let failCount = 0;

    for (const stream of this.streams.values()) {
      // 更新配置
      stream.embeddingConfig = {
        ...stream.embeddingConfig,
        ...this.embeddingConfig
      };

      // 如果启用且需要自动初始化
      if (this.embeddingConfig.enabled && this.embeddingConfig.autoInit) {
        BotUtil.makeLog('debug', `⏳ 初始化工作流 [${stream.name}] 的Embedding...`, 'StreamLoader');
        
        try {
          await stream.initEmbedding();
          successCount++;
          BotUtil.makeLog('success', `✅ 工作流 [${stream.name}] 的Embedding已就绪`, 'StreamLoader');
        } catch (err) {
          failCount++;
          BotUtil.makeLog('error', `❌ 工作流 [${stream.name}] 的Embedding初始化失败: ${err.message}`, 'StreamLoader');
        }
      }
    }

    BotUtil.makeLog('success', `✅ Embedding配置更新完成: ${successCount} 成功, ${failCount} 失败`, 'StreamLoader');
  }

  /**
   * 加载所有工作流
   */
  async load(isRefresh = false) {
    if (!isRefresh && this.loaded) {
      BotUtil.makeLog('warn', '⚠️ 工作流已加载，跳过重复加载', 'StreamLoader');
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
        BotUtil.makeLog('info', '📁 创建工作流目录', 'StreamLoader');
      }

      // 获取所有工作流文件
      const files = await BotUtil.glob(path.join(STREAMS_DIR, '*.js'));
      
      if (files.length === 0) {
        BotUtil.makeLog('warn', '⚠️ 未找到任何工作流文件', 'StreamLoader');
        this.loaded = true;
        return;
      }

      BotUtil.makeLog('info', `📦 发现 ${files.length} 个工作流文件`, 'StreamLoader');

      // 批量加载工作流
      const batchSize = 5;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        await Promise.allSettled(
          batch.map(file => this.loadStream(file))
        );
      }

      // 应用Embedding配置（如果已配置）
      if (this.embeddingConfig && this.embeddingConfig.enabled) {
        BotUtil.makeLog('info', '🔧 应用Embedding配置到所有工作流...', 'StreamLoader');
        await this.updateStreamsEmbedding();
      }

      this.loadStats.totalLoadTime = Date.now() - this.loadStats.startTime;
      this.loadStats.totalStreams = this.streams.size;

      this.loaded = true;
      
      // 显示加载结果
      this.displayLoadResults();
      this.listStreams();
    } catch (error) {
      BotUtil.makeLog('error', `❌ 工作流加载失败: ${error.message}`, 'StreamLoader');
      BotUtil.makeLog('error', error.stack, 'StreamLoader');
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

      // 应用全局Embedding配置（但不初始化）
      if (this.embeddingConfig) {
        stream.embeddingConfig = {
          ...stream.embeddingConfig,
          ...this.embeddingConfig,
          enabled: false // 先禁用，稍后统一初始化
        };
      }

      // 调用init方法初始化工作流（只执行一次）
      if (typeof stream.init === 'function') {
        await stream.init();
      } else {
        BotUtil.makeLog('warn', `⚠️ 工作流 [${stream.name}] 没有init方法`, 'StreamLoader');
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

      BotUtil.makeLog('success', `✅ 加载工作流: ${stream.name} v${stream.version} (${loadTime}ms)`, 'StreamLoader');
    } catch (error) {
      this.loadStats.failedStreams++;
      const loadTime = Date.now() - startTime;
      
      this.loadStats.streams.push({
        name: streamName,
        loadTime: loadTime,
        success: false,
        error: error.message
      });

      BotUtil.makeLog('error', `❌ 加载工作流失败: ${streamName} - ${error.message}`, 'StreamLoader');
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
    BotUtil.makeLog('success', `✅ 成功加载: ${successCount} 个工作流`, 'StreamLoader');
    
    if (failedCount > 0) {
      BotUtil.makeLog('error', `❌ 加载失败: ${failedCount} 个工作流`, 'StreamLoader');
      
      // 显示失败的工作流
      const failed = this.loadStats.streams.filter(s => !s.success);
      failed.forEach(s => {
        BotUtil.makeLog('error', `  - ${s.name}: ${s.error}`, 'StreamLoader');
      });
    }
    
    BotUtil.makeLog('success', `⏱️ 总耗时: ${totalTime}秒`, 'StreamLoader');
    
    // 显示最慢的3个工作流
    const slowest = [...this.loadStats.streams]
      .filter(s => s.success)
      .sort((a, b) => b.loadTime - a.loadTime)
      .slice(0, 3);
    
    if (slowest.length > 0 && slowest[0].loadTime > 100) {
      BotUtil.makeLog('info', '🐢 最慢的工作流:', 'StreamLoader');
      slowest.forEach(s => {
        BotUtil.makeLog('info', `  ${s.name}: ${s.loadTime}ms`, 'StreamLoader');
      });
    }
  }

  /**
   * 重新加载工作流
   */
  async reload() {
    BotUtil.makeLog('info', '🔄 开始重新加载工作流...', 'StreamLoader');
    
    // 清理现有工作流
    for (const stream of this.streams.values()) {
      if (typeof stream.cleanup === 'function') {
        await stream.cleanup().catch(err => {
          BotUtil.makeLog('warn', `⚠️ 清理工作流 [${stream.name}] 失败: ${err.message}`, 'StreamLoader');
        });
      }
    }

    this.streams.clear();
    this.streamClasses.clear();
    this.loaded = false;
    
    await this.load();
    BotUtil.makeLog('success', '✅ 工作流重新加载完成', 'StreamLoader');
  }

  /**
   * 获取工作流实例
   */
  getStream(name) {
    return this.streams.get(name);
  }

  /**
   * 获取工作流类
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
      BotUtil.makeLog('info', '📭 暂无工作流', 'StreamLoader');
      return;
    }

    const streams = this.getStreamsByPriority();
    BotUtil.makeLog('info', '━━━━━━━━━ 工作流列表 ━━━━━━━━━', 'StreamLoader');
    
    for (const stream of streams) {
      const status = stream.config.enabled ? '✅' : '❌';
      const funcCount = stream.functions?.size || 0;
      
      let embStatus = '';
      if (stream.embeddingConfig?.enabled) {
        const provider = stream.embeddingConfig.provider;
        const ready = stream.embeddingReady ? '✅' : '⏳';
        embStatus = `[Emb:${provider}${ready}]`;
      }
      
      BotUtil.makeLog('info', `${status} ${stream.name} v${stream.version} - ${stream.description} (${funcCount}功能) ${embStatus}`, 'StreamLoader');
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
      BotUtil.makeLog('info', `工作流 [${name}] 已${enabled ? '✅ 启用' : '❌ 禁用'}`, 'StreamLoader');
      return true;
    }
    return false;
  }

  /**
   * 启用/禁用所有工作流的Embedding
   */
  async toggleAllEmbedding(enabled) {
    if (!this.embeddingConfig) {
      BotUtil.makeLog('warn', '⚠️ 未配置Embedding', 'StreamLoader');
      return false;
    }

    BotUtil.makeLog('info', `🔄 正在${enabled ? '启用' : '禁用'}所有工作流的Embedding...`, 'StreamLoader');

    this.embeddingConfig.enabled = enabled;
    
    let successCount = 0;
    let failCount = 0;

    for (const stream of this.streams.values()) {
      stream.embeddingConfig.enabled = enabled;
      
      if (enabled && this.embeddingConfig.autoInit) {
        try {
          await stream.initEmbedding();
          successCount++;
        } catch (err) {
          failCount++;
          BotUtil.makeLog('warn', `⚠️ 工作流 [${stream.name}] 的Embedding初始化失败: ${err.message}`, 'StreamLoader');
        }
      } else if (!enabled && stream.embeddingReady) {
        await stream.cleanup().catch(() => {});
        successCount++;
      }
    }

    BotUtil.makeLog('success', `✅ Embedding已${enabled ? '启用' : '禁用'}: ${successCount}成功, ${failCount}失败`, 'StreamLoader');
    
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
        provider: this.embeddingConfig?.provider || 'none',
        configured: !!this.embeddingConfig
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
      errors: []
    };

    BotUtil.makeLog('info', '━━━━━━━━━ 检查 Embedding 依赖 ━━━━━━━━━', 'StreamLoader');

    // 检查 ONNX Runtime
    BotUtil.makeLog('info', '🔍 检查 ONNX Runtime...', 'StreamLoader');
    try {
      await import('onnxruntime-node');
      result.onnx = true;
      BotUtil.makeLog('success', '✅ ONNX Runtime 可用', 'StreamLoader');
    } catch (error) {
      result.onnx = false;
      result.errors.push(`ONNX Runtime: ${error.message}`);
      BotUtil.makeLog('warn', '❌ ONNX Runtime 不可用', 'StreamLoader');
      BotUtil.makeLog('info', '  💡 安装: pnpm add onnxruntime-node -w', 'StreamLoader');
    }

    // 检查 Hugging Face 配置
    BotUtil.makeLog('info', '🔍 检查 Hugging Face API...', 'StreamLoader');
    result.hf = !!this.embeddingConfig?.hfToken;
    if (result.hf) {
      BotUtil.makeLog('success', '✅ HF Token 已配置', 'StreamLoader');
    } else {
      BotUtil.makeLog('warn', '❌ HF Token 未配置', 'StreamLoader');
      BotUtil.makeLog('info', '  💡 获取: https://huggingface.co/settings/tokens', 'StreamLoader');
      result.errors.push('Hugging Face Token 未配置');
    }

    // 检查 FastText
    BotUtil.makeLog('info', '🔍 检查 FastText.js...', 'StreamLoader');
    try {
      await import('fasttext.js');
      result.fasttext = true;
      BotUtil.makeLog('success', '✅ FastText.js 可用', 'StreamLoader');
    } catch (error) {
      result.fasttext = false;
      result.errors.push(`FastText.js: ${error.message}`);
      BotUtil.makeLog('warn', '❌ FastText.js 不可用', 'StreamLoader');
      BotUtil.makeLog('info', '  💡 安装: pnpm add fasttext.js -w', 'StreamLoader');
    }

    // 检查自定义API配置
    BotUtil.makeLog('info', '🔍 检查自定义 API 配置...', 'StreamLoader');
    result.api = !!(this.embeddingConfig?.apiUrl && this.embeddingConfig?.apiKey);
    if (result.api) {
      BotUtil.makeLog('success', '✅ 自定义 API 已配置', 'StreamLoader');
    } else {
      BotUtil.makeLog('warn', '❌ 自定义 API 未配置', 'StreamLoader');
      result.errors.push('自定义 API 未配置');
    }

    // 检查Redis
    BotUtil.makeLog('info', '🔍 检查 Redis 连接...', 'StreamLoader');
    result.redis = typeof redis !== 'undefined' && redis !== null;
    if (result.redis) {
      BotUtil.makeLog('success', '✅ Redis 可用', 'StreamLoader');
    } else {
      BotUtil.makeLog('error', '❌ Redis 不可用 (必需)', 'StreamLoader');
      result.errors.push('Redis 未启用或未连接');
    }

    BotUtil.makeLog('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'StreamLoader');

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

    BotUtil.makeLog('info', '━━━━━━━━━ Embedding 方案推荐 ━━━━━━━━━', 'StreamLoader');

    // 1. ONNX Runtime（最推荐）
    if (deps.onnx && deps.redis) {
      recommendations.available.push('onnx');
      recommendations.recommended = 'onnx';
      recommendations.instructions.push(
        '🌟 ONNX Runtime（强烈推荐）',
        '  优点：高性能，纯JS，支持多种模型，无编译问题',
        '  缺点：首次下载模型需要时间',
        '  安装：pnpm add onnxruntime-node -w',
        '  适用：所有生产环境'
      );
      BotUtil.makeLog('success', '🌟 推荐: ONNX Runtime', 'StreamLoader');
    } else if (!deps.onnx) {
      recommendations.instructions.push(
        '❌ ONNX Runtime 未安装',
        '  💡 安装: pnpm add onnxruntime-node -w'
      );
    }

    // 2. Hugging Face API（免费）
    if (deps.hf && deps.redis) {
      recommendations.available.push('hf');
      if (!recommendations.recommended) {
        recommendations.recommended = 'hf';
      }
      recommendations.instructions.push(
        '✅ Hugging Face API（免费）',
        '  优点：零内存，免费使用，效果优秀',
        '  缺点：需要网络，有速率限制',
        '  安装：pnpm add @huggingface/inference -w',
        '  Token：https://huggingface.co/settings/tokens',
        '  适用：低内存服务器，开发测试'
      );
      BotUtil.makeLog('success', '✅ 可用: Hugging Face API', 'StreamLoader');
    } else if (!deps.hf) {
      recommendations.instructions.push(
        '❌ Hugging Face API 未配置',
        '  💡 免费Token: https://huggingface.co/settings/tokens'
      );
    }

    // 3. FastText（轻量级）
    if (deps.fasttext && deps.redis) {
      recommendations.available.push('fasttext');
      if (!recommendations.recommended) {
        recommendations.recommended = 'fasttext';
      }
      recommendations.instructions.push(
        '✅ FastText（轻量级）',
        '  优点：小巧快速，支持多语言',
        '  缺点：语义理解较弱',
        '  安装：pnpm add fasttext.js -w',
        '  适用：资源受限环境'
      );
      BotUtil.makeLog('success', '✅ 可用: FastText', 'StreamLoader');
    } else if (!deps.fasttext) {
      recommendations.instructions.push(
        '❌ FastText 未安装',
        '  💡 安装: pnpm add fasttext.js -w'
      );
    }

    // 4. 自定义API（OpenAI等）
    if (deps.api && deps.redis) {
      recommendations.available.push('api');
      if (!recommendations.recommended) {
        recommendations.recommended = 'api';
      }
      recommendations.instructions.push(
        '✅ 自定义 API',
        '  优点：效果最佳，零本地资源',
        '  缺点：需要付费，依赖网络',
        '  适用：追求最佳效果'
      );
    }

    // 5. 轻量级BM25（降级方案）
    if (deps.redis) {
      recommendations.available.push('lightweight');
      if (!recommendations.recommended) {
        recommendations.recommended = 'lightweight';
      }
      recommendations.instructions.push(
        '✅ 轻量级 BM25（降级方案）',
        '  优点：零依赖，零内存',
        '  缺点：效果最差',
        '  适用：依赖安装失败时'
      );
    }

    if (!deps.redis) {
      recommendations.instructions.unshift(
        '❌ Redis 未启用（必需）',
        '  Embedding 功能需要 Redis 存储向量'
      );
      BotUtil.makeLog('error', '💥 致命错误: Redis 未启用', 'StreamLoader');
    }

    if (recommendations.available.length === 0) {
      recommendations.recommended = 'none';
      recommendations.instructions.unshift(
        '❌ 无可用的 Embedding 方案',
        '请安装依赖或配置 API'
      );
    }

    BotUtil.makeLog('info', '📋 可用方案:', 'StreamLoader');
    recommendations.instructions.forEach(line => {
      BotUtil.makeLog('info', `  ${line}`, 'StreamLoader');
    });

    BotUtil.makeLog('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'StreamLoader');

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
    BotUtil.makeLog('info', '🧹 正在清理所有工作流资源...', 'StreamLoader');
    
    for (const stream of this.streams.values()) {
      if (typeof stream.cleanup === 'function') {
        await stream.cleanup().catch(err => {
          BotUtil.makeLog('warn', `⚠️ 清理工作流 [${stream.name}] 失败: ${err.message}`, 'StreamLoader');
        });
      }
    }

    this.streams.clear();
    this.streamClasses.clear();
    this.loaded = false;

    BotUtil.makeLog('success', '✅ 所有工作流资源已清理', 'StreamLoader');
  }

  /**
   * 诊断 Embedding 问题
   */
  async diagnoseEmbedding() {
    BotUtil.makeLog('info', '━━━━━━━━━ Embedding 诊断 ━━━━━━━━━', 'StreamLoader');
    
    // 1. 检查配置
    if (!this.embeddingConfig) {
      BotUtil.makeLog('error', '❌ Embedding 未配置', 'StreamLoader');
      return { status: 'not_configured' };
    }
    
    BotUtil.makeLog('success', '✅ Embedding 已配置', 'StreamLoader');
    BotUtil.makeLog('info', `  提供商: ${this.embeddingConfig.provider}`, 'StreamLoader');
    BotUtil.makeLog('info', `  启用状态: ${this.embeddingConfig.enabled}`, 'StreamLoader');
    
    // 2. 检查依赖
    const deps = await this.checkEmbeddingDependencies();
    
    // 3. 检查工作流状态
    const stats = this.getStats();
    BotUtil.makeLog('info', `\n📊 工作流状态:`, 'StreamLoader');
    BotUtil.makeLog('info', `  总数: ${stats.total}`, 'StreamLoader');
    BotUtil.makeLog('info', `  Embedding启用: ${stats.embedding.enabled}`, 'StreamLoader');
    BotUtil.makeLog('info', `  Embedding就绪: ${stats.embedding.ready}`, 'StreamLoader');
    
    // 4. 详细检查每个工作流
    BotUtil.makeLog('info', `\n📝 工作流详情:`, 'StreamLoader');
    for (const stream of this.streams.values()) {
      const embEnabled = stream.embeddingConfig?.enabled || false;
      const embReady = stream.embeddingReady || false;
      const status = embReady ? '✅' : (embEnabled ? '⏳' : '❌');
      
      BotUtil.makeLog('info', `  ${status} ${stream.name}: 启用=${embEnabled}, 就绪=${embReady}`, 'StreamLoader');
    }
    
    BotUtil.makeLog('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'StreamLoader');
    
    return {
      status: 'ok',
      config: this.embeddingConfig,
      dependencies: deps,
      stats: stats
    };
  }
}

// 导出单例
export default new StreamLoader();