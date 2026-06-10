/**
 * 统一日志与调试系统
 * - 分级：trace < debug < info(warn/error/fatal)；mark/success/tip 与 info 同级
 * - 全局等级：config.bot.log_level；按模块覆盖：config.bot.log_modules[模块名]
 * - BotUtil.makeLog(level, msg, id, trace) 使用 id 作为模块名，并受 log_modules 控制
 * - logger.logTag(level, tag, ...args) 带模块标签输出，文件日志含 module 字段便于过滤
 */
import pino from 'pino'
import chalk from 'chalk'
import cfg from './config.js'
import path from 'node:path'
import util from 'node:util'
import { execSync } from 'node:child_process'
import { FileUtils } from '../utils/file-utils.js'
import schedule from 'node-schedule'
import { createStream } from 'rotating-file-stream'

/** Logger 配置常量 */
const LOGGER_CONFIG = {
  LOG_DIR: './logs',
  MAIN_LOG_PREFIX: 'app',
  TRACE_LOG_PREFIX: 'trace',
  ROTATION_INTERVAL: '1d',
  COMPRESSION: 'gzip',
  CLEANUP_TIME: '0 3 * * *',
  DEFAULT_MAX_DAYS: 3,
  DEFAULT_TRACE_DAYS: 1,
  // trace.log 单文件最大大小（100MB），超过后自动轮转
  TRACE_MAX_SIZE: 100 * 1024 * 1024,
  // 单次清理检查的最大文件数，避免一次性处理过多文件
  CLEANUP_BATCH_SIZE: 1000
}

/**
 * 颜色方案配置
 */
const COLOR_SCHEMES = {
  default: ['#3494E6', '#3498db', '#00b4d8', '#0077b6', '#023e8a'],
  scheme1: ['#FF0000', '#FF7F00', '#FFFF00', '#00FF00', '#0000FF'],
  scheme2: ['#FF69B4', '#FF1493', '#C71585', '#DB7093', '#FFC0CB'],
  scheme3: ['#00CED1', '#20B2AA', '#48D1CC', '#008B8B', '#5F9EA0'],
  scheme4: ['#8A2BE2', '#9370DB', '#7B68EE', '#6A5ACD', '#483D8B'],
  scheme5: ['#36D1DC', '#5B86E5', '#4776E6', '#8E54E9', '#6A82FB'],
  scheme6: ['#FF512F', '#F09819', '#FF8008', '#FD746C', '#FE9A8B'],
  scheme7: ['#11998e', '#38ef7d', '#56ab2f', '#a8e063', '#76b852']
}

const TIMESTAMP_SCHEMES = {
  default: ['#64B5F6', '#90CAF9', '#BBDEFB', '#E3F2FD', '#B3E5FC'],
  scheme1: ['#FFCCBC', '#FFAB91', '#FF8A65', '#FF7043', '#FF5722'],
  scheme2: ['#F8BBD0', '#F48FB1', '#F06292', '#EC407A', '#E91E63'],
  scheme3: ['#B2DFDB', '#80CBC4', '#4DB6AC', '#26A69A', '#009688'],
  scheme4: ['#D1C4E9', '#B39DDB', '#9575CD', '#7E57C2', '#673AB7'],
  scheme5: ['#90CAF9', '#64B5F6', '#42A5F5', '#2196F3', '#1E88E5'],
  scheme6: ['#FFAB91', '#FF8A65', '#FF7043', '#FF5722', '#F4511E'],
  scheme7: ['#A5D6A7', '#81C784', '#66BB6A', '#4CAF50', '#43A047']
}

/**
 * 日志级别样式与语义（分级从低到高）
 * - trace (10): 最细粒度，请求/消息级追踪、定时任务、进度
 * - debug (20): 内部细节、加载/连接、排错，默认不显示
 * - info (30): 用户可见里程碑（启动/完成/注册）、状态变化；mark/success/tip/done 同档
 * - warn (40): 可恢复异常、降级、重试
 * - error (50): 错误、失败
 * - fatal (60): 致命错误
 */
const LOG_STYLES = {
  trace: { symbol: '•', color: 'grey', level: 10 },
  debug: { symbol: '⚙', color: 'cyan', level: 20 },
  info: { symbol: 'ℹ', color: 'blue', level: 30 },
  warn: { symbol: '⚠', color: 'yellow', level: 40 },
  error: { symbol: '✗', color: 'red', level: 50 },
  fatal: { symbol: '☠', color: 'redBright', level: 60 },
  mark: { symbol: '✧', color: 'magenta', level: 30 },
  success: { symbol: '✓', color: 'green', level: 30 },
  tip: { symbol: '💡', color: 'yellow', level: 30 },
  done: { symbol: '✓', color: 'greenBright', level: 30 }
}

