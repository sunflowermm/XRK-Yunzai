/**
 * 增强的工作流基类
 * 提供完整的AI交互和消息处理框架
 */
export default class StreamBase {
  constructor(options = {}) {
    // 基础信息
    this.name = options.name || 'UnnamedStream';
    this.description = options.description || '未知工作流';
    this.version = options.version || '1.0.0';
    this.author = options.author || 'Unknown';
    this.enabled = options.enabled !== false;
    
    // 工作流配置
    this.config = {
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      timeout: options.timeout || 10000,
      debug: options.debug || false,
      ai: null, // AI配置将在init时设置
      ...options.config
    };
    
    // 规则集合
    this.rules = [];
    this.ruleGroups = new Map();
    this.middleware = [];
    
    // 执行上下文
    this.context = new Map();
    
    // 消息历史缓存
    this.messageHistory = new Map();
    this.userCache = new Map();
    
    // 初始化
    this.init();
  }

  /**
   * 初始化工作流
   */
  init() {
    this.initMiddleware();
    this.initRules();
    this.validateRules();
  }

  /**
   * 初始化规则 - 子类需要重写
   */
  initRules() {
    // 子类实现具体规则
  }

  /**
   * 初始化中间件
   */
  initMiddleware() {
    // 默认中间件 - 记录执行时间
    this.use(async (ctx, next) => {
      ctx.startTime = Date.now();
      await next();
      ctx.duration = Date.now() - ctx.startTime;
    });
    
    // 消息历史记录中间件
    this.use(async (ctx, next) => {
      if (ctx.e && ctx.e.isGroup) {
        this.recordMessageHistory(ctx.e);
      }
      await next();
    });
  }

  /**
   * 记录消息历史
   */
  recordMessageHistory(e) {
    if (!e.isGroup) return;
    
    try {
      const groupId = e.group_id;
      if (!this.messageHistory.has(groupId)) {
        this.messageHistory.set(groupId, []);
      }
      
      const history = this.messageHistory.get(groupId);
      let messageContent = e.raw_message || e.msg || '';
      
      if (e.message && Array.isArray(e.message)) {
        messageContent = e.message.map(seg => {
          switch (seg.type) {
            case 'text': return seg.text;
            case 'image': return '[图片]';
            case 'at': return `@${seg.qq}`;
            default: return '';
          }
        }).join('');
      }
      
      history.push({
        user_id: e.user_id,
        nickname: e.sender?.card || e.sender?.nickname || '未知',
        message: messageContent,
        message_id: e.message_id,
        time: Date.now(),
        hasImage: e.img?.length > 0
      });
      
      // 保留最近30条
      if (history.length > 30) {
        history.shift();
      }
    } catch (error) {
      logger.error(`[Stream] 记录消息历史失败: ${error.message}`);
    }
  }

  /**
   * 添加中间件
   */
  use(middleware) {
    if (typeof middleware === 'function') {
      this.middleware.push(middleware);
    }
  }

  /**
   * 添加规则
   */
  addRule(rule) {
    const defaultRule = {
      name: 'unnamed_' + Date.now(),
      enabled: true,
      group: 'default',
      reg: null,
      pattern: null,
      regPrompt: '',
      priority: 100,
      handler: null,
      description: '',
      validator: null,
      transformer: null,
      errorHandler: null
    };
    
    const finalRule = { ...defaultRule, ...rule };
    
    // 编译正则表达式
    if (finalRule.pattern && !finalRule.reg) {
      finalRule.reg = this._compilePattern(finalRule.pattern);
    }
    
    this.rules.push(finalRule);
    
    // 添加到分组
    if (!this.ruleGroups.has(finalRule.group)) {
      this.ruleGroups.set(finalRule.group, []);
    }
    this.ruleGroups.get(finalRule.group).push(finalRule);
    
    // 按优先级排序
    this._sortRules();
    
    return this;
  }

