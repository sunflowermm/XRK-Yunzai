import pino from 'pino';
import log4js from 'log4js';
import chalk from 'chalk';
import cfg from './config.js';
import path from 'node:path';
import util from 'node:util';
import fs from 'node:fs';

export default function setLog() {
  const logDir = './logs';
  const isWindows = process.platform === 'win32';

  // 确保logs目录存在
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
    console.log(`Created logs directory: ${logDir}`);
  }

  if (isWindows && !process.env.PM2_HOME) {
    process.stdout.setEncoding('utf8');
    process.stderr.setEncoding('utf8');
  }

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

  // 使用默认值如果cfg.bot未定义
  const logLevel = cfg?.bot?.log_level || 'info';
  const logColor = cfg?.bot?.log_color || 'default';
  const logAlign = cfg?.bot?.log_align || 'XRKYZ';

  const selectedScheme = colorSchemes[logColor] || colorSchemes['default'];
  const selectedTimestampColors = timestampSchemes[logColor] || timestampSchemes['default'];

  function createGradientText(text, colors = selectedScheme) {
    if (!text || text.length === 0) return text;
    let result = '';
    
    if (isWindows) {
      for (let i = 0; i < text.length; i++) {
        const colorIndex = i % colors.length;
        result += chalk.hex(colors[colorIndex])(text[i]);
      }
    } else {
      const step = Math.ceil(text.length / colors.length);
      for (let i = 0; i < text.length; i += step) {
        const colorIndex = Math.floor(i / step) % colors.length;
        const chunk = text.slice(i, i + step);
        result += chalk.hex(colors[colorIndex])(chunk);
      }
    }
    return result;
  }

  function formatTimestamp() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const timestamp = `[${month}-${day} ${hours}:${minutes}:${seconds}]`;
    
    if (isWindows) {
      return createGradientText(timestamp, selectedTimestampColors);
    } else {
      return chalk.hex(selectedTimestampColors[0])(timestamp);
    }
  }

  const getLogHeader = () => {
    const headerText = logAlign ? `[${logAlign}]` : '[XRKYZ]';
    return createGradientText(headerText);
  };

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

  function createLogPrefix(level) {
    const style = logStyles[level] || logStyles.info;
    const header = getLogHeader();
    const timestamp = formatTimestamp();
    const symbol = chalk[style.color](style.symbol);
    return `${header} ${timestamp} ${symbol} `;
  }

  function ensureUTF8(str) {
    if (typeof str !== 'string') return str;
    return Buffer.from(str, 'utf8').toString('utf8');
  }

  let logger, commandLogger, errorLogger;
  let createLogMethod;

  if (isWindows) {
    // Windows系统使用log4js
    log4js.configure({
      appenders: {
        console: {
          type: 'console',
          layout: {
            type: 'pattern',
            pattern: '%m',  // 简化pattern以避免重复
          },
        },
        command: {
          type: 'dateFile',
          filename: path.join(logDir, 'command'),
          pattern: 'yyyy-MM-dd.log',
          numBackups: 15,
          alwaysIncludePattern: true,
          layout: {
            type: 'pattern',
            pattern: '[%d{yyyy-MM-dd hh:mm:ss}][%p] %m',
          },
        },
        error: {
          type: 'file',
          filename: path.join(logDir, 'error.log'),
          alwaysIncludePattern: true,
          layout: {
            type: 'pattern',
            pattern: '[%d{yyyy-MM-dd hh:mm:ss}][%p] %m',
          },
        },
        // 添加一个通用文件appender
        allFile: {
          type: 'file',
          filename: path.join(logDir, 'app.log'),
          maxLogSize: 10485760, // 10MB
          backups: 5,
          layout: {
            type: 'pattern',
            pattern: '[%d{yyyy-MM-dd hh:mm:ss}][%p] %m',
          },
        },
      },
      categories: {
        default: { appenders: ['console', 'allFile'], level: logLevel },
        command: { appenders: ['console', 'command', 'allFile'], level: 'info' },
        error: { appenders: ['console', 'error', 'allFile'], level: 'error' },
      },
    });

    logger = log4js.getLogger('default');
    commandLogger = log4js.getLogger('command');
    errorLogger = log4js.getLogger('error');

    createLogMethod = (loggerInstance, level) => (...args) => {
      const prefix = createLogPrefix(level);
      const message = args.map(arg => {
        if (typeof arg === 'object') {
          return util.inspect(arg, { colors: false });
        }
        return String(arg);
      }).join(' ');
      
      // 确保使用正确的log4js级别
      const log4jsLevel = level === 'fatal' ? 'error' : level;
      if (typeof loggerInstance[log4jsLevel] === 'function') {
        loggerInstance[log4jsLevel](prefix + message);
      } else if (typeof loggerInstance.info === 'function') {
        loggerInstance.info(prefix + message);
      }
    };

  } else {
    // 非Windows系统使用pino
    const pinoTransport = pino.transport({
      targets: [
        {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
          level: logLevel,
        },
        {
          target: 'pino/file',
          options: {
            destination: path.join(logDir, 'app.log'),
            mkdir: true,
          },
          level: logLevel,
        },
        {
          target: 'pino/file',
          options: {
            destination: path.join(logDir, 'command.log'),
            mkdir: true,
          },
          level: 'info',
        },
        {
          target: 'pino/file',
          options: {
            destination: path.join(logDir, 'error.log'),
            mkdir: true,
          },
          level: 'error',
        },
      ],
    });

    const pinoLogger = pino({
      level: logLevel,
      timestamp: pino.stdTimeFunctions.isoTime,
    }, pinoTransport);

    logger = pinoLogger;
    commandLogger = pinoLogger;
    errorLogger = pinoLogger;

    createLogMethod = (level) => (...args) => {
      const prefix = createLogPrefix(level);
      const message = args.map(arg => {
        if (typeof arg === 'string') {
          return ensureUTF8(arg);
        } else {
          return util.inspect(arg, { colors: false });
        }
      }).join(' ');

      const validLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
      const pinoLevel = level === 'fatal' ? 'error' : level;
      
      if (validLevels.includes(pinoLevel)) {
        pinoLogger[pinoLevel](prefix + message);
      } else {
        pinoLogger.info(prefix + message);
      }
    };
  }

  // 计时器功能
  const timers = {};

  /** 全局变量 logger */
  global.logger = {
    trace: isWindows ? createLogMethod(logger, 'trace') : createLogMethod('trace'),
    debug: isWindows ? createLogMethod(logger, 'debug') : createLogMethod('debug'),
    info: isWindows ? createLogMethod(logger, 'info') : createLogMethod('info'),
    warn: isWindows ? createLogMethod(commandLogger, 'warn') : createLogMethod('warn'),
    error: isWindows ? createLogMethod(errorLogger, 'error') : createLogMethod('error'),
    fatal: isWindows ? createLogMethod(errorLogger, 'fatal') : createLogMethod('fatal'),
    mark: isWindows ? createLogMethod(commandLogger, 'mark') : createLogMethod('mark'),

    chalk,
    red: (text) => chalk.red(text),
    green: (text) => chalk.green(text),
    yellow: (text) => chalk.yellow(text),
    blue: (text) => chalk.blue(text),
    magenta: (text) => chalk.magenta(text),
    cyan: (text) => chalk.cyan(text),
    gray: (text) => chalk.gray(text),
    white: (text) => chalk.white(text),

    xrkyzGradient: (text) => createGradientText(text, selectedScheme),
    rainbow: (text) => {
      const rainbowColors = ['#FF0000', '#FF7F00', '#FFFF00', '#00FF00', '#0000FF', '#4B0082', '#9400D3'];
      return createGradientText(text, rainbowColors);
    },
    gradient: createGradientText,

    success: function (...args) {
      const prefix = createLogPrefix('success');
      const message = args.map(arg => (typeof arg === 'string' ? (isWindows ? arg : ensureUTF8(arg)) : util.inspect(arg))).join(' ');
      if (isWindows) {
        logger.info(prefix + message);
      } else {
        logger.info(prefix + message);
      }
    },

    warning: function (...args) {
      const prefix = createLogPrefix('warn');
      const message = args.map(arg => (typeof arg === 'string' ? (isWindows ? arg : ensureUTF8(arg)) : util.inspect(arg))).join(' ');
      if (isWindows) {
        commandLogger.warn(prefix + message);
      } else {
        logger.warn(prefix + message);
      }
    },

    tip: function (...args) {
      const prefix = createLogPrefix('tip');
      const message = args.map(arg => (typeof arg === 'string' ? (isWindows ? arg : ensureUTF8(arg)) : util.inspect(arg))).join(' ');
      if (isWindows) {
        logger.info(prefix + message);
      } else {
        logger.info(prefix + message);
      }
    },

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
        if (isWindows) {
          logger.info(prefix + message);
        } else {
          logger.info(prefix + message);
        }
        delete timers[label];
      } else {
        this.warn(`计时器 ${label} 不存在`);
      }
    },

    done: function (text, label) {
      const prefix = createLogPrefix('done');
      let message = (isWindows ? (text || '操作完成') : ensureUTF8(text || '操作完成'));
      if (label && timers[label]) {
        const duration = Date.now() - timers[label];
        let timeStr = formatDuration(duration);
        message += ` (耗时: ${timeStr})`;
        delete timers[label];
      }
      if (isWindows) {
        logger.info(prefix + message);
      } else {
        logger.info(prefix + message);
      }
    },

    // 格式化输出
    title: function (text, color = 'yellow') {
      const prefix = createLogPrefix('info');
      const processedText = isWindows ? text : ensureUTF8(text);
      const line = '═'.repeat(processedText.length + 10);
      if (isWindows) {
        logger.info(prefix + chalk[color](line));
        logger.info(prefix + chalk[color](`╔ ${processedText} ╗`));
        logger.info(prefix + chalk[color](line));
      } else {
        logger.info(prefix + chalk[color](line));
        logger.info(prefix + chalk[color](`╔ ${processedText} ╗`));
        logger.info(prefix + chalk[color](line));
      }
    },

    subtitle: function (text, color = 'cyan') {
      const prefix = createLogPrefix('info');
      const processedText = isWindows ? text : ensureUTF8(text);
      const message = chalk[color](`┌─── ${processedText} ───┐`);
      if (isWindows) {
        logger.info(prefix + message);
      } else {
        logger.info(prefix + message);
      }
    },

    line: function (char = '─', length = 35, color = 'gray') {
      const prefix = createLogPrefix('info');
      const message = chalk[color](char.repeat(length));
      if (isWindows) {
        logger.info(prefix + message);
      } else {
        logger.info(prefix + message);
      }
    },

    box: function (text, color = 'blue') {
      const prefix = createLogPrefix('info');
      const processedText = isWindows ? text : ensureUTF8(text);
      const padding = 2;
      const paddedText = ' '.repeat(padding) + processedText + ' '.repeat(padding);
      const line = '─'.repeat(paddedText.length + 4);
      if (isWindows) {
        logger.info(prefix + chalk[color](`┌${line}┐`));
        logger.info(prefix + chalk[color](`│${paddedText}│`));
        logger.info(prefix + chalk[color](`└${line}┘`));
      } else {
        logger.info(prefix + chalk[color](`┌${line}┐`));
        logger.info(prefix + chalk[color](`│${paddedText}│`));
        logger.info(prefix + chalk[color](`└${line}┘`));
      }
    },

    json: function (obj, title) {
      const prefix = createLogPrefix('info');
      if (title) {
        const processedTitle = isWindows ? title : ensureUTF8(title);
        const titleMessage = chalk.cyan(`==== ${processedTitle} ====`);
        if (isWindows) {
          logger.info(prefix + titleMessage);
        } else {
          logger.info(prefix + titleMessage);
        }
      }
      
      try {
        if (isWindows) {
          const formatted = JSON.stringify(obj, null, 2);
          const lines = formatted.split('\n');
          lines.forEach(line => logger.info(prefix + line));
        } else {
          const formatted = util.inspect(obj, { depth: null, colors: true });
          const lines = formatted.split('\n');
          lines.forEach(line => logger.info(prefix + line));
        }
      } catch (err) {
        const errorMessage = `无法序列化对象: ${err.message}`;
        if (isWindows) {
          errorLogger.error(prefix + errorMessage);
          logger.info(prefix + String(obj));
        } else {
          logger.error(prefix + errorMessage);
          logger.info(prefix + String(obj));
        }
      }
    },

    // 更多实用工具
    progress: function (current, total, length = 30) {
      const prefix = createLogPrefix('info');
      const percent = Math.min(Math.round((current / total) * 100), 100);
      const filledLength = Math.round((current / total) * length);
      const bar = '█'.repeat(filledLength) + '░'.repeat(length - filledLength);
      const message = `${chalk.cyan('[')}${chalk.green(bar)}${chalk.cyan(']')} ${chalk.yellow(percent + '%')} ${current}/${total}`;
      if (isWindows) {
        logger.info(`${prefix}${message}`);
      } else {
        logger.info(`${prefix}${message}`);
      }
    },

    important: function (text) {
      const prefix = createLogPrefix('warn');
      const processedText = isWindows ? text : ensureUTF8(text);
      if (isWindows) {
        commandLogger.warn(prefix + processedText);
      } else {
        logger.warn(prefix + processedText);
      }
    },

    highlight: function (text) {
      const prefix = createLogPrefix('info');
      const processedText = isWindows ? text : ensureUTF8(text);
      const highlightedMessage = chalk.bgYellow.black(` ${processedText} `);
      if (isWindows) {
        logger.info(prefix + highlightedMessage);
      } else {
        logger.info(prefix + highlightedMessage);
      }
    },

    fail: function (text) {
      const prefix = createLogPrefix('error');
      const processedText = isWindows ? text : ensureUTF8(text);
      if (isWindows) {
        errorLogger.error(prefix + chalk.red(processedText));
      } else {
        logger.error(prefix + chalk.red(processedText));
      }
    },

    system: function (text) {
      const prefix = createLogPrefix('info');
      const processedText = isWindows ? text : ensureUTF8(text);
      const systemMessage = chalk.gray(`[SYSTEM] ${processedText}`);
      if (isWindows) {
        logger.info(prefix + systemMessage);
      } else {
        logger.info(prefix + systemMessage);
      }
    },

    list: function (items, title) {
      const prefix = createLogPrefix('info');
      if (title) {
        const processedTitle = isWindows ? title : ensureUTF8(title);
        const titleMessage = chalk.cyan(`=== ${processedTitle} ===`);
        if (isWindows) {
          logger.info(prefix + titleMessage);
        } else {
          logger.info(prefix + titleMessage);
        }
      }
      items.forEach((item, index) => {
        const processedItem = isWindows ? item : ensureUTF8(item);
        const bulletPoint = chalk.gray(`  ${index + 1}. `);
        if (isWindows) {
          logger.info(prefix + bulletPoint + processedItem);
        } else {
          logger.info(prefix + bulletPoint + processedItem);
        }
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
      const processedMessage = isWindows ? message : ensureUTF8(message);
      const statusMessage = chalk[statusColor](`${icon} [${status.toUpperCase()}] `) + processedMessage;
      if (isWindows) {
        logger.info(prefix + statusMessage);
      } else {
        logger.info(prefix + statusMessage);
      }
    },

    tag: function (text, tag, tagColor = 'blue') {
      const prefix = createLogPrefix('info');
      const processedText = isWindows ? text : ensureUTF8(text);
      const processedTag = isWindows ? tag : ensureUTF8(tag);
      const taggedMessage = chalk[tagColor](`[${processedTag}] `) + processedText;
      if (isWindows) {
        logger.info(prefix + taggedMessage);
      } else {
        logger.info(prefix + taggedMessage);
      }
    },

    table: function (data, title) {
      const prefix = createLogPrefix('info');
      if (title) {
        const processedTitle = isWindows ? title : ensureUTF8(title);
        const titleMessage = chalk.cyan(`=== ${processedTitle} ===`);
        if (isWindows) {
          logger.info(prefix + titleMessage);
        } else {
          logger.info(prefix + titleMessage);
        }
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
      if (isWindows) {
        logger.info(prefix + gradientLineText);
      } else {
        logger.info(prefix + gradientLineText);
      }
    },

    platform: function() {
      return {
        os: process.platform,
        isWindows: isWindows,
        loggerType: isWindows ? 'log4js' : 'pino',
        version: process.version,
        logDir: logDir,
        logLevel: logLevel
      };
    },
  };
  
  return global.logger;
}

function formatDuration(duration) {
  if (duration < 1000) return `${duration}ms`;
  if (duration < 60000) return `${(duration / 1000).toFixed(3)}s`;
  const minutes = Math.floor(duration / 60000);
  const seconds = ((duration % 60000) / 1000).toFixed(3);
  return `${minutes}m ${seconds}s`;
}