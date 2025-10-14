import fetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import BotUtil from '../common/util.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * 轻量级文本相似度计算器（BM25算法）
 * ═══════════════════════════════════════════════════════════════
 * 零依赖的降级方案，使用经典的BM25算法计算文本相似度
 * 适用于所有依赖安装失败的场景
 */
class LightweightSimilarity {
  constructor() {
    this.idf = new Map();
    this.avgDocLength = 0;
    this.k1 = 1.5;
    this.b = 0.75;
  }

  /**
   * 分词：中文字符级 + bigram
   */
  tokenize(text) {
    const chars = text.split('');
    const bigrams = [];
    for (let i = 0; i < chars.length - 1; i++) {
      bigrams.push(chars[i] + chars[i + 1]);
    }
    return [...chars, ...bigrams];
  }

  /**
   * 计算IDF值
   */
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

  /**
   * 计算BM25得分
   */
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
 * ═══════════════════════════════════════════════════════════════
 * AI工作流基类
 * ═══════════════════════════════════════════════════════════════
 * 提供统一的工作流接口，支持：
 * - 语义检索（Embedding）
 * - 功能注册和执行
 * - AI调用封装
 * - 上下文构建
 */
export default class AIStream {
  constructor(options = {}) {
    // ========== 基础信息 ==========
    this.name = options.name || 'base-stream';
    this.description = options.description || '基础工作流';
    this.version = options.version || '1.0.0';
    this.author = options.author || 'unknown';
    this.priority = options.priority || 100;
    
    // ========== AI配置 ==========
    this.config = {
      enabled: true,
      temperature: 0.8,
      maxTokens: 6000,
      topP: 0.9,
      presencePenalty: 0.6,
      frequencyPenalty: 0.6,
      ...options.config
    };
    
    // ========== 功能开关 ==========
    this.functionToggles = options.functionToggles || {};
    
    // ========== Embedding配置 ==========
    this.embeddingConfig = {
      enabled: false,
      provider: 'lightweight', // onnx | hf | fasttext | api | lightweight
      maxContexts: 5,
      similarityThreshold: 0.6,
      cacheExpiry: 86400,
      cachePath: path.join(process.cwd(), 'data/models'),
      
      // ONNX Runtime 配置（推荐，但需要网络下载模型）
      onnxModel: 'Xenova/all-MiniLM-L6-v2',
      onnxQuantized: true,
      
      // Hugging Face Inference API 配置（免费，需要Token）
      hfToken: null,
      hfModel: 'sentence-transformers/all-MiniLM-L6-v2',
      
      // FastText 配置（轻量级，需要安装fasttext.js）
      fasttextModel: 'cc.zh.300.bin',
      
      // 自定义 API 配置（如OpenAI Embedding API）
      apiUrl: null,
      apiKey: null,
      apiModel: 'text-embedding-3-small',
      
      ...options.embedding
    };
  }

