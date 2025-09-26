import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import path from 'path'

/**
 * Python桥接器 - 管理JavaScript与Python之间的通信
 * @class PythonBridge
 */
export class PythonBridge extends EventEmitter {
  /**
   * @param {Object} options - 配置选项
   * @param {string} options.pythonPath - Python解释器路径
   * @param {string} options.pluginsDir - 插件目录路径
   */
  constructor(options = {}) {
    super()
    
    /** @type {ChildProcess} Python进程 */
    this.process = null
    /** @type {string} 数据缓冲区 */
    this.buffer = ''
    /** @type {Map} 待处理的调用 */
    this.pendingCalls = new Map()
    /** @type {boolean} 是否就绪 */
    this.ready = false
    /** @type {Object} 配置 */
    this.options = {
      pythonPath: options.pythonPath || 'python3',
      pluginsDir: options.pluginsDir || 'plugins/python',
      bridgeScript: path.join(__dirname, 'bridge.py')
    }
  }

  /**
   * 启动Python进程
   * @returns {Promise<void>}
   */
  async start() {
    if (this.process) return

    this.process = spawn(this.options.pythonPath, [
      this.options.bridgeScript,
      '--plugins-dir', this.options.pluginsDir
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1'
      }
    })

    this.setupListeners()
    await this.waitForReady()
  }

  /**
   * 设置事件监听器
   */
  setupListeners() {
    // 处理标准输出
    this.process.stdout.on('data', (data) => {
      this.buffer += data.toString()
      this.processBuffer()
    })

    // 处理错误输出
    this.process.stderr.on('data', (data) => {
      logger.error(`[Python] ${data.toString()}`)
    })

    // 处理进程退出
    this.process.on('exit', (code) => {
      logger.warn(`Python进程退出，代码: ${code}`)
      this.process = null
      this.ready = false
      this.emit('exit', code)
    })
  }

  /**
   * 处理缓冲区数据
   */
  processBuffer() {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      
      try {
        const message = JSON.parse(line)
        this.handleMessage(message)
      } catch (error) {
        logger.debug(`解析消息失败: ${line}`)
      }
    }
  }

  /**
   * 处理接收的消息
   * @param {Object} message - 消息对象
   */
  handleMessage(message) {
    const { type, id, data } = message

    switch (type) {
      case 'ready':
        this.ready = true
        this.emit('ready')
        break
      
      case 'plugin_registered':
        this.emit('plugin_registered', data)
        break
      
      case 'response':
        const pending = this.pendingCalls.get(id)
        if (pending) {
          this.pendingCalls.delete(id)
          if (data.error) {
            pending.reject(new Error(data.error))
          } else {
            pending.resolve(data.result)
          }
        }
        break
      
      case 'log':
        logger[data.level || 'info'](`[Python] ${data.message}`)
        break
      
      default:
        logger.debug(`未知消息类型: ${type}`)
    }
  }

  /**
   * 等待Python进程就绪
   * @returns {Promise<void>}
   */
  waitForReady() {
    if (this.ready) return Promise.resolve()

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Python进程启动超时'))
      }, 30000)

      this.once('ready', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  /**
   * 调用Python插件方法
   * @param {string} plugin - 插件名
   * @param {string} method - 方法名
   * @param {Array} args - 参数
   * @returns {Promise<any>}
   */
  async callPlugin(plugin, method, args = []) {
    if (!this.ready) {
      throw new Error('Python进程未就绪')
    }

    const id = Date.now() + Math.random()
    
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(id, { resolve, reject })
      
      setTimeout(() => {
        if (this.pendingCalls.has(id)) {
          this.pendingCalls.delete(id)
          reject(new Error('调用超时'))
        }
      }, 30000)
      
      this.send({
        type: 'call',
        id,
        plugin,
        method,
        args
      })
    })
  }

  /**
   * 发送消息到Python进程
   * @param {Object} message - 消息对象
   */
  send(message) {
    if (!this.process) {
      throw new Error('Python进程未运行')
    }
    
    const data = JSON.stringify(message) + '\n'
    this.process.stdin.write(data)
  }

  /**
   * 关闭Python进程
   * @returns {Promise<void>}
   */
  async shutdown() {
    if (!this.process) return

    this.send({ type: 'shutdown' })
    
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.process.kill('SIGKILL')
        resolve()
      }, 5000)

      this.process.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
}