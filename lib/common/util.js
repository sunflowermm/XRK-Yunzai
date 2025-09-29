import fs from "node:fs/promises";
import * as fsSync from "fs";
import path from "node:path";
import crypto from 'node:crypto';
import { exec as execCallback, execFile } from "node:child_process";
import { ulid } from "ulid";
import { fileTypeFromBuffer } from "file-type";
import md5 from "md5";
import moment from "moment";

import cfg from "../config/config.js";
import common from './common.js';

/**
 * Bot utility class providing various utility functions
 * @class BotUtil
 */
export default class BotUtil {
  /**
   * @static
   * @private
   * @type {string}
   */
  static apiKey = '';

  /**
   * Regular expression cache for performance optimization
   * @static
   * @private
   * @type {Object<string, RegExp>}
   */
  static regexCache = {
    url: /^https?:\/\//,
    base64: /^base64:\/\//,
    controlChars: /\u001b$$\d+(;\d+)*m/g,
    globPattern: /[*?[$${}]/,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
    ipv6: /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4})$/,
    chinese: /[\u4e00-\u9fa5]/g
  };

  /**
   * MIME type to file extension mapping
   * @static
   * @private
   * @type {Map<string, string>}
   */
  static mimeToExtMap = new Map([
    ['image/jpeg', '.jpg'],
    ['image/png', '.png'],
    ['image/gif', '.gif'],
    ['image/webp', '.webp'],
    ['image/svg+xml', '.svg'],
    ['audio/mpeg', '.mp3'],
    ['audio/wav', '.wav'],
    ['video/mp4', '.mp4'],
    ['video/webm', '.webm'],
    ['application/pdf', '.pdf'],
    ['application/json', '.json'],
    ['application/zip', '.zip'],
    ['text/plain', '.txt'],
    ['text/html', '.html'],
    ['text/css', '.css'],
    ['text/javascript', '.js']
  ]);

  /**
   * Global map storage
   * @static
   * @private
   * @type {Map<string, Map>}
   */
  static #globalMaps = new Map();

  /**
   * Memory cache storage
   * @static
   * @private
   * @type {Map<string, Object>}
   */
  static #memoryCache = new Map();

  /**
   * Glob library instance
   * @static
   * @private
   * @type {Function|null}
   */
  static #globLib = null;

  /**
   * Color schemes for log ID formatting
   * @static
   * @type {Object<string, Array<string>>}
   */
  static idColorSchemes = {
    default: ['#00D9FF', '#00C9E6', '#00B8CC', '#00A6B3', '#009599'],
    scheme1: ['#FF00FF', '#E91E63', '#C2185B', '#AD1457', '#880E4F'],
    scheme2: ['#FF9800', '#FB8C00', '#F57C00', '#EF6C00', '#E65100'],
    scheme3: ['#FFD700', '#FFC107', '#FFB300', '#FFA000', '#FF8F00'],
    scheme4: ['#00BCD4', '#00ACC1', '#0097A7', '#00838F', '#006064'],
    scheme5: ['#FF6B6B', '#FE7A7A', '#FD8989', '#FC9898', '#FBA7A7'],
    scheme6: ['#74EBD5', '#6DDDC4', '#66CEB3', '#5FBFA2', '#58B091'],
    scheme7: ['#D4A574', '#CD9A67', '#C68F5A', '#BF844D', '#B87940']
  };

  // Initialize periodic cache cleanup
  static {
    setInterval(() => {
      const now = Date.now();
      for (const [key, cached] of BotUtil.#memoryCache) {
        if (cached.ttl > 0 && now > cached.expireAt) {
          BotUtil.#memoryCache.delete(key);
        }
      }
    }, 60000);
  }

  // ========== Map Management ==========

  /**
   * Get or create a Map object with extended functionality
   * @param {string} [name='default'] - Map identifier
   * @param {Object} [options={}] - Configuration options
   * @param {number} [options.maxSize=Infinity] - Maximum size limit
   * @param {number} [options.ttl=0] - Time to live in milliseconds
   * @param {Function} [options.onEvict=null] - Callback when item is evicted
   * @param {boolean} [options.autoClean=false] - Enable automatic cleanup
   * @param {number} [options.cleanInterval=60000] - Cleanup interval in milliseconds
   * @returns {Map} Extended Map object with additional methods
   */
  static getMap(name = 'default', options = {}) {
    if (!BotUtil.#globalMaps.has(name)) {
      BotUtil.#globalMaps.set(name, BotUtil.#createExtendedMap(options));
    }
    return BotUtil.#globalMaps.get(name);
  }

  /**
   * Create an extended Map with additional functionality
   * @private
   * @param {Object} options - Configuration options
   * @returns {Map} Extended Map object
   */
  static #createExtendedMap(options) {
    const {
      maxSize = Infinity,
      ttl = 0,
      onEvict = null,
      autoClean = false,
      cleanInterval = 60000
    } = options;

    const map = new Map();
    map._metadata = new Map();
    map._options = { maxSize, ttl, onEvict, autoClean, cleanInterval };

    const originalSet = map.set.bind(map);
    map.set = function (key, value) {
      if (this.size >= maxSize && !this.has(key)) {
        const firstKey = this.keys().next().value;
        if (onEvict) onEvict(firstKey, this.get(firstKey));
        this.delete(firstKey);
        this._metadata.delete(firstKey);
      }

      originalSet(key, value);

      if (ttl > 0) {
        this._metadata.set(key, {
          createdAt: Date.now(),
          ttl: ttl
        });
      }

      return this;
    };

    const originalGet = map.get.bind(map);
    map.get = function (key) {
      if (ttl > 0 && this._metadata.has(key)) {
        const metadata = this._metadata.get(key);
        if (Date.now() - metadata.createdAt > metadata.ttl) {
          if (onEvict) onEvict(key, originalGet(key));
          this.delete(key);
          this._metadata.delete(key);
          return undefined;
        }
      }
      return originalGet(key);
    };

    map.setMany = function (entries) {
      for (const [key, value] of entries) {
        this.set(key, value);
      }
      return this;
    };

    map.getMany = function (keys) {
      const result = new Map();
      for (const key of keys) {
        const value = this.get(key);
        if (value !== undefined) result.set(key, value);
      }
      return result;
    };

    map.cleanExpired = function () {
      if (ttl <= 0) return 0;
      let cleaned = 0;
      const now = Date.now();
      for (const [key, metadata] of this._metadata.entries()) {
        if (now - metadata.createdAt > metadata.ttl) {
          if (onEvict) onEvict(key, originalGet(key));
          this.delete(key);
          this._metadata.delete(key);
          cleaned++;
        }
      }
      return cleaned;
    };

    map.destroy = function () {
      if (this._cleanInterval) {
        clearInterval(this._cleanInterval);
      }
      this.clear();
      this._metadata.clear();
    };

    if (autoClean && ttl > 0) {
      map._cleanInterval = setInterval(() => {
        map.cleanExpired();
      }, cleanInterval);
    }

    return map;
  }

  /**
   * Delete a named Map
   * @param {string} name - Map identifier
   * @returns {boolean} Whether deletion was successful
   */
  static deleteMap(name) {
    const map = BotUtil.#globalMaps.get(name);
    if (map) {
      if (typeof map.destroy === 'function') map.destroy();
      return BotUtil.#globalMaps.delete(name);
    }
    return false;
  }

  // ========== Cache Management ==========

  /**
   * Memory cache operations - get or set cached values
   * @param {string} key - Cache key
   * @param {*} [value] - Value to cache (omit to get)
   * @param {number} [ttl=0] - Time to live in milliseconds (0 = no expiry)
   * @returns {*} Cached value or undefined
   */
  static cache(key, value, ttl = 0) {
    if (value === undefined) {
      const cached = BotUtil.#memoryCache.get(key);
      if (cached) {
        if (cached.ttl === 0 || Date.now() < cached.expireAt) {
          return cached.value;
        }
        BotUtil.#memoryCache.delete(key);
      }
      return undefined;
    }

    BotUtil.#memoryCache.set(key, {
      value,
      ttl,
      expireAt: ttl > 0 ? Date.now() + ttl : 0,
      createdAt: Date.now()
    });

    return value;
  }

  /**
   * Clear cache entries
   * @param {string|RegExp} [pattern] - Key or regex pattern to match
   * @returns {number} Number of entries deleted
   */
  static clearCache(pattern) {
    if (!pattern) {
      const size = BotUtil.#memoryCache.size;
      BotUtil.#memoryCache.clear();
      return size;
    }

    let deleted = 0;
    const isRegex = pattern instanceof RegExp;

    for (const [key] of BotUtil.#memoryCache) {
      if (isRegex ? pattern.test(key) : key === pattern) {
        BotUtil.#memoryCache.delete(key);
        deleted++;
      }
    }

    return deleted;
  }

  // ========== String and Data Processing ==========

  /**
   * Generate a unique identifier
   * @param {string} [version='v4'] - UUID version ('v4' or 'ulid')
   * @returns {string} Generated unique identifier
   */
  static uuid(version = 'v4') {
    if (version === 'ulid') return ulid();

    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Generate a random string
   * @param {number} [length=10] - String length
   * @param {string} [chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'] - Character set
   * @returns {string} Random string
   */
  static randomString(length = 10, chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') {
    let result = '';
    const charsLength = chars.length;
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * charsLength));
    }
    return result;
  }

  /**
   * Calculate hash of data
   * @param {string|Buffer} data - Data to hash
   * @param {string} [algorithm='md5'] - Hash algorithm
   * @returns {string} Hex hash string
   */
  static hash(data, algorithm = 'md5') {
    if (algorithm === 'md5') return md5(data);
    return crypto.createHash(algorithm).update(data).digest('hex');
  }

  /**
   * Convert any data to string representation
   * @param {*} data - Data to convert
   * @returns {string} String representation
   */
  static String(data) {
    if (data == null) return String(data);

    switch (typeof data) {
      case "string":
        return data;
      case "function":
        return `[Function: ${data.name || "anonymous"}]`;
      case "object":
        if (data instanceof Error) {
          return data.stack || data.message || String(data);
        }
        if (Buffer.isBuffer(data)) {
          if (data.length > 1024) {
            return `[Binary data, length: ${data.length}]`;
          }
          return `base64://${data.toString("base64")}`;
        }
        try {
          return JSON.stringify(data);
        } catch {
          return "[Object]";
        }
      default:
        return String(data);
    }
  }

  /**
   * Convert data to string or buffer
   * @param {*} data - Data to convert
   * @param {boolean} [base64=false] - Use base64 encoding for binary
   * @returns {string|Buffer} Converted result
   */
  static StringOrBuffer(data, base64) {
    if (!Buffer.isBuffer(data)) return String(data);

    const string = data.toString();
    if (string.includes("\ufffd") || /[\uD800-\uDFFF]/.test(string)) {
      return base64 ? `base64://${data.toString("base64")}` : data;
    }
    return string;
  }

  // ========== Logging System ==========

  /**
   * Calculate display width of string considering double-width characters
   * @private
   * @param {string} str - String to measure
   * @returns {number} Display width
   */
  static #getDisplayWidth(str) {
    if (typeof str !== 'string') str = String(str);
    let width = 0;
    for (const char of str) {
      const code = char.charCodeAt(0);
      // CJK Unified Ideographs
      if ((code >= 0x4E00 && code <= 0x9FFF) ||
        // CJK Symbols and Punctuation
        (code >= 0x3000 && code <= 0x303F) ||
        // Hiragana and Katakana
        (code >= 0x3040 && code <= 0x30FF) ||
        // Fullwidth characters
        (code >= 0xFF00 && code <= 0xFFEF) ||
        // Hangul
        (code >= 0xAC00 && code <= 0xD7AF) ||
        // CJK Extension A
        (code >= 0x3400 && code <= 0x4DBF)) {
        width += 2;
      } else {
        width += 1;
      }
    }
    return width;
  }

  /**
   * Lighten a hex color
   * @private
   * @param {string} hex - Hex color code
   * @param {number} amount - Lighten amount (0-1)
   * @returns {string} Lightened hex color
   */
  static #lightenColor(hex, amount) {
    const color = hex.replace('#', '');
    const num = parseInt(color, 16);
    const r = Math.min(255, Math.floor((num >> 16) + (255 - (num >> 16)) * amount));
    const g = Math.min(255, Math.floor(((num >> 8) & 0x00FF) + (255 - ((num >> 8) & 0x00FF)) * amount));
    const b = Math.min(255, Math.floor((num & 0x0000FF) + (255 - (num & 0x0000FF)) * amount));
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
  }

  /**
   * Apply gradient colors to string characters
   * @private
   * @param {string} text - Text to colorize
   * @param {Array<string>} colors - Color array
   * @param {Object} chalk - Chalk instance
   * @param {boolean} [lightMode=false] - Use lightened colors
   * @returns {string} Colorized string
   */
  static #applyGradientToString(text, colors, chalk, lightMode = false) {
    if (!text || !colors?.length || !chalk) return text;

    const chars = Array.from(text);
    const colorsToUse = lightMode ?
      colors.map(c => BotUtil.#lightenColor(c, 0.6)) :
      colors;

    if (chars.length === 1) {
      return chalk.hex(colorsToUse[Math.floor(colorsToUse.length / 2)])(text);
    }

    let result = '';
    const step = (colorsToUse.length - 1) / Math.max(1, chars.length - 1);

    for (let i = 0; i < chars.length; i++) {
      const colorIndex = Math.min(Math.floor(i * step), colorsToUse.length - 1);
      result += chalk.hex(colorsToUse[colorIndex])(chars[i]);
    }

    return result;
  }

  /**
   * Create formatted log ID with colors and padding
   * @param {string|*} id - ID to format
   * @returns {string} Formatted log ID
   */
  static makeLogID(id) {
    const cacheKey = `logid_${id}_${cfg.bot?.log_color}_${cfg.bot?.log_id_filler}`;
    const cached = BotUtil.cache(cacheKey);
    if (cached) return cached;

    const targetLength = cfg.bot?.log_id_length || 16;
    const filler = cfg.bot?.log_id_filler || '·';
    const currentTheme = cfg.bot?.log_color || 'default';
    const chalk = global.logger?.chalk;

    if (!id && !cfg.bot?.log_align) {
      return BotUtil.cache(cacheKey, "", 60000);
    }

    const idStr = id ? String(id) : (cfg.bot?.log_align || "XRKYZ");
    const displayWidth = BotUtil.#getDisplayWidth(idStr);

    // Plain text mode (no chalk)
    if (!chalk) {
      let plainContent;
      if (displayWidth > targetLength) {
        let truncated = '';
        let currentWidth = 0;
        for (const char of idStr) {
          const charWidth = BotUtil.#getDisplayWidth(char);
          if (currentWidth + charWidth + 2 > targetLength) break;
          truncated += char;
          currentWidth += charWidth;
        }
        plainContent = truncated + '..';
      } else {
        const totalPadding = targetLength - displayWidth;
        const leftPad = Math.floor(totalPadding / 2);
        const rightPad = totalPadding - leftPad;
        plainContent = filler.repeat(leftPad) + idStr + filler.repeat(rightPad);
      }
      return BotUtil.cache(cacheKey, `[${plainContent}]`, 60000);
    }

    // Colored mode
    const idColors = BotUtil.idColorSchemes[currentTheme] || BotUtil.idColorSchemes.default;
    let result = chalk.hex(idColors[0])('[');

    let fullContent = '';
    let isTruncated = false;
    let leftPad = 0;
    let idCharsLength = Array.from(idStr).length;

    if (displayWidth > targetLength) {
      // Truncate
      let truncated = '';
      let currentWidth = 0;
      const maxWidth = targetLength - 2; // for '..'

      for (const char of idStr) {
        const charWidth = BotUtil.#getDisplayWidth(char);
        if (currentWidth + charWidth > maxWidth) break;
        truncated += char;
        currentWidth += charWidth;
      }

      fullContent = truncated + '..';
      isTruncated = true;
    } else if (displayWidth === targetLength) {
      // Exact fit
      fullContent = idStr;
    } else {
      // Pad
      const totalPadding = targetLength - displayWidth;
      leftPad = Math.floor(totalPadding / 2);
      const rightPad = totalPadding - leftPad;

      fullContent = filler.repeat(leftPad) + idStr + filler.repeat(rightPad);
    }

    const chars = Array.from(fullContent);

    if (chars.length > 0 && idColors.length > 0) {
      const numColors = idColors.length;
      const step = chars.length > 1 ? (numColors - 1) / (chars.length - 1) : 0;

      for (let i = 0; i < chars.length; i++) {
        const colorIndex = Math.min(Math.floor(i * step), numColors - 1);
        let color = idColors[colorIndex];

        // Lighten filler parts if not truncated
        if (!isTruncated && (i < leftPad || i >= leftPad + idCharsLength)) {
          color = BotUtil.#lightenColor(color, 0.6);
        }

        result += chalk.hex(color)(chars[i]);
      }
    } else {
      result += fullContent;
    }

    result += chalk.hex(idColors[idColors.length - 1])(']');

    return BotUtil.cache(cacheKey, result, 60000);
  }

  /**
   * Create and output formatted log message
   * @param {string} [level='info'] - Log level
   * @param {string|Array} msg - Message(s) to log
   * @param {string|*} [id] - Log ID
   * @param {boolean} [trace=false] - Include stack trace
   * @returns {string} Formatted log message
   */
  static makeLog(level = "info", msg, id, trace = false) {
    const validLevels = ["trace", "debug", "info", "warn", "error", "fatal", "mark", "success", "tip"];
    level = validLevels.includes(level) ? level : "info";

    const configLogLevel = cfg.bot?.log_level || "info";
    const levelPriorities = {
      "trace": 0,
      "debug": 1,
      "info": 2,
      "mark": 2,
      "success": 2,
      "tip": 2,
      "warn": 3,
      "error": 4,
      "fatal": 5
    };

    const currentPriority = levelPriorities[level] ?? 2;
    const configPriority = levelPriorities[configLogLevel] ?? 2;

    if (currentPriority < configPriority) {
      BotUtil.#writeLogToFile(level, Array.isArray(msg) ? msg : [msg]);
      return "";
    }

    const formattedId = id !== false ? BotUtil.makeLogID(id !== undefined ? id : "") : "";
    const messages = Array.isArray(msg) ? msg : [msg];
    const logParts = [];

    if (formattedId) {
      logParts.push(formattedId);
    }

    for (const item of messages) {
      if (item == null) {
        logParts.push(String(item));
      } else if (typeof item === "object") {
        try {
          const objectOptions = cfg.bot?.log_object || {};
          const inspectOptions = {
            depth: objectOptions.depth || 10,
            colors: false,
            showHidden: objectOptions.showHidden || false,
            showProxy: objectOptions.showProxy || false,
            getters: objectOptions.getters || false,
            breakLength: objectOptions.breakLength || 100,
            maxArrayLength: objectOptions.maxArrayLength || 100,
            maxStringLength: objectOptions.maxStringLength || 1000
          };

          if (typeof util !== 'undefined' && util.inspect) {
            logParts.push(util.inspect(item, inspectOptions));
          } else {
            logParts.push(JSON.stringify(item, BotUtil.getCircularReplacer(), 2));
          }
        } catch {
          try {
            logParts.push(JSON.stringify(item, BotUtil.getCircularReplacer()));
          } catch (err) {
            logParts.push(`[Object: ${err.message}]`);
          }
        }
      } else {
        logParts.push(String(item));
      }
    }

    let logMessage = logParts.join(" ");
    const maxLength = 5000;

    if (logMessage.length > maxLength) {
      const preview = 1000;
      const suffix = 1000;
      logMessage = `${logMessage.slice(0, preview)}... [Truncated ${logMessage.length} chars] ...${logMessage.slice(-suffix)}`;
    }

    try {
      const logger = global.logger?.[level] ?? console[level] ?? console.log;
      logger(logMessage);

      if (trace && global.logger?.trace) {
        const stack = new Error().stack.split("\n").slice(2).join("\n");
        global.logger.trace(`Stack trace:\n${stack}`);
      }
    } catch {
      console.log(`[${level.toUpperCase()}] ${logMessage}`);
    }

    setImmediate(() => {
      const fileId = id !== undefined ? String(id) : (cfg.bot?.log_align || "XRKYZ");
      const width = BotUtil.#getDisplayWidth(fileId);
      const targetWidth = cfg.bot?.log_id_length || 16;

      let plainId;
      if (width > targetWidth) {
        let truncated = '';
        let currentWidth = 0;
        for (const char of fileId) {
          const charWidth = BotUtil.#getDisplayWidth(char);
          if (currentWidth + charWidth > targetWidth - 2) break;
          truncated += char;
          currentWidth += charWidth;
        }
        plainId = `[${truncated}..]`;
      } else {
        const padding = targetWidth - width;
        plainId = `[${fileId}${' '.repeat(padding > 0 ? padding : 0)}]`;
      }

      const fileParts = id !== false ? [plainId, ...messages] : messages;
      BotUtil.#writeLogToFile(level, fileParts.map(p => {
        if (typeof p === 'object') {
          try {
            return JSON.stringify(p);
          } catch {
            return String(p);
          }
        }
        return String(p);
      }));
    });

    return logMessage;
  }

  /**
   * Write log to file
   * @private
   * @param {string} level - Log level
   * @param {Array} logParts - Log message parts
   */
  static async #writeLogToFile(level, logParts) {
    try {
      const logDir = path.join(process.cwd(), "logs");
      await BotUtil.mkdir(logDir);

      const date = new Date();
      let logFile = path.join(logDir, `${date.toISOString().split("T")[0]}.log`);

      const maxFileSize = 10 * 1024 * 1024;
      const stat = await BotUtil.fsStat(logFile);
      if (stat && stat.size > maxFileSize) {
        logFile = path.join(logDir, `${date.toISOString().split("T")[0]}_${Date.now()}.log`);
      }

      const timestamp = date.toISOString();
      const cleanMessage = logParts.join(" ").replace(BotUtil.regexCache.controlChars, "");
      const fileLogMessage = `[${timestamp}] [${level.toUpperCase()}] ${cleanMessage}\n`;

      await fs.appendFile(logFile, fileLogMessage);
    } catch (error) {
      console.error("Log file write error:", error);
    }
  }

  /**
   * Get circular reference replacer for JSON.stringify
   * @returns {Function} Replacer function
   */
  static getCircularReplacer() {
    const seen = new WeakSet();

    return (key, value) => {
      if (value == null) return value;

      switch (typeof value) {
        case "function":
          return `[Function: ${value.name || "anonymous"}]`;
        case "bigint":
          return value.toString();
        case "object":
          if (seen.has(value)) return "[Circular]";
          seen.add(value);

          if (value instanceof Error) {
            return {
              name: value.name,
              message: value.message,
              stack: value.stack
            };
          }
          if (value instanceof Map) {
            return {
              dataType: "Map",
              value: Array.from(value.entries())
            };
          }
          if (value instanceof Set) {
            return {
              dataType: "Set",
              value: Array.from(value.values())
            };
          }
          if (Buffer.isBuffer(value)) {
            return BotUtil.StringOrBuffer(value, true);
          }
          break;
      }

      return value;
    };
  }

  // ========== File System Operations ==========

  /**
   * Get file stats
   * @param {string} filePath - File path
   * @returns {Promise<fs.Stats|false>} File stats or false if not exists
   */
  static async fsStat(filePath) {
    if (!filePath) return false;

    try {
      return await fs.stat(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        BotUtil.makeLog("trace", ["Get", filePath, "stat error", err.code || err.message]);
      }
      return false;
    }
  }

  /**
   * Create directory recursively
   * @param {string} dir - Directory path
   * @param {Object} [opts={recursive: true}] - Options
   * @returns {Promise<boolean>} Success status
   */
  static async mkdir(dir, opts = { recursive: true }) {
    if (!dir) return false;

    try {
      await fs.mkdir(dir, opts);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") return true;
      BotUtil.makeLog("error", ["Create", dir, "error", err.message]);
      return false;
    }
  }

  /**
   * Remove file or directory
   * @param {string} file - Path to remove
   * @returns {Promise<boolean>} Success status
   */
  static async rm(file) {
    if (!file) return false;

    try {
      await fs.rm(file, { force: true, recursive: true });
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return true;
      BotUtil.makeLog("error", ["Delete", file, "error", err.message]);
      return false;
    }
  }

  /**
   * Read file contents
   * @param {string} filePath - File path
   * @param {string} [encoding='utf8'] - File encoding
   * @returns {Promise<string|Buffer>} File contents
   * @throws {Error} If file path is empty
   */
  static async readFile(filePath, encoding = "utf8") {
    if (!filePath) throw new Error("File path is empty");
    return fs.readFile(filePath, encoding);
  }

  /**
   * Write data to file
   * @param {string} filePath - File path
   * @param {string|Buffer} data - Data to write
   * @param {Object} [opts={}] - Write options
   * @returns {Promise<void>}
   * @throws {Error} If file path is empty
   */
  static async writeFile(filePath, data, opts = {}) {
    if (!filePath) throw new Error("File path is empty");
    await BotUtil.mkdir(path.dirname(filePath));
    return fs.writeFile(filePath, data, opts);
  }

  /**
   * Check if file exists
   * @param {string} filePath - File path
   * @returns {Promise<boolean>} Existence status
   */
  static async fileExists(filePath) {
    if (!filePath) return false;

    try {
      await fs.access(filePath, fsSync.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Lazy load glob library
   * @private
   * @returns {Promise<Function>} Glob function
   * @throws {Error} If no glob library available
   */
  static async #getGlobLib() {
    if (!BotUtil.#globLib) {
      try {
        const { default: fastGlob } = await import('fast-glob');
        BotUtil.#globLib = fastGlob;
      } catch {
        try {
          const { glob } = await import('glob');
          BotUtil.#globLib = glob;
        } catch {
          throw new Error("Unable to load glob library");
        }
      }
    }
    return BotUtil.#globLib;
  }

  /**
   * Find files matching pattern
   * @param {string} pattern - Glob pattern
   * @param {Object} [opts={}] - Glob options
   * @param {boolean} [opts.force=false] - Force glob even for non-patterns
   * @param {boolean} [opts.dot=true] - Include dotfiles
   * @param {boolean} [opts.absolute=false] - Return absolute paths
   * @param {string} [opts.cwd=process.cwd()] - Current working directory
   * @param {Array} [opts.ignore=[]] - Patterns to ignore
   * @param {boolean} [opts.onlyFiles=true] - Only match files
   * @returns {Promise<Array<string>>} Matched file paths
   */
  static async glob(pattern, opts = {}) {
    if (!pattern) return [];

    if (!opts.force && !BotUtil.regexCache.globPattern.test(pattern)) {
      const stat = await BotUtil.fsStat(pattern);
      return stat ? [pattern] : [];
    }

    try {
      const globFunc = await BotUtil.#getGlobLib();

      const globOptions = {
        dot: opts.dot !== false,
        absolute: opts.absolute === true,
        cwd: opts.cwd || process.cwd(),
        ignore: opts.ignore || [],
        onlyFiles: opts.onlyFiles !== false,
        ...opts
      };

      const files = await globFunc(pattern, globOptions);
      return Array.isArray(files) ? files : Array.from(files);
    } catch (err) {
      BotUtil.makeLog("error", ["Match", pattern, "error", err.message]);
      return [];
    }
  }

  // ========== Buffer and File Processing ==========

  /**
   * Convert data to Buffer
   * @param {*} data - Data to convert
   * @param {Object} [opts={}] - Options
   * @param {number} [opts.size] - Max buffer size before saving to file
   * @param {boolean} [opts.http] - Keep as URL if it's HTTP
   * @param {boolean} [opts.file] - Keep as file path
   * @param {number} [opts.timeout=30000] - Fetch timeout
   * @param {Object} [opts.fetchOptions] - Additional fetch options
   * @returns {Promise<Buffer|string>} Buffer or file/data URL
   */
  static async Buffer(data, opts = {}) {
    if (Buffer.isBuffer(data)) {
      return opts.size && data.length > opts.size ?
        await BotUtil.#saveBufferToTempFile(data) : data;
    }

    const dataStr = String(data);

    // Handle base64
    if (dataStr.startsWith("base64://")) {
      try {
        const buffer = Buffer.from(dataStr.slice(9), "base64");
        return opts.size && buffer.length > opts.size ?
          await BotUtil.#saveBufferToTempFile(buffer) : buffer;
      } catch {
        return Buffer.alloc(0);
      }
    }

    // Handle URL
    if (BotUtil.regexCache.url.test(dataStr)) {
      if (opts.http) return dataStr;

      try {
        const response = await fetch(dataStr, {
          signal: AbortSignal.timeout(opts.timeout || 30000),
          ...opts.fetchOptions
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        return opts.size && buffer.length > opts.size ?
          await BotUtil.#saveBufferToTempFile(buffer) : buffer;
      } catch (err) {
        BotUtil.makeLog("error", ["Fetch URL content error", dataStr, err.message]);
        return Buffer.alloc(0);
      }
    }

    // Handle file path
    const filePath = dataStr.replace(/^file:\/\//, "");
    const stat = await BotUtil.fsStat(filePath);
    if (stat) {
      if (opts.file) return `file://${path.resolve(filePath)}`;

      try {
        const buffer = await fs.readFile(filePath);
        return opts.size && buffer.length > opts.size ?
          `file://${path.resolve(filePath)}` : buffer;
      } catch {
        return Buffer.alloc(0);
      }
    }

    return Buffer.from(dataStr);
  }

  /**
   * Save buffer to temporary file
   * @private
   * @param {Buffer} buffer - Buffer to save
   * @returns {Promise<string>} File URL or data URL
   */
  static async #saveBufferToTempFile(buffer) {
    const tempDir = path.join(process.cwd(), "temp");

    try {
      await BotUtil.mkdir(tempDir);
      const filename = ulid();
      const filePath = path.join(tempDir, filename);
      await fs.writeFile(filePath, buffer);

      setTimeout(() => BotUtil.rm(filePath).catch(() => { }), 60000);

      return `file://${path.resolve(filePath)}`;
    } catch {
      return `data:application/octet-stream;base64,${buffer.toString('base64')}`;
    }
  }

  /**
   * Detect file type from buffer
   * @param {Object} data - File data object
   * @param {string} [data.name] - File name
   * @param {string|Buffer} data.file - File content
   * @param {Object} [opts={}] - Options
   * @param {number} [opts.size] - Max size limit
   * @returns {Promise<Object>} File type info
   */
  static async fileType(data, opts = {}) {
    if (!data) return {
      name: "unknown",
      type: { ext: "unknown" },
      md5: "",
      url: "",
      buffer: null
    };

    const file = {
      name: data.name || "",
      url: "",
      buffer: null,
      type: { ext: "unknown" },
      md5: ""
    };

    try {
      if (Buffer.isBuffer(data.file)) {
        file.url = data.name || "Buffer";
        file.buffer = data.file;
      } else if (typeof data.file === 'string') {
        file.url = data.file.replace(/^base64:\/\/.*/, "base64://...");
        file.buffer = await BotUtil.Buffer(data.file, { ...opts, size: undefined });
      }

      if (Buffer.isBuffer(file.buffer) && file.buffer.length > 0) {
        const fileTypeResult = await fileTypeFromBuffer(file.buffer).catch(() => null);
        if (fileTypeResult) {
          file.type = fileTypeResult;
        } else {
          const ext = path.extname(file.url).slice(1);
          file.type = { ext: ext || "unknown" };
        }

        file.md5 = md5(file.buffer);
        file.name = file.name || `${Date.now().toString(36)}.${file.md5.slice(0, 8)}.${file.type.ext}`;

        if (opts.size && file.buffer.length > opts.size) {
          file.buffer = await BotUtil.Buffer(data.file, opts);
        }
      }
    } catch (err) {
      BotUtil.makeLog("error", ["File type detection error", err.message]);
    }

    file.name = file.name || `${Date.now().toString(36)}-unknown`;
    return file;
  }

  /**
   * Convert file to accessible URL
   * @param {string|Buffer} file - File to convert
   * @param {Object} [opts={}] - Options
   * @param {string} [opts.name] - File name
   * @param {boolean} [opts.returnPath] - Return path and URL
   * @param {string} [opts.baseUrl] - Base URL for serving
   * @param {Object} [opts.fetchOptions] - Fetch options
   * @returns {Promise<string|Object>} URL or URL with path
   * @throws {Error} If conversion fails
   */
  static async fileToUrl(file, opts = {}) {
    const options = {
      name: opts.name || null,
      time: (cfg.bot?.file_to_url_time || 10) * 60000,
      times: cfg.bot?.file_to_url_times || 1,
      returnPath: opts.returnPath === true,
      baseUrl: opts.baseUrl,
      fetchOptions: opts.fetchOptions
    };

    try {
      const mediaDir = path.join(process.cwd(), "www/media");
      await BotUtil.mkdir(mediaDir);

      let fileBuffer;
      let fileName = options.name || ulid();

      if (Buffer.isBuffer(file)) {
        fileBuffer = file;
      } else if (typeof file === "string") {
        if (file.startsWith("base64://")) {
          fileBuffer = Buffer.from(file.slice(9), "base64");
        } else if (BotUtil.regexCache.url.test(file)) {
          const response = await fetch(file, {
            signal: AbortSignal.timeout(30000),
            ...options.fetchOptions
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          fileBuffer = Buffer.from(await response.arrayBuffer());

          const contentType = response.headers.get('content-type')?.split(';')[0];
          const ext = contentType ? BotUtil.mimeToExtMap.get(contentType) : '';
          fileName = options.name || path.basename(file) || `${ulid()}${ext || '.file'}`;
        } else if (await BotUtil.fileExists(file)) {
          fileBuffer = await fs.readFile(file);
          fileName = options.name || path.basename(file);
        } else {
          throw new Error(`Invalid file path: ${file}`);
        }
      } else {
        throw new Error("Unsupported file type");
      }

      if (!fileBuffer || fileBuffer.length === 0) {
        throw new Error("Failed to get file data");
      }

      if (!path.extname(fileName)) {
        try {
          const fileType = await fileTypeFromBuffer(fileBuffer);
          fileName += `.${fileType?.ext || 'file'}`;
        } catch {
          fileName += '.file';
        }
      }

      const finalFileName = `${ulid()}_${fileName}`;
      const destPath = path.join(mediaDir, finalFileName);

      await fs.writeFile(destPath, fileBuffer);

      setTimeout(() => BotUtil.rm(destPath).catch(() => { }), options.time);

      const baseUrl = options.baseUrl || cfg.server?.server?.url || `http://localhost:${cfg.server?.server?.port || 8086}`;
      const url = `${baseUrl}/media/${finalFileName}`;

      if (options.returnPath) {
        return { url, path: path.resolve(destPath), name: finalFileName };
      }

      return url;
    } catch (err) {
      BotUtil.makeLog("error", ["File to URL error", err.message]);
      throw err;
    }
  }

  // ========== Utility Functions ==========

  /**
   * Execute system command
   * @param {string|Array} cmd - Command to execute
   * @param {Object} [opts={}] - Execution options
   * @param {boolean} [opts.quiet=false] - Suppress logs
   * @param {number} [opts.timeout=60000] - Timeout in milliseconds
   * @returns {Promise<Object>} Execution result
   */
  static async exec(cmd, opts = {}) {
    if (!cmd) return { error: new Error("Command is empty"), stdout: "", stderr: "" };

    const cmdStr = String(cmd);
    const startTime = Date.now();

    BotUtil.makeLog(opts.quiet ? "debug" : "mark", cmdStr, "Command");

    return new Promise((resolve) => {
      const execOpts = {
        encoding: "buffer",
        maxBuffer: 10 * 1024 * 1024,
        timeout: opts.timeout || 60000,
        windowsHide: true,
        ...opts
      };

      const callback = (error, stdout, stderr) => {
        const raw = { stdout, stderr };
        const stdoutStr = stdout?.toString() || "";
        const stderrStr = stderr?.toString() || "";
        const duration = BotUtil.getTimeDiff(startTime);

        const result = {
          error,
          stdout: stdoutStr.trim(),
          stderr: stderrStr.trim(),
          raw,
          duration
        };

        if (!opts.quiet) {
          let logMessage = `${cmdStr} [Complete ${duration}]`;
          if (result.stdout) logMessage += `\n${result.stdout}`;
          if (result.stderr) logMessage += `\n${result.stderr}`;
          BotUtil.makeLog("mark", logMessage, "Command");
        }

        if (error && !opts.quiet) {
          BotUtil.makeLog("error", error, "Command");
        }

        resolve(result);
      };

      if (Array.isArray(cmd)) {
        execFile(cmd[0], cmd.slice(1), execOpts, callback);
      } else {
        execCallback(cmd, execOpts, callback);
      }
    });
  }

  /**
   * Sleep/delay execution
   * @param {number} time - Delay in milliseconds
   * @param {Promise} [promise] - Optional promise to race with
   * @returns {Promise<*>} Timeout symbol or promise result
   */
  static sleep(time, promise) {
    if (!time || time <= 0) return Promise.resolve(Symbol("timeout"));

    const sleepPromise = new Promise(resolve =>
      setTimeout(() => resolve(Symbol("timeout")), time)
    );

    return promise instanceof Promise ?
      Promise.race([promise, sleepPromise]) : sleepPromise;
  }

  /**
   * Wait for event from EventEmitter
   * @param {EventEmitter} emitter - Event emitter
   * @param {string} event - Event name to wait for
   * @param {string} [errorEvent] - Error event name
   * @param {number} [timeout] - Timeout in milliseconds
   * @returns {Promise<Array>} Event arguments
   * @throws {Error} On error or timeout
   */
  static promiseEvent(emitter, event, errorEvent, timeout) {
    if (!emitter || !event) {
      return Promise.reject(new Error("Invalid arguments"));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId;

      const cleanup = () => {
        emitter.off(event, onSuccess);
        if (errorEvent) emitter.off(errorEvent, onError);
        if (timeoutId) clearTimeout(timeoutId);
      };

      const onSuccess = (...args) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(args);
      };

      const onError = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err || new Error(`${errorEvent} event triggered`));
      };

      emitter.once(event, onSuccess);
      if (errorEvent) emitter.once(errorEvent, onError);

      if (timeout && timeout > 0) {
        timeoutId = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`Wait for event ${event} timeout`));
        }, timeout);
      }
    });
  }

  /**
   * Get formatted time difference
   * @param {number} [time1=Date.now()] - Start time
   * @param {number} [time2=Date.now()] - End time
   * @returns {string} Formatted time difference
   */
  static getTimeDiff(time1 = Date.now(), time2 = Date.now()) {
    const totalSeconds = Math.abs(time2 - time1) / 1000;

    if (totalSeconds < 0.1) {
      return `${Math.round(Math.abs(time2 - time1))}ms`;
    }

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = (totalSeconds % 60).toFixed(3);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (parseFloat(seconds) > 0 || parts.length === 0) parts.push(`${seconds}s`);

    return parts.join(" ");
  }

  /**
   * Format file size to human readable
   * @param {number} bytes - File size in bytes
   * @param {number} [decimals=2] - Decimal places
   * @returns {string} Formatted size
   */
  static formatFileSize(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  /**
   * Format date to string
   * @param {Date|string|number} [date=new Date()] - Date to format
   * @param {string} [format='YYYY-MM-DD HH:mm:ss'] - Format pattern
   * @returns {string} Formatted date string
   */
  static formatDate(date = new Date(), format = "YYYY-MM-DD HH:mm:ss") {
    try {
      const d = date instanceof Date ? date : new Date(date);

      if (isNaN(d.getTime())) throw new Error("Invalid date");

      return format
        .replace(/YYYY/g, d.getFullYear())
        .replace(/MM/g, String(d.getMonth() + 1).padStart(2, "0"))
        .replace(/DD/g, String(d.getDate()).padStart(2, "0"))
        .replace(/HH/g, String(d.getHours()).padStart(2, "0"))
        .replace(/mm/g, String(d.getMinutes()).padStart(2, "0"))
        .replace(/ss/g, String(d.getSeconds()).padStart(2, "0"));
    } catch {
      return String(date);
    }
  }

  /**
   * Deep clone object
   * @param {*} obj - Object to clone
   * @param {WeakMap} [cache=new WeakMap()] - Cache for circular references
   * @returns {*} Cloned object
   */
  static deepClone(obj, cache = new WeakMap()) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (obj instanceof Date) return new Date(obj);
    if (obj instanceof Array) return obj.map(item => BotUtil.deepClone(item, cache));
    if (obj instanceof RegExp) return new RegExp(obj);
    if (obj instanceof Map) {
      const cloned = new Map();
      obj.forEach((value, key) => {
        cloned.set(key, BotUtil.deepClone(value, cache));
      });
      return cloned;
    }
    if (obj instanceof Set) {
      const cloned = new Set();
      obj.forEach(value => {
        cloned.add(BotUtil.deepClone(value, cache));
      });
      return cloned;
    }

    if (cache.has(obj)) return cache.get(obj);

    const clonedObj = Object.create(Object.getPrototypeOf(obj));
    cache.set(obj, clonedObj);

    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        clonedObj[key] = BotUtil.deepClone(obj[key], cache);
      }
    }

    return clonedObj;
  }

  /**
   * Deep merge objects
   * @param {Object} target - Target object
   * @param {...Object} sources - Source objects
   * @returns {Object} Merged object
   */
  static deepMerge(target, ...sources) {
    if (!sources.length) return target;

    const source = sources.shift();

    if (BotUtil.isObject(target) && BotUtil.isObject(source)) {
      for (const key in source) {
        if (BotUtil.isObject(source[key])) {
          if (!target[key]) Object.assign(target, { [key]: {} });
          BotUtil.deepMerge(target[key], source[key]);
        } else {
          Object.assign(target, { [key]: source[key] });
        }
      }
    }

    return BotUtil.deepMerge(target, ...sources);
  }

  /**
   * Check if value is plain object
   * @param {*} item - Value to check
   * @returns {boolean} Is plain object
   */
  static isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  }

  /**
   * Throttle function calls
   * @param {Function} func - Function to throttle
   * @param {number} [limit=1000] - Throttle limit in milliseconds
   * @returns {Function} Throttled function
   */
  static throttle(func, limit = 1000) {
    let inThrottle;
    let lastFunc;
    let lastRan;

    return function (...args) {
      const context = this;

      if (!inThrottle) {
        func.apply(context, args);
        lastRan = Date.now();
        inThrottle = true;

        setTimeout(() => {
          inThrottle = false;
          if (lastFunc) {
            lastFunc();
            lastFunc = null;
          }
        }, limit);
      } else {
        clearTimeout(lastFunc);
        lastFunc = setTimeout(() => {
          if (Date.now() - lastRan >= limit) {
            func.apply(context, args);
            lastRan = Date.now();
          }
        }, Math.max(limit - (Date.now() - lastRan), 0));
      }
    };
  }

  /**
   * Debounce function calls
   * @param {Function} func - Function to debounce
   * @param {number} [delay=5000] - Debounce delay in milliseconds
   * @returns {Function} Debounced function with cancel method
   * @throws {TypeError} If func is not a function
   */
  static debounce(func, delay = 5000) {
    if (typeof func !== 'function') {
      throw new TypeError('First argument must be a function');
    }

    const stateMap = new WeakMap();

    function debounced(...args) {
      const context = this || {};

      let state = stateMap.get(context);
      if (!state) {
        state = {};
        stateMap.set(context, state);
      }

      if (state.promise && !state.started) {
        clearTimeout(state.timeout);
      } else if (!state.promise) {
        state.promise = new Promise((resolve, reject) => {
          state.resolve = resolve;
          state.reject = reject;
        });
      }

      state.timeout = setTimeout(async () => {
        try {
          state.started = true;
          const result = await func.apply(context, args);
          state.resolve(result);
        } catch (err) {
          state.reject(err);
        } finally {
          stateMap.delete(context);
        }
      }, delay);

      return state.promise;
    }

    debounced.cancel = function (context) {
      const ctx = context || this;
      const state = stateMap.get(ctx);
      if (state?.timeout) {
        clearTimeout(state.timeout);
        if (state.resolve) state.resolve(null);
        stateMap.delete(ctx);
      }
    };

    return debounced;
  }

  /**
   * Retry function execution
   * @param {Function} func - Function to retry
   * @param {Object} [options={}] - Retry options
   * @param {number} [options.times=3] - Number of retries
   * @param {number} [options.delay=1000] - Delay between retries
   * @param {boolean} [options.exponential=false] - Use exponential backoff
   * @param {Function} [options.onRetry] - Callback on retry
   * @returns {Promise<*>} Function result
   * @throws {Error} Last error if all retries fail
   */
  static async retry(func, options = {}) {
    const {
      times = 3,
      delay = 1000,
      exponential = false,
      onRetry = null
    } = options;

    let lastError;

    for (let i = 0; i < times; i++) {
      try {
        return await func();
      } catch (error) {
        lastError = error;

        if (i < times - 1) {
          if (onRetry) onRetry(error, i + 1);

          const waitTime = exponential ? delay * Math.pow(2, i) : delay;
          await BotUtil.sleep(waitTime);
        }
      }
    }

    throw lastError;
  }

  /**
   * Process items in batches
   * @param {Array} items - Items to process
   * @param {Function} handler - Handler function for each item
   * @param {Object} [options={}] - Batch options
   * @param {number} [options.size=10] - Batch size
   * @param {number} [options.concurrency=1] - Concurrent batches
   * @param {Function} [options.onProgress] - Progress callback
   * @returns {Promise<Array>} Processed results
   */
  static async batch(items, handler, options = {}) {
    const {
      size = 10,
      concurrency = 1,
      onProgress = null
    } = options;

    const results = [];
    const batches = [];

    for (let i = 0; i < items.length; i += size) {
      batches.push(items.slice(i, i + size));
    }

    for (let i = 0; i < batches.length; i += concurrency) {
      const batchGroup = batches.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batchGroup.map(batch =>
          Promise.all(batch.map(item => handler(item)))
        )
      );

      results.push(...batchResults.flat());

      if (onProgress) {
        onProgress({
          processed: Math.min((i + concurrency) * size, items.length),
          total: items.length,
          percentage: Math.min(((i + concurrency) * size / items.length) * 100, 100)
        });
      }
    }

    return results;
  }

  // ========== Message Processing ==========

  /**
   * Extract text content from message
   * @param {string|Array|Object} message - Message to extract from
   * @returns {string} Extracted text content
   */
  static extractTextContent(message) {
    if (!message) return "";

    if (typeof message === "string") return message.trim();

    if (Array.isArray(message)) {
      return message
        .filter(m => m && (m.type === "text" || typeof m.text === "string"))
        .map(m => m.text || "")
        .join("")
        .trim();
    }

    if (typeof message === "object") {
      if (message.text) return String(message.text).trim();
      if (typeof message.message === "string") return message.message.trim();
      if (Array.isArray(message.message)) return BotUtil.extractTextContent(message.message);
    }

    return "";
  }

  /**
   * Create chat record
   * @param {Object} e - Event object
   * @param {Array} messages - Message array
   * @param {string} title - Record title
   * @param {string|Array} [description=['Bot message']] - Description
   * @returns {Promise<boolean>} Success status
   */
  static async makeChatRecord(e, messages, title, description = ["Bot message"]) {
    if (!e) return false;

    messages = Array.isArray(messages) ? messages : (messages ? [messages] : []);
    if (messages.length === 0) return false;

    try {
      const adapterName = e.adapter_name?.toUpperCase() || e.platform?.toUpperCase() || '';

      if (adapterName === "ICQQ") {
        const bot = e.bot || {};
        const nickname = bot.nickname || "Bot";
        const user_id = bot.uin || 0;
        const currentTime = Math.floor(Date.now() / 1000);

        const formatMessages = messages.map((msg, idx) => ({
          message: msg,
          nickname,
          user_id,
          time: currentTime + idx + 1,
        }));

        return await BotUtil.makeMsg(e, formatMessages, title, description);
      } else if (common?.makeForwardMsg) {
        const forwardMsg = await common.makeForwardMsg(e, messages, title);
        await e.reply(forwardMsg);
        return true;
      } else {
        return await BotUtil.makeMsg(e, messages, title, description);
      }
    } catch (err) {
      BotUtil.makeLog("error", ["Make chat record error", err.message]);
      try {
        const simpleMessage = typeof messages[0] === 'string' ? messages[0] : '[Complex message]';
        await e.reply(`${title || 'Message'}: ${simpleMessage}${messages.length > 1 ? ' (and more)' : ''}`);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Make forward message
   * @param {Object} e - Event object
   * @param {Array} messages - Message array
   * @param {string} title - Message title
   * @param {string} description - Message description
   * @returns {Promise<boolean>} Success status
   */
  static async makeMsg(e, messages, title, description) {
    if (!e) return false;

    messages = Array.isArray(messages) ? messages : (messages ? [messages] : []);
    if (messages.length === 0) return false;

    try {
      const summary = await fetch("https://v1.hitokoto.cn", {
        signal: AbortSignal.timeout(5000)
      })
        .then(res => res.ok ? res.json() : null)
        .then(data => data?.hitokoto?.replace(/。/g, "+") || null)
        .catch(() => null);

      const finalSummary = summary || moment().format("HH:mm:ss.SSS.");

      const rawObj = e.group?.makeForwardMsg ? e.group :
        e.friend?.makeForwardMsg ? e.friend :
          e.makeForwardMsg ? e : null;

      if (!rawObj) throw new Error("Cannot find makeForwardMsg method");

      const ngm = await rawObj.makeForwardMsg(messages);

      if (ngm?.data?.meta) {
        if (!ngm.data.meta.detail) ngm.data.meta.detail = {};
        Object.assign(ngm.data.meta.detail, {
          news: [{ text: description || title || 'View details' }],
          source: title || 'Forward message',
          summary: finalSummary
        });

        if (ngm.data.prompt) {
          ngm.data.prompt = title || 'Forward message';
        }
      }

      await e.reply(ngm);
      BotUtil.makeLog("mark", `『${title || 'Forward message'}』sent`);
      return true;

    } catch (error) {
      BotUtil.makeLog("error", ["Forward message error", error.message]);

      try {
        const firstMsg = Array.isArray(messages[0]) ? messages[0].join("\n") :
          typeof messages[0] === 'object' ?
            (messages[0].message || messages[0].content || JSON.stringify(messages[0])) :
            String(messages[0]);

        await e.reply(`${title ? `【${title}】\n` : ''}${firstMsg}${messages.length > 1 ? '\n(Message too long, omitted)' : ''}`);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Parse JSON safely
   * @param {string} str - JSON string
   * @param {*} [defaultValue={}] - Default value on parse failure
   * @returns {*} Parsed value or default
   */
  static parseJSON(str, defaultValue = {}) {
    if (!str || typeof str !== 'string') return defaultValue;

    try {
      return JSON.parse(str);
    } catch {
      return defaultValue;
    }
  }
}

// Export compatibility functions
export async function makemsg(e, messages, title, description) {
  return BotUtil.makeMsg(e, messages, title, description);
}

export async function 制作聊天记录(e, messages, title, description) {
  return BotUtil.makeChatRecord(e, messages, title, description);
}