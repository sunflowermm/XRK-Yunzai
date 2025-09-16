import log4js from 'log4js';
import chalk from 'chalk';
import cfg from './config.js';
import path from 'node:path';
import util from 'node:util';
import fs from 'node:fs';

/**
 * 配置日志系统，使用 log4js 和 chalk 实现彩色日志输出。
 * 整合 cfg.bot 中的日志相关配置，包括 log_level, log_align, log_color 等。
 * @returns {Object} 全局 logger 对象
 */
export default function setLog() {
  const logDir = './logs';

  // 确保 logs 目录存在，如果不存在则创建
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // 颜色方案定义
  const colorSchemes = {
    default: ['#3494E6', '#3498db', '#00b4d8', '#0077b6', '#023e8a'],
    scheme1: ['#FF0000', '#FF7F00', '#FFFF00', '#00FF00', '#0000FF'],
    scheme2: ['#FF69B4', '#FF1493', '#C71585', '#DB7093', '#FFC0CB'],
    scheme3: ['#00CED1', '#20B2AA', '#48D1CC', '#008B8B', '#5F9EA0'],
    scheme4: ['#8A2BE2', '#9370DB', '#7B68EE', '#6A5ACD', '#483D8B'],
    scheme5: ['#36D1DC', '#5B86E5', '#4776E6', '#8E54E9', '#6A82FB'],
    scheme6: ['#FF512F', '#F09819', '#FF8008', '#FD746C', '#FE9A8B'],
    scheme7: ['#11998e', '#38ef7d', '#56ab2f', '#a8e063', '#76b852'],
  };

  // 时间戳颜色方案定义
  const timestampSchemes = {
    default: ['#64B5F6', '#90CAF9', '#BBDEFB', '#E3F2FD', '#B3E5FC'],
    scheme1: ['#FFCCBC', '#FFAB91', '#FF8A65', '#FF7043', '#FF5722'],
    scheme2: ['#F8BBD0', '#F48FB1', '#F06292', '#EC407A', '#E91E63'],
    scheme3: ['#B2DFDB', '#80CBC4', '#4DB6AC', '#26A69A', '#009688'],
    scheme4: ['#D1C4E9', '#B39DDB', '#9575CD', '#7E57C2', '#673AB7'],
    scheme5: ['#90CAF9', '#64B5F6', '#42A5F5', '#2196F3', '#1E88E5'],
    scheme6: ['#FFAB91', '#FF8A65', '#FF7043', '#FF5722', '#F4511E'],
    scheme7: ['#A5D6A7', '#81C784', '#66BB6A', '#4CAF50', '#43A047'],
  };

  // 从 cfg.bot 获取配置，使用默认值作为 fallback
  const logLevel = cfg?.bot?.log_level || 'info';
  const logColor = cfg?.bot?.log_color || 'default';
  const logAlign = cfg?.bot?.log_align || 'XRKYZ';

  // 选择颜色方案
  const selectedScheme = colorSchemes[logColor] || colorSchemes['default'];
  const selectedTimestampColors = timestampSchemes[logColor] || timestampSchemes['default'];

  /**
   * 创建渐变色文本。
   * @param {string} text - 要应用的文本
   * @param {Array<string>} colors - 颜色数组
   * @returns {string} 渐变色文本
   */
  function createGradientText(text, colors = selectedScheme) {
    if (!text || text.length === 0) return text;
    let result = '';
    for (let i = 0; i < text.length; i++) {
      const colorIndex = i % colors.length;
      result += chalk.hex(colors[colorIndex])(text[i]);
    }
    return result;
  }

  /**
   * 格式化时间戳。
   * @returns {string} 渐变色时间戳
   */
  function formatTimestamp() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const timestamp = `[${month}-${day} ${hours}:${minutes}:${seconds}]`;
    return createGradientText(timestamp, selectedTimestampColors);
  }

  /**
   * 获取日志头。
   * @returns {string} 渐变色日志头
   */
  const getLogHeader = () => {
    const headerText = logAlign ? `[${logAlign}]` : '[XRKYZ]';
    return createGradientText(headerText);
  };

  // 日志样式定义
  const logStyles = {
    trace: { symbol: '•', color: 'grey' },
    debug: { symbol: '⚙', color: 'cyan' },
    info: { symbol: 'ℹ', color: 'blue' },
    warn: { symbol: '⚠', color: 'yellow' },
    error: { symbol: '✗', color: 'red' },
    fatal: { symbol: '☠', color: 'redBright' },
    mark: { symbol: '✧', color: 'magenta' },
    success: { symbol: '✓', color: 'green' },
    tip: { symbol: '💡', color: 'yellow' },
    done: { symbol: '✓', color: 'greenBright' },
  };

  /**
   * 创建日志前缀。
   * @param {string} level - 日志级别
   * @returns {string} 日志前缀
   */
  function createLogPrefix(level) {
    const style = logStyles[level] || logStyles.info;
    const header = getLogHeader();
    const timestamp = formatTimestamp();
    const symbol = chalk[style.color](style.symbol);
    return `${header} ${timestamp} ${symbol} `;
  }

  // 配置 log4js
  log4js.configure({
    appenders: {
      // 控制台输出（只输出消息内容）
      console: {
        type: 'console',
        layout: {
          type: 'pattern',
          pattern: '%m',
        },
      },
      // 所有日志文件
      app: {
        type: 'file',
        filename: path.join(logDir, 'app.log'),
        maxLogSize: 10485760, // 10MB
        backups: 5,
        compress: true,
        layout: {
          type: 'pattern',
          pattern: '[%d{yyyy-MM-dd hh:mm:ss}][%p] %m',
        },
      },
      // 命令日志（按日期分割）
      command: {
        type: 'dateFile',
        filename: path.join(logDir, 'command'),
        pattern: '.yyyy-MM-dd.log',
        numBackups: 15,
        alwaysIncludePattern: true,
        compress: true,
        layout: {
          type: 'pattern',
          pattern: '[%d{yyyy-MM-dd hh:mm:ss}][%p] %m',
        },
      },
      // 错误日志
      error: {
        type: 'file',
        filename: path.join(logDir, 'error.log'),
        maxLogSize: 10485760, // 10MB
        backups: 3,
        compress: true,
        layout: {
          type: 'pattern',
          pattern: '[%d{yyyy-MM-dd hh:mm:ss}][%p] %m',
        },
      },
      // 调试日志
      debug: {
        type: 'file',
        filename: path.join(logDir, 'debug.log'),
        maxLogSize: 10485760, // 10MB
        backups: 2,
        layout: {
          type: 'pattern',
          pattern: '[%d{yyyy-MM-dd hh:mm:ss}][%p] %m',
        },
      },
    },
    categories: {
      default: { 
        appenders: ['console', 'app'], 
        level: logLevel 
      },
      command: { 
        appenders: ['console', 'command', 'app'], 
        level: 'info'
      },
      error: { 
        appenders: ['console', 'error', 'app'], 
        level: 'error' 
      },
      debug: { 
        appenders: ['console', 'debug', 'app'], 
        level: 'debug' 
      },
    },
  });

  // 创建不同的 logger 实例
  const defaultLogger = log4js.getLogger('default');
  const commandLogger = log4js.getLogger('command');
  const errorLogger = log4js.getLogger('error');
  const debugLogger = log4js.getLogger('debug');

  /**
   * 创建日志方法。
   * @param {Object} loggerInstance - logger 实例
   * @param {string} level - 日志级别
   * @returns {Function} 日志函数
   */
  const createLogMethod = (loggerInstance, level) => {
    return (...args) => {
      const prefix = createLogPrefix(level);
      const message = args.map(arg => {
        if (typeof arg === 'object') {
          return util.inspect(arg, { colors: false, depth: null });
        }
        return String(arg);
      }).join(' ');
      
      // 映射特殊级别到 log4js 支持的级别
      let log4jsLevel = level;
      if (level === 'fatal') log4jsLevel = 'error';
      if (level === 'success' || level === 'tip' || level === 'done' || level === 'mark') log4jsLevel = 'info';
      
      if (typeof loggerInstance[log4jsLevel] === 'function') {
        loggerInstance[log4jsLevel](prefix + message);
      } else {
        loggerInstance.info(prefix + message);
      }
    };
  };

  // 计时器对象
  const timers = {};

  // 全局 logger 对象
  global.logger = {
    trace: createLogMethod(debugLogger, 'trace'),
    debug: createLogMethod(debugLogger, 'debug'),
    info: createLogMethod(defaultLogger, 'info'),
    warn: createLogMethod(commandLogger, 'warn'),
    error: createLogMethod(errorLogger, 'error'),
    fatal: createLogMethod(errorLogger, 'fatal'),
    mark: createLogMethod(commandLogger, 'mark'),

    // Chalk 颜色方法
    chalk,
    red: (text) => chalk.red(text),
    green: (text) => chalk.green(text),
    yellow: (text) => chalk.yellow(text),
    blue: (text) => chalk.blue(text),
    magenta: (text) => chalk.magenta(text),
    cyan: (text) => chalk.cyan(text),
    gray: (text) => chalk.gray(text),
    white: (text) => chalk.white(text),

    // 渐变色方法
    xrkyzGradient: (text) => createGradientText(text, selectedScheme),
    rainbow: (text) => {
      const rainbowColors = ['#FF0000', '#FF7F00', '#FFFF00', '#00FF00', '#0000FF', '#4B0082', '#9400D3'];
      return createGradientText(text, rainbowColors);
    },
    gradient: createGradientText,

    // 特殊日志方法
    success: createLogMethod(commandLogger, 'success'),
    warning: createLogMethod(commandLogger, 'warn'),
    tip: createLogMethod(defaultLogger, 'tip'),

    // 计时功能
    time: function (label = 'default') {
      timers[label] = Date.now();
      this.debug(`计时开始: ${label}`);
    },

    timeEnd: function (label = 'default') {
      if (timers[label]) {
        const duration = Date.now() - timers[label];
        let timeStr = formatDuration(duration);
        const prefix = createLogPrefix('info');
        const message = `计时结束 ${chalk.cyan(label)}: ${chalk.yellow(timeStr)}`;
        defaultLogger.info(prefix + message);
        delete timers[label];
      } else {
        this.warn(`计时器 ${label} 不存在`);
      }
    },

    done: function (text, label) {
      const prefix = createLogPrefix('done');
      let message = text || '操作完成';
      if (label && timers[label]) {
        const duration = Date.now() - timers[label];
        let timeStr = formatDuration(duration);
        message += ` (耗时: ${timeStr})`;
        delete timers[label];
      }
      defaultLogger.info(prefix + message);
    },

    // 格式化输出
    title: function (text, color = 'yellow') {
      const prefix = createLogPrefix('info');
      const line = '═'.repeat(text.length + 10);
      defaultLogger.info(prefix + chalk[color](line));
      defaultLogger.info(prefix + chalk[color](`╔ ${text} ╗`));
      defaultLogger.info(prefix + chalk[color](line));
    },

    subtitle: function (text, color = 'cyan') {
      const prefix = createLogPrefix('info');
      const message = chalk[color](`┌─── ${text} ───┐`);
      defaultLogger.info(prefix + message);
    },

    line: function (char = '─', length = 35, color = 'gray') {
      const prefix = createLogPrefix('info');
      const message = chalk[color](char.repeat(length));
      defaultLogger.info(prefix + message);
    },

    box: function (text, color = 'blue') {
      const prefix = createLogPrefix('info');
      const padding = 2;
      const paddedText = ' '.repeat(padding) + text + ' '.repeat(padding);
      const line = '─'.repeat(paddedText.length + 4);
      defaultLogger.info(prefix + chalk[color](`┌${line}┐`));
      defaultLogger.info(prefix + chalk[color](`│${paddedText}│`));
      defaultLogger.info(prefix + chalk[color](`└${line}┘`));
    },

    json: function (obj, title) {
      const prefix = createLogPrefix('info');
      if (title) {
        const titleMessage = chalk.cyan(`==== ${title} ====`);
        defaultLogger.info(prefix + titleMessage);
      }
      
      try {
        const formatted = JSON.stringify(obj, null, 2);
        const lines = formatted.split('\n');
        lines.forEach(line => defaultLogger.info(prefix + line));
      } catch (err) {
        const errorMessage = `无法序列化对象: ${err.message}`;
        errorLogger.error(prefix + errorMessage);
        defaultLogger.info(prefix + util.inspect(obj, { colors: false, depth: null }));
      }
    },

    // 进度条
    progress: function (current, total, length = 30) {
      const prefix = createLogPrefix('info');
      const percent = Math.min(Math.round((current / total) * 100), 100);
      const filledLength = Math.round((current / total) * length);
      const bar = '█'.repeat(filledLength) + '░'.repeat(length - filledLength);
      const message = `${chalk.cyan('[')}${chalk.green(bar)}${chalk.cyan(']')} ${chalk.yellow(percent + '%')} ${current}/${total}`;
      defaultLogger.info(`${prefix}${message}`);
    },

    important: function (text) {
      const prefix = createLogPrefix('warn');
      commandLogger.warn(prefix + chalk.bold.yellow(text));
    },

    highlight: function (text) {
      const prefix = createLogPrefix('info');
      const highlightedMessage = chalk.bgYellow.black(` ${text} `);
      defaultLogger.info(prefix + highlightedMessage);
    },

    fail: function (text) {
      const prefix = createLogPrefix('error');
      errorLogger.error(prefix + chalk.red(text));
    },

    system: function (text) {
      const prefix = createLogPrefix('info');
      const systemMessage = chalk.gray(`[SYSTEM] ${text}`);
      defaultLogger.info(prefix + systemMessage);
    },

    list: function (items, title) {
      const prefix = createLogPrefix('info');
      if (title) {
        const titleMessage = chalk.cyan(`=== ${title} ===`);
        defaultLogger.info(prefix + titleMessage);
      }
      items.forEach((item, index) => {
        const bulletPoint = chalk.gray(`  ${index + 1}. `);
        defaultLogger.info(prefix + bulletPoint + item);
      });
    },

    status: function (message, status, statusColor = 'green') {
      const prefix = createLogPrefix('info');
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
        skipped: '↷',
      };
      const icon = statusIcons[status.toLowerCase()] || '•';
      const statusMessage = chalk[statusColor](`${icon} [${status.toUpperCase()}] `) + message;
      defaultLogger.info(prefix + statusMessage);
    },

    tag: function (text, tag, tagColor = 'blue') {
      const prefix = createLogPrefix('info');
      const taggedMessage = chalk[tagColor](`[${tag}] `) + text;
      defaultLogger.info(prefix + taggedMessage);
    },

    table: function (data, title) {
      const prefix = createLogPrefix('info');
      if (title) {
        const titleMessage = chalk.cyan(`=== ${title} ===`);
        defaultLogger.info(prefix + titleMessage);
      }
      
      if (typeof console.table === 'function' && data && typeof data === 'object') {
        console.table(data);
      } else {
        this.json(data);
      }
    },

    gradientLine: function (char = '─', length = 50) {
      const prefix = createLogPrefix('info');
      const gradientLineText = this.gradient(char.repeat(length));
      defaultLogger.info(prefix + gradientLineText);
    },

    // 平台信息
    platform: function() {
      return {
        os: process.platform,
        node: process.version,
        loggerType: 'log4js',
        logDir: path.resolve(logDir),
        logLevel: logLevel
      };
    },

    // 测试日志功能
    test: function() {
      this.title('日志测试开始', 'cyan');
      
      this.info('测试 INFO 消息');
      this.warn('测试 WARN 消息');
      this.error('测试 ERROR 消息');
      this.success('测试 SUCCESS 消息');
      this.debug('测试 DEBUG 消息');
      this.tip('测试 TIP 消息');
      this.fail('测试 FAIL 消息');
      this.important('测试 IMPORTANT 消息');
      
      this.subtitle('渐变色测试');
      this.info(this.xrkyzGradient('XRKYZ渐变色文字'));
      this.info(this.rainbow('彩虹渐变色文字'));
      this.gradientLine();
      
      this.subtitle('格式化输出测试');
      this.box('盒子格式', 'magenta');
      this.list(['项目1', '项目2', '项目3'], '列表测试');
      this.status('任务执行中', 'running', 'yellow');
      this.status('任务完成', 'success', 'green');
      this.tag('带标签的消息', 'TEST', 'cyan');
      
      this.json({ name: 'test', value: 123, nested: { a: 1, b: 2 } }, 'JSON输出测试');
      
      this.progress(50, 100);
      
      this.time('test-timer');
      setTimeout(() => {
        this.timeEnd('test-timer');
        this.done('所有测试完成', 'test-timer');
      }, 1000);
    },

    // 清理旧日志
    cleanOldLogs: function(daysToKeep = 30) {
      const now = Date.now();
      const cutoffTime = now - (daysToKeep * 24 * 60 * 60 * 1000);
      
      try {
        const files = fs.readdirSync(logDir);
        let deletedCount = 0;
        
        files.forEach(file => {
          const filePath = path.join(logDir, file);
          const stats = fs.statSync(filePath);
          
          if (stats.isFile() && stats.mtime.getTime() < cutoffTime) {
            fs.unlinkSync(filePath);
            deletedCount++;
            this.debug(`删除旧日志文件: ${file}`);
          }
        });
        
        if (deletedCount > 0) {
          this.info(`清理了 ${deletedCount} 个旧日志文件`);
        }
      } catch (error) {
        this.error('清理旧日志失败:', error);
      }
    }
  };
  
  // 添加别名
  global.logger.warning = global.logger.warn;
  global.logger.log = global.logger.info;
  return global.logger;
}

/**
 * 格式化持续时间。
 * @param {number} duration - 持续时间（毫秒）
 * @returns {string} 格式化后的字符串
 */
function formatDuration(duration) {
  if (duration < 1000) return `${duration}ms`;
  if (duration < 60000) return `${(duration / 1000).toFixed(3)}s`;
  const minutes = Math.floor(duration / 60000);
  const seconds = ((duration % 60000) / 1000).toFixed(3);
  return `${minutes}m ${seconds}s`;
}