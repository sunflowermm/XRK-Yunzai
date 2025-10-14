import fetch from 'node-fetch';
import BotUtil from '../common/util.js';

/**
 * 轻量级文本相似度计算器
 * 使用 BM25 算法，无需任何依赖
 */
class LightweightSimilarity {
  constructor() {
    this.idf = new Map();
    this.avgDocLength = 0;
    this.k1 = 1.5;
    this.b = 0.75;
  }

  tokenize(text) {
    const chars = text.split('');
    const bigrams = [];
    for (let i = 0; i < chars.length - 1; i++) {
      bigrams.push(chars[i] + chars[i + 1]);
    }
    return [...chars, ...bigrams];
  }

  calculateIDF(documents) {
    const docCount = documents.length;
    const termDocCount = new Map();

    for (const doc of documents) {
      const tokens = new Set(this.tokenize(doc));
      for (const token of tokens) {
        termDocCount.set(token, (termDocCount.get(token) || 0) + 1);
      }
    }

    for (const [term, count] of termDocCount) {
      this.idf.set(term, Math.log((docCount - count + 0.5) / (count + 0.5) + 1));
    }

    this.avgDocLength = documents.reduce((sum, doc) => 
      sum + this.tokenize(doc).length, 0) / docCount;
  }

  score(query, document) {
    const queryTokens = this.tokenize(query);
    const docTokens = this.tokenize(document);
    const docLength = docTokens.length;

    const termFreq = new Map();
    for (const token of docTokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }

    let score = 0;
    for (const token of queryTokens) {
      const tf = termFreq.get(token) || 0;
      const idf = this.idf.get(token) || 0;
      const numerator = tf * (this.k1 + 1);
      const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / this.avgDocLength));
      score += idf * (numerator / denominator);
    }

    return score;
  }
}

/**
 * AI工作流基类
 */
export default class AIStream {
  constructor(options = {}) {
    this.name = options.name || 'base-stream';
    this.description = options.description || '基础工作流';
    this.version = options.version || '1.0.0';
    this.author = options.author || 'unknown';
    this.priority = options.priority || 100;
    
    this.config = {
      enabled: true,
      temperature: 0.8,
      maxTokens: 6000,
      topP: 0.9,
      presencePenalty: 0.6,
      frequencyPenalty: 0.6,
      ...options.config
    };
    
    this.functionToggles = options.functionToggles || {};
    
    // Embedding配置 - 支持多种模式
    this.embeddingConfig = {
      enabled: false,
      provider: 'lightweight', // lightweight | transformers | api
      model: null,
      maxContexts: 5,
      similarityThreshold: 0.3, // 降低阈值，适配轻量级算法
      cacheExpiry: 86400,
      transformersModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', // 多语言小模型
      ...options.embedding
    };
  }

  /**
   * 初始化工作流
   */
  async init() {
    if (!this.functions) {
      this.functions = new Map();
    }
    
    if (this.embeddingModel === undefined) {
      this.embeddingModel = null;
      this.embeddingReady = false;
      this.similarityCalculator = null;
    }
    
    if (this.embeddingConfig.enabled && !this.embeddingReady) {
      await this.initEmbedding().catch(err => {
        BotUtil.makeLog('warn', `[${this.name}] Embedding初始化失败: ${err.message}`, 'AIStream');
      });
    }
  }