/** 有效日志级别列表，用于 logTag 等 */
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'mark', 'success', 'tip']

/**
 * 初始化日志系统
 * @returns {Object} 全局 logger 对象
 */
export default function setLog() {
  fixWindowsUTF8()

  const logColor = cfg.bot.log_color || 'default';
  const selectedScheme = COLOR_SCHEMES[logColor] || COLOR_SCHEMES.default;
  const selectedTimestampColors = TIMESTAMP_SCHEMES[logColor] || TIMESTAMP_SCHEMES.default;
  const logLevel = cfg.bot.log_level || 'info';

  // 创建日志轮转流
  const fileStream = createRotatingStream(LOGGER_CONFIG.MAIN_LOG_PREFIX, cfg.bot.log_max_days)
  const traceStream = createRotatingStream(LOGGER_CONFIG.TRACE_LOG_PREFIX, cfg.bot.log_trace_days)

  // 创建 Pino 实例
  const pinoLogger = pino(
    {
      level: 'trace',
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      formatters: {
        level: (label) => ({ level: label })
      }
    },
    pino.multistream([
      { stream: fileStream, level: 'debug' },
      { stream: traceStream, level: 'trace' }
    ])
  )

  // 定时器存储
  const timers = new Map()

  // 清理任务
  let cleanupJob = null

  /**
   * 创建渐变文本
   * @param {string} text - 文本内容
   * @param {Array<string>} colors - 颜色数组
   * @returns {string} 渐变色文本
   */
  function createGradientText(text, colors = selectedScheme) {
    if (!text || text.length === 0) return text
    let result = ''
    const step = Math.max(1, Math.ceil(text.length / colors.length))

    for (let i = 0; i < text.length; i++) {
      const colorIndex = Math.floor(i / step) % colors.length
      result += chalk.hex(colors[colorIndex])(text[i])
    }
    return result
  }

  /**
   * 格式化时间戳
   * @returns {string} 格式化的时间戳
   */
  function formatTimestamp() {
    const now = new Date()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    const hours = String(now.getHours()).padStart(2, '0')
    const minutes = String(now.getMinutes()).padStart(2, '0')
    const seconds = String(now.getSeconds()).padStart(2, '0')
    const timestamp = `[${month}-${day} ${hours}:${minutes}:${seconds}]`

    return createGradientText(timestamp, selectedTimestampColors)
  }

  /**
   * 获取日志头部
   * @returns {string} 日志头部文本
   */
  function getLogHeader() {
    const headerText = `[${cfg.bot.log_align || 'XRKYZ'}]`;
    return createGradientText(headerText)
  }

  /**
   * 创建日志前缀
   * @param {string} level - 日志级别
   * @param {string} [tag] - 可选模块/标签，输出为 [Tag]
   * @returns {string} 完整的日志前缀
   */
  function createLogPrefix(level, tag) {
    const style = LOG_STYLES[level] || LOG_STYLES.info
    const header = getLogHeader()
    const timestamp = formatTimestamp()
    const symbol = chalk[style.color](style.symbol)
    const tagPart = (tag && String(tag).trim()) ? chalk.cyan(`[${String(tag).trim()}] `) : ''
    return `${header} ${timestamp} ${symbol}  ${tagPart}`
  }

  /**
   * 移除 ANSI 颜色代码
   * @param {string} str - 原始字符串
   * @returns {string} 清理后的字符串
   */
  function stripColors(str) {
    if (typeof str !== 'string') return str
    return str
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\u001b\[[^m]*m/g, '')
      .replace(/\[38;5;\d+m/g, '')
      .replace(/\[39m/g, '')
      .replace(/\[\d+m/g, '')
  }

  /**
   * 确保 UTF-8 编码
   * @param {string} str - 原始字符串
   * @returns {string} UTF-8 编码的字符串
   */
  function ensureUTF8(str) {
    if (typeof str !== 'string') return str
    try {
      return Buffer.from(str, 'utf8').toString('utf8')
    } catch {
      return str
    }
  }

  /**
   * 格式化持续时间
   * @param {number} duration - 持续时间（毫秒）
   * @returns {string} 格式化的时间字符串
   */
  function formatDuration(duration) {
    if (duration < 1000) return `${duration}ms`
    if (duration < 60000) return `${(duration / 1000).toFixed(3)}s`
    const minutes = Math.floor(duration / 60000)
    const seconds = ((duration % 60000) / 1000).toFixed(3)
    return `${minutes}m ${seconds}s`
  }

  /**
   * 创建标准日志方法
   * @param {string} level - 日志级别
   * @returns {Function} 日志方法
   */
  function createLogMethod(level) {
    return function (...args) {
      const errArg = args.find(a => a instanceof Error)
      const prefix = createLogPrefix(level)
      const message = args
        .map((arg) => {
          if (arg instanceof Error) return arg.message + (arg.stack ? '\n' + arg.stack : '')
          if (typeof arg === 'object' && arg !== null) {
            return util.inspect(arg, { colors: false, depth: null, maxArrayLength: null })
          }
          return ensureUTF8(String(arg))
        })
        .join(' ')

      const consoleMessage = prefix + message
      const configLevel = logLevel
      const levelValue = LOG_STYLES[level]?.level || 30
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30
      if (levelValue >= configLevelValue) console.log(consoleMessage)

      const fileMessage = stripColors(message)
      const pinoLevel = ['mark', 'success', 'tip', 'done'].includes(level) ? 'info' : level
      if (errArg) pinoLogger[pinoLevel]({ err: errArg }, fileMessage)
      else pinoLogger[pinoLevel](fileMessage)
    }
  }

  /**
   * 带模块标签的日志（供 BotUtil.makeLog 及按模块分级用）
   * @param {string} level - trace|debug|info|warn|error|fatal|mark|success|tip
   * @param {string} tag - 模块名，如 DeviceAPI、PluginsLoader、PuppeteerRenderer
   * @param {...*} args - 消息内容，同普通 logger.info(msg)
   */
  function logTag(level, tag, ...args) {
    const safeLevel = LOG_LEVELS.includes(level) ? level : 'info'
    const style = LOG_STYLES[safeLevel] || LOG_STYLES.info
    const prefix = createLogPrefix(safeLevel, tag)
    const message = args
      .map((arg) => {
        if (typeof arg === 'object' && arg !== null && !(arg instanceof Error)) {
          return util.inspect(arg, { colors: false, depth: null, maxArrayLength: null })
        }
        return ensureUTF8(String(arg))
      })
      .join(' ')
    const configLevel = logLevel
    const levelValue = style.level
    const configLevelValue = LOG_STYLES[configLevel]?.level ?? 30
    if (levelValue >= configLevelValue) {
      console.log(prefix + message)
    }
    const fileMessage = stripColors(message)
    const pinoLevel = ['mark', 'success', 'tip', 'done'].includes(safeLevel) ? 'info' : safeLevel
    const tagStr = (tag && String(tag).trim()) ? String(tag).trim() : ''
    if (args[0] instanceof Error) {
      pinoLogger.child({ module: tagStr })[pinoLevel]({ err: args[0] }, fileMessage)
    } else {
      pinoLogger.child({ module: tagStr })[pinoLevel](fileMessage)
    }
  }

  /**
   * 全局 Logger 对象
   */
  const logger = {
    // 基础日志方法
    trace: createLogMethod('trace'),
    debug: createLogMethod('debug'),
    info: createLogMethod('info'),
    warn: createLogMethod('warn'),
    error: createLogMethod('error'),
    fatal: createLogMethod('fatal'),
    mark: createLogMethod('mark'),

    /** 分级 + 模块标签：logger.logTag(level, tag, ...args)；级别见 LOG_STYLES */
    logTag,

    /** 日志级别与数值，供外部按配置过滤 */
    LOG_LEVELS: Object.freeze([...LOG_LEVELS]),
    LOG_STYLES: Object.freeze({ ...LOG_STYLES }),

    // Chalk 颜色工具
    chalk,
    red: (text) => chalk.red(text),
    green: (text) => chalk.green(text),
    yellow: (text) => chalk.yellow(text),
    blue: (text) => chalk.blue(text),
    magenta: (text) => chalk.magenta(text),
    cyan: (text) => chalk.cyan(text),
    gray: (text) => chalk.gray(text),
    white: (text) => chalk.white(text),

    // 渐变色工具
    xrkyzGradient: (text) => createGradientText(text, selectedScheme),
    rainbow: (text) => {
      const rainbowColors = ['#FF0000', '#FF7F00', '#FFFF00', '#00FF00', '#0000FF', '#4B0082', '#9400D3']
      return createGradientText(text, rainbowColors)
    },
    gradient: createGradientText,

    /**
     * 成功日志
     */
    success: function (...args) {
      const prefix = createLogPrefix('success')
      const message = args
        .map((arg) => (typeof arg === 'string' ? ensureUTF8(arg) : util.inspect(arg, { colors: false })))
        .join(' ')

      const consoleMessage = prefix + chalk.green(message)
      const configLevel = logLevel
      const levelValue = LOG_STYLES.success.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (levelValue >= configLevelValue) {
        console.log(consoleMessage)
      }

      pinoLogger.info(stripColors(message))
    },

    /**
     * 警告日志（别名）
     */
    warning: function (...args) {
      this.warn(...args)
    },

    /**
     * 提示日志
     */
    tip: function (...args) {
      const prefix = createLogPrefix('tip')
      const message = args
        .map((arg) => (typeof arg === 'string' ? ensureUTF8(arg) : util.inspect(arg, { colors: false })))
        .join(' ')

      const consoleMessage = prefix + chalk.yellow(message)
      const configLevel = logLevel
      const levelValue = LOG_STYLES.tip.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (levelValue >= configLevelValue) {
        console.log(consoleMessage)
      }

      pinoLogger.info(stripColors(message))
    },

    /**
     * 计时器开始
     * @param {string} label - 计时器标签
     */
    time: function (label = 'default') {
      timers.set(label, Date.now())
      this.trace(`Timer started: ${label}`)
    },

    /**
     * 计时器结束
     * @param {string} label - 计时器标签
     */
    timeEnd: function (label = 'default') {
      if (timers.has(label)) {
        const duration = Date.now() - timers.get(label)
        const timeStr = formatDuration(duration)
        const prefix = createLogPrefix('info')
        const message = `Timer ended ${chalk.cyan(label)}: ${chalk.yellow(timeStr)}`

        const configLevel = logLevel
        const levelValue = LOG_STYLES.info.level
        const configLevelValue = LOG_STYLES[configLevel]?.level || 30

        if (levelValue >= configLevelValue) {
          console.log(prefix + message)
        }

        pinoLogger.info(`Timer ended [${label}]: ${timeStr}`)
        timers.delete(label)
      } else {
        this.warn(`Timer ${label} does not exist`)
      }
    },

    /**
     * 完成日志
     * @param {string} text - 完成消息
     * @param {string} label - 计时器标签
     */
    done: function (text, label) {
      const prefix = createLogPrefix('done')
      let message = ensureUTF8(text || 'Operation completed')

      if (label && timers.has(label)) {
        const duration = Date.now() - timers.get(label)
        const timeStr = formatDuration(duration)
        message += ` (Duration: ${chalk.yellow(timeStr)})`
        timers.delete(label)
        pinoLogger.trace(`Operation completed [${label}]: ${text} - Duration ${timeStr}`)
      }

      const consoleMessage = prefix + chalk.green(message)
      const configLevel = logLevel
      const levelValue = LOG_STYLES.done.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (levelValue >= configLevelValue) {
        console.log(consoleMessage)
      }

      pinoLogger.info(stripColors(message))
    },

    /**
     * 标题日志
     * @param {string} text - 标题文本
     * @param {string} color - 颜色
     */
    title: function (text, color = 'yellow') {
      const prefix = createLogPrefix('info')
      const processedText = ensureUTF8(text)
      const line = '═'.repeat(processedText.length + 10)

      const configLevel = logLevel
      const levelValue = LOG_STYLES.info.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (levelValue >= configLevelValue) {
        console.log(prefix + chalk[color](line))
        console.log(prefix + chalk[color](`╔ ${processedText} ╗`))
        console.log(prefix + chalk[color](line))
      }

      pinoLogger.info(`=== ${processedText} ===`)
    },

    /**
     * 子标题日志
     * @param {string} text - 子标题文本
     * @param {string} color - 颜色
     */
    subtitle: function (text, color = 'cyan') {
      const prefix = createLogPrefix('info')
      const processedText = ensureUTF8(text)

      const configLevel = logLevel
      const levelValue = LOG_STYLES.info.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (levelValue >= configLevelValue) {
        console.log(prefix + chalk[color](`┌─── ${processedText} ───┐`))
      }

      pinoLogger.info(`--- ${processedText} ---`)
    },

    /**
     * 分隔线
     * @param {string} char - 分隔符字符
     * @param {number} length - 长度
     * @param {string} color - 颜色
     */
    line: function (char = '─', length = 35, color = 'gray') {
      const prefix = createLogPrefix('info')

      const configLevel = logLevel
      const levelValue = LOG_STYLES.info.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (levelValue >= configLevelValue) {
        console.log(prefix + chalk[color](char.repeat(length)))
      }

      pinoLogger.info(char.repeat(length))
    },

    /**
     * 方框日志
     * @param {string} text - 方框文本
     * @param {string} color - 颜色
     */
    box: function (text, color = 'blue') {
      const prefix = createLogPrefix('info')
      const processedText = ensureUTF8(text)
      const padding = 2
      const paddedText = ' '.repeat(padding) + processedText + ' '.repeat(padding)
      const line = '─'.repeat(paddedText.length)

      const configLevel = logLevel
      const levelValue = LOG_STYLES.info.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (levelValue >= configLevelValue) {
        console.log(prefix + chalk[color](`┌${line}┐`))
        console.log(prefix + chalk[color](`│${paddedText}│`))
        console.log(prefix + chalk[color](`└${line}┘`))
      }

      pinoLogger.info(`Box: ${processedText}`)
    },

    /**
     * JSON 日志
     * @param {Object} obj - JSON 对象
     * @param {string} title - 标题
     */
    json: function (obj, title) {
      const prefix = createLogPrefix('info')

      const configLevel = logLevel
      const levelValue = LOG_STYLES.info.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (title) {
        const processedTitle = ensureUTF8(title)
        if (levelValue >= configLevelValue) {
          console.log(prefix + chalk.cyan(`==== ${processedTitle} ====`))
        }
      }

      try {
        const formatted = JSON.stringify(obj, null, 2)
        if (levelValue >= configLevelValue) {
          const lines = formatted.split('\n')
          lines.forEach((line) => {
            console.log(prefix + chalk.gray(line))
          })
        }
        pinoLogger.info({ data: obj }, title ? `JSON Data [${title}]` : 'JSON Data')
      } catch (err) {
        if (levelValue >= configLevelValue) {
          console.log(prefix + `Cannot serialize object: ${err.message}`)
          console.log(prefix + util.inspect(obj, { depth: null, colors: true }))
        }
        pinoLogger.error({ err }, 'JSON serialization failed')
      }
    },

    /**
     * 进度条
     * @param {number} current - 当前进度
     * @param {number} total - 总数
     * @param {number} length - 进度条长度
     */
    progress: function (current, total, length = 30) {
      const prefix = createLogPrefix('info')
      const percent = Math.min(Math.round((current / total) * 100), 100)
      const filledLength = Math.round((current / total) * length)
      const bar = '█'.repeat(filledLength) + '░'.repeat(length - filledLength)
      const message = `${chalk.cyan('[')}${chalk.green(bar)}${chalk.cyan(']')} ${chalk.yellow(percent + '%')} ${current}/${total}`

      const configLevel = logLevel
      const levelValue = LOG_STYLES.info.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (levelValue >= configLevelValue) {
        console.log(`${prefix}${message}`)
      }

      if (percent === 100 || percent % 25 === 0) {
        pinoLogger.trace(`Progress: ${percent}% (${current}/${total})`)
      }
    },

    /**
     * 重要日志
     * @param {string} text - 重要消息
     */
    important: function (text) {
      const prefix = createLogPrefix('warn')
      const processedText = ensureUTF8(text)

      const configLevel = logLevel
      const levelValue = LOG_STYLES.warn.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (levelValue >= configLevelValue) {
        console.log(prefix + chalk.bold.yellow(processedText))
      }

      pinoLogger.warn(`IMPORTANT: ${processedText}`)
    },

    /**
     * 高亮日志
     * @param {string} text - 高亮文本
     */
    highlight: function (text) {
      const prefix = createLogPrefix('info')
      const processedText = ensureUTF8(text)

      const configLevel = logLevel
      const levelValue = LOG_STYLES.info.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (levelValue >= configLevelValue) {
        console.log(prefix + chalk.bgYellow.black(processedText))
      }

      pinoLogger.info(`HIGHLIGHT: ${processedText}`)
    },

    /**
     * 失败日志
     * @param {string} text - 失败消息
     */
    fail: function (text) {
      const prefix = createLogPrefix('error')
      const processedText = ensureUTF8(text)

      const configLevel = logLevel
      const levelValue = LOG_STYLES.error.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (levelValue >= configLevelValue) {
        console.log(prefix + chalk.red(processedText))
      }

      pinoLogger.error(`FAIL: ${processedText}`)
    },

    /**
     * 系统日志
     * @param {string} text - 系统消息
     */
    system: function (text) {
      const prefix = createLogPrefix('info')
      const processedText = ensureUTF8(text)

      const configLevel = logLevel
      const levelValue = LOG_STYLES.info.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (levelValue >= configLevelValue) {
        console.log(prefix + chalk.gray(processedText))
      }

      pinoLogger.trace(`System: ${processedText}`)
    },

    /**
     * 列表日志
     * @param {Array} items - 列表项
     * @param {string} title - 标题
     */
    list: function (items, title) {
      const prefix = createLogPrefix('info')

      const configLevel = logLevel
      const levelValue = LOG_STYLES.info.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (title) {
        const processedTitle = ensureUTF8(title)
        if (levelValue >= configLevelValue) {
          console.log(prefix + chalk.cyan(`=== ${processedTitle} ===`))
        }
        pinoLogger.info(`List: ${processedTitle}`)
      }

      items.forEach((item, index) => {
        const processedItem = ensureUTF8(item)
        const bullet = chalk.gray(`  ${index + 1}.`)
        if (levelValue >= configLevelValue) {
          console.log(prefix + `${bullet} ${processedItem}`)
        }
        pinoLogger.info(`  ${index + 1}. ${processedItem}`)
      })
    },

    /**
     * 状态日志
     * @param {string} message - 消息
     * @param {string} status - 状态
     * @param {string} statusColor - 状态颜色
     */
    status: function (message, status, statusColor = 'green') {
      const prefix = createLogPrefix('info')
      const statusIcons = {
        success: '✓',
        error: '✗',
        warning: '⚠',
        info: 'ℹ',
        pending: '⏳',
        running: '⚙',
        complete: '✓',
        failed: '✗',
        blocked: '⛔',
        skipped: '↷'
      }
      const icon = statusIcons[status.toLowerCase()] || '•'
      const processedMessage = ensureUTF8(message)
      const statusMessage = chalk[statusColor](`${icon} [${status.toUpperCase()}] `) + processedMessage

      const configLevel = logLevel
      const levelValue = LOG_STYLES.info.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (levelValue >= configLevelValue) {
        console.log(prefix + statusMessage)
      }

      pinoLogger.trace(`Status Change: [${status.toUpperCase()}] ${processedMessage}`)
    },

    /**
     * 标签日志
     * @param {string} text - 文本
     * @param {string} tag - 标签
     * @param {string} tagColor - 标签颜色
     */
    tag: function (text, tag, tagColor = 'blue') {
      const prefix = createLogPrefix('info')
      const processedText = ensureUTF8(text)
      const processedTag = ensureUTF8(tag)
      const taggedMessage = chalk[tagColor](`[${processedTag}] `) + processedText

      const configLevel = logLevel
      const levelValue = LOG_STYLES.info.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (levelValue >= configLevelValue) {
        console.log(prefix + taggedMessage)
      }

      pinoLogger.info(`[${processedTag}] ${processedText}`)
    },

    /**
     * 表格日志
     * @param {Object} data - 表格数据
     * @param {string} title - 标题
     */
    table: function (data, title) {
      const prefix = createLogPrefix('info')

      const configLevel = logLevel
      const levelValue = LOG_STYLES.info.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (title) {
        const processedTitle = ensureUTF8(title)
        if (levelValue >= configLevelValue) {
          console.log(prefix + chalk.cyan(`=== ${processedTitle} ===`))
        }
      }

      if (typeof console.table === 'function' && data && typeof data === 'object') {
        if (levelValue >= configLevelValue) {
          console.table(data)
        }
        pinoLogger.trace({ data }, title ? `Table Data [${title}]` : 'Table Data')
      } else {
        this.json(data)
      }
    },

    /**
     * 渐变分隔线
     * @param {string} char - 分隔符字符
     * @param {number} length - 长度
     */
    gradientLine: function (char = '─', length = 50) {
      const prefix = createLogPrefix('info')
      const gradientLineText = this.gradient(char.repeat(length))

      const configLevel = logLevel
      const levelValue = LOG_STYLES.info.level
      const configLevelValue = LOG_STYLES[configLevel]?.level || 30

      if (levelValue >= configLevelValue) {
        console.log(prefix + gradientLineText)
      }

      pinoLogger.info(char.repeat(length))
    },

    /**
     * 获取平台信息
     * @returns {Object} 平台信息
     */
    platform: function () {
      return {
        os: process.platform,
        loggerType: 'pino',
        loggerVersion: '9.x',
        nodeVersion: process.version,
        logLevel: logLevel,
        logDir: LOGGER_CONFIG.LOG_DIR,
        cleanupSchedule: 'Daily at 3 AM',
        mainLogAge: `${cfg.bot.log_max_days || LOGGER_CONFIG.DEFAULT_MAX_DAYS} days`,
        traceLogAge: `${cfg.bot.log_trace_days || LOGGER_CONFIG.DEFAULT_TRACE_DAYS} day(s)`,
        logFiles: {
          main: `${LOGGER_CONFIG.MAIN_LOG_PREFIX}.yyyy-MM-dd.log`,
          trace: `${LOGGER_CONFIG.TRACE_LOG_PREFIX}.yyyy-MM-dd.log`
        },
        performance: 'High (Pino)',
        encoding: 'UTF-8'
      }
    },

    /**
     * 手动清理日志
     * @param {number} days - 保留天数
     * @param {boolean} includeTrace - 是否包含 trace 日志
     * @returns {Promise<number>} 删除的文件数
     */
    cleanLogs: async function (days, includeTrace = true) {
      const mainDays = days || cfg.bot.log_max_days || LOGGER_CONFIG.DEFAULT_MAX_DAYS
      const traceDays = cfg.bot.log_trace_days || LOGGER_CONFIG.DEFAULT_TRACE_DAYS
      const n = await runLogCleanup(this, mainDays, traceDays, includeTrace)
      if (n > 0) this.info(`Manual cleanup completed, deleted ${n} expired log files`)
      return n
    },

    /**
     * 获取 trace 日志内容
     * @param {number} lines - 行数
     * @returns {Promise<Array|null>} 日志行数组
     */
    getTraceLogs: async function (lines = 100) {
      try {
        const currentDate = new Date().toISOString().split('T')[0]
        const traceFile = path.join(LOGGER_CONFIG.LOG_DIR, `${LOGGER_CONFIG.TRACE_LOG_PREFIX}.${currentDate}.log`)

        if (!FileUtils.existsSync(traceFile)) {
          return null
        }

        const content = await FileUtils.readFile(traceFile, 'utf8')
        const logLines = content.split('\n').filter((line) => line.trim())

        return logLines.slice(-lines)
      } catch (err) {
        this.error('Failed to read trace logs:', err.message)
        return null
      }
    },

    /**
     * 关闭日志系统
     * @returns {Promise<void>}
     */
    shutdown: async function () {
      try {
        if (cleanupJob) {
          cleanupJob.cancel()
          cleanupJob = null
        }

        // 关闭 Pino streams
        await new Promise((resolve) => {
          fileStream.end(() => {
            traceStream.end(() => {
              resolve()
            })
          })
        })

        this.info('Logger shutdown completed')
      } catch (err) {
        console.error('Error during logger shutdown:', err)
      }
    }
  }

  // 初始化清理任务
  cleanupJob = schedule.scheduleJob(LOGGER_CONFIG.CLEANUP_TIME, async () => {
    logger.info('Starting scheduled log cleanup...')
    await cleanExpiredLogs(logger)
  })

  // 启动时清理一次
  setTimeout(() => {
    cleanExpiredLogs(logger).catch((err) => {
      logger.error('Failed to clean logs on startup:', err.message)
    })
  }, 5000)

  // 处理进程退出（exit 时做流关闭等清理；SIGINT/SIGTERM 由 lib/config/loader.js 统一处理，避免多余监听导致 Ctrl+C 不重启）
  process.on('exit', () => {
    if (cleanupJob) {
      cleanupJob.cancel()
    }
    fileStream.end()
    traceStream.end()
  })

  // 设置全局 logger
  global.logger = logger

  return logger
}

/**
 * 修复 Windows UTF-8 编码问题
 */
function fixWindowsUTF8() {
  if (process.platform === 'win32') {
    try {
      process.stdout.setEncoding('utf8')
      process.stderr.setEncoding('utf8')
      try {
        execSync('chcp 65001', { stdio: 'ignore' })
      } catch {
        // chcp 不可用时可忽略
      }
    } catch {
      // 控制台编码设置失败时可忽略
    }
  }
}

/**
 * 创建日志轮转流
 * @param {string} prefix - 文件前缀
 * @param {number} maxDays - 最大保留天数
 * @returns {WritableStream} 轮转流
 */
function createRotatingStream(prefix, maxDays) {
  const isTrace = prefix === LOGGER_CONFIG.TRACE_LOG_PREFIX
  const options = {
    interval: LOGGER_CONFIG.ROTATION_INTERVAL,
    path: LOGGER_CONFIG.LOG_DIR,
    maxFiles: maxDays || (isTrace ? LOGGER_CONFIG.DEFAULT_TRACE_DAYS : LOGGER_CONFIG.DEFAULT_MAX_DAYS),
    compress: false
  }
  
  // trace 日志添加大小限制（格式：字符串，如 "100M"）
  if (isTrace && LOGGER_CONFIG.TRACE_MAX_SIZE) {
    const sizeMB = Math.floor(LOGGER_CONFIG.TRACE_MAX_SIZE / (1024 * 1024))
    options.size = `${sizeMB}M` // 使用 size 选项触发按大小轮转
  }
  
  return createStream(
    (time, index) => {
      if (!time) return `${prefix}.log`
      const date = time.toISOString().split('T')[0]
      return `${prefix}.${date}.log`
    },
    options
  )
}

/**
 * 按 mtime 删除过期日志文件（主日志与 trace 共用逻辑）
 * @param {Object} logger - Logger 实例
 * @param {number} mainDays - 主日志保留天数
 * @param {number} traceDays - trace 保留天数
 * @param {boolean} includeTrace - 是否清理 trace
 * @returns {Promise<number>} 删除数量
 */
async function runLogCleanup(logger, mainDays, traceDays, includeTrace = true) {
  let deletedCount = 0
  let cleanedTxtFiles = 0
  try {
    const files = await FileUtils.readDir(LOGGER_CONFIG.LOG_DIR)
    const now = Date.now()
    const mainMaxMs = mainDays * 24 * 60 * 60 * 1000
    const traceMaxMs = traceDays * 24 * 60 * 60 * 1000
    const mainPrefix = `${LOGGER_CONFIG.MAIN_LOG_PREFIX}.`
    const tracePrefix = `${LOGGER_CONFIG.TRACE_LOG_PREFIX}.`

    // 分批处理，避免一次性处理过多文件
    const batchSize = LOGGER_CONFIG.CLEANUP_BATCH_SIZE
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize)
      
      for (const file of batch) {
        const filePath = path.join(LOGGER_CONFIG.LOG_DIR, file)
        
        // 删除冗余的 .txt 文件（如 trace.log.txt、app.log.txt 等）
        if (file.endsWith('.txt') && (file.includes('trace') || file.includes('app') || file.includes('log'))) {
          try {
            await FileUtils.unlink(filePath)
            cleanedTxtFiles++
            logger.debug(`Deleted redundant log file: ${file}`)
          } catch (err) {
            logger.debug(`Failed to delete redundant file ${file}: ${err.message}`)
          }
          continue
        }
        
        // 只处理 .log 文件
        if (!file.endsWith('.log')) continue
        
        let maxAgeMs
        if (file.startsWith(tracePrefix)) {
          if (!includeTrace) continue
          maxAgeMs = traceMaxMs
        } else if (file.startsWith(mainPrefix)) {
          maxAgeMs = mainMaxMs
        } else continue
        
        try {
          const stat = await FileUtils.stat(filePath)
          if (stat && now - stat.mtimeMs > maxAgeMs) {
            await FileUtils.unlink(filePath)
            deletedCount++
          }
        } catch (err) {
          logger.error(`Failed to delete log file: ${file}`, err.message)
        }
      }
    }
    
    const totalCleaned = deletedCount + cleanedTxtFiles
    if (totalCleaned > 0) {
      logger.info(`Log cleanup completed: deleted ${deletedCount} expired .log files${cleanedTxtFiles > 0 ? `, ${cleanedTxtFiles} redundant .txt files` : ''}`)
    }
  } catch (err) {
    logger.error('Error cleaning expired logs:', err.message)
  }
  return deletedCount + cleanedTxtFiles
}

async function cleanExpiredLogs(logger) {
  const mainDays = cfg.bot.log_max_days || LOGGER_CONFIG.DEFAULT_MAX_DAYS
  const traceDays = cfg.bot.log_trace_days || LOGGER_CONFIG.DEFAULT_TRACE_DAYS
  return runLogCleanup(logger, mainDays, traceDays, true)
}