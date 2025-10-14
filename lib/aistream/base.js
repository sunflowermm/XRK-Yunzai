import fetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import BotUtil from '../common/util.js';

/**
 * 轻量级文本相似度计算器（BM25算法）
 * 零依赖降级方案
 */
class LightweightSimilarity {
  constructor() {
    this.idf = new Map();
    this.avgDocLength = 0;
    this.k1 = 1.5;
    this.b = 0.75;
  }

  tokenize(text) {
    // 中文字符级 + bigram
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
    
    // Embedding配置
    this.embeddingConfig = {
      enabled: false,
      provider: 'onnx', // onnx | hf | fasttext | api | lightweight
      maxContexts: 5,
      similarityThreshold: 0.6,
      cacheExpiry: 86400,
      cachePath: path.join(process.cwd(), 'data/models'),
      
      // ONNX Runtime 配置
      onnxModel: 'Xenova/all-MiniLM-L6-v2',
      onnxQuantized: true,
      
      // Hugging Face Inference API 配置
      hfToken: null,
      hfModel: 'sentence-transformers/all-MiniLM-L6-v2',
      
      // FastText 配置
      fasttextModel: 'cc.zh.300.bin',
      
      // 自定义 API 配置
      apiUrl: null,
      apiKey: null,
      apiModel: 'text-embedding-3-small',
      
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
      this.embeddingSession = null;
      this.tokenizer = null;
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

    BotUtil.makeLog('info', `[${this.name}] 🚀 初始化Embedding (${this.embeddingConfig.provider})...`, 'AIStream');

    try {
      switch (this.embeddingConfig.provider) {
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
          throw new Error(`未知提供商: ${this.embeddingConfig.provider}`);
      }
      
      BotUtil.makeLog('success', `[${this.name}] ✅ Embedding初始化成功`, 'AIStream');
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] ❌ Embedding初始化失败: ${error.message}`, 'AIStream');
      
      // 降级策略链
      const fallbackChain = ['onnx', 'hf', 'fasttext', 'api', 'lightweight'];
      const currentIndex = fallbackChain.indexOf(this.embeddingConfig.provider);
      
      for (let i = currentIndex + 1; i < fallbackChain.length; i++) {
        const fallbackProvider = fallbackChain[i];
        BotUtil.makeLog('info', `[${this.name}] 🔄 尝试降级到 ${fallbackProvider}...`, 'AIStream');
        
        try {
          this.embeddingConfig.provider = fallbackProvider;
          
          switch (fallbackProvider) {
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
            case 'lightweight':
              await this.initLightweightEmbedding();
              break;
          }
          
          BotUtil.makeLog('success', `[${this.name}] ✅ 已降级到 ${fallbackProvider}`, 'AIStream');
          return;
        } catch (fallbackError) {
          BotUtil.makeLog('warn', `[${this.name}] ⚠️ ${fallbackProvider} 降级失败: ${fallbackError.message}`, 'AIStream');
        }
      }
      
      // 所有方案都失败
      this.embeddingConfig.enabled = false;
      this.embeddingReady = false;
      throw new Error('所有Embedding方案都失败，已禁用功能');
    }
  }

  /**
   * 初始化轻量级Embedding（BM25算法，零依赖）
   */
  async initLightweightEmbedding() {
    BotUtil.makeLog('info', `[${this.name}] 📝 使用轻量级BM25算法（零依赖）`, 'AIStream');
    
    this.similarityCalculator = new LightweightSimilarity();
    this.embeddingReady = true;
    
    BotUtil.makeLog('success', `[${this.name}] ✅ 轻量级模式就绪`, 'AIStream');
  }

  /**
   * 初始化ONNX Runtime Embedding（推荐方案）
   */
  async initONNXEmbedding() {
    BotUtil.makeLog('info', `[${this.name}] 📦 加载 ONNX Runtime...`, 'AIStream');
    
    try {
      const ort = await import('onnxruntime-node');
      
      const modelName = this.embeddingConfig.onnxModel || 'Xenova/all-MiniLM-L6-v2';
      BotUtil.makeLog('info', `[${this.name}] 🤖 加载模型: ${modelName}`, 'AIStream');
      
      // 确保缓存目录存在
      const cachePath = this.embeddingConfig.cachePath;
      if (!fs.existsSync(cachePath)) {
        fs.mkdirSync(cachePath, { recursive: true });
      }
      
      // 下载或加载模型
      const modelPath = await this.downloadONNXModel(modelName);
      
      BotUtil.makeLog('info', `[${this.name}] ⏳ 加载模型文件...`, 'AIStream');
      const startTime = Date.now();
      
      this.embeddingSession = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all'
      });
      
      // 加载tokenizer
      await this.loadONNXTokenizer(modelName);
      
      const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
      this.embeddingReady = true;
      
      BotUtil.makeLog('success', `[${this.name}] ✅ ONNX模型就绪 (耗时: ${loadTime}秒)`, 'AIStream');
      
      // 测试模型
      await this.testEmbeddingModel();
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] ❌ ONNX加载失败: ${error.message}`, 'AIStream');
      
      if (error.message.includes('Cannot find module')) {
        BotUtil.makeLog('info', `[${this.name}] 💡 安装: pnpm add onnxruntime-node -w`, 'AIStream');
      }
      
      throw error;
    }
  }

  /**
   * 下载ONNX模型
   */
  async downloadONNXModel(modelName) {
    const cachePath = this.embeddingConfig.cachePath;
    const modelDir = path.join(cachePath, modelName.replace('/', '_'));
    const modelPath = path.join(modelDir, 'model_quantized.onnx');
    
    // 如果模型已存在，直接返回
    if (fs.existsSync(modelPath)) {
      BotUtil.makeLog('debug', `[${this.name}] 📂 使用缓存模型: ${modelPath}`, 'AIStream');
      return modelPath;
    }
    
    // 创建模型目录
    if (!fs.existsSync(modelDir)) {
      fs.mkdirSync(modelDir, { recursive: true });
    }
    
    // 下载模型
    BotUtil.makeLog('info', `[${this.name}] ⬇️ 下载模型 (约20-50MB)...`, 'AIStream');
    
    const modelUrl = `https://huggingface.co/${modelName}/resolve/main/onnx/model_quantized.onnx`;
    
    try {
      const response = await fetch(modelUrl);
      if (!response.ok) {
        throw new Error(`下载失败: ${response.status}`);
      }
      
      const buffer = await response.arrayBuffer();
      fs.writeFileSync(modelPath, Buffer.from(buffer));
      
      BotUtil.makeLog('success', `[${this.name}] ✅ 模型下载完成`, 'AIStream');
      return modelPath;
    } catch (error) {
      throw new Error(`模型下载失败: ${error.message}`);
    }
  }

  /**
   * 加载ONNX Tokenizer（简化版）
   */
  async loadONNXTokenizer(modelName) {
    // 简化的tokenizer，使用字符级分词
    this.tokenizer = {
      encode: (text) => {
        // 简单的字符级tokenization
        const tokens = text.split('').map(c => c.charCodeAt(0));
        return tokens.slice(0, 512); // 限制长度
      }
    };
    
    BotUtil.makeLog('debug', `[${this.name}] ✅ Tokenizer就绪`, 'AIStream');
  }

  /**
   * 初始化Hugging Face Inference API
   */
  async initHFEmbedding() {
    const config = this.embeddingConfig;
    
    if (!config.hfToken) {
      throw new Error('未配置Hugging Face Token (需要 hfToken)');
    }

    BotUtil.makeLog('info', `[${this.name}] 🤗 配置 Hugging Face API...`, 'AIStream');
    BotUtil.makeLog('info', `[${this.name}] 🔑 使用模型: ${config.hfModel}`, 'AIStream');
    
    try {
      // 动态导入
      const { HfInference } = await import('@huggingface/inference');
      this.embeddingModel = new HfInference(config.hfToken);
      
      // 测试连接
      await this.testHFConnection();
      this.embeddingReady = true;
      
      BotUtil.makeLog('success', `[${this.name}] ✅ HF API就绪 (免费)`, 'AIStream');
    } catch (error) {
      if (error.message.includes('Cannot find module')) {
        BotUtil.makeLog('info', `[${this.name}] 💡 安装: pnpm add @huggingface/inference -w`, 'AIStream');
      }
      throw error;
    }
  }

  /**
   * 初始化FastText
   */
  async initFastTextEmbedding() {
    BotUtil.makeLog('info', `[${this.name}] 📚 加载 FastText...`, 'AIStream');
    
    try {
      const FastText = await import('fasttext.js');
      
      const modelName = this.embeddingConfig.fasttextModel || 'cc.zh.300.bin';
      const modelPath = path.join(this.embeddingConfig.cachePath, modelName);
      
      if (!fs.existsSync(modelPath)) {
        BotUtil.makeLog('info', `[${this.name}] ⬇️ 下载FastText模型...`, 'AIStream');
        await this.downloadFastTextModel(modelName);
      }
      
      BotUtil.makeLog('info', `[${this.name}] ⏳ 加载模型...`, 'AIStream');
      const startTime = Date.now();
      
      this.embeddingModel = new FastText.FastText();
      await this.embeddingModel.load(modelPath);
      
      const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
      this.embeddingReady = true;
      
      BotUtil.makeLog('success', `[${this.name}] ✅ FastText就绪 (耗时: ${loadTime}秒)`, 'AIStream');
      
      // 测试模型
      await this.testEmbeddingModel();
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] ❌ FastText加载失败: ${error.message}`, 'AIStream');
      
      if (error.message.includes('Cannot find module')) {
        BotUtil.makeLog('info', `[${this.name}] 💡 安装: pnpm add fasttext.js -w`, 'AIStream');
      }
      
      throw error;
    }
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
    
    // FastText官方模型URL
    const modelUrl = `https://dl.fbaipublicfiles.com/fasttext/vectors-crawl/${modelName}`;
    
    BotUtil.makeLog('info', `[${this.name}] ⬇️ 下载FastText模型 (约500MB，请耐心等待)...`, 'AIStream');
    
    try {
      const response = await fetch(modelUrl);
      if (!response.ok) {
        throw new Error(`下载失败: ${response.status}`);
      }
      
      const buffer = await response.arrayBuffer();
      fs.writeFileSync(modelPath, Buffer.from(buffer));
      
      BotUtil.makeLog('success', `[${this.name}] ✅ 模型下载完成`, 'AIStream');
    } catch (error) {
      throw new Error(`模型下载失败: ${error.message}`);
    }
  }

  /**
   * 初始化自定义API Embedding
   */
  async initAPIEmbedding() {
    const config = this.embeddingConfig;
    
    if (!config.apiUrl || !config.apiKey) {
      throw new Error('未配置Embedding API (需要 apiUrl 和 apiKey)');
    }

    BotUtil.makeLog('info', `[${this.name}] 🌐 配置API: ${config.apiUrl}`, 'AIStream');
    BotUtil.makeLog('info', `[${this.name}] 🔑 使用模型: ${config.apiModel}`, 'AIStream');
    
    // 测试API连接
    await this.testAPIConnection();
    this.embeddingReady = true;
    
    BotUtil.makeLog('success', `[${this.name}] ✅ API连接成功`, 'AIStream');
  }

  /**
   * 测试Embedding模型
   */
  async testEmbeddingModel() {
    try {
      BotUtil.makeLog('debug', `[${this.name}] 🧪 测试模型...`, 'AIStream');
      const vector = await this.generateEmbedding('测试文本');
      
      if (!vector || !Array.isArray(vector) || vector.length === 0) {
        throw new Error('模型返回无效向量');
      }
      
      BotUtil.makeLog('success', `[${this.name}] ✅ 模型测试通过 (维度: ${vector.length})`, 'AIStream');
    } catch (error) {
      throw new Error(`模型测试失败: ${error.message}`);
    }
  }

  /**
   * 测试HF API连接
   */
  async testHFConnection() {
    try {
      const testVector = await this.generateHFEmbedding('test');
      if (!testVector || !Array.isArray(testVector) || testVector.length === 0) {
        throw new Error('HF API返回无效向量');
      }
      BotUtil.makeLog('debug', `[${this.name}] ✅ HF测试通过 (维度: ${testVector.length})`, 'AIStream');
    } catch (error) {
      throw new Error(`HF测试失败: ${error.message}`);
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
      BotUtil.makeLog('debug', `[${this.name}] ✅ API测试通过 (维度: ${testVector.length})`, 'AIStream');
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
      BotUtil.makeLog('warn', `[${this.name}] ⚠️ Embedding未就绪`, 'AIStream');
      return null;
    }

    try {
      switch (this.embeddingConfig.provider) {
        case 'lightweight':
          // 轻量级模式：返回文本本身
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
      BotUtil.makeLog('error', `[${this.name}] ❌ 生成Embedding失败: ${error.message}`, 'AIStream');
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

    try {
      const ort = await import('onnxruntime-node');
      
      // Tokenize
      const inputIds = this.tokenizer.encode(text);
      const attentionMask = new Array(inputIds.length).fill(1);
      
      // 填充到固定长度
      const maxLength = 512;
      while (inputIds.length < maxLength) {
        inputIds.push(0);
        attentionMask.push(0);
      }
      
      // 创建tensor
      const inputIdsTensor = new ort.Tensor('int64', BigInt64Array.from(inputIds.map(id => BigInt(id))), [1, maxLength]);
      const attentionMaskTensor = new ort.Tensor('int64', BigInt64Array.from(attentionMask.map(m => BigInt(m))), [1, maxLength]);
      
      // 运行推理
      const feeds = {
        input_ids: inputIdsTensor,
        attention_mask: attentionMaskTensor
      };
      
      const results = await this.embeddingSession.run(feeds);
      const outputTensor = results[Object.keys(results)[0]];
      
      // 提取embedding (mean pooling)
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
      
      // 平均化
      const result = meanEmbedding.map(v => v / validTokens);
      
      // 归一化
      const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
      return result.map(v => v / norm);
    } catch (error) {
      throw new Error(`ONNX生成失败: ${error.message}`);
    }
  }

  /**
   * 使用Hugging Face API生成Embedding
   */
  async generateHFEmbedding(text) {
    if (!this.embeddingModel) {
      throw new Error('HF模型未加载');
    }

    try {
      const result = await this.embeddingModel.featureExtraction({
        model: this.embeddingConfig.hfModel,
        inputs: text
      });
      
      // HF API返回的是数组，需要提取
      const embedding = Array.isArray(result) ? result : Array.from(result);
      return embedding;
    } catch (error) {
      if (error.message.includes('Rate limit')) {
        throw new Error('HF API速率限制，请稍后重试');
      }
      throw new Error(`HF生成失败: ${error.message}`);
    }
  }

  /**
   * 使用FastText生成Embedding
   */
  async generateFastTextEmbedding(text) {
    if (!this.embeddingModel) {
      throw new Error('FastText模型未加载');
    }

    try {
      // FastText生成句子向量
      const vector = await this.embeddingModel.getSentenceVector(text);
      return Array.from(vector);
    } catch (error) {
      throw new Error(`FastText生成失败: ${error.message}`);
    }
  }

  /**
   * 使用自定义API生成Embedding
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
          model: config.apiModel || 'text-embedding-3-small',
          input: text,
          encoding_format: 'float'
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
      
      BotUtil.makeLog('debug', `[${this.name}] 💾 已存储: ${messageText.substring(0, 30)}...`, 'AIStream');
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] ❌ 存储失败: ${error.message}`, 'AIStream');
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
        // 向量模式：使用余弦相似度
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
          `[${this.name}] 🔍 检索到 ${results.length} 条相关上下文 (最高: ${(results[0].similarity * 100).toFixed(1)}%)`,
          'AIStream'
        );
      }
      
      return results;
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] ❌ 检索失败: ${error.message}`, 'AIStream');
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
      BotUtil.makeLog('error', `[${this.name}] ❌ 构建上下文失败: ${error.message}`, 'AIStream');
      return baseMessages;
    }
  }

  // ========== 功能管理 ==========

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

    BotUtil.makeLog('debug', `[${this.name}] 📝 注册功能: ${name}`, 'AIStream');
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
        BotUtil.makeLog('error', `❌ 功能解析失败[${func.name}]: ${error.message}`, 'AIStream');
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
      BotUtil.makeLog('error', `❌ 功能执行失败[${type}]: ${error.message}`, 'AIStream');
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
      BotUtil.makeLog('error', `❌ AI调用失败: ${error.message}`, 'AIStream');
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
      
      // 存储Bot的回复
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
      BotUtil.makeLog('error', `❌ 工作流执行失败[${this.name}]: ${error.message}`, 'AIStream');
      return null;
    }
  }

  async process(e, question, apiConfig = {}) {
    try {
      return await this.execute(e, question, apiConfig);
    } catch (error) {
      BotUtil.makeLog('error', `❌ 工作流处理失败[${this.name}]: ${error.message}`, 'AIStream');
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
    BotUtil.makeLog('info', `[${this.name}] 🧹 清理资源...`, 'AIStream');
    
    // 清理ONNX Session
    if (this.embeddingSession) {
      try {
        // ONNX Runtime的session没有显式dispose方法，让GC处理
        this.embeddingSession = null;
        BotUtil.makeLog('debug', `[${this.name}] ✅ ONNX Session已释放`, 'AIStream');
      } catch (error) {
        BotUtil.makeLog('warn', `[${this.name}] ⚠️ 释放失败: ${error.message}`, 'AIStream');
      }
    }
    
    // 清理其他模型
    if (this.embeddingModel && typeof this.embeddingModel.dispose === 'function') {
      try {
        await this.embeddingModel.dispose();
        BotUtil.makeLog('debug', `[${this.name}] ✅ 模型已释放`, 'AIStream');
      } catch (error) {
        BotUtil.makeLog('warn', `[${this.name}] ⚠️ 释放失败: ${error.message}`, 'AIStream');
      }
    }
    
    this.embeddingModel = null;
    this.embeddingReady = false;
    this.tokenizer = null;
    
    BotUtil.makeLog('success', `[${this.name}] ✅ 清理完成`, 'AIStream');
  }
}