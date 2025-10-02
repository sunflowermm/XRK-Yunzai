import fetch from 'node-fetch';
import BotUtil from '../common/util.js';

/**
 * AI工作流基类
 * 提供工作流的基础功能：系统提示构建、响应解析、功能执行
 */
export default class AIStream {
  constructor(options = {}) {
    this.name = options.name || 'base-stream';
    this.description = options.description || '基础工作流';
    this.version = options.version || '1.0.0';
    this.author = options.author || 'unknown';
    this.priority = options.priority || 100;
    
    // 功能注册表
    this.functions = new Map();
    
    // 配置
    this.config = {
      enabled: true,
      temperature: 0.8,
      maxTokens: 6000,
      topP: 0.9,
      presencePenalty: 0.6,
      frequencyPenalty: 0.6,
      ...options.config
    };
    
    // 功能开关配置
    this.functionToggles = options.functionToggles || {};
  }

  /**
   * 注册功能
   * @param {string} name - 功能名称
   * @param {object} options - 功能选项
   * @param {Function} options.handler - 功能处理器
   * @param {string} options.prompt - 功能提示文本
   * @param {Function} options.parser - 响应解析器
   * @param {boolean} options.enabled - 是否默认启用
   * @param {string} options.permission - 需要的权限
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

    BotUtil.makeLog('debug', `工作流[${this.name}]注册功能: ${name}`, 'AIStream');
  }

  /**
   * 检查功能是否启用
   */
  isFunctionEnabled(name) {
    const func = this.functions.get(name);
    return func?.enabled ?? false;
  }

  /**
   * 启用/禁用功能
   */
  toggleFunction(name, enabled) {
    const func = this.functions.get(name);
    if (func) {
      func.enabled = enabled;
      this.functionToggles[name] = enabled;
    }
  }

  /**
   * 获取所有启用的功能
   */
  getEnabledFunctions() {
    return Array.from(this.functions.values()).filter(f => f.enabled);
  }

  /**
   * 构建系统提示（需要子类实现）
   * @param {object} context - 上下文信息
   * @returns {string} 系统提示
   */
  buildSystemPrompt(context) {
    throw new Error('buildSystemPrompt方法需要子类实现');
  }

  /**
   * 构建功能提示部分
   */
  buildFunctionsPrompt() {
    const enabledFuncs = this.getEnabledFunctions();
    if (enabledFuncs.length === 0) return '';

    const prompts = enabledFuncs
      .filter(f => f.prompt)
      .map(f => f.prompt)
      .join('\n');

    return prompts ? `\n【功能列表】\n${prompts}` : '';
  }

  /**
   * 构建聊天上下文（需要子类实现）
   * @param {object} e - 消息事件
   * @param {string} question - 用户问题
   * @returns {Array} 消息数组
   */
  async buildChatContext(e, question) {
    throw new Error('buildChatContext方法需要子类实现');
  }

  /**
   * 解析AI响应
   * @param {string} response - AI响应文本
   * @param {object} context - 上下文
   * @returns {object} 解析结果
   */
  parseResponse(response, context = {}) {
    const result = {
      segments: [],
      functions: [],
      metadata: {}
    };

    // 分割响应（最多2段）
    const segments = response.split('|').map(s => s.trim()).filter(s => s).slice(0, 2);

    for (const segment of segments) {
      const segmentData = this.parseSegment(segment, context);
      result.segments.push(segmentData);
    }

    return result;
  }

  /**
   * 解析单个响应段落
   */
  parseSegment(text, context) {
    const segmentData = {
      text: text,
      textParts: [],
      functions: [],
      metadata: {}
    };

    let cleanText = text;

    for (const func of this.functions.values()) {
      if (!func.enabled || !func.parser) continue;

      const parseResult = func.parser(text, context);
      if (parseResult.functions?.length > 0) {
        segmentData.functions.push(...parseResult.functions);
      }
      if (parseResult.cleanText) {
        cleanText = parseResult.cleanText;
      }
      if (parseResult.metadata) {
        Object.assign(segmentData.metadata, parseResult.metadata);
      }
    }

    segmentData.text = cleanText.trim();
    if (segmentData.text) {
      segmentData.textParts.push(segmentData.text);
    }

    return segmentData;
  }

  /**
   * 执行功能
   * @param {object} funcCall - 功能调用信息
   * @param {object} context - 上下文
   */
  async executeFunction(funcCall, context) {
    const { type, params } = funcCall;
    const func = this.functions.get(type);

    if (!func) {
      BotUtil.makeLog('warn', `未知功能: ${type}`, 'AIStream');
      return;
    }

    if (!func.enabled) {
      BotUtil.makeLog('debug', `功能未启用: ${type}`, 'AIStream');
      return;
    }

    if (func.permission && !(await this.checkPermission(func.permission, context))) {
      BotUtil.makeLog('warn', `权限不足: ${type}`, 'AIStream');
      return;
    }

    try {
      await func.handler(params, context);
      BotUtil.makeLog('debug', `功能执行成功: ${type}`, 'AIStream');
    } catch (error) {
      BotUtil.makeLog('error', `功能执行失败[${type}]: ${error.message}`, 'AIStream');
    }
  }

  /**
   * 检查权限
   */
  async checkPermission(permission, context) {
    const { e } = context;
    if (!e?.isGroup) return false;
    if (e.isMaster) return true;

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
  }

  /**
   * 调用AI
   * @param {Array} messages - 消息数组
   * @param {object} apiConfig - API配置
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
          frequency_penalty: config.frequencyPenalty
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
   * 处理消息（主入口）
   * @param {object} e - 消息事件
   * @param {string} question - 用户问题
   * @param {object} apiConfig - API配置
   */
  async process(e, question, apiConfig = {}) {
    try {
      // 构建聊天上下文
      const messages = await this.buildChatContext(e, question);
      
      // 调用AI
      const response = await this.callAI(messages, apiConfig);
      if (!response) return null;

      // 解析响应
      const parsed = this.parseResponse(response, { e, question });
      
      return parsed;
    } catch (error) {
      BotUtil.makeLog('error', `工作流处理失败[${this.name}]: ${error.message}`, 'AIStream');
      return null;
    }
  }

  /**
   * 获取工作流信息
   */
  getInfo() {
    return {
      name: this.name,
      description: this.description,
      version: this.version,
      author: this.author,
      priority: this.priority,
      functions: Array.from(this.functions.values()).map(f => ({
        name: f.name,
        description: f.description,
        enabled: f.enabled,
        permission: f.permission
      }))
    };
  }
}