  /**
   * 初始化Embedding模型
   */
  async initEmbedding() {
    if (!this.embeddingConfig.enabled) {
      BotUtil.makeLog('debug', `[${this.name}] Embedding未启用`, 'AIStream');
      return;
    }

    if (this.embeddingReady) {
      BotUtil.makeLog('debug', `[${this.name}] Embedding已初始化`, 'AIStream');
      return;
    }

    BotUtil.makeLog('info', `[${this.name}] 初始化Embedding (${this.embeddingConfig.provider})...`, 'AIStream');

    try {
      switch (this.embeddingConfig.provider) {
        case 'lightweight':
          await this.initLightweightEmbedding();
          break;
        case 'transformers':
          await this.initTransformersEmbedding();
          break;
        case 'api':
          await this.initAPIEmbedding();
          break;
        default:
          BotUtil.makeLog('warn', `[${this.name}] 未知提供商: ${this.embeddingConfig.provider}`, 'AIStream');
          return;
      }
      
      BotUtil.makeLog('success', `[${this.name}] Embedding初始化成功 ✓`, 'AIStream');
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] Embedding初始化失败: ${error.message}`, 'AIStream');
      
      // 尝试降级到轻量级模式
      if (this.embeddingConfig.provider !== 'lightweight') {
        BotUtil.makeLog('info', `[${this.name}] 尝试降级到轻量级模式...`, 'AIStream');
        try {
          this.embeddingConfig.provider = 'lightweight';
          await this.initLightweightEmbedding();
          BotUtil.makeLog('success', `[${this.name}] 已降级到轻量级模式`, 'AIStream');
          return;
        } catch (fallbackError) {
          BotUtil.makeLog('error', `[${this.name}] 降级失败: ${fallbackError.message}`, 'AIStream');
        }
      }
      
      this.embeddingConfig.enabled = false;
      this.embeddingReady = false;
      throw error;
    }
  }

  /**
   * 初始化轻量级Embedding（无需依赖）
   */
  async initLightweightEmbedding() {
    BotUtil.makeLog('info', `[${this.name}] 使用轻量级BM25算法（零依赖）`, 'AIStream');
    
    this.similarityCalculator = new LightweightSimilarity();
    this.embeddingReady = true;
    
    BotUtil.makeLog('success', `[${this.name}] ✓ 轻量级模式就绪`, 'AIStream');
  }

  /**
   * 初始化Transformers.js（推荐）
   */
  async initTransformersEmbedding() {
    BotUtil.makeLog('info', `[${this.name}] 加载 Transformers.js...`, 'AIStream');
    
    try {
      // 动态导入
      const { pipeline } = await import('@xenova/transformers');
      
      BotUtil.makeLog('info', `[${this.name}] 加载模型: ${this.embeddingConfig.transformersModel}`, 'AIStream');
      BotUtil.makeLog('info', `[${this.name}] 首次加载需下载模型文件，请耐心等待...`, 'AIStream');
      
      const startTime = Date.now();
      
      // 使用 feature-extraction pipeline
      this.embeddingModel = await pipeline(
        'feature-extraction',
        this.embeddingConfig.transformersModel,
        { quantized: true } // 使用量化版本，更快更小
      );
      
      const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
      this.embeddingReady = true;
      
      BotUtil.makeLog('success', `[${this.name}] ✓ Transformers模型就绪 (${loadTime}秒)`, 'AIStream');
      
      // 测试
      await this.testEmbeddingModel();
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] Transformers加载失败: ${error.message}`, 'AIStream');
      BotUtil.makeLog('info', `[${this.name}] 安装命令: pnpm add @xenova/transformers -w`, 'AIStream');
      throw error;
    }
  }

  /**
   * 初始化API Embedding
   */
  async initAPIEmbedding() {
    const config = this.embeddingConfig;
    
    if (!config.apiUrl || !config.apiKey) {
      throw new Error('未配置Embedding API');
    }

    BotUtil.makeLog('info', `[${this.name}] 配置API: ${config.apiUrl}`, 'AIStream');
    
    await this.testAPIConnection();
    this.embeddingReady = true;
    BotUtil.makeLog('success', `[${this.name}] ✓ API连接成功`, 'AIStream');
  }

  /**
   * 测试Embedding模型
   */
  async testEmbeddingModel() {
    try {
      BotUtil.makeLog('debug', `[${this.name}] 测试模型...`, 'AIStream');
      const vector = await this.generateEmbedding('测试文本');
      
      if (!vector || !Array.isArray(vector) || vector.length === 0) {
        throw new Error('模型返回无效向量');
      }
      
      BotUtil.makeLog('success', `[${this.name}] ✓ 模型测试成功 (维度: ${vector.length})`, 'AIStream');
    } catch (error) {
      throw new Error(`模型测试失败: ${error.message}`);
    }
  }

  /**
   * 测试API连接
   */
  async testAPIConnection() {
    try {
      const testVector = await this.generateAPIEmbedding('test');
      if (!testVector || !Array.isArray(testVector) || testVector.length === 0) {
        throw new Error('API返回无效向量');
      }
    } catch (error) {
      throw new Error(`API测试失败: ${error.message}`);
    }
  }

  /**
   * 生成Embedding向量
   */
  async generateEmbedding(text) {
    if (!this.embeddingConfig.enabled || !text) {
      return null;
    }

    if (!this.embeddingReady) {
      BotUtil.makeLog('warn', `[${this.name}] Embedding未就绪`, 'AIStream');
      return null;
    }

    try {
      switch (this.embeddingConfig.provider) {
        case 'lightweight':
          // 轻量级模式：返回文本本身，稍后用BM25计算相似度
          return text;
        case 'transformers':
          return await this.generateTransformersEmbedding(text);
        case 'api':
          return await this.generateAPIEmbedding(text);
        default:
          return null;
      }
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] 生成Embedding失败: ${error.message}`, 'AIStream');
      return null;
    }
  }

  /**
   * 使用Transformers.js生成Embedding
   */
  async generateTransformersEmbedding(text) {
    if (!this.embeddingModel) {
      throw new Error('Transformers模型未加载');
    }

    try {
      // 生成embedding
      const output = await this.embeddingModel(text, {
        pooling: 'mean',
        normalize: true
      });
      
      // 转换为普通数组
      const vector = Array.from(output.data);
      return vector;
    } catch (error) {
      throw new Error(`Transformers生成失败: ${error.message}`);
    }
  }

  /**
   * 使用API生成Embedding
   */
  async generateAPIEmbedding(text) {
    const config = this.embeddingConfig;
    
    if (!config.apiUrl || !config.apiKey) {
      throw new Error('未配置API');
    }

    try {
      const response = await fetch(config.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: config.apiModel || 'text-embedding-ada-002',
          input: text
        }),
        timeout: 10000
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`API错误 ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      const embedding = result.data?.[0]?.embedding;
      
      if (!embedding || !Array.isArray(embedding)) {
        throw new Error('API返回无效数据');
      }
      
      return embedding;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('API请求超时');
      }
      throw error;
    }
  }

  /**
   * 计算余弦相似度
   */
  cosineSimilarity(vec1, vec2) {
    if (!vec1 || !vec2 || !Array.isArray(vec1) || !Array.isArray(vec2)) {
      return 0;
    }

    if (vec1.length !== vec2.length) {
      return 0;
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }

    const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * 存储消息到Redis
   */
  async storeMessageWithEmbedding(groupId, message) {
    if (!this.embeddingConfig.enabled || typeof redis === 'undefined' || !redis) {
      return;
    }

    if (!this.embeddingReady) {
      return;
    }

    try {
      const key = `ai:embedding:${this.name}:${groupId}`;
      const messageText = `${message.nickname}: ${message.message}`;
      
      const embedding = await this.generateEmbedding(messageText);
      if (!embedding) {
        return;
      }

      const data = {
        message: messageText,
        embedding: embedding,
        userId: message.user_id,
        nickname: message.nickname,
        time: message.time || Date.now(),
        messageId: message.message_id
      };

      await redis.lPush(key, JSON.stringify(data));
      await redis.lTrim(key, 0, 99);
      await redis.expire(key, this.embeddingConfig.cacheExpiry);
      
      BotUtil.makeLog('debug', `[${this.name}] 已存储: ${messageText.substring(0, 30)}...`, 'AIStream');
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] 存储失败: ${error.message}`, 'AIStream');
    }
  }

  /**
   * 检索相关上下文
   */
  async retrieveRelevantContexts(groupId, query) {
    if (!this.embeddingConfig.enabled || typeof redis === 'undefined' || !redis) {
      return [];
    }

    if (!this.embeddingReady || !query) {
      return [];
    }

    try {
      const key = `ai:embedding:${this.name}:${groupId}`;
      const messages = await redis.lRange(key, 0, -1);
      
      if (!messages || messages.length === 0) {
        return [];
      }

      // 解析消息
      const parsedMessages = [];
      for (const msg of messages) {
        try {
          const data = JSON.parse(msg);
          if (data.embedding) {
            parsedMessages.push(data);
          }
        } catch (e) {
          continue;
        }
      }

      if (parsedMessages.length === 0) {
        return [];
      }

      // 根据提供商选择相似度计算方法
      let scored = [];
      
      if (this.embeddingConfig.provider === 'lightweight') {
        // 轻量级模式：使用BM25
        const documents = parsedMessages.map(m => m.message);
        this.similarityCalculator.calculateIDF(documents);
        
        scored = parsedMessages.map(data => ({
          message: data.message,
          similarity: this.similarityCalculator.score(query, data.message) / 10, // 归一化
          time: data.time,
          userId: data.userId,
          nickname: data.nickname
        }));
      } else {
        // Transformers/API模式：使用余弦相似度
        const queryEmbedding = await this.generateEmbedding(query);
        if (!queryEmbedding) {
          return [];
        }

        scored = parsedMessages.map(data => ({
          message: data.message,
          similarity: this.cosineSimilarity(queryEmbedding, data.embedding),
          time: data.time,
          userId: data.userId,
          nickname: data.nickname
        }));
      }

      // 过滤和排序
      const filtered = scored.filter(s => s.similarity >= this.embeddingConfig.similarityThreshold);
      filtered.sort((a, b) => b.similarity - a.similarity);
      const results = filtered.slice(0, this.embeddingConfig.maxContexts);
      
      if (results.length > 0) {
        BotUtil.makeLog('debug', 
          `[${this.name}] 检索到 ${results.length} 条 (最高: ${(results[0].similarity * 100).toFixed(1)}%)`,
          'AIStream'
        );
      }
      
      return results;
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] 检索失败: ${error.message}`, 'AIStream');
      return [];
    }
  }

  /**
   * 构建增强上下文
   */
  async buildEnhancedContext(e, question, baseMessages) {
    if (!this.embeddingConfig.enabled || !this.embeddingReady) {
      return baseMessages;
    }

    const groupId = e.group_id || `private_${e.user_id}`;
    const query = typeof question === 'string' ? question : 
                  (question?.content || question?.text || '');

    if (!query) {
      return baseMessages;
    }

    try {
      const relevantContexts = await this.retrieveRelevantContexts(groupId, query);
      
      if (relevantContexts.length === 0) {
        return baseMessages;
      }

      const enhanced = [...baseMessages];
      const contextPrompt = [
        '\n【相关历史对话】',
        relevantContexts.map((ctx, i) => 
          `${i + 1}. ${ctx.nickname}: ${ctx.message.substring(0, 100)} (${(ctx.similarity * 100).toFixed(0)}%)`
        ).join('\n'),
        '\n以上是相关历史，可参考但不要重复。\n'
      ].join('\n');

      if (enhanced[0]?.role === 'system') {
        enhanced[0].content += contextPrompt;
      } else {
        enhanced.unshift({
          role: 'system',
          content: contextPrompt
        });
      }

      BotUtil.makeLog('info', 
        `[${this.name}] ✓ 检索${relevantContexts.length}条相关上下文`, 
        'AIStream'
      );

      return enhanced;
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] 构建上下文失败: ${error.message}`, 'AIStream');
      return baseMessages;
    }
  }

  // ... [其他方法保持不变] ...

  registerFunction(name, options = {}) {
    const {
      handler,
      prompt = '',
      parser = null,
      enabled = true,
      permission = null,
      description = ''
    } = options;

    this.functions.set(name, {
      name,
      handler,
      prompt,
      parser,
      enabled: this.functionToggles[name] ?? enabled,
      permission,
      description
    });

    BotUtil.makeLog('debug', `[${this.name}]注册功能: ${name}`, 'AIStream');
  }

  isFunctionEnabled(name) {
    const func = this.functions.get(name);
    return func?.enabled ?? false;
  }

  toggleFunction(name, enabled) {
    const func = this.functions.get(name);
    if (func) {
      func.enabled = enabled;
      this.functionToggles[name] = enabled;
    }
  }

  getEnabledFunctions() {
    return Array.from(this.functions.values()).filter(f => f.enabled);
  }

  buildSystemPrompt(context) {
    throw new Error('buildSystemPrompt需要子类实现');
  }

  buildFunctionsPrompt() {
    const enabledFuncs = this.getEnabledFunctions();
    if (enabledFuncs.length === 0) return '';

    const prompts = enabledFuncs
      .filter(f => f.prompt)
      .map(f => f.prompt)
      .join('\n');

    return prompts ? `\n【功能列表】\n${prompts}` : '';
  }

  async buildChatContext(e, question) {
    throw new Error('buildChatContext需要子类实现');
  }

  parseFunctions(text, context = {}) {
    let cleanText = text;
    const allFunctions = [];
    
    for (const func of this.functions.values()) {
      if (!func.enabled || !func.parser) continue;
      
      try {
        const result = func.parser(cleanText, context);
        if (result.functions && result.functions.length > 0) {
          allFunctions.push(...result.functions);
        }
        if (result.cleanText !== undefined) {
          cleanText = result.cleanText;
        }
      } catch (error) {
        BotUtil.makeLog('error', `功能解析失败[${func.name}]: ${error.message}`, 'AIStream');
      }
    }
    
    return { functions: allFunctions, cleanText };
  }

  async executeFunction(type, params, context) {
    const func = this.functions.get(type);
    
    if (!func || !func.enabled) {
      return;
    }
    
    if (func.permission && !(await this.checkPermission(func.permission, context))) {
      return;
    }
    
    try {
      if (func.handler) {
        await func.handler(params, context);
      }
    } catch (error) {
      BotUtil.makeLog('error', `功能执行失败[${type}]: ${error.message}`, 'AIStream');
    }
  }

  async checkPermission(permission, context) {
    const { e } = context;
    if (!e?.isGroup) return false;
    if (e.isMaster) return true;

    try {
      const member = e.group?.pickMember(e.self_id);
      const info = await member?.getInfo().catch(() => null);
      const role = info?.role || 'member';

      switch (permission) {
        case 'admin':
        case 'mute':
          return role === 'owner' || role === 'admin';
        case 'owner':
          return role === 'owner';
        default:
          return true;
      }
    } catch (error) {
      return false;
    }
  }

  async callAI(messages, apiConfig = {}) {
    const config = { ...this.config, ...apiConfig };
    
    if (!config.baseUrl || !config.apiKey) {
      throw new Error('未配置AI API');
    }

    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: config.model || config.chatModel || 'gpt-3.5-turbo',
          messages,
          temperature: config.temperature,
          max_tokens: config.maxTokens,
          top_p: config.topP,
          presence_penalty: config.presencePenalty,
          frequency_penalty: config.frequencyPenalty,
          stream: false
        }),
        timeout: config.timeout || 30000
      });

      if (!response.ok) {
        throw new Error(`API错误: ${response.status}`);
      }

      const result = await response.json();
      return result.choices?.[0]?.message?.content || null;
    } catch (error) {
      BotUtil.makeLog('error', `AI调用失败: ${error.message}`, 'AIStream');
      return null;
    }
  }

  async execute(e, question, config) {
    try {
      const context = { e, question, config };
      const baseMessages = await this.buildChatContext(e, question);
      const messages = await this.buildEnhancedContext(e, question, baseMessages);
      const response = await this.callAI(messages, config);
      
      if (!response) {
        return null;
      }
      
      const { functions, cleanText } = this.parseFunctions(response, context);
      
      for (const func of functions) {
        await this.executeFunction(func.type, func.params, context);
      }
      
      if (this.embeddingConfig.enabled && cleanText) {
        const groupId = e.group_id || `private_${e.user_id}`;
        this.storeMessageWithEmbedding(groupId, {
          user_id: e.self_id,
          nickname: Bot.nickname || 'Bot',
          message: cleanText,
          message_id: Date.now().toString(),
          time: Date.now()
        }).catch(() => {});
      }
      
      return cleanText;
    } catch (error) {
      BotUtil.makeLog('error', `工作流执行失败[${this.name}]: ${error.message}`, 'AIStream');
      return null;
    }
  }

  async process(e, question, apiConfig = {}) {
    try {
      return await this.execute(e, question, apiConfig);
    } catch (error) {
      BotUtil.makeLog('error', `工作流处理失败[${this.name}]: ${error.message}`, 'AIStream');
      return null;
    }
  }

  getInfo() {
    return {
      name: this.name,
      description: this.description,
      version: this.version,
      author: this.author,
      priority: this.priority,
      embedding: {
        enabled: this.embeddingConfig.enabled,
        provider: this.embeddingConfig.provider,
        ready: this.embeddingReady,
        maxContexts: this.embeddingConfig.maxContexts,
        threshold: this.embeddingConfig.similarityThreshold
      },
      functions: Array.from(this.functions.values()).map(f => ({
        name: f.name,
        description: f.description,
        enabled: f.enabled,
        permission: f.permission
      }))
    };
  }

  async cleanup() {
    BotUtil.makeLog('info', `[${this.name}] 清理资源...`, 'AIStream');
    
    if (this.embeddingModel && typeof this.embeddingModel.dispose === 'function') {
      try {
        await this.embeddingModel.dispose();
        BotUtil.makeLog('debug', `[${this.name}] 模型已释放`, 'AIStream');
      } catch (error) {
        BotUtil.makeLog('warn', `[${this.name}] 释放失败: ${error.message}`, 'AIStream');
      }
      this.embeddingModel = null;
    }
    
    this.embeddingReady = false;
    BotUtil.makeLog('success', `[${this.name}] 清理完成`, 'AIStream');
  }
}