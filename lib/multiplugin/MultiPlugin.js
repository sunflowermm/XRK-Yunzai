import { EventEmitter } from 'events'
import path from 'path'
import { spawn } from 'child_process'
import { v4 as uuidv4 } from 'uuid'

/**
 * 多语言插件基类
 * 负责管理不同语言的插件运行时
 */
export class MultiPlugin extends EventEmitter {
  constructor(options = {}) {
    super()
    this.runtimes = new Map()
    this.plugins = new Map()
    this.pendingCalls = new Map()
    this.options = options
  }

  /**
   * 注册运行时
   */
  registerRuntime(language, runtime) {
    this.runtimes.set(language, runtime)
    runtime.on('message', this.handleRuntimeMessage.bind(this, language))
    runtime.on('error', this.handleRuntimeError.bind(this, language))
  }

  /**
   * 处理运行时消息
   */
  handleRuntimeMessage(language, message) {
    const { id, type, data } = message

    switch (type) {
      case 'response':
        this.resolveCall(id, data)
        break
      case 'event':
        this.emit('plugin-event', { language, ...data })
        break
      case 'log':
        logger[data.level || 'info'](`[${language}] ${data.message}`)
        break
      default:
        logger.debug(`未知消息类型: ${type}`)
    }
  }

  /**
   * 处理运行时错误
   */
  handleRuntimeError(language, error) {
    logger.error(`[${language}] 运行时错误: ${error.message}`)
    this.emit('runtime-error', { language, error })
  }

  /**
   * 调用插件方法
   */
  async callPlugin(language, pluginName, method, args = []) {
    const runtime = this.runtimes.get(language)
    if (!runtime) {
      throw new Error(`未找到${language}运行时`)
    }

    const callId = uuidv4()
    const promise = new Promise((resolve, reject) => {
      this.pendingCalls.set(callId, { resolve, reject })
      
      setTimeout(() => {
        if (this.pendingCalls.has(callId)) {
          this.pendingCalls.delete(callId)
          reject(new Error('插件调用超时'))
        }
      }, 30000)
    })

    runtime.send({
      id: callId,
      type: 'call',
      plugin: pluginName,
      method,
      args
    })

    return promise
  }

  /**
   * 解析调用结果
   */
  resolveCall(id, result) {
    const pending = this.pendingCalls.get(id)
    if (pending) {
      this.pendingCalls.delete(id)
      if (result.error) {
        pending.reject(new Error(result.error))
      } else {
        pending.resolve(result.value)
      }
    }
  }

  /**
   * 注册插件
   */
  registerPlugin(plugin) {
    const key = `${plugin.language}:${plugin.name}`
    this.plugins.set(key, plugin)
    return plugin
  }

  /**
   * 获取插件
   */
  getPlugin(language, name) {
    return this.plugins.get(`${language}:${name}`)
  }

  /**
   * 关闭所有运行时
   */
  async shutdown() {
    for (const [language, runtime] of this.runtimes) {
      try {
        await runtime.shutdown()
      } catch (error) {
        logger.error(`关闭${language}运行时失败: ${error.message}`)
      }
    }
  }
}

export default new MultiPlugin()