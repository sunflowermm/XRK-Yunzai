import fetch from 'node-fetch';
import BotUtil from '../common/util.js';

/**
 * AI工作流基类
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
    if (!this.embeddingConfig.enabled) {
      BotUtil.makeLog('debug', `[${this.name}] Embedding未启用，跳过初始化`, 'AIStream');
      return;
    }

    if (this.embeddingReady) {
      BotUtil.makeLog('debug', `[${this.name}] Embedding已初始化，跳过`, 'AIStream');
      return;
    }

    BotUtil.makeLog('info', `[${this.name}] 开始初始化Embedding (${this.embeddingConfig.provider})...`, 'AIStream');

    try {
      switch (this.embeddingConfig.provider) {
        case 'tensorflow':
          await this.initTensorFlowEmbedding();
          break;
        case 'api':
          await this.initAPIEmbedding();
          break;
        default:
          BotUtil.makeLog('warn', `[${this.name}] 未知的Embedding提供商: ${this.embeddingConfig.provider}`, 'AIStream');
          return;
      }
      
      BotUtil.makeLog('success', `[${this.name}] Embedding模型初始化成功 ✓`, 'AIStream');
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] Embedding初始化失败: ${error.message}`, 'AIStream');
      BotUtil.makeLog('error', `[${this.name}] 错误堆栈: ${error.stack}`, 'AIStream');
      this.embeddingConfig.enabled = false;
      this.embeddingReady = false;
      throw error;
    }
  }

  /**
   * 初始化TensorFlow.js Embedding（改进版）
   */
  async initTensorFlowEmbedding() {
    BotUtil.makeLog('info', `[${this.name}] 正在加载TensorFlow.js模块...`, 'AIStream');
    
    let tf = null;
    let use = null;
    
    try {
      // 尝试导入 @tensorflow/tfjs-node
      BotUtil.makeLog('debug', `[${this.name}] 导入 @tensorflow/tfjs-node...`, 'AIStream');
      tf = await import('@tensorflow/tfjs-node');
      BotUtil.makeLog('success', `[${this.name}] ✓ @tensorflow/tfjs-node 导入成功`, 'AIStream');
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] ✗ @tensorflow/tfjs-node 导入失败:`, 'AIStream');
      BotUtil.makeLog('error', `[${this.name}]   错误: ${error.message}`, 'AIStream');
      BotUtil.makeLog('error', `[${this.name}]   安装命令: pnpm add @tensorflow/tfjs-node -w`, 'AIStream');
      throw new Error(`@tensorflow/tfjs-node 导入失败: ${error.message}`);
    }

    try {
      // 尝试导入 @tensorflow-models/universal-sentence-encoder
      BotUtil.makeLog('debug', `[${this.name}] 导入 @tensorflow-models/universal-sentence-encoder...`, 'AIStream');
      use = await import('@tensorflow-models/universal-sentence-encoder');
      BotUtil.makeLog('success', `[${this.name}] ✓ universal-sentence-encoder 导入成功`, 'AIStream');
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] ✗ universal-sentence-encoder 导入失败:`, 'AIStream');
      BotUtil.makeLog('error', `[${this.name}]   错误: ${error.message}`, 'AIStream');
      BotUtil.makeLog('error', `[${this.name}]   安装命令: pnpm add @tensorflow-models/universal-sentence-encoder -w`, 'AIStream');
      throw new Error(`universal-sentence-encoder 导入失败: ${error.message}`);
    }

    if (!tf || !use) {
      throw new Error('TensorFlow.js 模块加载失败');
    }

    // 加载模型
    BotUtil.makeLog('info', `[${this.name}] 正在加载 Universal Sentence Encoder 模型（首次加载约需30秒）...`, 'AIStream');
    const startTime = Date.now();
    
    try {
      this.embeddingModel = await use.load();
      const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
      this.embeddingReady = true;
      
      BotUtil.makeLog('success', `[${this.name}] ✓ TensorFlow模型加载完成 (${loadTime}秒)`, 'AIStream');
      
      // 进行一次测试以确保模型可用
      await this.testEmbeddingModel();
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] ✗ 模型加载失败: ${error.message}`, 'AIStream');
      throw new Error(`TensorFlow模型加载失败: ${error.message}`);
    }
  }

  /**
   * 初始化API Embedding
   */
  async initAPIEmbedding() {
    const config = this.embeddingConfig;
    
    if (!config.apiUrl || !config.apiKey) {
      throw new Error('未配置Embedding API (需要 apiUrl 和 apiKey)');
    }

    BotUtil.makeLog('info', `[${this.name}] 配置API Embedding: ${config.apiUrl}`, 'AIStream');
    
    // 测试API连接
    try {
      await this.testAPIConnection();
      this.embeddingReady = true;
      BotUtil.makeLog('success', `[${this.name}] ✓ API连接测试成功`, 'AIStream');
    } catch (error) {
      throw new Error(`API连接测试失败: ${error.message}`);
    }
  }

  /**
   * 测试Embedding模型
   */
  async testEmbeddingModel() {
    if (!this.embeddingModel) {
      throw new Error('Embedding模型未加载');
    }

    try {
      BotUtil.makeLog('debug', `[${this.name}] 测试Embedding模型...`, 'AIStream');
      const testText = ['测试文本'];
      const embeddings = await this.embeddingModel.embed(testText);
      const vector = await embeddings.array();
      embeddings.dispose();
      
      if (!vector || !vector[0] || vector[0].length === 0) {
        throw new Error('模型返回无效向量');
      }
      
      BotUtil.makeLog('success', `[${this.name}] ✓ 模型测试成功 (向量维度: ${vector[0].length})`, 'AIStream');
    } catch (error) {
      throw new Error(`模型测试失败: ${error.message}`);
    }
  }

  /**
   * 测试API连接
   */
  async testAPIConnection() {
    try {
      const testVector = await this.generateAPIEmbedding('test');
      if (!testVector || !Array.isArray(testVector) || testVector.length === 0) {
        throw new Error('API返回无效向量');
      }
    } catch (error) {
      throw new Error(`API测试失败: ${error.message}`);
    }
  }

  /**
   * 生成文本的Embedding向量
   */
  async generateEmbedding(text) {
    if (!this.embeddingConfig.enabled || !text) {
      return null;
    }

    if (!this.embeddingReady) {
      BotUtil.makeLog('warn', `[${this.name}] Embedding未就绪，尝试初始化...`, 'AIStream');
      await this.initEmbedding().catch(err => {
        BotUtil.makeLog('error', `[${this.name}] Embedding初始化失败: ${err.message}`, 'AIStream');
        return null;
      });
      
      if (!this.embeddingReady) {
        return null;
      }
    }

    try {
      switch (this.embeddingConfig.provider) {
        case 'tensorflow':
          return await this.generateTFEmbedding(text);
        case 'api':
          return await this.generateAPIEmbedding(text);
        default:
          BotUtil.makeLog('warn', `[${this.name}] 未知的Embedding提供商: ${this.embeddingConfig.provider}`, 'AIStream');
          return null;
      }
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] 生成Embedding失败: ${error.message}`, 'AIStream');
      return null;
    }
  }

  /**
   * 使用TensorFlow生成Embedding
   */
  async generateTFEmbedding(text) {
    if (!this.embeddingModel) {
      throw new Error('TensorFlow模型未加载');
    }

    if (!text || typeof text !== 'string') {
      throw new Error('无效的文本输入');
    }

    try {
      const embeddings = await this.embeddingModel.embed([text]);
      const vector = await embeddings.array();
      embeddings.dispose(); // 释放内存
      
      return vector[0];
    } catch (error) {
      throw new Error(`TensorFlow生成向量失败: ${error.message}`);
    }
  }

  /**
   * 使用API生成Embedding
   */
  async generateAPIEmbedding(text) {
    const config = this.embeddingConfig;
    
    if (!config.apiUrl || !config.apiKey) {
      throw new Error('未配置Embedding API');
    }

    if (!text || typeof text !== 'string') {
      throw new Error('无效的文本输入');
    }

    try {
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
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`API错误 ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      const embedding = result.data?.[0]?.embedding;
      
      if (!embedding || !Array.isArray(embedding)) {
        throw new Error('API返回无效的embedding数据');
      }
      
      return embedding;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('API请求超时');
      }
      throw error;
    }
  }

  /**
   * 计算余弦相似度
   */
  cosineSimilarity(vec1, vec2) {
    if (!vec1 || !vec2 || !Array.isArray(vec1) || !Array.isArray(vec2)) {
      BotUtil.makeLog('warn', `[${this.name}] 无效的向量输入`, 'AIStream');
      return 0;
    }

    if (vec1.length !== vec2.length) {
      BotUtil.makeLog('warn', `[${this.name}] 向量维度不匹配: ${vec1.length} vs ${vec2.length}`, 'AIStream');
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
    
    if (denominator === 0) {
      BotUtil.makeLog('warn', `[${this.name}] 向量范数为0`, 'AIStream');
      return 0;
    }
    
    return dotProduct / denominator;
  }

  /**
   * 存储对话到Redis（带Embedding）
   */
  async storeMessageWithEmbedding(groupId, message) {
    if (!this.embeddingConfig.enabled) {
      return;
    }

    if (typeof redis === 'undefined' || !redis) {
      BotUtil.makeLog('warn', `[${this.name}] Redis未启用，无法存储Embedding`, 'AIStream');
      return;
    }

    if (!this.embeddingReady) {
      BotUtil.makeLog('debug', `[${this.name}] Embedding未就绪，跳过存储`, 'AIStream');
      return;
    }

    try {
      const key = `ai:embedding:${this.name}:${groupId}`;
      const messageText = `${message.nickname}: ${message.message}`;
      
      // 生成embedding向量
      const embedding = await this.generateEmbedding(messageText);
      if (!embedding) {
        BotUtil.makeLog('debug', `[${this.name}] 无法生成Embedding，跳过存储`, 'AIStream');
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

      // 存储到Redis列表
      await redis.lPush(key, JSON.stringify(data));
      await redis.lTrim(key, 0, 99); // 保留最近100条
      await redis.expire(key, this.embeddingConfig.cacheExpiry);
      
      BotUtil.makeLog('debug', `[${this.name}] 已存储Embedding: ${messageText.substring(0, 50)}...`, 'AIStream');
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] 存储Embedding失败: ${error.message}`, 'AIStream');
    }
  }

  /**
   * 检索相关上下文
   */
  async retrieveRelevantContexts(groupId, query) {
    if (!this.embeddingConfig.enabled) {
      return [];
    }

    if (typeof redis === 'undefined' || !redis) {
      BotUtil.makeLog('warn', `[${this.name}] Redis未启用，无法检索上下文`, 'AIStream');
      return [];
    }

    if (!this.embeddingReady) {
      BotUtil.makeLog('debug', `[${this.name}] Embedding未就绪，跳过检索`, 'AIStream');
      return [];
    }

    if (!query || typeof query !== 'string') {
      return [];
    }

    try {
      const key = `ai:embedding:${this.name}:${groupId}`;
      
      // 生成查询的embedding
      const queryEmbedding = await this.generateEmbedding(query);
      if (!queryEmbedding) {
        BotUtil.makeLog('debug', `[${this.name}] 无法生成查询Embedding`, 'AIStream');
        return [];
      }

      // 从Redis获取历史消息
      const messages = await redis.lRange(key, 0, -1);
      if (!messages || messages.length === 0) {
        BotUtil.makeLog('debug', `[${this.name}] 没有历史消息可检索`, 'AIStream');
        return [];
      }

      // 计算相似度并筛选
      const scored = [];
      for (const msg of messages) {
        try {
          const data = JSON.parse(msg);
          
          if (!data.embedding || !Array.isArray(data.embedding)) {
            BotUtil.makeLog('debug', `[${this.name}] 消息缺少有效的embedding，跳过`, 'AIStream');
            continue;
          }
          
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
          BotUtil.makeLog('debug', `[${this.name}] 解析消息失败: ${e.message}`, 'AIStream');
          continue;
        }
      }

      // 按相似度排序并返回前N条
      scored.sort((a, b) => b.similarity - a.similarity);
      const results = scored.slice(0, this.embeddingConfig.maxContexts);
      
      if (results.length > 0) {
        BotUtil.makeLog('debug', 
          `[${this.name}] 检索到 ${results.length} 条相关上下文 (最高相似度: ${(results[0].similarity * 100).toFixed(1)}%)`,
          'AIStream'
        );
      }
      
      return results;
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] 检索上下文失败: ${error.message}`, 'AIStream');
      return [];
    }
  }

  /**
   * 构建增强的聊天上下文（带语义检索）
   */
  async buildEnhancedContext(e, question, baseMessages) {
    if (!this.embeddingConfig.enabled || !this.embeddingReady) {
      return baseMessages;
    }

    const groupId = e.group_id || `private_${e.user_id}`;
    const query = typeof question === 'string' ? question : 
                  (question?.content || question?.text || '');

    if (!query) {
      return baseMessages;
    }

    try {
      const relevantContexts = await this.retrieveRelevantContexts(groupId, query);
      
      if (relevantContexts.length === 0) {
        return baseMessages;
      }

      // 构建增强的消息数组
      const enhanced = [...baseMessages];
      const contextPrompt = [
        '\n【语义检索的相关对话】',
        relevantContexts.map((ctx, i) => 
          `${i + 1}. ${ctx.nickname}: ${ctx.message.substring(0, 100)} (相似度: ${(ctx.similarity * 100).toFixed(1)}%)`
        ).join('\n'),
        '\n以上是与当前话题相关的历史对话，可以参考但不要重复。\n'
      ].join('\n');

      // 将上下文添加到system消息
      if (enhanced[0]?.role === 'system') {
        enhanced[0].content += contextPrompt;
      } else {
        enhanced.unshift({
          role: 'system',
          content: contextPrompt
        });
      }

      BotUtil.makeLog('info', 
        `[${this.name}] ✓ 检索到${relevantContexts.length}条相关上下文`, 
        'AIStream'
      );

      return enhanced;
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] 构建增强上下文失败: ${error.message}`, 'AIStream');
      return baseMessages;
    }
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
      
      // 构建基础消息
      const baseMessages = await this.buildChatContext(e, question);
      
      // 构建增强消息（带语义检索）
      const messages = await this.buildEnhancedContext(e, question, baseMessages);
      
      // 调用AI
      const response = await this.callAI(messages, config);
      
      if (!response) {
        return null;
      }
      
      // 解析功能调用
      const { functions, cleanText } = this.parseFunctions(response, context);
      
      // 执行功能
      for (const func of functions) {
        await this.executeFunction(func.type, func.params, context);
      }
      
      // 存储AI的回复（带Embedding）
      if (this.embeddingConfig.enabled && cleanText) {
        const groupId = e.group_id || `private_${e.user_id}`;
        this.storeMessageWithEmbedding(groupId, {
          user_id: e.self_id,
          nickname: Bot.nickname || 'Bot',
          message: cleanText,
          message_id: Date.now().toString(),
          time: Date.now()
        }).catch(err => {
          BotUtil.makeLog('debug', `存储Bot回复Embedding失败: ${err.message}`, 'AIStream');
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
        ready: this.embeddingReady,
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

  /**
   * 清理资源
   */
  async cleanup() {
    BotUtil.makeLog('info', `[${this.name}] 正在清理资源...`, 'AIStream');
    
    if (this.embeddingModel && typeof this.embeddingModel.dispose === 'function') {
      try {
        this.embeddingModel.dispose();
        BotUtil.makeLog('debug', `[${this.name}] TensorFlow模型已释放`, 'AIStream');
      } catch (error) {
        BotUtil.makeLog('warn', `[${this.name}] 释放模型失败: ${error.message}`, 'AIStream');
      }
      this.embeddingModel = null;
    }
    
    this.embeddingReady = false;
    BotUtil.makeLog('success', `[${this.name}] 资源清理完成`, 'AIStream');
  }
}