  /**
   * ═══════════════════════════════════════════════════════════════
   * 初始化工作流
   * ═══════════════════════════════════════════════════════════════
   */
  async init() {
    if (!this.functions) {
      this.functions = new Map();
    }
    
    if (this.embeddingModel === undefined) {
      this.embeddingModel = null;
      this.embeddingReady = false;
      this.similarityCalculator = null;
      this.embeddingSession = null;
      this.tokenizer = null;
    }
    
    // 如果启用了Embedding，尝试初始化
    if (this.embeddingConfig.enabled && !this.embeddingReady) {
      await this.initEmbedding().catch(err => {
        BotUtil.makeLog('debug', `[${this.name}] Embedding初始化跳过: ${err.message}`, 'AIStream');
      });
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════
   * 初始化Embedding模型（带智能降级）
   * ═══════════════════════════════════════════════════════════════
   */
  async initEmbedding() {
    if (!this.embeddingConfig.enabled) {
      return;
    }

    if (this.embeddingReady) {
      return;
    }

    const provider = this.embeddingConfig.provider;
    BotUtil.makeLog('info', `[${this.name}] 🔧 初始化语义检索 (${provider})`, 'AIStream');

    try {
      // 尝试初始化指定的提供商
      await this.tryInitProvider(provider);
      BotUtil.makeLog('success', `[${this.name}] ✅ 语义检索就绪 (${provider})`, 'AIStream');
      return;
    } catch (error) {
      // 静默降级：只记录debug日志
      BotUtil.makeLog('debug', `[${this.name}] ${provider}初始化失败: ${error.message}`, 'AIStream');
      
      // 自动降级到lightweight
      if (provider !== 'lightweight') {
        BotUtil.makeLog('info', `[${this.name}] 🔄 降级到轻量级模式`, 'AIStream');
        try {
          this.embeddingConfig.provider = 'lightweight';
          await this.initLightweightEmbedding();
          BotUtil.makeLog('success', `[${this.name}] ✅ 语义检索就绪 (lightweight)`, 'AIStream');
          return;
        } catch (fallbackError) {
          BotUtil.makeLog('error', `[${this.name}] ❌ 语义检索初始化失败`, 'AIStream');
        }
      }
      
      // 完全失败，禁用功能
      this.embeddingConfig.enabled = false;
      this.embeddingReady = false;
      throw new Error('语义检索初始化失败，已禁用');
    }
  }

  /**
   * 尝试初始化指定的提供商
   */
  async tryInitProvider(provider) {
    switch (provider) {
      case 'lightweight':
        await this.initLightweightEmbedding();
        break;
      case 'onnx':
        await this.initONNXEmbedding();
        break;
      case 'hf':
        await this.initHFEmbedding();
        break;
      case 'fasttext':
        await this.initFastTextEmbedding();
        break;
      case 'api':
        await this.initAPIEmbedding();
        break;
      default:
        throw new Error(`未知提供商: ${provider}`);
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════
   * 各种Embedding提供商的初始化方法
   * ═══════════════════════════════════════════════════════════════
   */

  /**
   * 轻量级模式：BM25算法（零依赖）
   */
  async initLightweightEmbedding() {
    this.similarityCalculator = new LightweightSimilarity();
    this.embeddingReady = true;
  }

  /**
   * ONNX Runtime模式（推荐，但需要下载模型）
   */
  async initONNXEmbedding() {
    const ort = await import('onnxruntime-node');
    
    const modelName = this.embeddingConfig.onnxModel;
    const cachePath = this.embeddingConfig.cachePath;
    
    if (!fs.existsSync(cachePath)) {
      fs.mkdirSync(cachePath, { recursive: true });
    }
    
    const modelPath = await this.downloadONNXModel(modelName);
    
    this.embeddingSession = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all'
    });
    
    await this.loadONNXTokenizer(modelName);
    this.embeddingReady = true;
    
    // 测试模型
    await this.testEmbeddingModel();
  }

  /**
   * 下载ONNX模型
   */
  async downloadONNXModel(modelName) {
    const cachePath = this.embeddingConfig.cachePath;
    const modelDir = path.join(cachePath, modelName.replace('/', '_'));
    const modelPath = path.join(modelDir, 'model_quantized.onnx');
    
    if (fs.existsSync(modelPath)) {
      return modelPath;
    }
    
    if (!fs.existsSync(modelDir)) {
      fs.mkdirSync(modelDir, { recursive: true });
    }
    
    const modelUrl = `https://huggingface.co/${modelName}/resolve/main/onnx/model_quantized.onnx`;
    
    const response = await fetch(modelUrl);
    if (!response.ok) {
      throw new Error(`下载失败: ${response.status}`);
    }
    
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(modelPath, Buffer.from(buffer));
    
    return modelPath;
  }

  /**
   * 加载ONNX Tokenizer（简化版）
   */
  async loadONNXTokenizer(modelName) {
    this.tokenizer = {
      encode: (text) => {
        const tokens = text.split('').map(c => c.charCodeAt(0));
        return tokens.slice(0, 512);
      }
    };
  }

  /**
   * Hugging Face API模式（免费，需要Token）
   */
  async initHFEmbedding() {
    const config = this.embeddingConfig;
    
    if (!config.hfToken) {
      throw new Error('未配置Hugging Face Token');
    }

    const { HfInference } = await import('@huggingface/inference');
    this.embeddingModel = new HfInference(config.hfToken);
    
    await this.testHFConnection();
    this.embeddingReady = true;
  }

  /**
   * FastText模式（轻量级）
   */
  async initFastTextEmbedding() {
    const FastText = await import('fasttext.js');
    
    const modelName = this.embeddingConfig.fasttextModel;
    const modelPath = path.join(this.embeddingConfig.cachePath, modelName);
    
    if (!fs.existsSync(modelPath)) {
      await this.downloadFastTextModel(modelName);
    }
    
    this.embeddingModel = new FastText.FastText();
    await this.embeddingModel.load(modelPath);
    this.embeddingReady = true;
    
    await this.testEmbeddingModel();
  }

  /**
   * 下载FastText模型
   */
  async downloadFastTextModel(modelName) {
    const cachePath = this.embeddingConfig.cachePath;
    const modelPath = path.join(cachePath, modelName);
    
    if (!fs.existsSync(cachePath)) {
      fs.mkdirSync(cachePath, { recursive: true });
    }
    
    const modelUrl = `https://dl.fbaipublicfiles.com/fasttext/vectors-crawl/${modelName}`;
    
    const response = await fetch(modelUrl);
    if (!response.ok) {
      throw new Error(`下载失败: ${response.status}`);
    }
    
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(modelPath, Buffer.from(buffer));
  }

  /**
   * 自定义API模式（如OpenAI Embedding）
   */
  async initAPIEmbedding() {
    const config = this.embeddingConfig;
    
    if (!config.apiUrl || !config.apiKey) {
      throw new Error('未配置Embedding API');
    }

    await this.testAPIConnection();
    this.embeddingReady = true;
  }

  /**
   * ═══════════════════════════════════════════════════════════════
   * 测试方法
   * ═══════════════════════════════════════════════════════════════
   */

  async testEmbeddingModel() {
    const vector = await this.generateEmbedding('测试');
    if (!vector || !Array.isArray(vector) || vector.length === 0) {
      throw new Error('模型返回无效向量');
    }
  }

  async testHFConnection() {
    const testVector = await this.generateHFEmbedding('test');
    if (!testVector || !Array.isArray(testVector) || testVector.length === 0) {
      throw new Error('HF API返回无效向量');
    }
  }

  async testAPIConnection() {
    const testVector = await this.generateAPIEmbedding('test');
    if (!testVector || !Array.isArray(testVector) || testVector.length === 0) {
      throw new Error('API返回无效向量');
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════
   * 生成Embedding向量
   * ═══════════════════════════════════════════════════════════════
   */
  async generateEmbedding(text) {
    if (!this.embeddingConfig.enabled || !text) {
      return null;
    }

    if (!this.embeddingReady) {
      return null;
    }

    try {
      switch (this.embeddingConfig.provider) {
        case 'lightweight':
          return text;
        case 'onnx':
          return await this.generateONNXEmbedding(text);
        case 'hf':
          return await this.generateHFEmbedding(text);
        case 'fasttext':
          return await this.generateFastTextEmbedding(text);
        case 'api':
          return await this.generateAPIEmbedding(text);
        default:
          return null;
      }
    } catch (error) {
      BotUtil.makeLog('debug', `[${this.name}] 生成Embedding失败: ${error.message}`, 'AIStream');
      return null;
    }
  }

  /**
   * 使用ONNX Runtime生成Embedding
   */
  async generateONNXEmbedding(text) {
    if (!this.embeddingSession || !this.tokenizer) {
      throw new Error('ONNX模型未加载');
    }

    const ort = await import('onnxruntime-node');
    
    const inputIds = this.tokenizer.encode(text);
    const attentionMask = new Array(inputIds.length).fill(1);
    
    const maxLength = 512;
    while (inputIds.length < maxLength) {
      inputIds.push(0);
      attentionMask.push(0);
    }
    
    const inputIdsTensor = new ort.Tensor('int64', BigInt64Array.from(inputIds.map(id => BigInt(id))), [1, maxLength]);
    const attentionMaskTensor = new ort.Tensor('int64', BigInt64Array.from(attentionMask.map(m => BigInt(m))), [1, maxLength]);
    
    const feeds = {
      input_ids: inputIdsTensor,
      attention_mask: attentionMaskTensor
    };
    
    const results = await this.embeddingSession.run(feeds);
    const outputTensor = results[Object.keys(results)[0]];
    
    const embeddings = Array.from(outputTensor.data);
    const embeddingDim = embeddings.length / maxLength;
    const meanEmbedding = new Array(embeddingDim).fill(0);
    
    let validTokens = 0;
    for (let i = 0; i < maxLength; i++) {
      if (attentionMask[i] === 1) {
        for (let j = 0; j < embeddingDim; j++) {
          meanEmbedding[j] += embeddings[i * embeddingDim + j];
        }
        validTokens++;
      }
    }
    
    const result = meanEmbedding.map(v => v / validTokens);
    const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
    return result.map(v => v / norm);
  }

  /**
   * 使用Hugging Face API生成Embedding
   */
  async generateHFEmbedding(text) {
    if (!this.embeddingModel) {
      throw new Error('HF模型未加载');
    }

    const result = await this.embeddingModel.featureExtraction({
      model: this.embeddingConfig.hfModel,
      inputs: text
    });
    
    return Array.isArray(result) ? result : Array.from(result);
  }

  /**
   * 使用FastText生成Embedding
   */
  async generateFastTextEmbedding(text) {
    if (!this.embeddingModel) {
      throw new Error('FastText模型未加载');
    }

    const vector = await this.embeddingModel.getSentenceVector(text);
    return Array.from(vector);
  }

  /**
   * 使用自定义API生成Embedding
   */
  async generateAPIEmbedding(text) {
    const config = this.embeddingConfig;
    
    if (!config.apiUrl || !config.apiKey) {
      throw new Error('未配置API');
    }

    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.apiModel,
        input: text,
        encoding_format: 'float'
      }),
      timeout: 10000
    });

    if (!response.ok) {
      throw new Error(`API错误 ${response.status}`);
    }

    const result = await response.json();
    const embedding = result.data?.[0]?.embedding;
    
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error('API返回无效数据');
    }
    
