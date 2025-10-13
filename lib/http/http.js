import BotUtil from '../common/util.js';

/**
 * Fastify HTTP API 基类
 * 提供统一的 API 开发接口和工具方法
 * @class HttpApi
 */
export default class HttpApi {
  /**
   * 构造函数
   * @param {Object} [config={}] - 配置对象
   */
  constructor(config = {}) {
    /** @type {string} API 名称 */
    this.name = config.name || 'Unnamed API';

    /** @type {string} API 描述 */
    this.dsc = config.dsc || '暂无描述';

    /** @type {number} 优先级（数字越大越先执行） */
    this.priority = config.priority || 100;

    /** @type {boolean} 是否启用 */
    this.enable = config.enable !== false;

    /** @type {string} 路由前缀 */
    this.prefix = config.prefix || '';

    /** @type {Array<Object>} 路由配置列表 */
    this.routes = config.routes || [];

    /** @type {number} 创建时间戳 */
    this.createTime = Date.now();

    /** @type {string} API 键名（由加载器设置） */
    this.key = '';

    /** @type {string} 文件路径（由加载器设置） */
    this.filePath = '';

    /** @type {Object} Fastify 实例 */
    this.fastify = null;

    /** @type {Object} Bot 实例 */
    this.bot = null;

    // 如果传入了配置对象，复制所有属性
    if (config && typeof config === 'object') {
      Object.assign(this, config);
    }
  }

  /**
   * 初始化 API
   * @param {Object} fastify - Fastify 实例
   * @param {Object} bot - Bot 实例
   * @returns {Promise<void>}
   */
  async init(fastify, bot) {
    this.fastify = fastify;
    this.bot = bot;

    // 调用自定义初始化方法
    if (typeof this.onInit === 'function') {
      await this.onInit(fastify, bot);
    }

    // 自动注册路由
    await this.registerRoutes();

    BotUtil.makeLog('debug', `✓ ${this.name} 初始化完成`, 'HttpApi');
  }

  /**
   * 注册所有路由
   * @returns {Promise<void>}
   */
  async registerRoutes() {
    if (!this.routes || this.routes.length === 0) {
      return;
    }

    for (const route of this.routes) {
      await this.registerRoute(route);
    }
  }

  /**
   * 注册单个路由
   * @param {Object} route - 路由配置
   * @returns {Promise<void>}
   */
  async registerRoute(route) {
    if (!route || !route.url) {
      BotUtil.makeLog('warn', `✗ 路由配置无效: 缺少 url`, 'HttpApi');
      return;
    }

    const method = (route.method || 'GET').toLowerCase();
    const url = route.url;
    const handler = route.handler || route.fn;

    if (typeof handler !== 'function') {
      BotUtil.makeLog('warn', `✗ 路由 ${method.toUpperCase()} ${url} 缺少处理器`, 'HttpApi');
      return;
    }

    // 构建 Fastify 路由选项
    const routeOptions = {
      method: method.toUpperCase(),
      url: url,
      handler: async (request, reply) => {
        try {
          // 创建兼容层对象
          const context = {
            request,
            reply,
            fastify: this.fastify,
            bot: this.bot,
            api: this,
            // 便捷访问属性
            query: request.query,
            params: request.params,
            body: request.body,
            headers: request.headers,
            ip: request.ip,
            method: request.method,
            url: request.url
          };

          // 调用处理器
          const result = await handler.call(this, context);

          // 如果处理器返回值且还没有发送响应
          if (result !== undefined && !reply.sent) {
            return result;
          }
        } catch (error) {
          BotUtil.makeLog('error', `路由错误 ${method.toUpperCase()} ${url}: ${error.message}`, 'HttpApi');
          
          if (!reply.sent) {
            return reply.code(500).send({
              success: false,
              error: '内部服务器错误',
              message: error.message
            });
          }
        }
      }
    };

    // 添加路由 schema（用于验证和文档生成）
    if (route.schema) {
      routeOptions.schema = route.schema;
    }

    // 添加路由配置
    if (route.config) {
      routeOptions.config = route.config;
    }

    // 添加前置钩子
    if (route.preHandler) {
      routeOptions.preHandler = Array.isArray(route.preHandler)
        ? route.preHandler
        : [route.preHandler];
    }

    // 注册路由
    this.fastify.route(routeOptions);

    BotUtil.makeLog(
      'debug',
      `✓ 注册路由: ${method.toUpperCase()} ${url}`,
      'HttpApi'
    );
  }

