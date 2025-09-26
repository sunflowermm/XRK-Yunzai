import { EventEmitter } from 'events'
import { PythonRuntime } from './runtimes/PythonRuntime.js'
import { v4 as uuidv4 } from 'uuid'

/**
 * 插件桥接器
 * 统一管理不同语言运行时的插件通信
 */
export class PluginBridge extends EventEmitter {
  constructor(options = {}) {
    super()
    
    /** @type {Map<string, any>} 运行时实例映射 */
    this.runtimes = new Map()
    
    /** @type {Map<string, Promise>} 待处理的调用 */
    this.pendingCalls = new Map()
    
    /** @type {Map<string, Object>} 已注册的插件 */
    this.plugins = new Map()
    
    /** @type {Object} 配置选项 */
    this.options = {
      pluginsDir: options.pluginsDir || 'plugins',
      languages: options.languages || ['python'],
      callTimeout: options.callTimeout || 30000,
      ...options
    }
    
    /** @type {boolean} 是否已启动 */
    this.started = false
  }

  /**
   * 启动桥接器
   * @returns {Promise<void>}
   */
  async start() {
    if (this.started) return
    
    // 初始化各语言运行时
    for (const language of this.options.languages) {
      await this.initRuntime(language)
    }
    
    this.started = true
    this.emit('ready')
  }

  /**
   * 初始化运行时
   * @param {string} language - 语言类型
   * @returns {Promise<void>}
   */
  async initRuntime(language) {
    try {
      let runtime
      
      switch (language) {
        case 'python':
          runtime = new PythonRuntime({
            pythonPath: this.options.pythonPath,
            pluginsDir: `${this.options.pluginsDir}/python`
          })
          break
        
        // 可扩展其他语言
        // case 'nodejs':
        //   runtime = new NodeRuntime(...)
        //   break
        
        default:
          throw new Error(`不支持的语言: ${language}`)
      }
      
      // 设置运行时事件监听
      runtime.on('message', (msg) => this.handleRuntimeMessage(language, msg))
      runtime.on('error', (err) => this.handleRuntimeError(language, err))
      runtime.on('plugin:loaded', (plugin) => this.handlePluginLoaded(language, plugin))
      runtime.on('log', (log) => this.handleRuntimeLog(language, log))
      
      // 启动运行时
      await runtime.start()
      
      // 保存运行时实例
      this.runtimes.set(language, runtime)
      
      this.emit('runtime:started', { language })
      
    } catch (error) {
      this.emit('runtime:error', { language, error })
      throw error
    }
  }

  /**
   * 处理运行时消息
   * @param {string} language - 语言类型
   * @param {Object} message - 消息对象
   */
  handleRuntimeMessage(language, message) {
    const { id, type, data } = message
    
    switch (type) {
      case 'response':
        this.resolveCall(id, data)
        break
        
      case 'event':
        this.emit('plugin:event', { language, ...data })
        break
        
      case 'request':
        this.handlePluginRequest(language, message)
        break
        
      default:
        this.emit('runtime:message', { language, message })
    }
  }

  /**
   * 处理运行时错误
   * @param {string} language - 语言类型
   * @param {Error} error - 错误对象
   */
  handleRuntimeError(language, error) {
    this.emit('runtime:error', { language, error })
    
    // 拒绝所有待处理的该语言调用
    for (const [id, call] of this.pendingCalls.entries()) {
      if (call.language === language) {
        call.reject(error)
        this.pendingCalls.delete(id)
      }
    }
  }

  /**
   * 处理插件加载事件
   * @param {string} language - 语言类型
   * @param {Object} plugin - 插件信息
   */
  handlePluginLoaded(language, plugin) {
    const key = `${language}:${plugin.key}`
    this.plugins.set(key, { ...plugin, language })
    
    this.emit('plugin:loaded', { language, plugin })
  }

  /**
   * 处理运行时日志
   * @param {string} language - 语言类型
   * @param {Object} log - 日志信息
   */
  handleRuntimeLog(language, log) {
    this.emit('plugin:log', { 
      language, 
      level: log.level || 'info', 
      message: log.message 
    })
  }

