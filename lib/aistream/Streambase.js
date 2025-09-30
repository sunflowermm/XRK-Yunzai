/**
 * 工作流基类
 * 提供工作流的基础功能和规则处理
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
      ...options.config
    };
    
    // 规则集合
    this.rules = [];
    this.ruleGroups = new Map();
    this.middleware = [];
    
    // 执行上下文
    this.context = new Map();
    
    // 初始化
    this.init();
  }

  /**
   * 初始化工作流
   */
  init() {
    this.initMiddleware();
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
    // 默认中间件
    this.use(async (ctx, next) => {
      ctx.startTime = Date.now();
      await next();
      ctx.duration = Date.now() - ctx.startTime;
    });
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
   * @param {Object} rule 规则配置
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
      maxRetries: this.config.maxRetries,
      timeout: this.config.timeout,
      cache: false,
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
   * 批量添加规则
   */
  addRules(rules) {
    rules.forEach(rule => this.addRule(rule));
    return this;
  }

/**
 * 编译模式为正则表达式
 */
_compilePattern(pattern) {
  if (pattern instanceof RegExp) {
    return pattern;
  }
  
  let regStr = pattern;
  
  // 检测是否包含正则量词语法（如 \d{4}, \w{1,3} 等）
  // 如果包含，说明这是一个标准正则表达式，不进行简化语法转换
  const hasRegexQuantifiers = /\\[dws]\{|\\\w\{/.test(regStr);
  
  if (!hasRegexQuantifiers) {
    // 只在不包含正则量词的情况下才应用简化语法转换
    // {name} -> 命名捕获组
    regStr = regStr.replace(/\{(\w+)\}/g, '(?<$1>[^\\s]+)');
    // [content] -> 懒惰匹配
    regStr = regStr.replace(/\[(\w+)\]/g, '(?<$1>.+?)');
  }
  
  try {
    return new RegExp(regStr, 'gi');
  } catch (error) {
    // 如果正则编译失败，记录错误并返回一个永远不匹配的正则
    logger?.error(`[Stream] 正则表达式编译失败: ${error.message}\nPattern: ${pattern}`);
    return /(?!)/; // 永远不匹配的正则，避免崩溃
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
   * 验证规则有效性
   */
  validateRules() {
    const errors = [];
    const warnings = [];
    
    this.rules.forEach(rule => {
      // 检查必要字段
      if (!rule.handler && !rule.transformer) {
        errors.push(`规则 ${rule.name} 缺少处理器`);
      }
      
      if (!rule.reg && !rule.pattern) {
        warnings.push(`规则 ${rule.name} 没有匹配模式`);
      }
      
      // 检查处理器类型
      if (rule.handler && typeof rule.handler !== 'function') {
        errors.push(`规则 ${rule.name} 的处理器必须是函数`);
      }
    });
    
    if (errors.length > 0) {
      logger?.error(`[Stream ${this.name}] 规则验证失败:`, errors);
    }
    
    if (warnings.length > 0 && this.config.debug) {
      logger?.warn(`[Stream ${this.name}] 规则警告:`, warnings);
    }
    
    return errors.length === 0;
  }

  /**
   * 构建系统提示词
   */
  buildSystemPrompt(basePrompt = '', context = {}) {
    let prompt = basePrompt;
    
    // 添加基础信息
    if (this.description) {
      prompt += `\n\n【工作流】${this.name} - ${this.description}`;
    }
    
    // 按组添加规则提示
    const groupedPrompts = new Map();
    
    for (const rule of this.rules) {
      if (!rule.enabled || !rule.regPrompt) continue;
      
      if (!groupedPrompts.has(rule.group)) {
        groupedPrompts.set(rule.group, []);
      }
      
      groupedPrompts.get(rule.group).push(rule.regPrompt);
    }
    
    // 组装提示词
    if (groupedPrompts.size > 0) {
      prompt += '\n\n【可用指令】';
      
      for (const [group, prompts] of groupedPrompts) {
        if (group !== 'default') {
          prompt += `\n\n[${group}]`;
        }
        prompts.forEach(p => {
          prompt += `\n${p}`;
        });
      }
    }
    
    // 添加上下文相关提示
    if (context.additionalPrompts) {
      prompt += '\n\n' + context.additionalPrompts;
    }
    
    return prompt;
  }

  /**
   * 解析AI响应
   */
  async parseResponse(response, context = {}) {
    const results = [];
    const matchedRules = new Set();
    let processedResponse = response;
    
    // 执行中间件
    const ctx = {
      response,
      results,
      context,
      stream: this
    };
    
    await this._runMiddleware(ctx);
    
    // 遍历规则进行匹配
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      
      const matches = await this._matchRule(rule, response, context);
      
      for (const match of matches) {
        // 验证匹配
        if (rule.validator) {
          const isValid = await rule.validator(match, context);
          if (!isValid) continue;
        }
        
        // 转换匹配
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
          cache: rule.cache,
          metadata: {
            ...rule,
            handler: undefined // 不包含函数
          }
        });
        
        matchedRules.add(rule.name);
      }
    }
    
    // 清理已匹配的内容
    processedResponse = this.cleanResponse(response, results);
    
    return {
      original: response,
      processedResponse,
      results,
      matchedRules: Array.from(matchedRules),
      context: ctx
    };
  }

  /**
   * 匹配单个规则
   */
  async _matchRule(rule, response, context) {
    const matches = [];
    
    if (!rule.reg) return matches;
    
    // 重置正则表达式索引
    if (rule.reg.global) {
      rule.reg.lastIndex = 0;
    }
    
    let match;
    while ((match = rule.reg.exec(response)) !== null) {
      const matchData = {
        match: match[0],
        params: match.slice(1),
        named: match.groups || {},
        index: match.index,
        input: match.input
      };
      
      matches.push(matchData);
      
      // 防止无限循环
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
   * 清理响应中的指令标记
   */
  cleanResponse(response, results) {
    let cleaned = response;
    
    const sortedResults = results
      .filter(r => r.match && typeof r.match === 'string')
      .sort((a, b) => (b.index || 0) - (a.index || 0));
    
    for (const result of sortedResults) {
      cleaned = cleaned.replace(result.match, '');
    }
    
    // 清理多余的空白
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
    const executedResults = [];
    const errors = [];
    
    // 按优先级执行
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

  /**
   * 执行单个规则
   */
  async _executeRule(result, context) {
    const { rule, handler, metadata } = result;
    
    if (!handler || typeof handler !== 'function') {
      return {
        rule,
        success: false,
        error: '无有效处理器'
      };
    }
    
    let attempts = 0;
    const maxRetries = metadata?.maxRetries || this.config.maxRetries;
    
    while (attempts < maxRetries) {
      attempts++;
      
      try {
        // 执行处理器（带超时）
        const handlerResult = await this._executeWithTimeout(
          handler.call(this, result, context),
          metadata?.timeout || this.config.timeout
        );
        
        return {
          rule,
          success: true,
          result: handlerResult,
          attempts
        };
        
      } catch (error) {
        logger?.error(`[Stream ${this.name}] 规则 ${rule} 执行失败 (${attempts}/${maxRetries}):`, error.message);
        
        // 自定义错误处理
        if (metadata?.errorHandler) {
          const handled = await metadata.errorHandler(error, result, context);
          if (handled) {
            return {
              rule,
              success: true,
              result: handled,
              recovered: true,
              attempts
            };
          }
        }
        
        // 重试延迟
        if (attempts < maxRetries) {
          await this._delay(this.config.retryDelay * attempts);
        } else {
          return {
            rule,
            success: false,
            error: error.message,
            attempts
          };
        }
      }
    }
  }

  /**
   * 带超时的执行
   */
  async _executeWithTimeout(promise, timeout) {
    return Promise.race([
      promise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`执行超时 (${timeout}ms)`)), timeout)
      )
    ]);
  }

  /**
   * 延迟函数
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 完整处理流程
   */
  async process(response, context = {}) {
    try {
      // 解析响应
      const parseResult = await this.parseResponse(response, context);
      
      // 执行规则
      const executeResult = await this.execute(parseResult.results, {
        ...context,
        parseContext: parseResult.context
      });
      
      // 组装最终结果
      const finalResult = {
        success: executeResult.success,
        processedResponse: parseResult.processedResponse,
        original: parseResult.original,
        results: parseResult.results,
        executed: executeResult.executed,
        errors: executeResult.errors,
        matchedRules: parseResult.matchedRules,
        metadata: {
          stream: this.name,
          version: this.version,
          duration: parseResult.context.duration
        }
      };
      
      // 日志记录
      if (this.config.debug) {
        logger?.debug(`[Stream ${this.name}] 处理完成:`, {
          matched: finalResult.matchedRules.length,
          executed: finalResult.executed.length,
          errors: finalResult.errors.length
        });
      }
      
      return finalResult;
      
    } catch (error) {
      logger?.error(`[Stream ${this.name}] 处理失败:`, error);
      throw error;
    }
  }

  /**
   * 获取规则信息
   */
  getRuleInfo(ruleName) {
    return this.rules.find(r => r.name === ruleName);
  }

  /**
   * 启用/禁用规则
   */
  setRuleEnabled(ruleName, enabled) {
    const rule = this.getRuleInfo(ruleName);
    if (rule) {
      rule.enabled = enabled;
      return true;
    }
    return false;
  }

  /**
   * 获取规则组
   */
  getRuleGroup(groupName) {
    return this.ruleGroups.get(groupName) || [];
  }

  /**
   * 启用/禁用规则组
   */
  setGroupEnabled(groupName, enabled) {
    const rules = this.getRuleGroup(groupName);
    rules.forEach(rule => {
      rule.enabled = enabled;
    });
    return rules.length;
  }

  /**
   * 获取工作流状态
   */
  getStatus() {
    return {
      name: this.name,
      version: this.version,
      enabled: this.enabled,
      rules: {
        total: this.rules.length,
        enabled: this.rules.filter(r => r.enabled).length,
        groups: Array.from(this.ruleGroups.keys())
      },
      middleware: this.middleware.length
    };
  }

  /**
   * 导出配置
   */
  exportConfig() {
    return {
      name: this.name,
      description: this.description,
      version: this.version,
      author: this.author,
      config: this.config,
      rules: this.rules.map(r => ({
        ...r,
        handler: undefined,
        validator: undefined,
        transformer: undefined,
        errorHandler: undefined
      }))
    };
  }
}