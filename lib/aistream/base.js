import BotUtil from '../common/util.js';

export default class BaseStream {
  constructor(options = {}) {
    this.name = options.name || 'base-stream';
    this.description = options.description || '基础工作流';
    this.version = options.version || '1.0.0';
    this.author = options.author || 'unknown';
    
    this.features = new Map();
    this.config = {};
    
    this.init();
  }

  init() {}

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

  setFeatureEnabled(name, enabled) {
    const feature = this.features.get(name);
    if (feature) {
      feature.enabled = enabled;
    }
  }

  getEnabledFeatures() {
    return Array.from(this.features.entries())
      .filter(([_, feature]) => feature.enabled)
      .map(([name, feature]) => ({ name, ...feature }));
  }

  async buildSystemPrompt(context, options = {}) {
    const enabledFeatures = this.getEnabledFeatures();
    const featurePrompts = enabledFeatures
      .filter(f => f.prompt)
      .map(f => f.prompt)
      .join('\n');
    
    return `【工作流】${this.name}\n${this.description}\n\n【可用功能】\n${featurePrompts}`;
  }

  async buildMessages(context, options = {}) {
    const systemPrompt = await this.buildSystemPrompt(context, options);
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: context.question || '' }
    ];
  }

  async callAI(messages, config = {}) {
    const aiConfig = Object.assign({}, this.config.ai, config);
    
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
  }

  async parseResponse(response, context) {
    const results = {
      text: [],
      functions: [],
      segments: []
    };

    const lines = response.split('|').map(s => s.trim()).filter(s => s);
    
    for (const line of lines) {
      const functions = await this.extractFunctions(line, context);
      results.functions.push(...functions);
      
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
    
    functions.sort((a, b) => {
      const featureA = this.features.get(a.name);
      const featureB = this.features.get(b.name);
      return (featureB?.priority || 0) - (featureA?.priority || 0);
    });
    
    return functions;
  }

  async executeFunction(func) {
    if (typeof func.handler === 'function') {
      return await func.handler(func.params, func.context);
    }
    
    const feature = this.features.get(func.name);
    if (feature && typeof this[`handle${func.name}`] === 'function') {
      return await this[`handle${func.name}`](func.params, func.context);
    }
    
    BotUtil.makeLog('warn', `未找到功能处理器：${func.name}`, this.name);
  }

  async sendResponse(context, parsed) {
    const e = context.e;
    
    for (let i = 0; i < parsed.segments.length; i++) {
      if (parsed.text[i]) {
        await e.reply(parsed.text[i], Math.random() > 0.5);
      }
      
      if (i < parsed.segments.length - 1) {
        await BotUtil.sleep(Math.random() * 1000 + 500);
      }
    }
    
    for (const func of parsed.functions) {
      await this.executeFunction(func);
    }
  }

  async process(context, options = {}) {
    this.config = Object.assign({}, this.config, options.config || {});
    
    const messages = await this.buildMessages(context, options);
    
    const response = await this.callAI(messages, options.aiConfig);
    
    if (!response) {
      throw new Error('AI无响应');
    }
    
    const parsed = await this.parseResponse(response, context);
    
    await this.sendResponse(context, parsed);
    
    return { success: true, response, parsed };
  }

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