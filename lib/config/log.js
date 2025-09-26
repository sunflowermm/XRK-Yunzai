import log4js from 'log4js';
import chalk from 'chalk';
import cfg from './config.js';
import path from 'node:path';
import util from 'node:util';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import schedule from 'node-schedule';

export default function setLog() {
  const logDir = './logs';
  
  // 确保日志目录存在
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
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

  const selectedScheme = colorSchemes[cfg.bot.log_color] || colorSchemes['default'];
  const selectedTimestampColors = timestampSchemes[cfg.bot.log_color] || timestampSchemes['default'];

  function createGradientText(text, colors = selectedScheme) {
    if (!text || text.length === 0) return text;
    let result = '';
    const step = Math.max(1, Math.ceil(text.length / colors.length));
    
    for (let i = 0; i < text.length; i++) {
      const colorIndex = Math.floor(i / step) % colors.length;
      result += chalk.hex(colors[colorIndex])(text[i]);
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
    
    return createGradientText(timestamp, selectedTimestampColors);
  }

  const getLogHeader = () => {
    const headerText = cfg.bot.log_align ? `[${cfg.bot.log_align}]` : '[XRKYZ]';
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

  // 自定义布局
  log4js.addLayout('custom', function(config) {
    return function(logEvent) {
      return logEvent.data.join(' ');
    };
  });

  // 配置 log4js
  log4js.configure({
    appenders: {
      console: {
        type: 'console',
        layout: {
          type: 'custom'
        },
      },
      command: {
        type: 'dateFile',
        filename: path.join(logDir, 'command'),
        pattern: 'yyyy-MM-dd.log',
        numBackups: 15,
        alwaysIncludePattern: true,
        compress: false, // 不使用 gz 压缩，方便读取
        keepFileExt: true,
        layout: {
          type: 'pattern',
          pattern: '[%d{yyyy-MM-dd hh:mm:ss}][%p] %m',
        },
      },
      error: {
        type: 'file',
        filename: path.join(logDir, 'error.log'),
        maxLogSize: 10485760, // 10MB
        backups: 5,
        compress: false,
        layout: {
          type: 'pattern',
          pattern: '[%d{yyyy-MM-dd hh:mm:ss}][%p] %m',
        },
      },
      trace: {
        type: 'file',
        filename: path.join(logDir, 'trace.log'),
        maxLogSize: 10485760,
        backups: 3,
        compress: false,
        layout: {
          type: 'pattern',
          pattern: '[%d{yyyy-MM-dd hh:mm:ss}][%p] %m',
        },
      },
    },
    categories: {
      default: { 
        appenders: ['console'], 
        level: cfg.bot.log_level || 'info',
        enableCallStack: true
      },
      command: { 
        appenders: ['console', 'command'], 
        level: 'warn',
        enableCallStack: true
      },
      error: { 
        appenders: ['console', 'command', 'error'], 
        level: 'error',
        enableCallStack: true
      },
      trace: {
        appenders: ['console', 'trace'],
        level: 'trace',
        enableCallStack: true
      }
    },
    pm2: true,
    pm2InstanceVar: 'INSTANCE_ID',
    disableClustering: true,
  });

  const logger = log4js.getLogger('default');
  const commandLogger = log4js.getLogger('command');
  const errorLogger = log4js.getLogger('error');
  const traceLogger = log4js.getLogger('trace');

  // 创建日志方法
  const createLogMethod = (loggerInstance, level) => (...args) => {
    const prefix = createLogPrefix(level);
    const message = args.map(arg => {
      if (typeof arg === 'object') {
        return util.inspect(arg, { colors: false, depth: null });
      }
      return ensureUTF8(String(arg));
    }).join(' ');
    
    const logMethod = loggerInstance[level] || loggerInstance.info;
    logMethod.call(loggerInstance, prefix + message);
  };

  // 计时器功能
  const timers = new Map();

  // 格式化持续时间
  function formatDuration(duration) {
    if (duration < 1000) return `${duration}ms`;
    if (duration < 60000) return `${(duration / 1000).toFixed(3)}s`;
    const minutes = Math.floor(duration / 60000);
    const seconds = ((duration % 60000) / 1000).toFixed(3);
    return `${minutes}m ${seconds}s`;
  }

  // 日志清理功能
  async function cleanExpiredLogs() {
    const maxAge = 3; // 天数
    const now = Date.now();
    const maxAgeMs = maxAge * 24 * 60 * 60 * 1000;

    try {
      const files = await fsPromises.readdir(logDir);
      let deletedCount = 0;
      
      for (const file of files) {
        // 只清理 command.yyyy-MM-dd.log 格式的日志文件
        if (file.startsWith('command.') && file.endsWith('.log')) {
          const dateMatch = file.match(/command\.(\d{4}-\d{2}-\d{2})\.log/);
          if (dateMatch) {
            const fileDate = new Date(dateMatch[1]);
            const filePath = path.join(logDir, file);
            
            if (now - fileDate.getTime() > maxAgeMs) {
              try {
                await fsPromises.unlink(filePath);
                deletedCount++;
                logger.info(`已删除过期日志文件: ${file}`);
              } catch (err) {
                logger.error(`删除日志文件失败: ${file}`, err);
              }
            }
          }
        }
        // 清理 .gz 压缩文件
        else if (file.endsWith('.gz')) {
          const filePath = path.join(logDir, file);
          const stats = await fsPromises.stat(filePath);
          
          if (now - stats.mtime.getTime() > maxAgeMs) {
            try {
              await fsPromises.unlink(filePath);
              deletedCount++;
              logger.info(`已删除过期压缩日志: ${file}`);
            } catch (err) {
              logger.error(`删除压缩日志失败: ${file}`, err);
            }
          }
        }
      }
      
      if (deletedCount > 0) {
        logger.success(`日志清理完成，共删除 ${deletedCount} 个过期文件`);
      }
    } catch (err) {
      logger.error('清理过期日志时出错:', err);
    }
  }

  // 设置定时任务 - 每天凌晨 3 点执行清理
  const cleanupJob = schedule.scheduleJob('0 3 * * *', async () => {
    logger.info('开始执行日志清理任务...');
    await cleanExpiredLogs();
  });

  // 启动时立即执行一次清理
  setTimeout(() => {
    cleanExpiredLogs().catch(err => {
      logger.error('启动时清理日志失败:', err);
    });
  }, 5000);

  /** 全局变量 logger */
  global.logger = {
    trace: createLogMethod(traceLogger, 'trace'),
    debug: createLogMethod(logger, 'debug'),
    info: createLogMethod(logger, 'info'),
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

    // 渐变文本
    xrkyzGradient: (text) => createGradientText(text, selectedScheme),
    rainbow: (text) => {
      const rainbowColors = ['#FF0000', '#FF7F00', '#FFFF00', '#00FF00', '#0000FF', '#4B0082', '#9400D3'];
      return createGradientText(text, rainbowColors);
    },
    gradient: createGradientText,

    // 特殊日志方法
    success: function (...args) {
      const prefix = createLogPrefix('success');
      const message = args.map(arg => typeof arg === 'string' ? ensureUTF8(arg) : util.inspect(arg)).join(' ');
      logger.info(prefix + chalk.green(message));
    },

    warning: function (...args) {
      const prefix = createLogPrefix('warn');
      const message = args.map(arg => typeof arg === 'string' ? ensureUTF8(arg) : util.inspect(arg)).join(' ');
      commandLogger.warn(prefix + chalk.yellow(message));
    },

    tip: function (...args) {
      const prefix = createLogPrefix('tip');
      const message = args.map(arg => typeof arg === 'string' ? ensureUTF8(arg) : util.inspect(arg)).join(' ');
      logger.info(prefix + chalk.yellow(message));
    },

    // 计时功能
    time: function (label = 'default') {
      timers.set(label, Date.now());
      this.debug(`计时开始: ${label}`);
    },

    timeEnd: function (label = 'default') {
      if (timers.has(label)) {
        const duration = Date.now() - timers.get(label);
        const timeStr = formatDuration(duration);
        const prefix = createLogPrefix('info');
        const message = `计时结束 ${chalk.cyan(label)}: ${chalk.yellow(timeStr)}`;
        logger.info(prefix + message);
        timers.delete(label);
      } else {
        this.warn(`计时器 ${label} 不存在`);
      }
    },

    done: function (text, label) {
      const prefix = createLogPrefix('done');
      let message = ensureUTF8(text || '操作完成');
      if (label && timers.has(label)) {
        const duration = Date.now() - timers.get(label);
        const timeStr = formatDuration(duration);
        message += ` (耗时: ${chalk.yellow(timeStr)})`;
        timers.delete(label);
      }
      logger.info(prefix + chalk.green(message));
    },

    // 格式化输出
    title: function (text, color = 'yellow') {
      const prefix = createLogPrefix('info');
      const processedText = ensureUTF8(text);
      const line = '═'.repeat(processedText.length + 10);
      logger.info(prefix + chalk[color](line));
      logger.info(prefix + chalk[color](`╔ ${processedText} ╗`));
      logger.info(prefix + chalk[color](line));
    },

    subtitle: function (text, color = 'cyan') {
      const prefix = createLogPrefix('info');
      const processedText = ensureUTF8(text);
      logger.info(prefix + chalk[color](`┌─── ${processedText} ───┐`));
    },

    line: function (char = '─', length = 35, color = 'gray') {
      const prefix = createLogPrefix('info');
      logger.info(prefix + chalk[color](char.repeat(length)));
    },

    box: function (text, color = 'blue') {
      const prefix = createLogPrefix('info');
      const processedText = ensureUTF8(text);
      const padding = 2;
      const paddedText = ' '.repeat(padding) + processedText + ' '.repeat(padding);
      const line = '─'.repeat(paddedText.length);
      logger.info(prefix + chalk[color](`┌${line}┐`));
      logger.info(prefix + chalk[color](`│${paddedText}│`));
      logger.info(prefix + chalk[color](`└${line}┘`));
    },

    json: function (obj, title) {
      const prefix = createLogPrefix('info');
      if (title) {
        const processedTitle = ensureUTF8(title);
        logger.info(prefix + chalk.cyan(`==== ${processedTitle} ====`));
      }
      
      try {
        const formatted = JSON.stringify(obj, null, 2);
        const lines = formatted.split('\n');
        lines.forEach(line => {
          logger.info(prefix + chalk.gray(line));
        });
      } catch (err) {
        errorLogger.error(prefix + `无法序列化对象: ${err.message}`);
        logger.info(prefix + util.inspect(obj, { depth: null, colors: true }));
      }
    },

    // 进度条
    progress: function (current, total, length = 30) {
      const prefix = createLogPrefix('info');
      const percent = Math.min(Math.round((current / total) * 100), 100);
      const filledLength = Math.round((current / total) * length);
      const bar = '█'.repeat(filledLength) + '░'.repeat(length - filledLength);
      const message = `${chalk.cyan('[')}${chalk.green(bar)}${chalk.cyan(']')} ${chalk.yellow(percent + '%')} ${current}/${total}`;
      logger.info(`${prefix}${message}`);
    },

    // 其他实用方法
    important: function (text) {
      const prefix = createLogPrefix('warn');
      const processedText = ensureUTF8(text);
      commandLogger.warn(prefix + chalk.bold.yellow(processedText));
    },

    highlight: function (text) {
      const prefix = createLogPrefix('info');
      const processedText = ensureUTF8(text);
      logger.info(prefix + chalk.bgYellow.black(processedText));
    },

    fail: function (text) {
      const prefix = createLogPrefix('error');
      const processedText = ensureUTF8(text);
      errorLogger.error(prefix + chalk.red(processedText));
    },

    system: function (text) {
      const prefix = createLogPrefix('info');
      const processedText = ensureUTF8(text);
      logger.info(prefix + chalk.gray(processedText));
    },

    list: function (items, title) {
      const prefix = createLogPrefix('info');
      if (title) {
        const processedTitle = ensureUTF8(title);
        logger.info(prefix + chalk.cyan(`=== ${processedTitle} ===`));
      }
      items.forEach((item, index) => {
        const processedItem = ensureUTF8(item);
        const bullet = chalk.gray(`  ${index + 1}.`);
        logger.info(prefix + `${bullet} ${processedItem}`);
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
      const processedMessage = ensureUTF8(message);
      const statusMessage = chalk[statusColor](`${icon} [${status.toUpperCase()}] `) + processedMessage;
      logger.info(prefix + statusMessage);
    },

    tag: function (text, tag, tagColor = 'blue') {
      const prefix = createLogPrefix('info');
      const processedText = ensureUTF8(text);
      const processedTag = ensureUTF8(tag);
      const taggedMessage = chalk[tagColor](`[${processedTag}] `) + processedText;
      logger.info(prefix + taggedMessage);
    },

    table: function (data, title) {
      const prefix = createLogPrefix('info');
      if (title) {
        const processedTitle = ensureUTF8(title);
        logger.info(prefix + chalk.cyan(`=== ${processedTitle} ===`));
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
      logger.info(prefix + gradientLineText);
    },

    // 获取平台信息
    platform: function() {
      return {
        os: process.platform,
        loggerType: 'log4js',
        loggerVersion: log4js.levels.version || '6.x',
        nodeVersion: process.version,
        logLevel: cfg.bot.log_level || 'info',
        logDir: logDir,
        cleanupSchedule: '每天凌晨3点',
        maxLogAge: '3天'
      };
    },

    // 手动清理日志
    cleanLogs: async function(days = 3) {
      const maxAgeMs = days * 24 * 60 * 60 * 1000;
      const now = Date.now();
      
      try {
        const files = await fsPromises.readdir(logDir);
        let deletedCount = 0;
        
        for (const file of files) {
          const filePath = path.join(logDir, file);
          const stats = await fsPromises.stat(filePath);
          
          if (now - stats.mtime.getTime() > maxAgeMs) {
            await fsPromises.unlink(filePath);
            deletedCount++;
          }
        }
        
        this.success(`手动清理完成，删除了 ${deletedCount} 个过期日志文件`);
        return deletedCount;
      } catch (err) {
        this.error('手动清理日志失败:', err);
        return 0;
      }
    },

    // 清理和关闭
    shutdown: function() {
      return new Promise((resolve) => {
        // 取消定时任务
        if (cleanupJob) {
          cleanupJob.cancel();
        }
        
        log4js.shutdown((err) => {
          if (err) {
            console.error('Error during log4js shutdown:', err);
          }
          resolve();
        });
      });
    }
  };

  // 别名
  logger.warning = logger.warn;

  // 处理进程退出
  process.on('exit', () => {
    if (cleanupJob) {
      cleanupJob.cancel();
    }
    log4js.shutdown();
  });

  process.on('SIGINT', () => {
    if (cleanupJob) {
      cleanupJob.cancel();
    }
    log4js.shutdown(() => {
      process.exit(0);
    });
  });

  return global.logger;
}