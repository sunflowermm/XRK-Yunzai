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

  const selectedScheme = colorSchemes[cfg.bot?.log_color] || colorSchemes.default;
  const selectedTimestampColors = timestampSchemes[cfg.bot?.log_color] || timestampSchemes.default;

  // Level mapping for custom log methods
  const levelMapping = {
    trace: 'trace',
    debug: 'debug',
    info: 'info',
    warn: 'warn',
    error: 'error',
    fatal: 'fatal',
    mark: 'info',
    success: 'info',
    tip: 'info',
    done: 'info'
  };

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
    const headerText = cfg.bot?.log_align ? `[${cfg.bot.log_align}]` : '[XRKYZ]';
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

  // Remove all ANSI color codes from text
  function stripColors(str) {
    if (typeof str !== 'string') return str;
    return str
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\u001b\[[^m]*m/g, '')
      .replace(/\[38;5;\d+m/g, '')
      .replace(/\[39m/g, '')
      .replace(/\[\d+m/g, '');
  }

  function ensureUTF8(str) {
    if (typeof str !== 'string') return str;
    return Buffer.from(str, 'utf8').toString('utf8');
  }

  // Custom console output layout
  log4js.addLayout('custom', function(config) {
    return function(logEvent) {
      return logEvent.data.join(' ');
    };
  });

  // File output layout (no colors)
  log4js.addLayout('file', function(config) {
    return function(logEvent) {
      const timestamp = new Date(logEvent.startTime).toISOString().replace('T', ' ').split('.')[0];
      const level = logEvent.level.levelStr;
      const message = stripColors(logEvent.data.join(' '));
      return `[${timestamp}] [${level}] ${message}`;
    };
  });

  // Trace layout with call stack
  log4js.addLayout('trace', function(config) {
    return function(logEvent) {
      const timestamp = new Date(logEvent.startTime).toISOString().replace('T', ' ').split('.')[0];
      const level = logEvent.level.levelStr;
      const message = stripColors(logEvent.data.join(' '));
      
      let stackInfo = '';
      if (logEvent.callStack) {
        const stack = new Error().stack;
        if (stack) {
          const lines = stack.split('\n').slice(3, 6);
          stackInfo = '\n  Stack: ' + lines.join('\n  ');
        }
      }
      
      return `[${timestamp}] [${level}] ${message}${stackInfo}`;
    };
  });

  // Configure log4js
  log4js.configure({
    appenders: {
      console: {
        type: 'console',
        layout: { type: 'custom' }
      },
      dailyFile: {
        type: 'dateFile',
        filename: path.join(logDir, 'app'),
        pattern: 'yyyy-MM-dd.log',
        numBackups: cfg.bot?.log_max_days || 3,
        alwaysIncludePattern: true,
        compress: false,
        keepFileExt: true,
        layout: { type: 'file' }
      },
      traceFile: {
        type: 'dateFile',
        filename: path.join(logDir, 'trace'),
        pattern: 'yyyy-MM-dd.log',
        numBackups: cfg.bot?.log_trace_days || 1,
        alwaysIncludePattern: true,
        compress: false,
        keepFileExt: true,
        layout: { type: 'trace' }
      },
      consoleFilter: {
        type: 'logLevelFilter',
        appender: 'console',
        level: cfg.bot?.log_level || 'info',
        maxLevel: 'fatal'
      },
      fileFilter: {
        type: 'logLevelFilter', 
        appender: 'dailyFile',
        level: 'debug',
        maxLevel: 'fatal'
      },
      traceFilter: {
        type: 'logLevelFilter',
        appender: 'traceFile',
        level: 'trace',
        maxLevel: 'trace'
      }
    },
    categories: {
      default: { 
        appenders: ['consoleFilter', 'fileFilter', 'traceFilter'], 
        level: 'trace',
        enableCallStack: true
      }
    },
    pm2: true,
    pm2InstanceVar: 'INSTANCE_ID',
    disableClustering: true,
  });

  const logger = log4js.getLogger('default');

  const createLogMethod = (level) => (...args) => {
    const prefix = createLogPrefix(level);
    const message = args.map(arg => {
      if (typeof arg === 'object') {
        return util.inspect(arg, { colors: false, depth: null, maxArrayLength: null });
      }
      return ensureUTF8(String(arg));
    }).join(' ');
    
    const actualLevel = levelMapping[level] || 'info';
    
    if ((level === 'error' || level === 'fatal') && args[0] instanceof Error) {
      const error = args[0];
      const errorMessage = `${prefix}${error.message}`;
      logger[actualLevel].call(logger, errorMessage);
      
      if (error.stack) {
        logger.trace(`Stack trace for error: ${error.stack}`);
      }
    } else {
      logger[actualLevel].call(logger, prefix + message);
    }
  };

  const timers = new Map();

  function formatDuration(duration) {
    if (duration < 1000) return `${duration}ms`;
    if (duration < 60000) return `${(duration / 1000).toFixed(3)}s`;
    const minutes = Math.floor(duration / 60000);
    const seconds = ((duration % 60000) / 1000).toFixed(3);
    return `${minutes}m ${seconds}s`;
  }

  // Clean expired log files
  async function cleanExpiredLogs() {
    const mainLogMaxAge = cfg.bot?.log_max_days || 3;
    const traceLogMaxAge = cfg.bot?.log_trace_days || 1; 
    const now = Date.now();

    try {
      const files = await fsPromises.readdir(logDir);
      let deletedCount = 0;
      
      for (const file of files) {
        const filePath = path.join(logDir, file);
        
        if (file.startsWith('app.') && file.endsWith('.log')) {
          const dateMatch = file.match(/app\.(\d{4}-\d{2}-\d{2})\.log/);
          if (dateMatch) {
            const fileDate = new Date(dateMatch[1]);
            const fileAge = now - fileDate.getTime();
            const maxAgeMs = mainLogMaxAge * 24 * 60 * 60 * 1000;
            
            if (fileAge > maxAgeMs) {
              try {
                await fsPromises.unlink(filePath);
                deletedCount++;
                logger.debug(`Deleted expired log file: ${file}`);
              } catch (err) {
                logger.error(`Failed to delete log file: ${file}`, err.message);
              }
            }
          }
        }
        else if (file.startsWith('trace.') && file.endsWith('.log')) {
          const dateMatch = file.match(/trace\.(\d{4}-\d{2}-\d{2})\.log/);
          if (dateMatch) {
            const fileDate = new Date(dateMatch[1]);
            const fileAge = now - fileDate.getTime();
            const maxAgeMs = traceLogMaxAge * 24 * 60 * 60 * 1000;
            
            if (fileAge > maxAgeMs) {
              try {
                await fsPromises.unlink(filePath);
                deletedCount++;
                logger.debug(`Deleted expired trace log file: ${file}`);
              } catch (err) {
                logger.error(`Failed to delete trace log file: ${file}`, err.message);
              }
            }
          }
        }
        else if (file.match(/^\d{4}-\d{2}-\d{2}\.log$/) || file.startsWith('command.')) {
          try {
            const stats = await fsPromises.stat(filePath);
            const maxAgeMs = mainLogMaxAge * 24 * 60 * 60 * 1000;
            if (now - stats.mtime.getTime() > maxAgeMs) {
              await fsPromises.unlink(filePath);
              deletedCount++;
              logger.debug(`Deleted old format log file: ${file}`);
            }
          } catch (err) {
            // Ignore errors
          }
        }
      }
      
      if (deletedCount > 0) {
        logger.info(`Log cleanup completed, deleted ${deletedCount} expired files`);
      }
    } catch (err) {
      logger.error('Error cleaning expired logs:', err.message);
    }
  }

  // Schedule cleanup at 3 AM daily
  const cleanupJob = schedule.scheduleJob('0 3 * * *', async () => {
    logger.info('Starting log cleanup task...');
    await cleanExpiredLogs();
  });

  // Cleanup on startup
  setTimeout(() => {
    cleanExpiredLogs().catch(err => {
      logger.error('Failed to clean logs on startup:', err.message);
    });
  }, 5000);

  // Global logger object
  global.logger = {
    trace: createLogMethod('trace'),
    debug: createLogMethod('debug'),
    info: createLogMethod('info'),
    warn: createLogMethod('warn'),
    error: createLogMethod('error'),
    fatal: createLogMethod('fatal'),
    mark: createLogMethod('mark'),

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
      const message = args.map(arg => typeof arg === 'string' ? ensureUTF8(arg) : util.inspect(arg, { colors: false })).join(' ');
      logger.info(prefix + chalk.green(message));
    },

    warning: function (...args) {
      const prefix = createLogPrefix('warn');
      const message = args.map(arg => typeof arg === 'string' ? ensureUTF8(arg) : util.inspect(arg, { colors: false })).join(' ');
      logger.warn(prefix + chalk.yellow(message));
    },

    tip: function (...args) {
      const prefix = createLogPrefix('tip');
      const message = args.map(arg => typeof arg === 'string' ? ensureUTF8(arg) : util.inspect(arg, { colors: false })).join(' ');
      logger.info(prefix + chalk.yellow(message));
    },

    time: function (label = 'default') {
      timers.set(label, Date.now());
      this.trace(`Timer started: ${label}`);
    },

    timeEnd: function (label = 'default') {
      if (timers.has(label)) {
        const duration = Date.now() - timers.get(label);
        const timeStr = formatDuration(duration);
        const prefix = createLogPrefix('info');
        const message = `Timer ended ${chalk.cyan(label)}: ${chalk.yellow(timeStr)}`;
        logger.info(prefix + message);
        timers.delete(label);
        
        logger.trace(`Timer [${label}] duration: ${timeStr}`);
      } else {
        this.warn(`Timer ${label} does not exist`);
      }
    },

    done: function (text, label) {
      const prefix = createLogPrefix('done');
      let message = ensureUTF8(text || 'Operation completed');
      if (label && timers.has(label)) {
        const duration = Date.now() - timers.get(label);
        const timeStr = formatDuration(duration);
        message += ` (Duration: ${chalk.yellow(timeStr)})`;
        timers.delete(label);
        
        logger.trace(`Operation completed [${label}]: ${text} - Duration ${timeStr}`);
      }
      logger.info(prefix + chalk.green(message));
    },

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
        
        logger.trace(`JSON Data ${title ? `[${title}]` : ''}: ${JSON.stringify(obj)}`);
      } catch (err) {
        logger.error(prefix + `Cannot serialize object: ${err.message}`);
        logger.info(prefix + util.inspect(obj, { depth: null, colors: true }));
      }
    },

    progress: function (current, total, length = 30) {
      const prefix = createLogPrefix('info');
      const percent = Math.min(Math.round((current / total) * 100), 100);
      const filledLength = Math.round((current / total) * length);
      const bar = '█'.repeat(filledLength) + '░'.repeat(length - filledLength);
      const message = `${chalk.cyan('[')}${chalk.green(bar)}${chalk.cyan(']')} ${chalk.yellow(percent + '%')} ${current}/${total}`;
      logger.info(`${prefix}${message}`);
      
      if (percent === 100 || percent % 25 === 0) {
        logger.trace(`Progress: ${percent}% (${current}/${total})`);
      }
    },

    important: function (text) {
      const prefix = createLogPrefix('warn');
      const processedText = ensureUTF8(text);
      logger.warn(prefix + chalk.bold.yellow(processedText));
    },

    highlight: function (text) {
      const prefix = createLogPrefix('info');
      const processedText = ensureUTF8(text);
      logger.info(prefix + chalk.bgYellow.black(processedText));
    },

    fail: function (text) {
      const prefix = createLogPrefix('error');
      const processedText = ensureUTF8(text);
      logger.error(prefix + chalk.red(processedText));
    },

    system: function (text) {
      const prefix = createLogPrefix('info');
      const processedText = ensureUTF8(text);
      logger.info(prefix + chalk.gray(processedText));
      
      logger.trace(`System: ${processedText}`);
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
      
      logger.trace(`Status Change: [${status.toUpperCase()}] ${processedMessage}`);
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
        
        logger.trace(`Table Data ${title ? `[${title}]` : ''}: ${JSON.stringify(data)}`);
      } else {
        this.json(data);
      }
    },

    gradientLine: function (char = '─', length = 50) {
      const prefix = createLogPrefix('info');
      const gradientLineText = this.gradient(char.repeat(length));
      logger.info(prefix + gradientLineText);
    },

    // Get platform information
    platform: function() {
      return {
        os: process.platform,
        loggerType: 'log4js',
        loggerVersion: '6.x',
        nodeVersion: process.version,
        logLevel: cfg.bot?.log_level || 'info',
        logDir: logDir,
        cleanupSchedule: 'Daily at 3 AM',
        mainLogAge: `${cfg.bot?.log_max_days || 3} days`,
        traceLogAge: `${cfg.bot?.log_trace_days || 1} day(s)`,
        logFiles: {
          main: 'app.yyyy-MM-dd.log',
          trace: 'trace.yyyy-MM-dd.log'
        }
      };
    },

    // Manual log cleanup
    cleanLogs: async function(days, includeTrace = true) {
      const mainDays = days || cfg.bot?.log_max_days || 3;
      const traceDays = cfg.bot?.log_trace_days || 1;
      const now = Date.now();
      
      try {
        const files = await fsPromises.readdir(logDir);
        let deletedCount = 0;
        
        for (const file of files) {
          const filePath = path.join(logDir, file);
          const stats = await fsPromises.stat(filePath);
          
          let maxAgeMs;
          if (file.startsWith('trace.')) {
            if (!includeTrace) continue;
            maxAgeMs = traceDays * 24 * 60 * 60 * 1000;
          } else {
            maxAgeMs = mainDays * 24 * 60 * 60 * 1000;
          }
          
          if (now - stats.mtime.getTime() > maxAgeMs) {
            await fsPromises.unlink(filePath);
            deletedCount++;
          }
        }
        
        this.info(`Manual cleanup completed, deleted ${deletedCount} expired log files`);
        return deletedCount;
      } catch (err) {
        this.error('Manual log cleanup failed:', err.message);
        return 0;
      }
    },

    // Get trace logs content
    getTraceLogs: async function(lines = 100) {
      try {
        const currentDate = new Date().toISOString().split('T')[0];
        const traceFile = path.join(logDir, `trace.${currentDate}.log`);
        
        if (!fs.existsSync(traceFile)) {
          return null;
        }
        
        const content = await fsPromises.readFile(traceFile, 'utf8');
        const logLines = content.split('\n').filter(line => line.trim());
        
        return logLines.slice(-lines);
      } catch (err) {
        this.error('Failed to read trace logs:', err.message);
        return null;
      }
    },

    // Shutdown logger
    shutdown: function() {
      return new Promise((resolve) => {
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

  // Alias
  global.logger.warning = global.logger.warn;

  // Handle process exit
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