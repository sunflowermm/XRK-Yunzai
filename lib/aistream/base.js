import fetch from 'node-fetch';
import BotUtil from '../common/util.js';

/**
 * AI工作流基类（含Embedding智能检索）
 * 提供工作流的基础功能：系统提示构建、响应解析、功能执行、语义检索
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
    
    // Embedding配置
    this.embeddingConfig = {
      enabled: false,
      provider: 'none', // 'tensorflow', 'api', 'none'
      model: null,
      maxContexts: 5, // 最多检索5条相关上下文
      similarityThreshold: 0.6, // 相似度阈值
      cacheExpiry: 86400, // Redis缓存24小时
      ...options.embedding
    };
    
    // Embedding模型实例（延迟加载）
    this.embeddingModel = null;
    this.embeddingReady = false;
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
      // 动态导入，避免未安装时报错
      const tf = await import('@tensorflow/tfjs-node').catch(() => null);
      const use = await import('@tensorflow-models/universal-sentence-encoder').catch(() => null);
      
      if (!tf || !use) {
        throw new Error('TensorFlow.js未安装，请运行: pnpm add @tensorflow/tfjs-node @tensorflow-models/universal-sentence-encoder');
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
   * @param {string} text - 输入文本
   * @returns {Array<number>|null} 向量数组
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
   * @param {string} text - 输入文本
   * @returns {Array<number>} 向量数组
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
    embeddings.dispose(); // 释放内存
    
    return vector[0];
  }

  /**
   * 使用API生成Embedding
   * @param {string} text - 输入文本
   * @returns {Array<number>} 向量数组
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
   * @param {Array<number>} vec1 - 向量1
   * @param {Array<number>} vec2 - 向量2
   * @returns {number} 相似度分数 (0-1)
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
   * @param {string} groupId - 群组ID
   * @param {object} message - 消息对象
   */
  async storeMessageWithEmbedding(groupId, message) {
    if (!this.embeddingConfig.enabled || !redis) {
      return;
    }

    try {
      const key = `ai:embedding:${this.name}:${groupId}`;
      const messageText = `${message.nickname}: ${message.message}`;
      
      // 生成embedding
      const embedding = await this.generateEmbedding(messageText);
      if (!embedding) {
        return;
      }

      // 存储到Redis
      const data = {
        message: messageText,
        embedding: embedding,
        userId: message.user_id,
        nickname: message.nickname,
        time: message.time || Date.now(),
        messageId: message.message_id
      };

      await redis.lPush(key, JSON.stringify(data));
      
      // 只保留最近100条
      await redis.lTrim(key, 0, 99);
      
      // 设置过期时间
      await redis.expire(key, this.embeddingConfig.cacheExpiry);
    } catch (error) {
      BotUtil.makeLog('error', `存储Embedding失败: ${error.message}`, 'AIStream');
    }
  }

  /**
   * 检索相关上下文
   * @param {string} groupId - 群组ID
   * @param {string} query - 查询文本
   * @returns {Array} 相关消息数组
   */
  async retrieveRelevantContexts(groupId, query) {
    if (!this.embeddingConfig.enabled || !redis || !query) {
      return [];
    }

    try {
      const key = `ai:embedding:${this.name}:${groupId}`;
      
      // 生成查询向量
      const queryEmbedding = await this.generateEmbedding(query);
      if (!queryEmbedding) {
        return [];
      }

      // 获取所有历史消息
      const messages = await redis.lRange(key, 0, -1);
      if (!messages || messages.length === 0) {
        return [];
      }

      // 计算相似度并排序
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

      // 按相似度降序排序，取前N条
      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, this.embeddingConfig.maxContexts);
    } catch (error) {
      BotUtil.makeLog('error', `检索上下文失败: ${error.message}`, 'AIStream');
      return [];
    }
  }

  /**
   * 构建增强的聊天上下文（带语义检索）
   * @param {object} e - 消息事件
   * @param {object} question - 用户问题
   * @param {Array} baseMessages - 基础消息数组
   * @returns {Array} 增强后的消息数组
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

    // 检索相关上下文
    const relevantContexts = await this.retrieveRelevantContexts(groupId, query);
    
    if (relevantContexts.length === 0) {
      return baseMessages;
    }

    // 在系统消息后插入相关上下文
    const enhanced = [...baseMessages];
    const contextPrompt = [
      '\n【语义检索的相关对话】',
      relevantContexts.map((ctx, i) => 
        `${i + 1}. ${ctx.nickname}: ${ctx.message.substring(0, 100)} (相似度: ${(ctx.similarity * 100).toFixed(1)}%)`
      ).join('\n'),
      '\n以上是与当前话题相关的历史对话，可以参考但不要重复。\n'
    ].join('\n');

    // 将相关上下文添加到系统消息中
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
   * @param {string} name - 功能名称
   * @param {object} options - 功能选项
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
   * 调用AI（优化版，支持流式响应）
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
          stream: false // 暂不使用流式，保持兼容性
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
      // 初始化Embedding（如果需要）
      if (this.embeddingConfig.enabled && !this.embeddingReady) {
        await this.initEmbedding();
      }

      // 构建上下文
      const context = { e, question, config };
      
      // 构建基础消息
      const baseMessages = await this.buildChatContext(e, question);
      
      // 使用语义检索增强上下文
      const messages = await this.buildEnhancedContext(e, question, baseMessages);
      
      // 调用AI
      const response = await this.callAI(messages, config);
      
      if (!response) {
        return null;
      }
      
      // 解析并执行功能
      const { functions, cleanText } = this.parseFunctions(response, context);
      
      // 执行功能
      for (const func of functions) {
        await this.executeFunction(func.type, func.params, context);
      }
      
      // 存储当前对话到Embedding缓存（异步，不阻塞）
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
    // 清理TensorFlow模型
    if (this.embeddingModel && typeof this.embeddingModel.dispose === 'function') {
      this.embeddingModel.dispose();
      this.embeddingModel = null;
    }
    this.embeddingReady = false;
  }
}