  /**
   * 添加路由（动态添加）
   * @param {string} method - HTTP 方法
   * @param {string} url - 路由路径
   * @param {Function} handler - 处理器函数
   * @param {Object} [options={}] - 额外选项
   * @returns {HttpApi} 返回自身以支持链式调用
   */
  addRoute(method, url, handler, options = {}) {
    const route = {
      method,
      url,
      handler,
      ...options
    };

    this.routes.push(route);

    // 如果已经初始化，立即注册路由
    if (this.fastify) {
      this.registerRoute(route);
    }

    return this;
  }

  /**
   * 添加 GET 路由
   * @param {string} url - 路由路径
   * @param {Function} handler - 处理器函数
   * @param {Object} [options={}] - 额外选项
   * @returns {HttpApi} 返回自身
   */
  get(url, handler, options = {}) {
    return this.addRoute('GET', url, handler, options);
  }

  /**
   * 添加 POST 路由
   * @param {string} url - 路由路径
   * @param {Function} handler - 处理器函数
   * @param {Object} [options={}] - 额外选项
   * @returns {HttpApi} 返回自身
   */
  post(url, handler, options = {}) {
    return this.addRoute('POST', url, handler, options);
  }

  /**
   * 添加 PUT 路由
   * @param {string} url - 路由路径
   * @param {Function} handler - 处理器函数
   * @param {Object} [options={}] - 额外选项
   * @returns {HttpApi} 返回自身
   */
  put(url, handler, options = {}) {
    return this.addRoute('PUT', url, handler, options);
  }

  /**
   * 添加 DELETE 路由
   * @param {string} url - 路由路径
   * @param {Function} handler - 处理器函数
   * @param {Object} [options={}] - 额外选项
   * @returns {HttpApi} 返回自身
   */
  delete(url, handler, options = {}) {
    return this.addRoute('DELETE', url, handler, options);
  }

  /**
   * 添加 PATCH 路由
   * @param {string} url - 路由路径
   * @param {Function} handler - 处理器函数
   * @param {Object} [options={}] - 额外选项
   * @returns {HttpApi} 返回自身
   */
  patch(url, handler, options = {}) {
    return this.addRoute('PATCH', url, handler, options);
  }

  /**
   * 添加 OPTIONS 路由
   * @param {string} url - 路由路径
   * @param {Function} handler - 处理器函数
   * @param {Object} [options={}] - 额外选项
   * @returns {HttpApi} 返回自身
   */
  options(url, handler, options = {}) {
    return this.addRoute('OPTIONS', url, handler, options);
  }

  /**
   * 添加 HEAD 路由
   * @param {string} url - 路由路径
   * @param {Function} handler - 处理器函数
   * @param {Object} [options={}] - 额外选项
   * @returns {HttpApi} 返回自身
   */
  head(url, handler, options = {}) {
    return this.addRoute('HEAD', url, handler, options);
  }

  /**
   * 发送 JSON 响应
   * @param {Object} reply - Fastify reply 对象
   * @param {*} data - 响应数据
   * @param {number} [code=200] - HTTP 状态码
   * @returns {Object} reply 对象
   */
  json(reply, data, code = 200) {
    return reply.code(code).send(data);
  }

