import fetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import BotUtil from '../common/util.js';
import cfg from '../config/config.js';
import { MemorySystem } from './memory.js';

/**
 * 轻量级文本相似度计算器（BM25算法）
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
 * 
 * 提供统一的AI调用、记忆系统、功能管理等能力。
 * 所有工作流都应继承此类。
 * 
 * 文件路径: lib/aistream/aistream.js
 * 工作流存放路径: plugins/stream/
 * 
 * @class AIStream
 * @example
 * import AIStream from '../../lib/aistream/aistream.js';
 * 
 * export default class MyWorkflow extends AIStream {
 *   constructor() {
 *     super({
 *       name: 'my-workflow',
 *       description: '我的工作流'
 *     });
 *   }
 * 
 *   buildSystemPrompt(context) {
 *     return '系统提示';
 *   }
 * 
 *   async buildChatContext(e, question) {
 *     return [
 *       { role: 'system', content: this.buildSystemPrompt({ e, question }) },
 *       { role: 'user', content: question }
 *     ];
 *   }
 * }
 */
export default class AIStream {
  constructor(options = {}) {
    this.name = options.name || 'base-stream';
    this.description = options.description || '基础工作流';
    this.version = options.version || '1.0.0';
    this.author = options.author || 'unknown';
    this.priority = options.priority || 100;
    
    const kuizaiConfig = cfg.kuizai?.ai || {};
    this.config = {
      enabled: kuizaiConfig.enabled !== false,
      baseUrl: kuizaiConfig.baseUrl || '',
      apiKey: kuizaiConfig.apiKey || '',
      model: kuizaiConfig.chatModel || 'deepseek-r1-0528',
      chatModel: kuizaiConfig.chatModel || 'deepseek-r1-0528',
      temperature: kuizaiConfig.temperature || 0.8,
      maxTokens: kuizaiConfig.max_tokens || 6000,
      topP: kuizaiConfig.top_p || 0.9,
      presencePenalty: kuizaiConfig.presence_penalty || 0.6,
      frequencyPenalty: kuizaiConfig.frequency_penalty || 0.6,
      timeout: kuizaiConfig.timeout || 30000,
      ...options.config
    };
    
    this.functionToggles = options.functionToggles || {};
    
    this.embeddingConfig = {
      enabled: false,
      provider: 'lightweight',
      maxContexts: 5,
      similarityThreshold: 0.6,
      cacheExpiry: 86400,
      cachePath: path.join(process.cwd(), 'data/models'),
      onnxModel: 'Xenova/all-MiniLM-L6-v2',
      onnxQuantized: true,
      hfToken: null,
      hfModel: 'sentence-transformers/all-MiniLM-L6-v2',
      fasttextModel: 'cc.zh.300.bin',
      apiUrl: null,
      apiKey: null,
      apiModel: 'text-embedding-3-small',
      ...options.embedding
    };

    this._initialized = false;
    this._embeddingInitialized = false;
    
    this.memorySystem = new MemorySystem({
      baseKey: `ai:memory:${this.name}`,
      maxPerOwner: 60,
      longTTL: 3 * 24 * 60 * 60 * 1000,
      shortTTL: 24 * 60 * 60 * 1000
    });
  }

  async init() {
    if (this._initialized) {
      return;
    }

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

    if (this.memorySystem?.isEnabled() && cfg.masterQQ) {
      await this.memorySystem.initMasters(cfg.masterQQ || []).catch(() => {});
    }

    this._initialized = true;
  }

  /**
   * 初始化Embedding（带防重复保护）
   */
  async initEmbedding() {
    if (!this.embeddingConfig.enabled) {
      return;
    }

    if (this._embeddingInitialized && this.embeddingReady) {
      return;
    }

    const provider = this.embeddingConfig.provider;

    try {
      await this.tryInitProvider(provider);
      this.embeddingReady = true;
      this._embeddingInitialized = true;
    } catch (error) {
      // 降级到lightweight
      if (provider !== 'lightweight') {
        BotUtil.makeLog('debug', 
          `[${this.name}] ${provider}失败，降级到lightweight`, 
          'AIStream'
        );
        try {
          this.embeddingConfig.provider = 'lightweight';
          await this.initLightweightEmbedding();
          this.embeddingReady = true;
          this._embeddingInitialized = true;
          return;
        } catch (fallbackError) {
        }
      }
      
      this.embeddingConfig.enabled = false;
      this.embeddingReady = false;
      throw new Error('Embedding初始化失败');
    }
  }

