import BotUtil from '../util.js';
import cfg from '../config/config.js';
import { MemorySystem } from './memory.js';
import LLMFactory from '../factory/llm/LLMFactory.js';

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
    
    // 默认配置
    this.config = {
      enabled: true,
      baseUrl: '',
      apiKey: '',
      model: 'deepseek-r1-0528',
      chatModel: 'deepseek-r1-0528',
      temperature: 0.8,
      maxTokens: 6000,
      topP: 0.9,
      presencePenalty: 0.6,
      frequencyPenalty: 0.6,
      timeout: 30000,
      ...options.config
    };
    
    this.functionToggles = options.functionToggles || {};
    
    // 仅保留轻量 BM25 语义检索配置
    this.embeddingConfig = {
      enabled: options.embedding?.enabled ?? false,
      maxContexts: options.embedding?.maxContexts ?? 5,
      similarityThreshold: options.embedding?.similarityThreshold ?? 0.6,
      cacheExpiry: options.embedding?.cacheExpiry ?? 86400
    };

    this._initialized = false;
    this.similarityCalculator = new LightweightSimilarity();
    
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
    
    if (this.memorySystem && this.memorySystem.isEnabled() && cfg.masterQQ) {
      await this.memorySystem.initMasters(cfg.masterQQ || []).catch(() => {});
    }

    this._initialized = true;
  }

  /**
   * 初始化 Embedding（轻量 BM25，无外部依赖）
   */
  async initEmbedding() {
    if (!this.embeddingConfig.enabled) {
      return;
    }
    // 轻量 BM25 不需要额外初始化，预留扩展点
    this.similarityCalculator = this.similarityCalculator || new LightweightSimilarity();
  }


  /**
   * 存储和检索
   */
  async storeMessageWithEmbedding(groupId, message) {
    if (!this.embeddingConfig.enabled || !redis) {
      return;
    }

    try {
      const key = `ai:embedding:${this.name}:${groupId}`;
      const messageText = `${message.nickname}: ${message.message}`;

      const data = {
        message: messageText,
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
    if (!this.embeddingConfig.enabled || !redis) {
      return [];
    }

    if (!query) {
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
          if (data && typeof data.message === 'string') {
            parsedMessages.push(data);
          }
        } catch (e) {
          continue;
        }
      }

      if (parsedMessages.length === 0) {
        return [];
      }

      const documents = parsedMessages.map(m => m.message);
      this.similarityCalculator.calculateIDF(documents);

      const scored = parsedMessages.map(data => ({
        message: data.message,
        similarity: this.similarityCalculator.score(query, data.message) / 10,
        time: data.time,
        userId: data.userId,
        nickname: data.nickname
      }));

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
    if (!this.embeddingConfig.enabled) {
      return baseMessages;
    }

    const groupId = e.group_id || `private_${e.user_id}`;
    const query = typeof question === 'string' ? question : 
                  (question && question.content || question && question.text || '');

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

      if (enhanced[0] && enhanced[0].role === 'system') {
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
    return (func && func.enabled) ?? false;
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
    if (!text || !functions || !functions.length) {
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

      const rawLength = fn.raw && fn.raw.length || 0;
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
        if (result && result.type === 'text' && result.content) {
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
    if (!e || !e.isGroup) return false;
    if (e.isMaster) return true;

    try {
      const member = e.group && e.group.pickMember(e.self_id);
      const info = member ? await member.getInfo().catch(() => null) : null;
      const role = info && info.role || 'member';

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
   * 获取默认运营商（优先使用配置中的defaultProvider，否则使用LLMFactory的统一方法）
   * @returns {string} 默认运营商名称
   */
  _getDefaultProvider() {
    try {
      const aistreamConfig = global.cfg?.aistream || {};
      const configuredProvider = aistreamConfig.defaultProvider;
      
      if (configuredProvider && LLMFactory.hasProvider(configuredProvider)) {
        const providerConfig = LLMFactory.getProviderConfig(configuredProvider);
        if (providerConfig.enabled !== false) {
          return configuredProvider;
        }
      }
    } catch (error) {
      BotUtil.makeLog('debug', `[AIStream] 读取配置失败: ${error.message}`, 'AIStream');
    }
    
    return LLMFactory.getDefaultProvider();
  }

  /**
   * 从baseUrl推断运营商
   * @param {string} baseUrl - API基础地址
   * @returns {string|null} 推断的运营商名称
   */
  _inferProviderFromBaseUrl(baseUrl) {
    if (!baseUrl) return null;
    
    const url = baseUrl.toLowerCase();
    if (url.includes('gptgod')) return 'gptgod';
    if (url.includes('volces') || url.includes('volcengine')) return 'volcengine';
    if (url.includes('xiaomimimo')) return 'xiaomimimo';
    if (url.includes('openai.com')) return 'openai';
    if (url.includes('anthropic') || url.includes('claude')) return 'anthropic';
    if (url.includes('gemini') || url.includes('google')) return 'gemini';
    if (url.includes('azure')) return 'azure_openai';
    return 'openai_compat'; // 默认使用兼容模式
  }

  /**
   * 获取LLM客户端（直接使用LLMFactory）
   * @param {Object} apiConfig - 用户配置，可包含 provider 字段选择运营商
   * @returns {Object} LLM客户端实例
   */
  _getLLMClient(apiConfig = {}) {
    const userConfig = apiConfig || {};
    const baseConfig = { ...this.config };
    
    // 确定provider优先级：用户配置 > baseConfig配置 > 从baseUrl推断 > 默认运营商
    let provider = userConfig.provider || baseConfig.provider;
    
    if (!provider) {
      const baseUrl = userConfig.baseUrl || baseConfig.baseUrl;
      provider = this._inferProviderFromBaseUrl(baseUrl);
    }
    
    if (!provider || !LLMFactory.hasProvider(provider)) {
      provider = this._getDefaultProvider();
    }
    
    // 构建LLM配置（LLMFactory会自动从配置系统读取provider配置并合并）
    const llmConfig = {
      provider: provider.toLowerCase(),
      baseUrl: userConfig.baseUrl || baseConfig.baseUrl,
      apiKey: userConfig.apiKey || baseConfig.apiKey,
      model: userConfig.model || userConfig.chatModel || baseConfig.model || baseConfig.chatModel,
      chatModel: userConfig.chatModel || baseConfig.chatModel || baseConfig.model,
      temperature: userConfig.temperature ?? baseConfig.temperature,
      maxTokens: userConfig.maxTokens ?? userConfig.max_tokens ?? baseConfig.maxTokens,
      max_tokens: userConfig.maxTokens ?? userConfig.max_tokens ?? baseConfig.maxTokens,
      topP: userConfig.topP ?? userConfig.top_p ?? baseConfig.topP,
      top_p: userConfig.topP ?? userConfig.top_p ?? baseConfig.topP,
      presencePenalty: userConfig.presencePenalty ?? userConfig.presence_penalty ?? baseConfig.presencePenalty,
      presence_penalty: userConfig.presencePenalty ?? userConfig.presence_penalty ?? baseConfig.presencePenalty,
      frequencyPenalty: userConfig.frequencyPenalty ?? userConfig.frequency_penalty ?? baseConfig.frequencyPenalty,
      frequency_penalty: userConfig.frequencyPenalty ?? userConfig.frequency_penalty ?? baseConfig.frequencyPenalty,
      timeout: userConfig.timeout ?? baseConfig.timeout ?? 30000,
      ...userConfig
    };
    
    return LLMFactory.createClient(llmConfig);
  }

  /**
   * 调用AI（非流式）- 直接使用LLMFactory
   * @param {Array} messages - 消息数组
   * @param {Object} apiConfig - API配置
   * @returns {Promise<string|null>} AI回复文本
   */
  async callAI(messages, apiConfig = {}) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      BotUtil.makeLog('warn', '[AIStream] 消息数组为空', 'AIStream');
      return null;
    }

    try {
      // 直接使用LLMFactory创建客户端（会自动从配置系统读取配置）
      const client = this._getLLMClient(apiConfig);
      
      // 构建overrides配置（只传递需要覆盖的参数）
      const overrides = {};
      if (apiConfig.temperature !== undefined) {
        overrides.temperature = apiConfig.temperature;
      }
      if (apiConfig.maxTokens !== undefined || apiConfig.max_tokens !== undefined) {
        overrides.max_tokens = apiConfig.maxTokens ?? apiConfig.max_tokens;
      }
      if (apiConfig.topP !== undefined || apiConfig.top_p !== undefined) {
        overrides.top_p = apiConfig.topP ?? apiConfig.top_p;
      }
      if (apiConfig.presencePenalty !== undefined || apiConfig.presence_penalty !== undefined) {
        overrides.presence_penalty = apiConfig.presencePenalty ?? apiConfig.presence_penalty;
      }
      if (apiConfig.frequencyPenalty !== undefined || apiConfig.frequency_penalty !== undefined) {
        overrides.frequency_penalty = apiConfig.frequencyPenalty ?? apiConfig.frequency_penalty;
      }
      
      // 调用客户端的chat方法
      const result = await client.chat(messages, overrides);
      return result || null;
    } catch (error) {
      BotUtil.makeLog('error', 
        `[AIStream] AI调用失败: ${error.message}`, 
        'AIStream'
      );
      return null;
    }
  }

  /**
   * 调用AI（流式）- 直接使用LLMFactory
   * @param {Array} messages - 消息数组
   * @param {Object} apiConfig - API配置
   * @param {Function} onDelta - 流式数据回调
   * @returns {Promise<void>}
   */
  async callAIStream(messages, apiConfig = {}, onDelta) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      BotUtil.makeLog('warn', '[AIStream] 消息数组为空', 'AIStream');
      onDelta?.('[ERROR] 消息数组为空');
      return;
    }

    if (typeof onDelta !== 'function') {
      BotUtil.makeLog('warn', '[AIStream] onDelta回调函数未提供', 'AIStream');
      return;
    }

    try {
      const client = this._getLLMClient(apiConfig);
      
      if (typeof client.chatStream !== 'function') {
        throw new Error('LLM客户端不支持流式调用');
      }
      
      const overrides = { stream: true };
      const { temperature, maxTokens, max_tokens, topP, top_p, presencePenalty, presence_penalty, frequencyPenalty, frequency_penalty } = apiConfig;
      
      if (temperature !== undefined) overrides.temperature = temperature;
      if (maxTokens !== undefined || max_tokens !== undefined) overrides.max_tokens = maxTokens ?? max_tokens;
      if (topP !== undefined || top_p !== undefined) overrides.top_p = topP ?? top_p;
      if (presencePenalty !== undefined || presence_penalty !== undefined) overrides.presence_penalty = presencePenalty ?? presence_penalty;
      if (frequencyPenalty !== undefined || frequency_penalty !== undefined) overrides.frequency_penalty = frequencyPenalty ?? frequency_penalty;
      
      await client.chatStream(messages, onDelta, overrides);
    } catch (error) {
      BotUtil.makeLog('error', `[AIStream] AI流式调用失败: ${error.message}`, 'AIStream');
      onDelta?.(`[ERROR] ${error.message}`);
    }
  }

  async execute(e, question, config) {
    try {
      const userConfig = config || {};
      const finalConfig = { 
        ...this.config, 
        ...userConfig 
      };
      
      const context = { e, question, config: finalConfig };
      const baseMessages = await this.buildChatContext(e, question);
      const messages = await this.buildEnhancedContext(e, question, baseMessages);
      
      const response = await this.callAI(messages, userConfig);
      
      if (!response) {
        return null;
      }
      
      const preprocessed = await this.preprocessResponse(response, context);
      const parseSource = preprocessed ?? response;
      
      const { timeline, cleanText: parsedText } = this.parseFunctions(parseSource, context);
      const actionTimeline = timeline && timeline.length ? timeline : [{ type: 'text', content: parsedText || response }];
      let cleanText = await this.runActionTimeline(actionTimeline, context);
      if (!cleanText && parsedText) {
        cleanText = parsedText;
      }
      
      if (e && e.isGroup && cleanText) {
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
          nickname: Bot.nickname || 'Bot',
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
        provider: 'bm25',
        ready: this.embeddingConfig.enabled,
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
    if (!this.memorySystem || !this.memorySystem.isEnabled()) {
      return '';
    }
    return await this.memorySystem.buildSummary(e, options);
  }

  async cleanup() {
    BotUtil.makeLog('debug', `[${this.name}] 清理资源`, 'AIStream');
    this._initialized = false;
  }
}