    return embedding;
  }

  /**
   * ═══════════════════════════════════════════════════════════════
   * 相似度计算
   * ═══════════════════════════════════════════════════════════════
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
   * ═══════════════════════════════════════════════════════════════
   * 存储和检索
   * ═══════════════════════════════════════════════════════════════
   */

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
    } catch (error) {
      BotUtil.makeLog('debug', `[${this.name}] 存储失败: ${error.message}`, 'AIStream');
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

      let scored = [];
      
      if (this.embeddingConfig.provider === 'lightweight') {
        // BM25算法
        const documents = parsedMessages.map(m => m.message);
        this.similarityCalculator.calculateIDF(documents);
        
        scored = parsedMessages.map(data => ({
          message: data.message,
          similarity: this.similarityCalculator.score(query, data.message) / 10,
          time: data.time,
          userId: data.userId,
          nickname: data.nickname
        }));
      } else {
        // 向量相似度
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

      const filtered = scored.filter(s => s.similarity >= this.embeddingConfig.similarityThreshold);
      filtered.sort((a, b) => b.similarity - a.similarity);
      const results = filtered.slice(0, this.embeddingConfig.maxContexts);
      
      if (results.length > 0) {
        BotUtil.makeLog('debug', 
          `[${this.name}] 检索到 ${results.length} 条 (${(results[0].similarity * 100).toFixed(1)}%)`,
          'AIStream'
        );
      }
      
      return results;
    } catch (error) {
      BotUtil.makeLog('debug', `[${this.name}] 检索失败: ${error.message}`, 'AIStream');
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
          `${i + 1}. ${ctx.message.substring(0, 100)} (相关度: ${(ctx.similarity * 100).toFixed(0)}%)`
        ).join('\n'),
        '\n以上是相关历史对话，可参考但不要重复。\n'
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
        `[${this.name}] ✅ 检索到 ${relevantContexts.length} 条相关上下文`, 
        'AIStream'
      );

      return enhanced;
    } catch (error) {
      BotUtil.makeLog('debug', `[${this.name}] 构建上下文失败: ${error.message}`, 'AIStream');
      return baseMessages;
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════
   * 功能管理
   * ═══════════════════════════════════════════════════════════════
   */

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
        BotUtil.makeLog('debug', `功能解析失败[${func.name}]: ${error.message}`, 'AIStream');
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
      BotUtil.makeLog('debug', `功能执行失败[${type}]: ${error.message}`, 'AIStream');
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

  /**
   * ═══════════════════════════════════════════════════════════════
   * AI调用
   * ═══════════════════════════════════════════════════════════════
   */
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

  /**
   * ═══════════════════════════════════════════════════════════════
   * 执行工作流
   * ═══════════════════════════════════════════════════════════════
   */
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
      
      // 存储Bot回复
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

  /**
   * ═══════════════════════════════════════════════════════════════
   * 工具方法
   * ═══════════════════════════════════════════════════════════════
   */

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
        model: this.embeddingConfig.onnxModel || this.embeddingConfig.hfModel || this.embeddingConfig.apiModel,
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
    BotUtil.makeLog('info', `[${this.name}] 清理资源`, 'AIStream');
    
    if (this.embeddingSession) {
      this.embeddingSession = null;
    }
    
    if (this.embeddingModel && typeof this.embeddingModel.dispose === 'function') {
      try {
        await this.embeddingModel.dispose();
      } catch (error) {
        // 静默处理
      }
    }
    
    this.embeddingModel = null;
    this.embeddingReady = false;
    this.tokenizer = null;
  }
}