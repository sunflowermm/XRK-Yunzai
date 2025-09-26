import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { v4 as uuidv4 } from 'uuid'

/**
 * 多语言桥接器
 * @class LanguageBridge
 * @extends EventEmitter
 * @description 管理不同语言运行时之间的通信
 */
export class LanguageBridge extends EventEmitter {
  constructor(options = {}) {
    super()
    
    this.options = {
      pluginsDir: options.pluginsDir || 'plugins',
      languages: options.languages || {},
      timeout: options.timeout || 30000,
      maxRestarts: options.maxRestarts || 3
    }
    
    // 运行时管理
    this.runtimes = new Map()
    this.pendingCalls = new Map()
    this.plugins = new Map()
    
    // 状态管理
    this.initialized = false
    this.restartCounts = new Map()
  }

  /**
   * 初始化桥接器
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) return
    
    logger.info('初始化多语言桥接器...')
    
    // 初始化各语言运行时
    for (const [language, config] of Object.entries(this.options.languages)) {
      if (config.enabled) {
        await this.initializeRuntime(language, config)
      }
    }
    
    this.initialized = true
    logger.success('多语言桥接器初始化完成')
  }

  /**
   * 初始化单个语言运行时
   * @param {string} language - 语言名称
   * @param {Object} config - 语言配置
   */
  async initializeRuntime(language, config) {
    try {
      logger.info(`启动${language}运行时...`)
      
      const runtime = this.createRuntime(language, config)
      this.runtimes.set(language, runtime)
      
      // 设置事件监听
      this.setupRuntimeListeners(language, runtime)
      
      // 启动运行时
      await runtime.start()
      
      // 加载插件
      await this.loadLanguagePlugins(language)
      
      this.emit('runtime-ready', { language })
      logger.success(`${language}运行时启动成功`)
      
    } catch (error) {
      logger.error(`${language}运行时启动失败: ${error.message}`)
      this.emit('runtime-error', { language, error })
    }
  }

  /**
   * 创建运行时实例
   * @param {string} language - 语言名称
   * @param {Object} config - 配置
   * @returns {Object} 运行时实例
   */
  createRuntime(language, config) {
    switch (language) {
      case 'python':
        return new PythonRuntime({
          ...config,
          bridgePath: path.join(__dirname, 'bridges', 'python_bridge.py'),
          pluginsDir: path.join(this.options.pluginsDir, 'python')
        })
      // 可扩展其他语言
      default:
        throw new Error(`不支持的语言: ${language}`)
    }
  }

  /**
   * 设置运行时监听器
   * @param {string} language - 语言名称
   * @param {Object} runtime - 运行时实例
   */
  setupRuntimeListeners(language, runtime) {
    // 消息处理
    runtime.on('message', (msg) => {
      this.handleRuntimeMessage(language, msg)
    })
    
    // 错误处理
    runtime.on('error', (error) => {
      this.handleRuntimeError(language, error)
    })
    
    // 退出处理
    runtime.on('exit', (code) => {
      this.handleRuntimeExit(language, code)
    })
  }

  /**
   * 处理运行时消息
   * @param {string} language - 语言名称
   * @param {Object} message - 消息
   */
  handleRuntimeMessage(language, message) {
    const { id, type, data } = message
    
    switch (type) {
      case 'response':
        this.resolveCall(id, data)
        break
        
      case 'plugin_registered':
        this.registerPlugin(language, data)
        break
        
      case 'log':
        logger[data.level || 'info'](`[${language}] ${data.message}`)
        break
        
      case 'event':
        this.emit('plugin-event', { language, ...data })
        break
        
      default:
        logger.debug(`[${language}] 未知消息类型: ${type}`)
    }
  }

  /**
   * 处理运行时错误
   * @param {string} language - 语言名称
   * @param {Error} error - 错误对象
   */
  handleRuntimeError(language, error) {
    logger.error(`[${language}] 运行时错误: ${error.message}`)
    this.emit('runtime-error', { language, error })
  }

  /**
   * 处理运行时退出
   * @param {string} language - 语言名称
   * @param {number} code - 退出码
   */
  async handleRuntimeExit(language, code) {
    logger.warn(`[${language}] 运行时退出，代码: ${code}`)
    
    // 尝试重启
    const restartCount = this.restartCounts.get(language) || 0
    if (restartCount < this.options.maxRestarts) {
      this.restartCounts.set(language, restartCount + 1)
      logger.info(`尝试重启${language}运行时 (${restartCount + 1}/${this.options.maxRestarts})`)
      
      setTimeout(() => {
        const config = this.options.languages[language]
        if (config) {
          this.initializeRuntime(language, config)
        }
      }, 3000)
    } else {
      logger.error(`${language}运行时重启次数过多，已停止`)
      this.runtimes.delete(language)
    }
  }

  /**
   * 注册插件
   * @param {string} language - 语言
   * @param {Object} plugin - 插件信息
   */
  registerPlugin(language, plugin) {
    const key = `${language}:${plugin.key}`
    this.plugins.set(key, { ...plugin, language })
    
    this.emit('plugin-registered', { language, plugin })
    logger.debug(`注册插件: ${key} [${plugin.name}]`)
  }