  /**
   * 发送成功响应
   * @param {Object} reply - Fastify reply 对象
   * @param {*} data - 响应数据
   * @param {string} [message='操作成功'] - 消息
   * @returns {Object} reply 对象
   */
  success(reply, data = null, message = '操作成功') {
    return this.json(reply, {
      success: true,
      message,
      data,
      timestamp: Date.now()
    });
  }

  /**
   * 发送错误响应
   * @param {Object} reply - Fastify reply 对象
   * @param {string|Error} error - 错误信息或错误对象
   * @param {number} [code=400] - HTTP 状态码
   * @returns {Object} reply 对象
   */
  error(reply, error, code = 400) {
    const message = error instanceof Error ? error.message : String(error);

    return this.json(
      reply,
      {
        success: false,
        error: message,
        timestamp: Date.now()
      },
      code
    );
  }

  /**
   * 发送分页响应
   * @param {Object} reply - Fastify reply 对象
   * @param {Array} items - 数据项
   * @param {number} total - 总数
   * @param {number} page - 当前页
   * @param {number} pageSize - 每页大小
   * @returns {Object} reply 对象
   */
  paginate(reply, items, total, page, pageSize) {
    return this.json(reply, {
      success: true,
      data: {
        items,
        pagination: {
          total,
          page,
          pageSize,
          totalPages: Math.ceil(total / pageSize)
        }
      },
      timestamp: Date.now()
    });
  }

  /**
   * 发送文件
   * @param {Object} reply - Fastify reply 对象
   * @param {string} filePath - 文件路径
   * @param {Object} [options={}] - 选项
   * @returns {Object} reply 对象
   */
  sendFile(reply, filePath, options = {}) {
    return reply.sendFile(filePath, options);
  }

  /**
   * 重定向
   * @param {Object} reply - Fastify reply 对象
   * @param {string} url - 目标 URL
   * @param {number} [code=302] - HTTP 状态码
   * @returns {Object} reply 对象
   */
  redirect(reply, url, code = 302) {
    return reply.redirect(code, url);
  }

  /**
   * 检查 API 授权
   * @param {Object} request - Fastify request 对象
   * @returns {boolean} 是否通过授权
   */
  checkAuth(request) {
    if (this.bot && typeof this.bot.checkApiAuthorization === 'function') {
      return this.bot.checkApiAuthorization(request);
    }
    return true;
  }

  /**
   * 验证必需参数
   * @param {Object} data - 数据对象
   * @param {Array<string>} required - 必需字段列表
   * @returns {Object} 验证结果 { valid: boolean, missing: Array }
   */
  validateRequired(data, required) {
    const missing = [];

    for (const field of required) {
      if (data[field] === undefined || data[field] === null || data[field] === '') {
        missing.push(field);
      }
    }

    return {
      valid: missing.length === 0,
      missing
    };
  }

  /**
   * 获取客户端 IP
   * @param {Object} request - Fastify request 对象
   * @returns {string} IP 地址
   */
  getClientIp(request) {
    return request.ip || request.socket?.remoteAddress || 'unknown';
  }

  /**
   * 记录日志
   * @param {string} level - 日志级别
   * @param {string} message - 日志消息
   * @param {string} [tag] - 标签
   */
  log(level, message, tag) {
    BotUtil.makeLog(level, message, tag || this.name);
  }

  /**
   * 获取 API 信息
   * @returns {Object} API 信息对象
   */
  getInfo() {
    return {
      name: this.name,
      dsc: this.dsc,
      priority: this.priority,
      routes: this.routes.length,
      enable: this.enable,
      createTime: this.createTime,
      key: this.key,
      prefix: this.prefix
    };
  }

  /**
   * 停止 API（清理资源）
   * @returns {Promise<void>}
   */
  async stop() {
    // 调用自定义停止方法
    if (typeof this.onStop === 'function') {
      await this.onStop();
    }

    BotUtil.makeLog('debug', `✓ ${this.name} 已停止`, 'HttpApi');
  }