  /**
   * 处理插件请求（插件主动调用Node.js功能）
   * @param {string} language - 语言类型
   * @param {Object} request - 请求对象
   */
  async handlePluginRequest(language, request) {
    const { id, method, params } = request
    const runtime = this.runtimes.get(language)
    
    try {
      let result
      
      // 处理插件请求的Node.js功能
      switch (method) {
        case 'redis:get':
          result = await redis.get(params.key)
          break
          
        case 'redis:set':
          result = await redis.set(params.key, params.value, params.options)
          break
          
        case 'config:get':
          result = cfg[params.key]
          break
          
        // 可扩展更多功能
        
        default:
          throw new Error(`未知的请求方法: ${method}`)
      }
      
      // 返回结果
      runtime.send({
        id,
        type: 'response',
        data: { value: result }
      })
      
    } catch (error) {
      runtime.send({
        id,
        type: 'response',
        data: { error: error.message }
      })
    }
  }

  /**
   * 调用插件方法
   * @param {string} language - 语言类型
   * @param {string} pluginKey - 插件键
   * @param {string} method - 方法名
   * @param {Object} params - 参数
   * @returns {Promise<any>}
   */
  async callPlugin(language, pluginKey, method, params = {}) {
    const runtime = this.runtimes.get(language)
    if (!runtime) {
      throw new Error(`运行时未找到: ${language}`)
    }
    
    const callId = uuidv4()
    
    // 创建待处理调用
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCalls.delete(callId)
        reject(new Error(`调用超时: ${pluginKey}.${method}`))
      }, this.options.callTimeout)
      
      this.pendingCalls.set(callId, {
        resolve,
        reject,
        timeout,
        language
      })
    })
    
    // 发送调用请求
    runtime.send({
      id: callId,
      type: 'call',
      plugin: pluginKey,
      method,
      params
    })
    
    return promise
  }

  /**
   * 解析调用结果
   * @param {string} id - 调用ID
   * @param {Object} result - 结果数据
   */
  resolveCall(id, result) {
    const pending = this.pendingCalls.get(id)
    if (!pending) return
    
    this.pendingCalls.delete(id)
    clearTimeout(pending.timeout)
    
    if (result.error) {
      pending.reject(new Error(result.error))
    } else {
      pending.resolve(result)
    }
  }

  /**
   * 获取插件信息
   * @param {string} language - 语言类型
   * @param {string} pluginKey - 插件键
   * @returns {Object|null}
   */
  getPlugin(language, pluginKey) {
    return this.plugins.get(`${language}:${pluginKey}`) || null
  }

  /**
   * 获取所有插件
   * @param {string} language - 语言类型（可选）
   * @returns {Array<Object>}
   */
  getAllPlugins(language = null) {
    const plugins = []
    
    for (const [key, plugin] of this.plugins) {
      if (!language || plugin.language === language) {
        plugins.push(plugin)
      }
    }
    
    return plugins
  }

  /**
   * 重载插件
   * @param {string} language - 语言类型
   * @param {string} pluginKey - 插件键
   * @returns {Promise<void>}
   */
  async reloadPlugin(language, pluginKey) {
    const runtime = this.runtimes.get(language)
    if (!runtime) {
      throw new Error(`运行时未找到: ${language}`)
    }
    
    await runtime.reloadPlugin(pluginKey)
  }

  /**
   * 关闭桥接器
   * @returns {Promise<void>}
   */
  async shutdown() {
    // 清理待处理调用
    for (const [id, call] of this.pendingCalls) {
      call.reject(new Error('桥接器关闭'))
      clearTimeout(call.timeout)
    }
    this.pendingCalls.clear()
    
    // 关闭所有运行时
    const shutdownPromises = []
    for (const [language, runtime] of this.runtimes) {
      shutdownPromises.push(
        runtime.shutdown()
          .catch(err => this.emit('runtime:error', { language, error: err }))
      )
    }
    
    await Promise.all(shutdownPromises)
    
    this.runtimes.clear()
    this.plugins.clear()
    this.started = false
    
    this.emit('shutdown')
  }
}