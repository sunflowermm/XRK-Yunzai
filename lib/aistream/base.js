import { segment } from 'oicq';
import BotUtil from '../common/util.js';

/**
 * AI工作流基类
 */
export default class BaseStream {
  constructor(options = {}) {
    this.name = options.name || 'base-stream';
    this.description = options.description || '基础工作流';
    this.version = options.version || '1.0.0';
    this.author = options.author || 'unknown';
    
    // 功能配置
    this.features = new Map();
    this.config = {};
    
    // 初始化
    this.init();
  }

  /**
   * 初始化（子类重写）
   */
  init() {}

  /**
   * 注册功能
   */
  registerFeature(name, feature) {
    this.features.set(name, {
      name: feature.name || name,
      description: feature.description || '',
      enabled: feature.enabled !== false,
      handler: feature.handler || null,
      prompt: feature.prompt || '',
      pattern: feature.pattern || null,
      priority: feature.priority || 100
    });
  }

  /**
   * 启用/禁用功能
   */
  setFeatureEnabled(name, enabled) {
    const feature = this.features.get(name);
    if (feature) {
      feature.enabled = enabled;
    }
  }

  /**
   * 获取启用的功能
   */
  getEnabledFeatures() {
    return Array.from(this.features.entries())
      .filter(([_, feature]) => feature.enabled)
      .map(([name, feature]) => ({ name, ...feature }));
  }

  /**
   * 构建系统提示（子类重写）
   */
  async buildSystemPrompt(context, options = {}) {
    const enabledFeatures = this.getEnabledFeatures();
    const featurePrompts = enabledFeatures
      .filter(f => f.prompt)
      .map(f => f.prompt)
      .join('\n');
    
    return `【工作流】${this.name}\n${this.description}\n\n【可用功能】\n${featurePrompts}`;
  }

  /**
   * 构建消息上下文（子类重写）
   */
  async buildMessages(context, options = {}) {
    const systemPrompt = await this.buildSystemPrompt(context, options);
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: context.question || '' }
    ];
  }

  /**
   * 调用AI API
   */
  async callAI(messages, config = {}) {
    const aiConfig = Object.assign({}, this.config.ai, config);
    
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
          max_tokens: aiConfig.maxTokens || 2000,
          ...config
        })
      });

      if (!response.ok) {
        throw new Error(`API调用失败: ${response.status}`);
      }

      const result = await response.json();
      return result.choices?.[0]?.message?.content || null;
      
    } catch (error) {
      BotUtil.makeLog('error', `AI调用失败：${error.message}`, this.name);
      throw error;
    }
  }

  /**
   * 解析AI响应
   */
  async parseResponse(response, context) {
    const results = {
      text: [],
      functions: [],
      segments: []
    };

    // 基础解析逻辑
    const lines = response.split('|').map(s => s.trim()).filter(s => s);
    
    for (const line of lines) {
      // 解析功能调用
      const functions = await this.extractFunctions(line, context);
      results.functions.push(...functions);
      
      // 清理后的文本
      let cleanText = line;
      for (const func of functions) {
        cleanText = cleanText.replace(func.raw, '');
      }
      
      if (cleanText.trim()) {
        results.text.push(cleanText.trim());
      }
    }
    
    results.segments = lines;
    return results;
  }

  /**
   * 提取功能调用
   */
  async extractFunctions(text, context) {
    const functions = [];
    const enabledFeatures = this.getEnabledFeatures();
    
    for (const feature of enabledFeatures) {
      if (!feature.pattern) continue;
      
      const regex = new RegExp(feature.pattern, 'g');
      let match;
      
      while ((match = regex.exec(text))) {
        functions.push({
          name: feature.name,
          handler: feature.handler,
          params: match.slice(1),
          raw: match[0],
          context
        });
      }
    }
    
    // 按优先级排序
    functions.sort((a, b) => {
      const featureA = this.features.get(a.name);
      const featureB = this.features.get(b.name);
      return (featureB?.priority || 0) - (featureA?.priority || 0);
    });
    
    return functions;
  }

  /**
   * 执行功能
   */
  async executeFunction(func) {
    try {
      if (typeof func.handler === 'function') {
        return await func.handler(func.params, func.context);
      }
      
      // 默认处理器
      const feature = this.features.get(func.name);
      if (feature && typeof this[`handle${func.name}`] === 'function') {
        return await this[`handle${func.name}`](func.params, func.context);
      }
      
      BotUtil.makeLog('warn', `未找到功能处理器：${func.name}`, this.name);
      
    } catch (error) {
      BotUtil.makeLog('error', `执行功能失败 ${func.name}：${error.message}`, this.name);
    }
  }

  /**
   * 发送响应
   */
  async sendResponse(context, parsed) {
    const e = context.e;
    
    for (let i = 0; i < parsed.segments.length; i++) {
      // 发送文本
      if (parsed.text[i]) {
        await e.reply(parsed.text[i], Math.random() > 0.5);
      }
      
      // 延迟
      if (i < parsed.segments.length - 1) {
        await BotUtil.sleep(Math.random() * 1000 + 500);
      }
    }
    
    // 执行功能
    for (const func of parsed.functions) {
      await this.executeFunction(func);
    }
  }

  /**
   * 处理工作流（主入口）
   */
  async process(context, options = {}) {
    try {
      // 合并配置
      this.config = Object.assign({}, this.config, options.config || {});
      
      // 构建消息
      const messages = await this.buildMessages(context, options);
      
      // 调用AI
      const response = await this.callAI(messages, options.aiConfig);
      
      if (!response) {
        throw new Error('AI无响应');
      }
      
      // 解析响应
      const parsed = await this.parseResponse(response, context);
      
      // 发送响应
      await this.sendResponse(context, parsed);
      
      return { success: true, response, parsed };
      
    } catch (error) {
      BotUtil.makeLog('error', `工作流处理失败：${error.message}`, this.name);
      return { success: false, error: error.message };
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
      features: Array.from(this.features.entries()).map(([name, feature]) => ({
        name,
        description: feature.description,
        enabled: feature.enabled
      }))
    };
  }
}