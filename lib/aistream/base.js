import fetch from 'node-fetch';
import BotUtil from '../common/util.js';

/**
 * AI工作流基类（优化版 - 避免重复初始化）
 */
export default class AIStream {
  constructor(options = {}) {
    // 只设置基础配置，不做任何初始化
    this.name = options.name || 'base-stream';
    this.description = options.description || '基础工作流';
    this.version = options.version || '1.0.0';
    this.author = options.author || 'unknown';
    this.priority = options.priority || 100;
    
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
    
    this.functionToggles = options.functionToggles || {};
    
    // Embedding配置
    this.embeddingConfig = {
      enabled: false,
      provider: 'none',
      model: null,
      maxContexts: 5,
      similarityThreshold: 0.6,
      cacheExpiry: 86400,
      ...options.embedding
    };
  }

  /**
   * 初始化工作流（只执行一次）
   * 子类应该重写此方法来初始化共享资源
   */
  async init() {
    // 功能注册表 - 在init中初始化
    if (!this.functions) {
      this.functions = new Map();
    }
    
    // Embedding模型实例
    if (this.embeddingModel === undefined) {
      this.embeddingModel = null;
      this.embeddingReady = false;
    }
    
    // 初始化Embedding（如果需要）
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
    if (!this.embeddingConfig.enabled || this.embeddingReady) {
      return;
    }

    try {
      switch (this.embeddingConfig.provider) {
        case 'tensorflow':
          await this.initTensorFlowEmbedding();
          break;
        case 'api':
          this.embeddingReady = true;
          break;
        default:
          return;
      }
      
      BotUtil.makeLog('success', `[${this.name}] Embedding模型初始化成功`, 'AIStream');
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] Embedding初始化失败: ${error.message}`, 'AIStream');
      this.embeddingConfig.enabled = false;
    }
  }

  /**
   * 初始化TensorFlow.js Embedding
   */
  async initTensorFlowEmbedding() {
    try {
      const tf = await import('@tensorflow/tfjs-node').catch(() => null);
      const use = await import('@tensorflow-models/universal-sentence-encoder').catch(() => null);
      
      if (!tf || !use) {
        throw new Error('TensorFlow.js未安装');
      }

      BotUtil.makeLog('info', `[${this.name}] 正在加载Universal Sentence Encoder...`, 'AIStream');
      this.embeddingModel = await use.load();
      this.embeddingReady = true;
      
      BotUtil.makeLog('success', `[${this.name}] TensorFlow模型加载完成`, 'AIStream');
    } catch (error) {
      throw new Error(`TensorFlow初始化失败: ${error.message}`);
    }
  }

  /**
   * 生成文本的Embedding向量
   */
  async generateEmbedding(text) {
    if (!this.embeddingConfig.enabled || !text) {
      return null;
    }

    try {
      switch (this.embeddingConfig.provider) {
        case 'tensorflow':
          return await this.generateTFEmbedding(text);
        case 'api':
          return await this.generateAPIEmbedding(text);
        default:
          return null;
      }
    } catch (error) {
      BotUtil.makeLog('error', `生成Embedding失败: ${error.message}`, 'AIStream');
      return null;
    }
  }

  /**
   * 使用TensorFlow生成Embedding
   */
  async generateTFEmbedding(text) {
    if (!this.embeddingModel) {
      await this.initEmbedding();
    }

    if (!this.embeddingModel) {
      return null;
    }

    const embeddings = await this.embeddingModel.embed([text]);
    const vector = await embeddings.array();
    embeddings.dispose();
    
    return vector[0];
  }

  /**
   * 使用API生成Embedding
   */
  async generateAPIEmbedding(text) {
    const config = this.embeddingConfig;
    
    if (!config.apiUrl || !config.apiKey) {
      throw new Error('未配置Embedding API');
    }

    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.apiModel || 'text-embedding-ada-002',
        input: text
      }),
      timeout: 10000
    });

    if (!response.ok) {
      throw new Error(`API错误: ${response.status}`);
    }

    const result = await response.json();
    return result.data?.[0]?.embedding || null;
  }

  /**
   * 计算余弦相似度
   */
  cosineSimilarity(vec1, vec2) {
    if (!vec1 || !vec2 || vec1.length !== vec2.length) {
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
   * 存储对话到Redis（带Embedding）
   */
  async storeMessageWithEmbedding(groupId, message) {
    if (!this.embeddingConfig.enabled || !redis) {
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
      BotUtil.makeLog('error', `存储Embedding失败: ${error.message}`, 'AIStream');
    }
  }

  /**
   * 检索相关上下文
   */
  async retrieveRelevantContexts(groupId, query) {
    if (!this.embeddingConfig.enabled || !redis || !query) {
      return [];
    }

    try {
      const key = `ai:embedding:${this.name}:${groupId}`;
      
      const queryEmbedding = await this.generateEmbedding(query);
      if (!queryEmbedding) {
        return [];
      }

      const messages = await redis.lRange(key, 0, -1);
      if (!messages || messages.length === 0) {
        return [];
      }

      const scored = [];
      for (const msg of messages) {
        try {
          const data = JSON.parse(msg);
          const similarity = this.cosineSimilarity(queryEmbedding, data.embedding);
          
          if (similarity >= this.embeddingConfig.similarityThreshold) {
            scored.push({
              message: data.message,
              similarity: similarity,
              time: data.time,
              userId: data.userId,
              nickname: data.nickname
            });
          }
        } catch (e) {
          continue;
        }
      }

      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, this.embeddingConfig.maxContexts);
    } catch (error) {
      BotUtil.makeLog('error', `检索上下文失败: ${error.message}`, 'AIStream');
      return [];
    }
  }

  /**
   * 构建增强的聊天上下文（带语义检索）
   */
  async buildEnhancedContext(e, question, baseMessages) {
    if (!this.embeddingConfig.enabled) {
      return baseMessages;
    }

    const groupId = e.group_id || `private_${e.user_id}`;
    const query = typeof question === 'string' ? question : 
                  (question?.content || question?.text || '');

    if (!query) {
      return baseMessages;
    }

    const relevantContexts = await this.retrieveRelevantContexts(groupId, query);
    
    if (relevantContexts.length === 0) {
      return baseMessages;
    }

    const enhanced = [...baseMessages];
    const contextPrompt = [
      '\n【语义检索的相关对话】',
      relevantContexts.map((ctx, i) => 
        `${i + 1}. ${ctx.nickname}: ${ctx.message.substring(0, 100)} (相似度: ${(ctx.similarity * 100).toFixed(1)}%)`
      ).join('\n'),
      '\n以上是与当前话题相关的历史对话，可以参考但不要重复。\n'
    ].join('\n');

    if (enhanced[0]?.role === 'system') {
      enhanced[0].content += contextPrompt;
    } else {
      enhanced.unshift({
        role: 'system',
        content: contextPrompt
      });
    }

    BotUtil.makeLog('debug', 
      `[${this.name}] 检索到${relevantContexts.length}条相关上下文`, 
      'AIStream'
    );

    return enhanced;
  }

  /**
   * 注册功能
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
   */
  async buildChatContext(e, question) {
    throw new Error('buildChatContext方法需要子类实现');
  }

  /**
   * 解析功能调用
   */
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
        BotUtil.makeLog('error', `功能解析失败[${func.name}]: ${error.message}`, 'AIStream');
      }
    }
    
    return { functions: allFunctions, cleanText };
  }

  /**
   * 执行功能
   */
  async executeFunction(type, params, context) {
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
      if (func.handler) {
        await func.handler(params, context);
        BotUtil.makeLog('debug', `功能执行成功: ${type}`, 'AIStream');
      }
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
      BotUtil.makeLog('debug', `权限检查失败: ${error.message}`, 'AIStream');
      return false;
    }
  }

  /**
   * 调用AI
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
      BotUtil.makeLog('error', `AI调用失败: ${error.message}`, 'AIStream');
      return null;
    }
  }

  /**
   * 执行工作流（增强版）
   */
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
      
      if (this.embeddingConfig.enabled && cleanText) {
        const groupId = e.group_id || `private_${e.user_id}`;
        this.storeMessageWithEmbedding(groupId, {
          user_id: e.self_id,
          nickname: Bot.nickname,
          message: cleanText,
          message_id: Date.now().toString(),
          time: Date.now()
        }).catch(err => {
          BotUtil.makeLog('warn', `存储Embedding失败: ${err.message}`, 'AIStream');
        });
      }
      
      return cleanText;
    } catch (error) {
      BotUtil.makeLog('error', `工作流执行失败[${this.name}]: ${error.message}`, 'AIStream');
      return null;
    }
  }

  /**
   * 处理消息（主入口）
   */
  async process(e, question, apiConfig = {}) {
    try {
      const result = await this.execute(e, question, apiConfig);
      return result;
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
      embedding: {
        enabled: this.embeddingConfig.enabled,
        provider: this.embeddingConfig.provider,
        ready: this.embeddingReady
      },
      functions: Array.from(this.functions.values()).map(f => ({
        name: f.name,
        description: f.description,
        enabled: f.enabled,
        permission: f.permission
      }))
    };
  }

  /**
   * 清理资源
   */
  async cleanup() {
    if (this.embeddingModel && typeof this.embeddingModel.dispose === 'function') {
      this.embeddingModel.dispose();
      this.embeddingModel = null;
    }
    this.embeddingReady = false;
  }
}