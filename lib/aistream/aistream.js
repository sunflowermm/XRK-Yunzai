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

    if (!this.mcpTools) {
      this.mcpTools = new Map();
    }
    
    if (this.memorySystem && this.memorySystem.isEnabled() && cfg.masterQQ) {
      await this.memorySystem.initMasters(cfg.masterQQ || []).catch(() => {});
    }

    this._initialized = true;
  }

  /**
   * 注册 MCP 工具（与 registerFunction 并列）
   * @param {string} name - 工具名称
   * @param {Object} options - { handler, description?, inputSchema?, enabled? }
   */
  registerMCPTool(name, options = {}) {
    const {
      handler,
      description = '',
      inputSchema = {},
      enabled = true
    } = options;
    if (!this.mcpTools) this.mcpTools = new Map();
    this.mcpTools.set(name, {
      name,
      handler,
      description,
      inputSchema,
      enabled: this.functionToggles?.[name] ?? enabled
    });
  }

  /**
   * MCP 工具成功返回（供子类 handler 内使用，保证与 MCP 协议一致）
   * @param {Object} data - 返回数据，可包含 message、data 等
   * @returns {Object} { success: true, ...data }
   */
  successResponse(data = {}) {
    if (data && typeof data === 'object' && 'success' in data) return data;
    return { success: true, ...data };
  }

  /**
   * MCP 工具失败返回（供子类 handler 内使用）
   * @param {string} code - 错误码
   * @param {string} message - 错误信息
   * @returns {Object} { success: false, error: { code, message } }
   */
  errorResponse(code, message) {
    return { success: false, error: { code: code || 'ERROR', message: String(message || '') } };
  }

  /**
   * 初始化 Embedding（轻量 BM25，无外部依赖）
   */
  async initEmbedding() {
    if (!this.embeddingConfig.enabled) return;
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
        return await func.handler.call(this, params, context);
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
   * 获取默认运营商（使用 LLMFactory 第一个启用的运营商）
   * @returns {string} 默认运营商名称
   */
  _getDefaultProvider() {
    return LLMFactory.getDefaultProvider();
  }

  /**
   * 获取重试配置
   * @returns {Object}
   */
  getRetryConfig() {
    const aistreamConfig = global.cfg?.aistream || {};
    const llm = aistreamConfig.llm || {};
    const retryConfig = llm.retry || {};
    return {
      enabled: retryConfig.enabled !== false,
      maxAttempts: retryConfig.maxAttempts || 3,
      delay: retryConfig.delay || 2000,
      maxDelay: retryConfig.maxDelay || 10000,
      backoffMultiplier: retryConfig.backoffMultiplier || 2,
      retryOn: retryConfig.retryOn || ['timeout', 'network', '5xx', 'rate_limit']
    };
  }

  /**
   * 计算重试延迟（指数退避）
   * @param {number} attempt - 重试次数
   * @param {Object} retryConfig - 重试配置
   * @returns {number}
   */
  calculateRetryDelay(attempt, retryConfig) {
    const baseDelay = retryConfig.delay || 2000;
    const multiplier = retryConfig.backoffMultiplier || 2;
    const maxDelay = retryConfig.maxDelay || 10000;
    const delay = Math.min(baseDelay * Math.pow(multiplier, attempt - 1), maxDelay);
    const jitter = delay * 0.1 * (Math.random() * 2 - 1);
    return Math.max(0, delay + jitter);
  }

  /**
   * 分类错误类型
   * @param {Error} error - 错误对象
   * @returns {Object}
   */
  classifyError(error) {
    if (!error) {
      return {
        isTimeout: false,
        isNetwork: false,
        is5xx: false,
        is4xx: false,
        isRateLimit: false,
        isAuth: false,
        originalError: error
      };
    }
    const message = (error?.message || '').toLowerCase();
    const code = (error?.code || '').toLowerCase();
    const status = error?.status || error?.statusCode || 0;
    const name = (error?.name || '').toLowerCase();
    return {
      isTimeout: name === 'aborterror' || name === 'timeouterror' ||
        message.includes('timeout') || message.includes('超时') || message.includes('timed out') ||
        code === 'timeout' || code === 'etimedout',
      isNetwork: message.includes('network') || message.includes('网络') ||
        message.includes('连接') || message.includes('connection') ||
        code === 'econnrefused' || code === 'enotfound' || code === 'econnreset',
      is5xx: /^5\d{2}$/.test(status) || code === '5xx' || (status >= 500 && status < 600),
      is4xx: /^4\d{2}$/.test(status) || code === '4xx' || (status >= 400 && status < 500),
      isRateLimit: status === 429 || message.includes('rate limit') ||
        message.includes('限流') || message.includes('too many requests'),
      isAuth: status === 401 || status === 403 ||
        message.includes('unauthorized') || message.includes('forbidden') ||
        message.includes('认证') || message.includes('权限'),
      originalError: error
    };
  }

  /**
   * 判断是否应该重试
   * @param {Object} errorInfo - classifyError 返回值
   * @param {Object} retryConfig - getRetryConfig 返回值
   * @param {number} attempt - 当前重试次数
   * @returns {boolean}
   */
  shouldRetry(errorInfo, retryConfig, attempt) {
    if (!retryConfig.enabled || attempt >= retryConfig.maxAttempts) return false;
    if (errorInfo.isAuth) return false;
    const { isTimeout, isNetwork, is5xx, isRateLimit } = errorInfo;
    const { retryOn } = retryConfig;
    return (
      (isTimeout && retryOn.includes('timeout')) ||
      (isNetwork && retryOn.includes('network')) ||
      (is5xx && retryOn.includes('5xx')) ||
      (isRateLimit && retryOn.includes('rate_limit')) ||
      retryOn.includes('all')
    );
  }

  /**
   * 解析 LLM 配置（标准化合并 apiConfig / this.config / 全局配置）
   * @param {Object} apiConfig - 单次调用的 API 配置
   * @returns {Object}
   */
  resolveLLMConfig(apiConfig = {}) {
    const llm = (global.cfg?.aistream || {}).llm || {};
    const pick = (...vals) => vals.find(v => v !== undefined);
    const pickTrim = (...vals) => {
      const v = vals.find(v => v !== undefined);
      return (v != null && v !== '') ? String(v).trim() : undefined;
    };
    const pickUrl = (...vals) => vals.find(v => v != null && v !== '' && String(v).trim() !== '');
    const provider = (apiConfig.provider || this.config?.provider || llm.Provider || llm.provider || '').toLowerCase();
    if (provider && !LLMFactory.hasProvider(provider)) {
      BotUtil.makeLog('warn', `[AIStream] 不支持的 LLM 提供商: ${provider}`, 'AIStream');
    }
    const providerConfig = LLMFactory.getProviderConfig(provider);
    const timeout = pick(apiConfig.timeout, apiConfig.timeoutMs, this.config?.timeout, llm.timeout, 30000);
    const apiKey = pickTrim(apiConfig.apiKey, apiConfig.api_key, providerConfig.apiKey, providerConfig.api_key, this.config?.apiKey, this.config?.api_key);
    const baseUrl = pickUrl(apiConfig.baseUrl, apiConfig.base_url, this.config?.baseUrl, this.config?.base_url, providerConfig.baseUrl, providerConfig.base_url);
    const model = pick(apiConfig.model, providerConfig.model, this.config?.model);
    const maxTokens = pick(apiConfig.maxTokens, this.config?.maxTokens, providerConfig.maxTokens);
    const topP = pick(apiConfig.topP, this.config?.topP, providerConfig.topP);
    const presencePenalty = pick(apiConfig.presencePenalty, this.config?.presencePenalty, providerConfig.presencePenalty);
    const frequencyPenalty = pick(apiConfig.frequencyPenalty, this.config?.frequencyPenalty, providerConfig.frequencyPenalty);
    return {
      ...providerConfig,
      ...this.config,
      ...apiConfig,
      apiKey,
      baseUrl,
      model,
      maxTokens,
      topP,
      presencePenalty,
      frequencyPenalty,
      provider: provider || this._getDefaultProvider(),
      timeout
    };
  }

  /**
   * 从标准化配置构建 overrides（供 chat/chatStream 使用，与 AGT 一致单一路径）
   * @param {Object} config - resolveLLMConfig 结果
   * @param {Object} base - 基础 overrides，如 { stream: true }
   * @returns {Object}
   */
  _buildOverridesFromConfig(config, base = {}) {
    const o = { ...base };
    if (config.temperature !== undefined) o.temperature = config.temperature;
    if (config.maxTokens !== undefined) o.max_tokens = config.maxTokens;
    if (config.topP !== undefined) o.top_p = config.topP;
    if (config.presencePenalty !== undefined) o.presence_penalty = config.presencePenalty;
    if (config.frequencyPenalty !== undefined) o.frequency_penalty = config.frequencyPenalty;
    return o;
  }

  /** 供 LLM 请求使用的工具流列表：当前工作流 + 所有远程 MCP 流（remote-mcp.xxx），保证合并流与远程工具一起下发 */
  _getToolStreamNames() {
    const names = [this.name];
    try {
      const loader = global.Bot?.StreamLoader;
      const remote = loader?.remoteMCPServers;
      if (remote && typeof remote.keys === 'function') {
        for (const k of remote.keys()) {
          names.push(`remote-mcp.${k}`);
        }
      }
    } catch (_) {}
    return names;
  }

  /**
   * 调用AI（非流式）- 使用 LLMFactory，支持重试
   * @param {Array} messages - 消息数组
   * @param {Object} apiConfig - API配置
   * @returns {Promise<string|null>} AI回复文本
   */
  async callAI(messages, apiConfig = {}) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      BotUtil.makeLog('warn', '[AIStream] 消息数组为空', 'AIStream');
      return null;
    }

    const config = this.resolveLLMConfig(apiConfig);
    const retryConfig = this.getRetryConfig();
    let lastError = null;

    for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
      try {
        const client = LLMFactory.createClient(config);
        const overrides = this._buildOverridesFromConfig(config, { stream: false, streams: this._getToolStreamNames() });

        const result = await client.chat(messages, overrides);
        return result || null;
      } catch (error) {
        lastError = error;
        const errorInfo = this.classifyError(error);
        const shouldRetry = this.shouldRetry(errorInfo, retryConfig, attempt);

        if (shouldRetry) {
          const delay = this.calculateRetryDelay(attempt, retryConfig);
          BotUtil.makeLog('warn', `[AIStream] AI调用失败，${attempt}/${retryConfig.maxAttempts}次重试中: ${error.message}`, 'AIStream');
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        BotUtil.makeLog('error', `[AIStream] AI调用失败: ${error.message}`, 'AIStream');
        return null;
      }
    }

    BotUtil.makeLog('error', `[AIStream] AI调用失败，已重试${retryConfig.maxAttempts}次: ${lastError?.message || '未知错误'}`, 'AIStream');
    return null;
  }

  /**
   * 调用AI（流式）- 使用 LLMFactory，支持重试
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

    const config = this.resolveLLMConfig(apiConfig);
    const retryConfig = this.getRetryConfig();
    let lastError = null;

    for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
      try {
        const client = LLMFactory.createClient(config);
        if (typeof client.chatStream !== 'function') {
          throw new Error('LLM客户端不支持流式调用');
        }
        const overrides = this._buildOverridesFromConfig(config, { stream: true, streams: this._getToolStreamNames() });
        await client.chatStream(messages, onDelta, overrides);
        return;
      } catch (error) {
        lastError = error;
        const errorInfo = this.classifyError(error);
        const shouldRetry = this.shouldRetry(errorInfo, retryConfig, attempt);

        if (shouldRetry) {
          const delay = this.calculateRetryDelay(attempt, retryConfig);
          BotUtil.makeLog('warn', `[AIStream] AI流式调用失败，${attempt}/${retryConfig.maxAttempts}次重试中: ${error.message}`, 'AIStream');
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        BotUtil.makeLog('error', `[AIStream] AI流式调用失败: ${error.message}`, 'AIStream');
        onDelta?.(`[ERROR] ${error.message}`);
        return;
      }
    }

    BotUtil.makeLog('error', `[AIStream] AI流式调用失败，已重试${retryConfig.maxAttempts}次: ${lastError?.message || '未知错误'}`, 'AIStream');
    onDelta?.(`[ERROR] ${lastError?.message || '未知错误'}`);
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
    return await this.execute(e, question, apiConfig);
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