  /**
   * 编译模式为正则表达式
   */
  _compilePattern(pattern) {
    if (pattern instanceof RegExp) return pattern;
    
    let regStr = pattern;
    const hasRegexQuantifiers = /\\[dws]\{|\\\w\{/.test(regStr);
    
    if (!hasRegexQuantifiers) {
      regStr = regStr.replace(/\{(\w+)\}/g, '(?<$1>[^\\s]+)');
      regStr = regStr.replace(/\[(\w+)\]/g, '(?<$1>.+?)');
    }
    
    try {
      return new RegExp(regStr, 'gi');
    } catch (error) {
      logger?.error(`[Stream] 正则编译失败: ${error.message}`);
      return /(?!)/;
    }
  }

  /**
   * 排序规则
   */
  _sortRules() {
    this.rules.sort((a, b) => b.priority - a.priority);
    for (const [group, rules] of this.ruleGroups) {
      rules.sort((a, b) => b.priority - a.priority);
    }
  }

  /**
   * 验证规则
   */
  validateRules() {
    const errors = [];
    this.rules.forEach(rule => {
      if (!rule.handler && !rule.transformer) {
        errors.push(`规则 ${rule.name} 缺少处理器`);
      }
    });
    
    if (errors.length > 0) {
      logger?.error(`[Stream ${this.name}] 规则验证失败:`, errors);
    }
    
    return errors.length === 0;
  }

  /**
   * AI调用方法
   */
  async callAI(messages, config = null) {
    const aiConfig = config || this.config.ai;
    if (!aiConfig) {
      throw new Error('AI配置未设置');
    }
    
    try {
      const response = await fetch(`${aiConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${aiConfig.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: aiConfig.model || 'gpt-3.5-turbo',
          messages: messages,
          temperature: aiConfig.temperature || 0.8,
          max_tokens: aiConfig.max_tokens || 2000,
          top_p: aiConfig.top_p || 0.9,
          presence_penalty: aiConfig.presence_penalty || 0.6,
          frequency_penalty: aiConfig.frequency_penalty || 0.6
        }),
        timeout: 30000
      });

      if (!response.ok) {
        throw new Error(`API错误: ${response.status}`);
      }

      const result = await response.json();
      return result.choices?.[0]?.message?.content || null;
    } catch (error) {
      logger.error(`[Stream] AI调用失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 构建聊天上下文
   */
  async buildChatContext(e, systemPrompt, question, options = {}) {
    const messages = [];
    
    // 系统提示
    if (systemPrompt) {
      messages.push({ 
        role: 'system', 
        content: systemPrompt
      });
    }
    
    // 群聊历史
    if (e.isGroup && options.includeHistory !== false) {
      const history = this.messageHistory.get(e.group_id) || [];
      const historyCount = options.historyCount || 10;
      
      if (history.length > 0) {
        const relevantHistory = history.slice(-historyCount);
        messages.push({
          role: 'user',
          content: `[群聊记录]\n${relevantHistory.map(msg => 
            `${msg.nickname}(${msg.user_id}): ${msg.message}`
          ).join('\n')}`
        });
      }
    }
    
    // 当前消息
    if (question) {
      const userInfo = e.sender?.card || e.sender?.nickname || '未知';
      messages.push({
        role: 'user',
        content: `${userInfo}(${e.user_id}): ${question}`
      });
    }
    
    return messages;
  }

  /**
   * 解析AI响应并提取指令
   */
  async parseResponse(response, context = {}) {
    const results = [];
    const matchedRules = new Set();
    
    // 执行中间件
    const ctx = {
      response,
      results,
      context,
      stream: this,
      e: context.e
    };
    
    await this._runMiddleware(ctx);
    
    // 遍历规则进行匹配
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      
      const matches = await this._matchRule(rule, response, context);
      
      for (const match of matches) {
        // 验证
        if (rule.validator) {
          const isValid = await rule.validator(match, context);
          if (!isValid) continue;
        }
        
        // 转换
        let transformed = match;
        if (rule.transformer) {
          transformed = await rule.transformer(match, context);
        }
        
        results.push({
          rule: rule.name,
          group: rule.group,
          match: transformed.match || match.match,
          params: transformed.params || match.params,
          handler: rule.handler,
          priority: rule.priority
        });
        
        matchedRules.add(rule.name);
      }
    }
    
    // 清理已匹配的内容
    const processedResponse = this.cleanResponse(response, results);
    
    return {
      original: response,
      processedResponse,
      results,
      matchedRules: Array.from(matchedRules)
    };
  }

  /**
   * 匹配单个规则
   */
  async _matchRule(rule, response, context) {
    const matches = [];
    
    if (!rule.reg) return matches;
    
    if (rule.reg.global) {
      rule.reg.lastIndex = 0;
    }
    
    let match;
    while ((match = rule.reg.exec(response)) !== null) {
      matches.push({
        match: match[0],
        params: match.slice(1),
        named: match.groups || {},
        index: match.index
      });
      
      if (!rule.reg.global) break;
    }
    
    return matches;
  }

  /**
   * 执行中间件
   */
  async _runMiddleware(ctx) {
    const stack = [...this.middleware];
    let index = 0;
    
    const next = async () => {
      if (index >= stack.length) return;
      const middleware = stack[index++];
      await middleware(ctx, next);
    };
    
    await next();
  }

  /**
   * 清理响应
   */
  cleanResponse(response, results) {
    let cleaned = response;
    
    // 移除匹配的指令
    const sortedResults = results
      .filter(r => r.match && typeof r.match === 'string')
      .sort((a, b) => (b.index || 0) - (a.index || 0));
    
    for (const result of sortedResults) {
      cleaned = cleaned.replace(result.match, '');
    }
    
    // 清理空白
    cleaned = cleaned
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s+$/gm, '')
      .trim();
    
    return cleaned;
  }

  /**
   * 执行解析结果
   */
  async execute(results, context = {}) {
    const executed = [];
    const errors = [];
    
    // 按优先级执行
    const sorted = [...results].sort((a, b) => b.priority - a.priority);
    
    for (const result of sorted) {
      try {
        if (result.handler) {
          const handlerResult = await result.handler.call(this, result, context);
          executed.push({
            rule: result.rule,
            result: handlerResult
          });
        }
      } catch (error) {
        errors.push({
          rule: result.rule,
          error: error.message
        });
      }
    }
    
    return { executed, errors };
  }

  /**
   * 完整处理流程
   */
  async process(response, context = {}) {
    try {
      const parseResult = await this.parseResponse(response, context);
      const executeResult = await this.execute(parseResult.results, context);
      
      return {
        success: true,
        processedResponse: parseResult.processedResponse,
        original: parseResult.original,
        results: parseResult.results,
        executed: executeResult.executed,
        errors: executeResult.errors
      };
    } catch (error) {
      logger?.error(`[Stream ${this.name}] 处理失败:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 清理缓存
   */
  cleanupCache() {
    const now = Date.now();
    const maxAge = 1800000; // 30分钟
    
    // 清理消息历史
    for (const [groupId, messages] of this.messageHistory) {
      const filtered = messages.filter(msg => now - msg.time < maxAge);
      if (filtered.length === 0) {
        this.messageHistory.delete(groupId);
      } else {
        this.messageHistory.set(groupId, filtered);
      }
    }
    
    // 清理用户缓存
    for (const [key, data] of this.userCache) {
      if (now - data.time > 300000) {
        this.userCache.delete(key);
      }
    }
  }
}