  /**
   * 尝试初始化指定提供商
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
   * 各种Embedding提供商初始化
   */
  async initLightweightEmbedding() {
    this.similarityCalculator = new LightweightSimilarity();
  }

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
    await this.testEmbeddingModel();
  }

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

  async loadONNXTokenizer(modelName) {
    this.tokenizer = {
      encode: (text) => {
        const tokens = text.split('').map(c => c.charCodeAt(0));
        return tokens.slice(0, 512);
      }
    };
  }

  async initHFEmbedding() {
    const config = this.embeddingConfig;
    
    if (!config.hfToken) {
      throw new Error('未配置HF Token');
    }

    const { HfInference } = await import('@huggingface/inference');
    this.embeddingModel = new HfInference(config.hfToken);
    
    await this.testHFConnection();
  }

  async initFastTextEmbedding() {
    const FastText = await import('fasttext.js');
    
    const modelName = this.embeddingConfig.fasttextModel;
    const modelPath = path.join(this.embeddingConfig.cachePath, modelName);
    
    if (!fs.existsSync(modelPath)) {
      await this.downloadFastTextModel(modelName);
    }
    
    this.embeddingModel = new FastText.FastText();
    await this.embeddingModel.load(modelPath);
    await this.testEmbeddingModel();
  }

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

  async initAPIEmbedding() {
    const config = this.embeddingConfig;
    
    if (!config.apiUrl || !config.apiKey) {
      throw new Error('未配置API');
    }

    await this.testAPIConnection();
  }

  /**
   * 测试方法
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
   * 生成Embedding向量
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
      BotUtil.makeLog('debug', 
        `[${this.name}] 生成Embedding失败: ${error.message}`, 
        'AIStream'
      );
      return null;
    }
  }

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

  async generateFastTextEmbedding(text) {
    if (!this.embeddingModel) {
      throw new Error('FastText模型未加载');
    }

    const vector = await this.embeddingModel.getSentenceVector(text);
    return Array.from(vector);
  }

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
   * 相似度计算
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
   * 存储和检索
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
      BotUtil.makeLog('debug', 
        `[${this.name}] 存储失败: ${error.message}`, 
        'AIStream'
      );
    }
  }

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
      return filtered.slice(0, this.embeddingConfig.maxContexts);
    } catch (error) {
      BotUtil.makeLog('debug', 
        `[${this.name}] 检索失败: ${error.message}`, 
        'AIStream'
      );
      return [];
    }
  }

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

      return enhanced;
    } catch (error) {
      BotUtil.makeLog('debug', 
        `[${this.name}] 构建上下文失败: ${error.message}`, 
        'AIStream'
      );
      return baseMessages;
    }
  }

  /**
   * 功能管理
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
        const result = func.parser(cleanText, context, text);
        if (result.functions && result.functions.length > 0) {
          for (const fn of result.functions) {
            if (!fn) continue;
            const normalized = {
              ...fn,
              raw: fn.raw || fn.token || ''
            };
            normalized.__seq = allFunctions.length;
            allFunctions.push(normalized);
          }
        }
        if (result.cleanText !== undefined) {
          cleanText = result.cleanText;
        }
      } catch (error) {
        BotUtil.makeLog('debug', 
          `功能解析失败[${func.name}]: ${error.message}`, 
          'AIStream'
        );
      }
    }

    this.assignFunctionPositions(text, allFunctions);
    const timeline = this.buildActionTimeline(text, allFunctions);
    const mergedText = this.mergeTextSegments(timeline);
    
    return { functions: allFunctions, cleanText: mergedText, timeline };
  }

  assignFunctionPositions(text, functions) {
    if (!text || !functions?.length) {
      return;
    }

    const usedRanges = [];
    const textLength = text.length;
    let fallbackIndex = textLength;

    for (const fn of functions) {
      if (typeof fn.position === 'number') {
        usedRanges.push({
          start: fn.position,
          end: fn.position + (fn.raw?.length || 0)
        });
        continue;
      }

      if (!fn.raw) {
        fn.position = fallbackIndex++;
        continue;
      }

      const position = this.findAvailablePosition(text, fn.raw, usedRanges);
      if (position >= 0) {
        fn.position = position;
        usedRanges.push({
          start: position,
          end: position + fn.raw.length
        });
      } else {
        fn.position = fallbackIndex++;
      }
    }
  }

  findAvailablePosition(text, raw, usedRanges) {
    let startIndex = 0;

    while (startIndex <= text.length) {
      const idx = text.indexOf(raw, startIndex);
      if (idx === -1) {
        return -1;
      }

      const end = idx + raw.length;
      const overlap = usedRanges.some(range => 
        Math.max(range.start, idx) < Math.min(range.end, end)
      );

      if (!overlap) {
        return idx;
      }

      startIndex = idx + 1;
    }

    return -1;
  }

  buildActionTimeline(text, functions = []) {
    if (!text) {
      return [];
    }

    if (!functions.length) {
      return [{ type: 'text', content: text }];
    }

    const sorted = [...functions].sort((a, b) => {
      const posA = typeof a.position === 'number' ? a.position : Number.MAX_SAFE_INTEGER;
      const posB = typeof b.position === 'number' ? b.position : Number.MAX_SAFE_INTEGER;
      if (posA === posB) {
        return (a.__seq ?? 0) - (b.__seq ?? 0);
      }
      return posA - posB;
    });

    const actions = [];
    let cursor = 0;

    for (const fn of sorted) {
      const start = typeof fn.position === 'number' ? Math.max(0, Math.min(fn.position, text.length)) : cursor;
      if (start > cursor) {
        actions.push({
          type: 'text',
          content: text.slice(cursor, start)
        });
      }

      actions.push({ type: 'function', data: fn });

      const rawLength = fn.raw?.length || 0;
      cursor = rawLength > 0 ? Math.max(cursor, start + rawLength) : start;
    }

    if (cursor < text.length) {
      actions.push({
        type: 'text',
        content: text.slice(cursor)
      });
    }

    return actions.length ? actions : [{ type: 'text', content: text }];
  }

  mergeTextSegments(timeline = []) {
    if (!timeline.length) return '';

    return timeline
      .filter(action => action.type === 'text' && action.content !== undefined)
      .map(action => action.content)
      .join('')
      .trim();
  }

  async runActionTimeline(timeline = [], context) {
    if (!timeline.length) return '';

    const textSegments = [];

    for (const action of timeline) {
      if (action.type === 'text') {
        if (action.content) {
          textSegments.push(action.content);
        }
        continue;
      }

      if (action.type === 'function' && action.data) {
        const result = await this.executeFunction(action.data.type, action.data.params, context);
        if (result && typeof result === 'object' && result.type === 'text' && result.content) {
          textSegments.push(result.content);
        } else if (typeof result === 'string') {
          textSegments.push(result);
        } else if (result && result.content) {
          textSegments.push(String(result.content));
        }
      }
    }

    return textSegments.join('').trim();
  }

  async executeFunction(type, params, context) {
    const func = this.functions.get(type);
    
    if (!func || !func.enabled) {
      return null;
    }
    
    if (func.permission && !(await this.checkPermission(func.permission, context))) {
      return null;
    }
    
    try {
      if (func.handler) {
        return await func.handler(params, context);
      }
    } catch (error) {
      BotUtil.makeLog('debug', 
        `功能执行失败[${type}]: ${error.message}`, 
        'AIStream'
      );
    }

    return null;
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
      if (typeof logger !== 'undefined') {
        logger.warn('[AI] 未配置AI API，返回空结果');
      }
      return {
        text: '',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
    }

    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: (apiConfig?.model ?? apiConfig?.chatModel ?? config.model ?? config.chatModel ?? 'gpt-3.5-turbo'),
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
      BotUtil.makeLog('error', 
        `AI调用失败: ${error.message}`, 
        'AIStream'
      );
      return null;
    }
  }

  async callAIStream(messages, apiConfig = {}, onDelta) {
    const config = { ...this.config, ...apiConfig };

    if (!config.baseUrl || !config.apiKey) {
      if (typeof logger !== 'undefined') {
        logger.warn('[AI] 未配置AI API，无法进行流式调用');
      }
      if (typeof onDelta === 'function') {
        onDelta('[ERROR] AI API未配置');
      }
      return;
    }

    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: (apiConfig?.model ?? apiConfig?.chatModel ?? config.model ?? config.chatModel ?? 'gpt-3.5-turbo'),
          messages,
          temperature: config.temperature,
          max_tokens: config.maxTokens,
          top_p: config.topP,
          presence_penalty: config.presencePenalty,
          frequency_penalty: config.frequencyPenalty,
          stream: true // 开启流式输出
        }),
        timeout: config.timeout || 30000
      });

      if (!response.ok) {
        throw new Error(`API错误: ${response.status}`);
      }

      for await (const chunk of response.body) {
        const lines = chunk.toString('utf8').split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.substring(6);
            if (data.trim() === '[DONE]') {
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content || '';
              if (delta && typeof onDelta === 'function') {
                onDelta(delta);
              }
            } catch (e) {
            }
          }
        }
      }
    } catch (error) {
      BotUtil.makeLog('error', `AI流式调用失败: ${error.message}`, 'AIStream');
      if (typeof onDelta === 'function') {
        onDelta(`[ERROR] ${error.message}`);
      }
    }
  }

  async execute(e, question, config) {
    try {
      const finalConfig = { ...this.config, ...cfg.kuizai?.ai, ...config };
      const context = { e, question, config: finalConfig };
      const baseMessages = await this.buildChatContext(e, question);
      const messages = await this.buildEnhancedContext(e, question, baseMessages);
      const response = await this.callAI(messages, finalConfig);
      
      if (!response) {
        return null;
      }
      
      const preprocessed = await this.preprocessResponse(response, context);
      const parseSource = preprocessed ?? response;
      
      const { timeline, cleanText: parsedText } = this.parseFunctions(parseSource, context);
      const actionTimeline = timeline?.length ? timeline : [{ type: 'text', content: parsedText || response }];
      let cleanText = await this.runActionTimeline(actionTimeline, context);
      if (!cleanText && parsedText) {
        cleanText = parsedText;
      }
      
      if (e?.isGroup && cleanText && typeof this.recordBotReply === 'function') {
        try {
          await this.recordBotReply(e, cleanText);
        } catch (error) {
          BotUtil.makeLog('debug', `记录Bot回复失败: ${error.message}`, 'AIStream');
        }
      }
      
      if (this.embeddingConfig?.enabled && cleanText) {
        const groupId = e?.group_id || `private_${e?.user_id || ''}`;
        this.storeMessageWithEmbedding(groupId, {
          user_id: e?.self_id || 'Bot',
          nickname: (typeof Bot !== 'undefined' && Bot.nickname) || 'Bot',
          message: cleanText,
          message_id: Date.now().toString(),
          time: Date.now()
        }).catch(() => {});
      }
      
      return cleanText;
    } catch (error) {
      BotUtil.makeLog('error', 
        `工作流执行失败[${this.name}]: ${error.message}`, 
        'AIStream'
      );
      return null;
    }
  }

  async preprocessResponse(response, context) {
    return response;
  }

  async process(e, question, apiConfig = {}) {
    try {
      return await this.execute(e, question, apiConfig);
    } catch (error) {
      BotUtil.makeLog('error', 
        `工作流处理失败[${this.name}]: ${error.message}`, 
        'AIStream'
      );
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

  getMemorySystem() {
    return this.memorySystem;
  }

  async buildMemorySummary(e, options = {}) {
    if (!this.memorySystem?.isEnabled()) {
      return '';
    }
    return await this.memorySystem.buildSummary(e, options);
  }

  async cleanup() {
    BotUtil.makeLog('debug', `[${this.name}] 清理资源`, 'AIStream');
    
    if (this.embeddingSession) {
      this.embeddingSession = null;
    }
    
    if (this.embeddingModel && typeof this.embeddingModel.dispose === 'function') {
        try {
          await this.embeddingModel.dispose();
        } catch (error) {
        }
      }
    
    this.embeddingModel = null;
    this.embeddingReady = false;
    this.tokenizer = null;
    this._initialized = false;
    this._embeddingInitialized = false;
  }
}