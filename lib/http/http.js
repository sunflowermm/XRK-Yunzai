import BotUtil from '../common/util.js'

/**
 * Fastify HTTP API 基类
 * 提供标准化的API模块定义和路由注册接口
 * @class HttpApi
 */
export default class HttpApi {
  /**
   * 构造函数
   * @param {Object} config - API配置对象
   * @param {string} config.name - API名称
   * @param {string} config.dsc - API描述
   * @param {number} config.priority - 优先级（数字越大越先执行）
   * @param {boolean} config.enable - 是否启用
   * @param {Array} config.routes - 路由配置数组
   */
  constructor(config = {}) {
    // 基本信息
    this.name = config.name || 'UnnamedApi'
    this.dsc = config.dsc || '暂无描述'
    this.priority = config.priority || 100
    this.enable = config.enable !== false
    this.createTime = Date.now()

    // 路由配置
    this.routes = config.routes || []
    this.prefix = config.prefix || ''

    // 运行时属性
    this.key = ''
    this.filePath = ''
    this.fastify = null
    this.bot = null

    // 如果配置中有 init 方法，保存它
    if (typeof config.init === 'function') {
      this._customInit = config.init
    }

    // 保存其他自定义方法
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'function' && !this[key]) {
        this[key] = value
      }
    }
  }

  /**
   * 初始化API模块
   * 在此方法中注册所有路由和中间件
   * @param {Object} fastify - Fastify实例
   * @param {Object} bot - Bot实例
   * @returns {Promise<void>}
   */
  async init(fastify, bot) {
    this.fastify = fastify
    this.bot = bot

    try {
      // 如果有自定义init方法，优先执行
      if (this._customInit) {
        await this._customInit.call(this, fastify, bot)
        return
      }

      // 注册所有路由
      if (this.routes && this.routes.length > 0) {
        await this.registerRoutes(fastify, bot)
      }

      BotUtil.makeLog('debug', `API初始化完成: ${this.name}`, 'HttpApi')
    } catch (error) {
      BotUtil.makeLog('error', `API初始化失败: ${this.name}`, 'HttpApi')
      throw error
    }
  }

  /**
   * 注册路由
   * @param {Object} fastify - Fastify实例
   * @param {Object} bot - Bot实例
   * @returns {Promise<void>}
   */
  async registerRoutes(fastify, bot) {
    for (const route of this.routes) {
      try {
        await this.registerRoute(fastify, bot, route)
      } catch (error) {
        BotUtil.makeLog('error', `路由注册失败: ${route.path || 'unknown'}`, 'HttpApi')
        throw error
      }
    }
  }

  /**
   * 注册单个路由
   * @param {Object} fastify - Fastify实例
   * @param {Object} bot - Bot实例
   * @param {Object} route - 路由配置
   * @returns {Promise<void>}
   */
  async registerRoute(fastify, bot, route) {
    const {
      method = 'GET',
      path,
      handler,
      schema,
      preHandler,
      onRequest,
      preParsing,
      preValidation,
      preSerialization,
      onSend,
      onResponse,
      onError,
      onTimeout,
      config = {}
    } = route

    if (!path || !handler) {
      throw new Error(`路由配置无效: 缺少 path 或 handler`)
    }

    // 构建完整路径
    const fullPath = this.prefix ? `${this.prefix}${path}` : path

    // 构建路由选项
    const routeOptions = {
      method: Array.isArray(method) ? method : [method.toUpperCase()],
      url: fullPath,
      schema,
      config,
      handler: async (request, reply) => {
        // 注入 bot 和 api 实例
        request.bot = bot
        request.api = this

        // 构建兼容的上下文对象
        const context = {
          request,
          reply,
          bot,
          api: this,
          fastify,
          // 兼容方法
          send: (data) => reply.send(data),
          json: (data) => reply.send(data),
          status: (code) => reply.code(code),
          header: (key, value) => reply.header(key, value),
          redirect: (url) => reply.redirect(url)
        }

        try {
          // 调用处理函数
          const result = await handler.call(this, context)

          // 如果处理函数返回了数据且还没发送响应，则发送
          if (result !== undefined && !reply.sent) {
            reply.send(result)
          }
        } catch (error) {
          BotUtil.makeLog('error', `路由处理错误 [${method} ${fullPath}]: ${error.message}`, 'HttpApi')

          if (!reply.sent) {
            reply.code(500).send({
              success: false,
              error: '服务器内部错误',
              message: error.message,
              timestamp: Date.now()
            })
          }
        }
      }
    }

    // 添加钩子
    if (preHandler) routeOptions.preHandler = preHandler
    if (onRequest) routeOptions.onRequest = onRequest
    if (preParsing) routeOptions.preParsing = preParsing
    if (preValidation) routeOptions.preValidation = preValidation
    if (preSerialization) routeOptions.preSerialization = preSerialization
    if (onSend) routeOptions.onSend = onSend
    if (onResponse) routeOptions.onResponse = onResponse
    if (onError) routeOptions.onError = onError
    if (onTimeout) routeOptions.onTimeout = onTimeout

    // 注册路由
    fastify.route(routeOptions)

    BotUtil.makeLog(
      'debug',
      `注册路由: ${routeOptions.method.join('|')} ${fullPath}`,
      'HttpApi'
    )
  }

  /**
   * 停止API
   * 清理资源，取消监听器等
   */
  stop() {
    BotUtil.makeLog('debug', `停止API: ${this.name}`, 'HttpApi')
    // 子类可以重写此方法实现自定义清理逻辑
  }

  /**
   * 获取API信息
   * @returns {Object} API信息对象
   */
  getInfo() {
    return {
      name: this.name,
      dsc: this.dsc,
      priority: this.priority,
      enable: this.enable,
      routes: this.routes.length,
      prefix: this.prefix,
      key: this.key,
      createTime: this.createTime
    }
  }

  /**
   * 创建标准响应
   * @param {boolean} success - 是否成功
   * @param {*} data - 响应数据
   * @param {string} message - 响应消息
   * @returns {Object} 标准响应对象
   */
  createResponse(success = true, data = null, message = '') {
    return {
      success,
      data,
      message,
      timestamp: Date.now()
    }
  }

  /**
   * 创建成功响应
   * @param {*} data - 响应数据
   * @param {string} message - 响应消息
   * @returns {Object} 成功响应对象
   */
  success(data = null, message = '操作成功') {
    return this.createResponse(true, data, message)
  }

  /**
   * 创建错误响应
   * @param {string} message - 错误消息
   * @param {*} error - 错误详情
   * @returns {Object} 错误响应对象
   */
  error(message = '操作失败', error = null) {
    return this.createResponse(false, error, message)
  }

  /**
   * 验证请求参数
   * @param {Object} context - 上下文对象
   * @param {Object} rules - 验证规则
   * @returns {Object|null} 验证错误或null
   */
  validateParams(context, rules) {
    const { request } = context
    const params = {
      ...request.query,
      ...request.params,
      ...request.body
    }

    for (const [key, rule] of Object.entries(rules)) {
      const value = params[key]

      // 必填验证
      if (rule.required && (value === undefined || value === null || value === '')) {
        return {
          field: key,
          message: `参数 ${key} 是必填的`
        }
      }

      // 类型验证
      if (value !== undefined && rule.type) {
        const actualType = Array.isArray(value) ? 'array' : typeof value
        if (actualType !== rule.type) {
          return {
            field: key,
            message: `参数 ${key} 类型错误，期望 ${rule.type}，实际 ${actualType}`
          }
        }
      }

      // 自定义验证
      if (value !== undefined && rule.validator) {
        const result = rule.validator(value)
        if (result !== true) {
          return {
            field: key,
            message: typeof result === 'string' ? result : `参数 ${key} 验证失败`
          }
        }
      }
    }

    return null
  }

  /**
   * 获取请求参数
   * @param {Object} context - 上下文对象
   * @param {string} key - 参数键名
   * @param {*} defaultValue - 默认值
   * @returns {*} 参数值
   */
  getParam(context, key, defaultValue = null) {
    const { request } = context
    return request.query?.[key] ?? request.params?.[key] ?? request.body?.[key] ?? defaultValue
  }

  /**
   * 获取所有请求参数
   * @param {Object} context - 上下文对象
   * @returns {Object} 所有参数
   */
  getAllParams(context) {
    const { request } = context
    return {
      ...request.query,
      ...request.params,
      ...request.body
    }
  }

  /**
   * 检查用户权限
   * @param {Object} context - 上下文对象
   * @returns {boolean} 是否有权限
   */
  checkAuth(context) {
    const { request, bot } = context
    return bot.checkApiAuthorization(request)
  }

  /**
   * 获取客户端IP
   * @param {Object} context - 上下文对象
   * @returns {string} 客户端IP
   */
  getClientIp(context) {
    const { request } = context
    return request.ip || request.socket?.remoteAddress || 'unknown'
  }

  /**
   * 记录日志
   * @param {string} level - 日志级别
   * @param {string} message - 日志消息
   * @param {*} data - 附加数据
   */
  log(level, message, data) {
    BotUtil.makeLog(level, `[${this.name}] ${message}`, 'HttpApi', data)
  }
}