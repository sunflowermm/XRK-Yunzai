import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import path from 'path'
import { existsSync } from 'fs'

/**
 * Python运行时管理器
 * 负责Python进程的生命周期管理和通信
 */
export class PythonRuntime extends EventEmitter {
  constructor(options = {}) {
    super()
    
    /** @type {ChildProcess|null} Python进程实例 */
    this.process = null
    
    /** @type {string} 接收缓冲区 */
    this.buffer = ''
    
    /** @type {Object} 配置选项 */
    this.options = {
      pythonPath: options.pythonPath || 'python3',
      bridgePath: path.join(process.cwd(), 'lib/multiplugin/bridges/python_bridge.py'),
      pluginsDir: options.pluginsDir || 'plugins/python',
      maxRestarts: options.maxRestarts || 3,
      startTimeout: options.startTimeout || 30000,
      ...options
    }
    
    /** @type {number} 重启计数 */
    this.restartCount = 0
    
    /** @type {boolean} 是否就绪 */
    this.ready = false
    
    /** @type {boolean} 是否正在关闭 */
    this.shuttingDown = false
  }

  /**
   * 启动Python进程
   * @returns {Promise<void>}
   */
  async start() {
    if (this.process) return
    
    try {
      // 启动Python进程
      this.process = spawn(this.options.pythonPath, [
        '-u',  // 无缓冲输出
        this.options.bridgePath,
        '--plugins-dir', this.options.pluginsDir
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONPATH: this.options.pluginsDir
        }
      })
      
      // 设置事件监听
      this.setupProcessListeners()
      
      // 等待就绪
      await this.waitForReady()
      
      this.emit('started')
      
    } catch (error) {
      this.cleanup()
      throw error
    }
  }

  /**
   * 设置进程监听器
   */
  setupProcessListeners() {
    // 标准输出处理
    this.process.stdout.on('data', (data) => {
      this.buffer += data.toString()
      this.processBuffer()
    })
    
    // 错误输出处理
    this.process.stderr.on('data', (data) => {
      const message = data.toString().trim()
      
      // 过滤Python警告
      if (message.includes('UserWarning') || message.includes('DeprecationWarning')) {
        this.emit('log', { level: 'debug', message })
      } else {
        this.emit('log', { level: 'error', message })
      }
    })
    
    // 进程退出处理
    this.process.on('exit', (code, signal) => {
      this.process = null
      this.ready = false
      
      if (this.shuttingDown) return
      
      this.emit('log', { 
        level: 'warn', 
        message: `Python进程退出 (code: ${code}, signal: ${signal})` 
      })
      
      // 自动重启逻辑
      if (this.restartCount < this.options.maxRestarts) {
        this.restartCount++
        this.emit('log', { 
          level: 'info', 
          message: `尝试重启Python运行时 (${this.restartCount}/${this.options.maxRestarts})` 
        })
        
        setTimeout(() => {
          if (!this.shuttingDown) {
            this.start().catch(err => this.emit('error', err))
          }
        }, 3000)
      } else {
        this.emit('error', new Error('Python运行时崩溃次数过多'))
      }
    })
    
    // 进程错误处理
    this.process.on('error', (error) => {
      this.emit('error', error)
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
        // 非JSON输出作为日志
        this.emit('log', { level: 'debug', message: line })
      }
    }
  }

  /**
   * 处理消息
   * @param {Object} message - 消息对象
   */
  handleMessage(message) {
    const { type, data } = message
    
    switch (type) {
      case 'ready':
        this.ready = true
        this.restartCount = 0
        this.emit('ready')
        break
        
      case 'plugin_loaded':
        this.emit('plugin:loaded', data)
        break
        
      case 'log':
        this.emit('log', data)
        break
        
      default:
        this.emit('message', message)
    }
  }

  /**
   * 等待就绪
   * @returns {Promise<void>}
   */
  async waitForReady() {
    if (this.ready) return
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Python运行时启动超时'))
      }, this.options.startTimeout)
      
      const readyHandler = () => {
        clearTimeout(timeout)
        resolve()
      }
      
      const errorHandler = (error) => {
        clearTimeout(timeout)
        this.removeListener('ready', readyHandler)
        reject(error)
      }
      
      this.once('ready', readyHandler)
      this.once('error', errorHandler)
    })
  }

  /**
   * 发送消息到Python进程
   * @param {Object} message - 消息对象
   */
  send(message) {
    if (!this.process || !this.ready) {
      throw new Error('Python运行时未就绪')
    }
    
    const data = JSON.stringify(message) + '\n'
    this.process.stdin.write(data)
  }

  /**
   * 重载插件
   * @param {string} pluginKey - 插件键
   * @returns {Promise<void>}
   */
  async reloadPlugin(pluginKey) {
    return new Promise((resolve, reject) => {
      const id = Date.now().toString()
      
      const timeout = setTimeout(() => {
        this.removeAllListeners(`reload:${id}`)
        reject(new Error('重载超时'))
      }, 5000)
      
      this.once(`reload:${id}`, (result) => {
        clearTimeout(timeout)
        if (result.success) {
          resolve()
        } else {
          reject(new Error(result.error || '重载失败'))
        }
      })
      
      this.send({
        id,
        type: 'reload',
        plugin: pluginKey
      })
    })
  }

  /**
   * 清理资源
   */
  cleanup() {
    if (this.process) {
      this.process.stdout.removeAllListeners()
      this.process.stderr.removeAllListeners()
      this.process.removeAllListeners()
      
      if (this.process.exitCode === null) {
        this.process.kill('SIGTERM')
      }
      
      this.process = null
    }
    
    this.buffer = ''
    this.ready = false
  }

  /**
   * 关闭运行时
   * @returns {Promise<void>}
   */
  async shutdown() {
    this.shuttingDown = true
    
    if (!this.process) return
    
    // 发送关闭信号
    try {
      this.send({ type: 'shutdown' })
    } catch (error) {
      // 忽略发送错误
    }
    
    // 等待进程结束
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL')
        }
        resolve()
      }, 5000)
      
      if (this.process) {
        this.process.once('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      } else {
        clearTimeout(timeout)
        resolve()
      }
    })
    
    this.cleanup()
    this.emit('shutdown')
  }
}