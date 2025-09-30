/**
 * 工作流基类 - 扩展版
 * 支持完整的消息处理流程
 */
export default class StreamBase {
  constructor(options = {}) {
    this.name = options.name || 'UnnamedStream';
    this.description = options.description || '未知工作流';
    this.version = options.version || '1.0.0';
    this.author = options.author || 'Unknown';
    this.enabled = options.enabled !== false;
    
    this.config = {
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      timeout: options.timeout || 10000,
      debug: options.debug || false,
      ...options.config
    };
    
    this.rules = [];
    this.ruleGroups = new Map();
    this.middleware = [];
    this.context = new Map();
    
    this.init();
  }

  init() {
    this.initMiddleware();
    this.initRules();
    this.validateRules();
  }

  initRules() {
    // 子类实现
  }

  initMiddleware() {
    this.use(async (ctx, next) => {
      ctx.startTime = Date.now();
      await next();
      ctx.duration = Date.now() - ctx.startTime;
    });
  }

  use(middleware) {
    if (typeof middleware === 'function') {
      this.middleware.push(middleware);
    }
  }

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
      transformer: null
    };
    
    const finalRule = { ...defaultRule, ...rule };
    
    if (finalRule.pattern && !finalRule.reg) {
      finalRule.reg = this._compilePattern(finalRule.pattern);
    }
    
    this.rules.push(finalRule);
    
    if (!this.ruleGroups.has(finalRule.group)) {
      this.ruleGroups.set(finalRule.group, []);
    }
    this.ruleGroups.get(finalRule.group).push(finalRule);
    
    this._sortRules();
    return this;
  }

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

  _sortRules() {
    this.rules.sort((a, b) => b.priority - a.priority);
    for (const [group, rules] of this.ruleGroups) {
      rules.sort((a, b) => b.priority - a.priority);
    }
  }

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

  // ========== 核心消息处理方法 ==========

  /**
   * 判断是否应该触发此工作流
   * @param {Object} e - 消息事件
   * @param {Object} context - 上下文
   * @returns {Promise<boolean>}
   */
  async shouldTrigger(e, context) {
    // 子类实现具体触发逻辑
    return false;
  }

  /**
   * 处理消息内容
   * @param {Object} e - 消息事件
   * @param {Object} context - 上下文
   * @returns {Promise<string>}
   */
  async processMessageContent(e, context) {
    return e.msg || '';
  }

  /**
   * 构建系统提示词
   * @param {string} basePrompt - 基础提示词
   * @param {Object} context - 上下文
   * @returns {string}
   */
  buildSystemPrompt(basePrompt = '', context = {}) {
    let prompt = basePrompt;
    
    if (this.description) {
      prompt += `\n\n【工作流】${this.name} - ${this.description}`;
    }
    
    const groupedPrompts = new Map();
    for (const rule of this.rules) {
      if (!rule.enabled || !rule.regPrompt) continue;
      
      if (!groupedPrompts.has(rule.group)) {
        groupedPrompts.set(rule.group, []);
      }
      groupedPrompts.get(rule.group).push(rule.regPrompt);
    }
    
    if (groupedPrompts.size > 0) {
      prompt += '\n\n【可用指令】';
      for (const [group, prompts] of groupedPrompts) {
        if (group !== 'default') {
          prompt += `\n\n[${group}]`;
        }
        prompts.forEach(p => prompt += `\n${p}`);
      }
    }
    
    return prompt;
  }

  /**
   * 构建聊天上下文
   * @param {Object} e - 消息事件
   * @param {string} question - 问题
   * @param {Object} context - 上下文
   * @returns {Promise<Array>}
   */
  async buildChatContext(e, question, context) {
    const messages = [];
    const systemPrompt = await this.buildSystemPrompt(context.persona || '', context);
    
    messages.push({ role: 'system', content: systemPrompt });
    
    if (context.history && context.history.length > 0) {
      messages.push({
        role: 'user',
        content: `[群聊记录]\n${context.history}`
      });
    }
    
    if (question) {
      messages.push({
        role: 'user',
        content: `[当前消息]\n${question}`
      });
    }
    
    return messages;
  }

  /**
   * 解析AI响应
   * @param {string} response - AI响应
   * @param {Object} context - 上下文
   * @returns {Promise<Object>}
   */
  async parseResponse(response, context = {}) {
    const results = [];
    const matchedRules = new Set();
    
    const ctx = { response, results, context, stream: this };
    await this._runMiddleware(ctx);
    
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      
      const matches = await this._matchRule(rule, response, context);
      for (const match of matches) {
        if (rule.validator) {
          const isValid = await rule.validator(match, context);
          if (!isValid) continue;
        }
        
        let transformed = match;
        if (rule.transformer) {
          transformed = await rule.transformer(match, context);
        }
        
        results.push({
          rule: rule.name,
          group: rule.group,
          match: transformed.match || match.match,
          params: transformed.params || match.params,
          named: transformed.named || match.named,
          handler: rule.handler,
          priority: rule.priority,
          metadata: { ...rule, handler: undefined }
        });
        
        matchedRules.add(rule.name);
      }
    }
    
    const processedResponse = this.cleanResponse(response, results);
    
    return {
      original: response,
      processedResponse,
      results,
      matchedRules: Array.from(matchedRules),
      context: ctx
    };
  }

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
        index: match.index,
        input: match.input
      });
      
      if (!rule.reg.global) break;
    }
    
    return matches;
  }

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

  cleanResponse(response, results) {
    let cleaned = response;
    
    const sortedResults = results
      .filter(r => r.match && typeof r.match === 'string')
      .sort((a, b) => (b.index || 0) - (a.index || 0));
    
    for (const result of sortedResults) {
      cleaned = cleaned.replace(result.match, '');
    }
    
    cleaned = cleaned
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s+$/gm, '')
      .trim();
    
    return cleaned;
  }

  /**
   * 执行解析结果
   * @param {Array} results - 解析结果
   * @param {Object} context - 上下文
   * @returns {Promise<Object>}
   */
  async execute(results, context = {}) {
    const executedResults = [];
    const errors = [];
    
    const sortedResults = [...results].sort((a, b) => b.priority - a.priority);
    
    for (const result of sortedResults) {
      const execResult = await this._executeRule(result, context);
      
      if (execResult.success) {
        executedResults.push(execResult);
      } else {
        errors.push(execResult);
      }
    }
    
    return {
      executed: executedResults,
      errors,
      success: errors.length === 0
    };
  }

  async _executeRule(result, context) {
    const { rule, handler, metadata } = result;
    
    if (!handler || typeof handler !== 'function') {
      return { rule, success: false, error: '无有效处理器' };
    }
    
    let attempts = 0;
    const maxRetries = metadata?.maxRetries || this.config.maxRetries;
    
    while (attempts < maxRetries) {
      attempts++;
      
      try {
        const handlerResult = await this._executeWithTimeout(
          handler.call(this, result, context),
          metadata?.timeout || this.config.timeout
        );
        
        return { rule, success: true, result: handlerResult, attempts };
        
      } catch (error) {
        if (attempts >= maxRetries) {
          return { rule, success: false, error: error.message, attempts };
        }
        await this._delay(this.config.retryDelay * attempts);
      }
    }
  }

  async _executeWithTimeout(promise, timeout) {
    return Promise.race([
      promise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`执行超时 (${timeout}ms)`)), timeout)
      )
    ]);
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 完整处理流程（入口方法）
   * @param {Object} e - 消息事件
   * @param {Object} context - 上下文
   * @returns {Promise<Object>}
   */
  async process(e, context = {}) {
    try {
      // 1. 判断是否触发
      const shouldTrigger = await this.shouldTrigger(e, context);
      if (!shouldTrigger) {
        return { triggered: false };
      }
      
      // 2. 处理消息内容
      const question = await this.processMessageContent(e, context);
      
      // 3. 构建AI请求
      const messages = await this.buildChatContext(e, question, context);
      
      // 4. 调用AI
      const aiResponse = await this.callAI(messages, context.aiConfig);
      if (!aiResponse) {
        return { triggered: true, success: false, error: 'AI响应为空' };
      }
      
      // 5. 解析响应
      const parseResult = await this.parseResponse(aiResponse, { ...context, e });
      
      // 6. 执行规则
      const executeResult = await this.execute(parseResult.results, { ...context, e });
      
      // 7. 发送响应
      await this.sendResponse(e, parseResult.processedResponse, executeResult, context);
      
      return {
        triggered: true,
        success: true,
        processedResponse: parseResult.processedResponse,
        executed: executeResult.executed,
        errors: executeResult.errors
      };
      
    } catch (error) {
      logger?.error(`[Stream ${this.name}] 处理失败:`, error);
      return { triggered: true, success: false, error: error.message };
    }
  }

  /**
   * 调用AI
   * @param {Array} messages - 消息列表
   * @param {Object} config - AI配置
   * @returns {Promise<string>}
   */
  async callAI(messages, config) {
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: config.chatModel || 'gpt-3.5-turbo',
          messages,
          temperature: config.temperature || 0.8,
          max_tokens: config.max_tokens || 6000,
          top_p: config.top_p || 0.9,
          presence_penalty: config.presence_penalty || 0.6,
          frequency_penalty: config.frequency_penalty || 0.6
        }),
        timeout: 30000
      });

      if (!response.ok) {
        throw new Error(`API错误: ${response.status}`);
      }

      const result = await response.json();
      return result.choices?.[0]?.message?.content || null;
    } catch (error) {
      logger?.error(`[Stream ${this.name}] AI调用失败:`, error.message);
      return null;
    }
  }

  /**
   * 发送响应
   * @param {Object} e - 消息事件
   * @param {string} text - 文本内容
   * @param {Object} executeResult - 执行结果
   * @param {Object} context - 上下文
   */
  async sendResponse(e, text, executeResult, context) {
    // 子类实现具体的发送逻辑
    if (text) {
      await e.reply(text);
    }
  }

  getStatus() {
    return {
      name: this.name,
      version: this.version,
      enabled: this.enabled,
      rules: {
        total: this.rules.length,
        enabled: this.rules.filter(r => r.enabled).length,
        groups: Array.from(this.ruleGroups.keys())
      }
    };
  }
}