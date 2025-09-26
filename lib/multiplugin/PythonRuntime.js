import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import path from 'path'
import { existsSync } from 'fs'

/**
 * Python运行时管理器
 */
export class PythonRuntime extends EventEmitter {
  constructor(options = {}) {
    super()
    this.process = null
    this.buffer = ''
    this.options = {
      pythonPath: options.pythonPath || 'python',
      bridgePath: path.join(process.cwd(), 'lib/multiplugin/python_bridge.py'),
      maxRestarts: 3,
      ...options
    }
    this.restartCount = 0
    this.ready = false
  }

  /**
   * 启动Python进程
   */
  async start() {
    if (this.process) return

    // 检查Python环境
    await this.checkPythonEnvironment()

    // 启动进程
    this.process = spawn(this.options.pythonPath, [
      this.options.bridgePath,
      '--plugins-dir', path.join(process.cwd(), 'plugins/python')
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1'
      }
    })

    // 设置事件监听
    this.setupProcessListeners()

    // 等待就绪
    await this.waitForReady()
  }

  /**
   * 检查Python环境
   */
  async checkPythonEnvironment() {
    try {
      const { execSync } = await import('child_process')
      const version = execSync(`${this.options.pythonPath} --version`, { encoding: 'utf8' })
      logger.info(`Python环境: ${version.trim()}`)
      
      // 检查依赖
      const requirementsPath = path.join(process.cwd(), 'plugins/python/requirements.txt')
      if (existsSync(requirementsPath)) {
        logger.info('安装Python依赖...')
        execSync(`${this.options.pythonPath} -m pip install -r ${requirementsPath} --quiet`, {
          cwd: path.dirname(requirementsPath)
        })
      }
    } catch (error) {
      throw new Error(`Python环境检查失败: ${error.message}`)
    }
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
      logger.error(`[Python] ${data.toString()}`)
    })

    // 进程退出
    this.process.on('exit', (code) => {
      logger.warn(`Python进程退出，代码: ${code}`)
      this.process = null
      this.ready = false
      
      if (this.restartCount < this.options.maxRestarts) {
        this.restartCount++
        logger.info(`尝试重启Python运行时 (${this.restartCount}/${this.options.maxRestarts})`)
        setTimeout(() => this.start(), 3000)
      } else {
        this.emit('error', new Error('Python运行时崩溃次数过多'))
      }
    })

    // 进程错误
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
        
        if (message.type === 'ready') {
          this.ready = true
          this.emit('ready')
        } else {
          this.emit('message', message)
        }
      } catch (error) {
        logger.debug(`解析Python消息失败: ${line}`)
      }
    }
  }

  /**
   * 等待就绪
   */
  async waitForReady() {
    if (this.ready) return

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
  send(message) {
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
      this.send({ type: 'shutdown' })
      
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