  /**
   * 创建前置处理器（中间件）
   * @param {Function} handler - 处理器函数
   * @returns {Function} Fastify 兼容的前置处理器
   */
  createPreHandler(handler) {
    return async (request, reply) => {
      try {
        const context = {
          request,
          reply,
          fastify: this.fastify,
          bot: this.bot,
          api: this,
          query: request.query,
          params: request.params,
          body: request.body,
          headers: request.headers,
          ip: request.ip,
          method: request.method,
          url: request.url
        };

        await handler.call(this, context);
      } catch (error) {
        BotUtil.makeLog('error', `前置处理器错误: ${error.message}`, 'HttpApi');
        reply.code(500).send({
          success: false,
          error: '前置处理错误',
          message: error.message
        });
      }
    };
  }

  /**
   * 添加钩子
   * @param {string} hookName - 钩子名称
   * @param {Function} handler - 处理器函数
   */
  addHook(hookName, handler) {
    if (this.fastify) {
      this.fastify.addHook(hookName, handler);
    }
  }

  /**
   * 注册装饰器
   * @param {string} name - 装饰器名称
   * @param {*} value - 装饰器值
   */
  decorate(name, value) {
    if (this.fastify) {
      this.fastify.decorate(name, value);
    }
  }

  /**
   * 注册请求装饰器
   * @param {string} name - 装饰器名称
   * @param {*} value - 装饰器值
   */
  decorateRequest(name, value) {
    if (this.fastify) {
      this.fastify.decorateRequest(name, value);
    }
  }

  /**
   * 注册响应装饰器
   * @param {string} name - 装饰器名称
   * @param {*} value - 装饰器值
   */
  decorateReply(name, value) {
    if (this.fastify) {
      this.fastify.decorateReply(name, value);
    }
  }

  /**
   * 创建 JSON Schema
   * @param {Object} properties - 属性定义
   * @param {Array<string>} [required=[]] - 必需字段
   * @returns {Object} JSON Schema 对象
   */
  createSchema(properties, required = []) {
    return {
      type: 'object',
      properties,
      required
    };
  }

  /**
   * 创建响应 Schema
   * @param {Object} schema - Schema 定义
   * @param {number} [statusCode=200] - 状态码
   * @returns {Object} 响应 Schema 对象
   */
  createResponseSchema(schema, statusCode = 200) {
    return {
      [statusCode]: schema
    };
  }

  /**
   * 限流装饰器
   * @param {Object} options - 限流选项
   * @returns {Function} 前置处理器
   */
  rateLimit(options = {}) {
    const rateLimiter = new Map();
    const max = options.max || 10;
    const windowMs = options.windowMs || 60000;

    return this.createPreHandler(async (context) => {
      const key = context.ip;
      const now = Date.now();

      if (!rateLimiter.has(key)) {
        rateLimiter.set(key, { count: 1, resetTime: now + windowMs });
        return;
      }

      const limiter = rateLimiter.get(key);

      if (now > limiter.resetTime) {
        limiter.count = 1;
        limiter.resetTime = now + windowMs;
        return;
      }

      if (limiter.count >= max) {
        throw new Error('请求过于频繁');
      }

      limiter.count++;
    });
  }

  /**
   * 认证装饰器
   * @returns {Function} 前置处理器
   */
  requireAuth() {
    return this.createPreHandler(async (context) => {
      if (!this.checkAuth(context.request)) {
        context.reply.code(401).send({
          success: false,
          error: '未授权',
          message: '需要有效的API密钥'
        });
      }
    });
  }

  /**
   * 参数验证装饰器
   * @param {Array<string>} required - 必需参数
   * @param {string} [source='body'] - 参数来源 (body/query/params)
   * @returns {Function} 前置处理器
   */
  validateParams(required, source = 'body') {
    return this.createPreHandler(async (context) => {
      const data = context[source];
      const result = this.validateRequired(data, required);

      if (!result.valid) {
        context.reply.code(400).send({
          success: false,
          error: '参数验证失败',
          missing: result.missing
        });
      }
    });
  }
}