  /**
   * 加载语言插件
   * @param {string} language - 语言名称
   */
  async loadLanguagePlugins(language) {
    const runtime = this.runtimes.get(language)
    if (!runtime) return
    
    // 发送加载插件命令
    await runtime.send({
      type: 'load_plugins',
      data: {
        dir: path.join(this.options.pluginsDir, language)
      }
    })
  }

  /**
   * 调用插件方法
   * @param {string} language - 语言
   * @param {string} pluginKey - 插件键
   * @param {string} method - 方法名
   * @param {Array} args - 参数
   * @returns {Promise<any>}
   */
  async callPlugin(language, pluginKey, method, args = []) {
    const runtime = this.runtimes.get(language)
    if (!runtime) {
      throw new Error(`${language}运行时不可用`)
    }
    
    const callId = uuidv4()
    const promise = new Promise((resolve, reject) => {
      // 设置超时
      const timeout = setTimeout(() => {
        this.pendingCalls.delete(callId)
        reject(new Error(`插件调用超时: ${pluginKey}.${method}`))
      }, this.options.timeout)
      
      this.pendingCalls.set(callId, { resolve, reject, timeout })
    })
    
    // 发送调用请求
    await runtime.send({
      id: callId,
      type: 'call',
      plugin: pluginKey,
      method,
      args
    })
    
    return promise
  }

  /**
   * 解析调用结果
   * @param {string} id - 调用ID
   * @param {Object} result - 结果
   */
  resolveCall(id, result) {
    const pending = this.pendingCalls.get(id)
    if (!pending) return
    
    this.pendingCalls.delete(id)
    clearTimeout(pending.timeout)
    
    if (result.error) {
      pending.reject(new Error(result.error))
    } else {
      pending.resolve(result.value)
    }
  }

  /**
   * 关闭桥接器
   */
  async shutdown() {
    logger.info('关闭多语言桥接器...')
    
    // 关闭所有运行时
    const promises = []
    for (const [language, runtime] of this.runtimes) {
      promises.push(runtime.shutdown().catch(err => {
        logger.error(`关闭${language}运行时失败: ${err.message}`)
      }))
    }
    
    await Promise.all(promises)
    
    // 清理
    this.runtimes.clear()
    this.pendingCalls.clear()
    this.plugins.clear()
    this.initialized = false
    
    logger.success('多语言桥接器已关闭')
  }
}

/**
 * Python运行时
 * @class PythonRuntime
 * @extends EventEmitter
 */
class PythonRuntime extends EventEmitter {
  constructor(options) {
    super()
    
    this.options = {
      runtime: options.runtime || 'python3',
      venv: options.venv,
      bridgePath: options.bridgePath,
      pluginsDir: options.pluginsDir
    }
    
    this.process = null
    this.buffer = ''
    this.ready = false
  }

  /**
   * 启动Python运行时
   */
  async start() {
    // 构建Python命令
    let pythonCmd = this.options.runtime
    if (this.options.venv) {
      pythonCmd = path.join(this.options.venv, 'bin', 'python')
    }
    
    // 启动进程
    this.process = spawn(pythonCmd, [
      this.options.bridgePath,
      '--plugins-dir', this.options.pluginsDir
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1'
      }
    })
    
    // 设置监听器
    this.setupProcessListeners()
    
    // 等待就绪
    await this.waitForReady()
  }

  /**
   * 设置进程监听器
   */
  setupProcessListeners() {
    // 标准输出
    this.process.stdout.on('data', (data) => {
      this.buffer += data.toString()
      this.processBuffer()
    })
    
    // 错误输出
    this.process.stderr.on('data', (data) => {
      const msg = data.toString()
      // 过滤已知警告
      if (!msg.includes('pkg_resources is deprecated')) {
        logger.error(`[Python] ${msg}`)
      }
    })
    
    // 进程退出
    this.process.on('exit', (code) => {
      this.ready = false
      this.process = null
      this.emit('exit', code)
    })
    
    // 进程错误
    this.process.on('error', (error) => {
      this.emit('error', error)
    })
  }

  /**
   * 处理缓冲区
   */
  processBuffer() {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''
    
    for (const line of lines) {
      if (!line.trim()) continue
      
      try {
        const message = JSON.parse(line)
        
        if (message.type === 'ready') {
          this.ready = true
          this.emit('ready')
        } else {
          this.emit('message', message)
        }
      } catch (error) {
        // 忽略非JSON行
      }
    }
  }

  /**
   * 等待就绪
   */
  waitForReady() {
    if (this.ready) return Promise.resolve()
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Python运行时启动超时'))
      }, 30000)
      
      this.once('ready', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  /**
   * 发送消息
   */
  async send(message) {
    if (!this.process || !this.ready) {
      throw new Error('Python运行时未就绪')
    }
    
    const data = JSON.stringify(message) + '\n'
    this.process.stdin.write(data)
  }

  /**
   * 关闭运行时
   */
  async shutdown() {
    if (this.process) {
      await this.send({ type: 'shutdown' })
      
      // 等待进程结束
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this.process.kill('SIGKILL')
          resolve()
        }, 5000)
        
        this.process.once('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
      
      this.process = null
      this.ready = false
    }
  }
}