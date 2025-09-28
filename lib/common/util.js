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
 * Bot工具类 - 提供各种实用函数
 * @class BotUtil
 */
export default class BotUtil {
  /**
   * API密钥存储
   * @static
   * @type {string}
   */
  static apiKey = '';

  /**
   * 正则表达式缓存
   * @static
   * @type {Object}
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
   * MIME类型到扩展名映射
   * @static
   * @type {Map}
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
   * 全局Map存储
   * @static
   * @private
   * @type {Map}
   */
  static #globalMaps = new Map();

  /**
   * 内存缓存
   * @static
   * @private
   * @type {Map}
   */
  static #memoryCache = new Map();

  /**
   * Glob库实例
   * @static
   * @private
   * @type {Function|null}
   */
  static #globLib = null;

  // 定时清理过期缓存
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

  // ========== Map管理 ==========

  /**
   * 获取或创建Map对象
   * @static
   * @param {string} name - Map名称
   * @param {Object} options - 配置选项
   * @returns {Map} 扩展的Map对象
   */
  static getMap(name = 'default', options = {}) {
    if (!BotUtil.#globalMaps.has(name)) {
      BotUtil.#globalMaps.set(name, BotUtil.#createExtendedMap(options));
    }
    return BotUtil.#globalMaps.get(name);
  }

  /**
   * 创建扩展Map
   * @static
   * @private
   * @param {Object} options - 配置选项
   * @returns {Map} 扩展的Map对象
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

    // 重写set方法
    const originalSet = map.set.bind(map);
    map.set = function(key, value) {
      // 检查容量限制
      if (this.size >= maxSize && !this.has(key)) {
        const firstKey = this.keys().next().value;
        if (onEvict) onEvict(firstKey, this.get(firstKey));
        this.delete(firstKey);
        this._metadata.delete(firstKey);
      }

      originalSet(key, value);

      // 设置TTL元数据
      if (ttl > 0) {
        this._metadata.set(key, {
          createdAt: Date.now(),
          ttl: ttl
        });
      }

      return this;
    };

    // 重写get方法
    const originalGet = map.get.bind(map);
    map.get = function(key) {
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

    // 批量操作
    map.setMany = function(entries) {
      for (const [key, value] of entries) {
        this.set(key, value);
      }
      return this;
    };

    map.getMany = function(keys) {
      const result = new Map();
      for (const key of keys) {
        const value = this.get(key);
        if (value !== undefined) result.set(key, value);
      }
      return result;
    };

    // 清理过期项
    map.cleanExpired = function() {
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

    // 销毁Map
    map.destroy = function() {
      if (this._cleanInterval) {
        clearInterval(this._cleanInterval);
      }
      this.clear();
      this._metadata.clear();
    };

    // 自动清理
    if (autoClean && ttl > 0) {
      map._cleanInterval = setInterval(() => {
        map.cleanExpired();
      }, cleanInterval);
    }

    return map;
  }

  /**
   * 删除Map
   * @static
   * @param {string} name - Map名称
   * @returns {boolean} 是否成功
   */
  static deleteMap(name) {
    const map = BotUtil.#globalMaps.get(name);
    if (map) {
      if (typeof map.destroy === 'function') map.destroy();
      return BotUtil.#globalMaps.delete(name);
    }
    return false;
  }

  // ========== 缓存管理 ==========

  /**
   * 内存缓存操作
   * @static
   * @param {string} key - 缓存键
   * @param {any} [value] - 缓存值
   * @param {number} [ttl=0] - 生存时间（毫秒）
   * @returns {any} 缓存值
   */
  static cache(key, value, ttl = 0) {
    if (value === undefined) {
      // 获取缓存
      const cached = BotUtil.#memoryCache.get(key);
      if (cached) {
        if (cached.ttl === 0 || Date.now() < cached.expireAt) {
          return cached.value;
        }
        BotUtil.#memoryCache.delete(key);
      }
      return undefined;
    }

    // 设置缓存
    BotUtil.#memoryCache.set(key, {
      value,
      ttl,
      expireAt: ttl > 0 ? Date.now() + ttl : 0,
      createdAt: Date.now()
    });

    return value;
  }

  /**
   * 清除缓存
   * @static
   * @param {string|RegExp} [pattern] - 键或正则表达式
   * @returns {number} 删除的数量
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

  // ========== 字符串和数据处理 ==========

  /**
   * 生成UUID
   * @static
   * @param {string} [version='v4'] - UUID版本
   * @returns {string} UUID
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
   * 生成随机字符串
   * @static
   * @param {number} [length=10] - 长度
   * @param {string} [chars] - 字符集
   * @returns {string} 随机字符串
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
   * 计算哈希值
   * @static
   * @param {string|Buffer} data - 数据
   * @param {string} [algorithm='md5'] - 算法
   * @returns {string} 哈希值
   */
  static hash(data, algorithm = 'md5') {
    if (algorithm === 'md5') return md5(data);

    return crypto
      .createHash(algorithm)
      .update(data)
      .digest('hex');
  }

  /**
   * 将数据转换为字符串
   * @static
   * @param {any} data - 数据
   * @returns {string} 字符串
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
   * 将数据转换为字符串或Buffer
   * @static
   * @param {any} data - 数据
   * @param {boolean} [base64] - 是否使用base64
   * @returns {string|Buffer} 结果
   */
  static StringOrBuffer(data, base64) {
    if (!Buffer.isBuffer(data)) return String(data);

    const string = data.toString();
    if (string.includes("\ufffd") || /[\uD800-\uDFFF]/.test(string)) {
      return base64 ? `base64://${data.toString("base64")}` : data;
    }
    return string;
  }

  // ========== 日志管理 ==========

  /**
   * 创建日志ID
   * @static
   * @param {string} id - 日志ID
   * @returns {string} 格式化后的日志ID
   */
  static makeLogID(id) {
    const cacheKey = `logid_${id}`;
    const cached = BotUtil.cache(cacheKey);
    if (cached) return cached;

    if (!cfg.bot?.log_align) {
      const result = id ? String(id) : "";
      return BotUtil.cache(cacheKey, result, 60000);
    }

    const idStr = id ? String(id) : String(cfg.bot.log_align);
    const targetLength = cfg.bot.log_align.length;
    const currentLength = idStr.length;

    let result;
    if (currentLength === targetLength) {
      result = `[${idStr}]`;
    } else if (currentLength < targetLength) {
      const padding = targetLength - currentLength;
      const leftPad = Math.floor(padding / 2);
      const rightPad = Math.ceil(padding / 2);
      const paddedId = " ".repeat(leftPad) + idStr + " ".repeat(rightPad);
      result = `[${paddedId}]`;
    } else {
      const truncatedId = idStr.slice(0, targetLength - 1) + ".";
      result = `[${truncatedId}]`;
    }

    return BotUtil.cache(cacheKey, result, 60000);
  }

  /**
   * 创建并记录日志
   * @static
   * @param {string} [level='info'] - 日志级别
   * @param {string|Array} msg - 日志消息
   * @param {string} [id] - 日志ID
   * @param {boolean} [trace=false] - 是否记录堆栈
   * @returns {string} 日志消息
   */
  static makeLog(level = "info", msg, id, trace = false) {
    const validLevels = ["trace", "debug", "info", "warn", "error", "fatal", "mark", "success", "tip"];
    level = validLevels.includes(level) ? level : "info";

    // 检查日志级别
    const logLevel = cfg.bot?.log_level || "info";
    const levels = ["trace", "debug", "info", "warn", "error", "fatal"];
    if (levels.indexOf(level) < levels.indexOf(logLevel)) {
      BotUtil.#writeLogToFile(level, [msg]);
      return "";
    }

    // 格式化消息
    const formattedId = id !== false ? BotUtil.makeLogID(id !== undefined ? id : "") : "";
    const messages = Array.isArray(msg) ? msg : [msg];
    const logParts = formattedId ? [formattedId] : [];

    for (const item of messages) {
      if (item == null) {
        logParts.push(String(item));
      } else if (typeof item === "object") {
        try {
          logParts.push(JSON.stringify(item, BotUtil.getCircularReplacer()));
        } catch {
          logParts.push(String(item));
        }
      } else {
        logParts.push(item);
      }
    }

    // 截断过长日志
    let logMessage = logParts.join("");
    if (logMessage.length > 5000) {
      logMessage = `${logMessage.slice(0, 1000)}... [truncated ${logMessage.length} chars] ...${logMessage.slice(-1000)}`;
    }

    // 输出日志
    const logger = global.logger?.[level] ?? console[level] ?? console.log;
    logger(logMessage);

    if (trace && global.logger?.trace) {
      global.logger.trace(new Error().stack.split("\n").slice(2).join("\n"));
    }

    // 异步写入文件
    setImmediate(() => BotUtil.#writeLogToFile(level, logParts));

    return logMessage;
  }

  /**
   * 写入日志到文件
   * @static
   * @private
   * @async
   */
  static async #writeLogToFile(level, logParts) {
    try {
      const logDir = path.join(process.cwd(), "logs");
      await BotUtil.mkdir(logDir);

      const date = new Date();
      let logFile = path.join(logDir, `${date.toISOString().split("T")[0]}.log`);

      // 检查文件大小
      const maxFileSize = 10 * 1024 * 1024; // 10MB
      const stat = await BotUtil.fsStat(logFile);
      if (stat && stat.size > maxFileSize) {
        logFile = path.join(logDir, `${date.toISOString().split("T")[0]}_${Date.now()}.log`);
      }

      // 写入日志
      const timestamp = date.toISOString();
      const cleanMessage = logParts.join(" ").replace(BotUtil.regexCache.controlChars, "");
      const fileLogMessage = `[${timestamp}] [${level.toUpperCase()}] ${cleanMessage}\n`;

      await fs.appendFile(logFile, fileLogMessage);
    } catch (error) {
      console.error("日志文件写入错误:", error);
    }
  }

  /**
   * 获取循环引用处理器
   * @static
   * @returns {Function} 处理函数
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

  // ========== 文件系统操作 ==========

  /**
   * 获取文件状态
   * @static
   * @async
   * @param {string} filePath - 文件路径
   * @returns {Promise<fs.Stats|false>} 文件状态
   */
  static async fsStat(filePath) {
    if (!filePath) return false;

    try {
      return await fs.stat(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        BotUtil.makeLog("trace", ["获取", filePath, "状态错误", err.code || err.message]);
      }
      return false;
    }
  }

  /**
   * 创建目录
   * @static
   * @async
   * @param {string} dir - 目录路径
   * @param {Object} [opts] - 选项
   * @returns {Promise<boolean>} 是否成功
   */
  static async mkdir(dir, opts = { recursive: true }) {
    if (!dir) return false;

    try {
      await fs.mkdir(dir, opts);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") return true;
      BotUtil.makeLog("error", ["创建", dir, "错误", err.message]);
      return false;
    }
  }

  /**
   * 删除文件或目录
   * @static
   * @async
   * @param {string} file - 路径
   * @returns {Promise<boolean>} 是否成功
   */
  static async rm(file) {
    if (!file) return false;

    try {
      await fs.rm(file, { force: true, recursive: true });
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return true;
      BotUtil.makeLog("error", ["删除", file, "错误", err.message]);
      return false;
    }
  }

  /**
   * 读取文件
   * @static
   * @async
   * @param {string} filePath - 文件路径
   * @param {string} [encoding='utf8'] - 编码
   * @returns {Promise<string|Buffer>} 文件内容
   */
  static async readFile(filePath, encoding = "utf8") {
    if (!filePath) throw new Error("文件路径为空");
    return fs.readFile(filePath, encoding);
  }

  /**
   * 写入文件
   * @static
   * @async
   * @param {string} filePath - 文件路径
   * @param {string|Buffer} data - 数据
   * @param {Object} [opts] - 选项
   * @returns {Promise<void>}
   */
  static async writeFile(filePath, data, opts = {}) {
    if (!filePath) throw new Error("文件路径为空");
    await BotUtil.mkdir(path.dirname(filePath));
    return fs.writeFile(filePath, data, opts);
  }

  /**
   * 检查文件是否存在
   * @static
   * @async
   * @param {string} filePath - 文件路径
   * @returns {Promise<boolean>} 是否存在
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
   * 延迟加载glob库
   * @static
   * @private
   * @async
   * @returns {Promise<Function>} glob函数
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
          throw new Error("无法加载glob库");
        }
      }
    }
    return BotUtil.#globLib;
  }

  /**
   * 匹配文件
   * @static
   * @async
   * @param {string} pattern - 匹配模式
   * @param {Object} [opts] - 选项
   * @returns {Promise<Array<string>>} 匹配的文件
   */
  static async glob(pattern, opts = {}) {
    if (!pattern) return [];

    // 非glob模式直接检查
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
      BotUtil.makeLog("error", ["匹配", pattern, "错误", err.message]);
      return [];
    }
  }

  // ========== Buffer和文件处理 ==========

  /**
   * 将数据转换为Buffer
   * @static
   * @async
   * @param {any} data - 数据
   * @param {Object} [opts] - 选项
   * @returns {Promise<Buffer|string>} Buffer或文件路径
   */
  static async Buffer(data, opts = {}) {
    if (Buffer.isBuffer(data)) {
      return opts.size && data.length > opts.size ?
        await BotUtil.#saveBufferToTempFile(data) : data;
    }

    const dataStr = String(data);

    // 处理base64
    if (dataStr.startsWith("base64://")) {
      try {
        const buffer = Buffer.from(dataStr.slice(9), "base64");
        return opts.size && buffer.length > opts.size ?
          await BotUtil.#saveBufferToTempFile(buffer) : buffer;
      } catch {
        return Buffer.alloc(0);
      }
    }

    // 处理URL
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
        BotUtil.makeLog("error", ["获取URL内容错误", dataStr, err.message]);
        return Buffer.alloc(0);
      }
    }

    // 处理文件路径
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
   * 保存Buffer为临时文件
   * @static
   * @private
   * @async
   */
  static async #saveBufferToTempFile(buffer) {
    const tempDir = path.join(process.cwd(), "temp");

    try {
      await BotUtil.mkdir(tempDir);
      const filename = ulid();
      const filePath = path.join(tempDir, filename);
      await fs.writeFile(filePath, buffer);

      // 60秒后删除
      setTimeout(() => BotUtil.rm(filePath).catch(() => {}), 60000);

      return `file://${path.resolve(filePath)}`;
    } catch {
      return `data:application/octet-stream;base64,${buffer.toString('base64')}`;
    }
  }

  /**
   * 获取文件类型
   * @static
   * @async
   * @param {Object} data - 文件数据
   * @param {Object} [opts] - 选项
   * @returns {Promise<Object>} 文件类型信息
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
      BotUtil.makeLog("error", ["文件类型检测错误", err.message]);
    }

    file.name = file.name || `${Date.now().toString(36)}-unknown`;
    return file;
  }

  /**
   * 将文件转换为URL
   * @static
   * @async
   * @param {string|Buffer} file - 文件
   * @param {Object} [opts] - 选项
   * @returns {Promise<string|Object>} 文件URL
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

      // 处理不同类型的文件输入
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

          // 从Content-Type获取扩展名
          const contentType = response.headers.get('content-type')?.split(';')[0];
          const ext = contentType ? BotUtil.mimeToExtMap.get(contentType) : '';
          fileName = options.name || path.basename(file) || `${ulid()}${ext || '.file'}`;
        } else if (await BotUtil.fileExists(file)) {
          fileBuffer = await fs.readFile(file);
          fileName = options.name || path.basename(file);
        } else {
          throw new Error(`无效的文件路径: ${file}`);
        }
      } else {
        throw new Error("不支持的文件类型");
      }

      if (!fileBuffer || fileBuffer.length === 0) {
        throw new Error("获取文件数据失败");
      }

      // 确保文件名有扩展名
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

      // 定时删除
      setTimeout(() => BotUtil.rm(destPath).catch(() => {}), options.time);

      const baseUrl = options.baseUrl || cfg.server?.url || `http://localhost:${cfg.server?.port || 8086}`;
      const url = `${baseUrl}/media/${finalFileName}`;

      if (options.returnPath) {
        return { url, path: path.resolve(destPath), name: finalFileName };
      }

      return url;
    } catch (err) {
      BotUtil.makeLog("error", ["文件转URL错误", err.message]);
      throw err;
    }
  }

  // ========== 实用工具 ==========

  /**
   * 执行命令
   * @static
   * @async
   * @param {string|Array} cmd - 命令
   * @param {Object} [opts] - 选项
   * @returns {Promise<Object>} 执行结果
   */
  static async exec(cmd, opts = {}) {
    if (!cmd) return { error: new Error("命令为空"), stdout: "", stderr: "" };

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
          let logMessage = `${cmdStr} [完成${duration}]`;
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
   * 睡眠延迟
   * @static
   * @param {number} time - 延迟时间（毫秒）
   * @param {Promise} [promise] - Promise对象
   * @returns {Promise} Promise
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
   * 等待事件
   * @static
   * @param {EventEmitter} emitter - 事件发射器
   * @param {string} event - 事件名
   * @param {string} [errorEvent] - 错误事件名
   * @param {number} [timeout] - 超时时间
   * @returns {Promise<Array>} 事件参数
   */
  static promiseEvent(emitter, event, errorEvent, timeout) {
    if (!emitter || !event) {
      return Promise.reject(new Error("无效的参数"));
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
        reject(err || new Error(`${errorEvent} 事件触发`));
      };

      emitter.once(event, onSuccess);
      if (errorEvent) emitter.once(errorEvent, onError);

      if (timeout && timeout > 0) {
        timeoutId = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`等待事件 ${event} 超时`));
        }, timeout);
      }
    });
  }

  /**
   * 获取时间差
   * @static
   * @param {number} [time1] - 开始时间
   * @param {number} [time2] - 结束时间
   * @returns {string} 时间差描述
   */
  static getTimeDiff(time1 = Date.now(), time2 = Date.now()) {
    const totalSeconds = Math.abs(time2 - time1) / 1000;

    if (totalSeconds < 0.1) {
      return `${Math.round(Math.abs(time2 - time1))}毫秒`;
    }

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = (totalSeconds % 60).toFixed(3);

    const parts = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}时`);
    if (minutes > 0) parts.push(`${minutes}分`);
    if (parseFloat(seconds) > 0 || parts.length === 0) parts.push(`${seconds}秒`);

    return parts.join("");
  }

  /**
   * 格式化文件大小
   * @static
   * @param {number} bytes - 字节数
   * @param {number} [decimals=2] - 小数位数
   * @returns {string} 格式化后的大小
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
   * 格式化日期
   * @static
   * @param {Date|string|number} [date] - 日期
   * @param {string} [format] - 格式
   * @returns {string} 格式化后的日期
   */
  static formatDate(date = new Date(), format = "YYYY-MM-DD HH:mm:ss") {
    try {
      const d = date instanceof Date ? date : new Date(date);

      if (isNaN(d.getTime())) throw new Error("无效的日期");

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
   * 深度克隆对象
   * @static
   * @param {any} obj - 要克隆的对象
   * @param {WeakMap} [cache] - 缓存
   * @returns {any} 克隆后的对象
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
   * 深度合并对象
   * @static
   * @param {Object} target - 目标对象
   * @param {...Object} sources - 源对象
   * @returns {Object} 合并后的对象
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
   * 判断是否为对象
   * @static
   * @param {any} item - 要判断的项
   * @returns {boolean} 是否为对象
   */
  static isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  }

  /**
   * 节流函数
   * @static
   * @param {Function} func - 要节流的函数
   * @param {number} [limit=1000] - 时间限制
   * @returns {Function} 节流后的函数
   */
  static throttle(func, limit = 1000) {
    let inThrottle;
    let lastFunc;
    let lastRan;

    return function(...args) {
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
   * 防抖函数
   * @static
   * @param {Function} func - 要防抖的函数
   * @param {number} [time=5000] - 延迟时间
   * @returns {Function} 防抖后的函数
   */
  static debounce(func, time = 5000) {
    if (typeof func !== 'function') {
      throw new TypeError('第一个参数必须是函数');
    }

    const stateMap = new WeakMap();

    function debounced(...args) {
      const context = this || {};
      const delay = time;

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
   * 重试函数
   * @static
   * @async
   * @param {Function} func - 要重试的函数
   * @param {Object} [options] - 选项
   * @returns {Promise<any>} 执行结果
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
   * 批量处理
   * @static
   * @async
   * @param {Array} items - 要处理的项
   * @param {Function} handler - 处理函数
   * @param {Object} [options] - 选项
   * @returns {Promise<Array>} 处理结果
   */
  static async batch(items, handler, options = {}) {
    const {
      size = 10,
      concurrency = 1,
      onProgress = null
    } = options;

    const results = [];
    const batches = [];

    // 分批
    for (let i = 0; i < items.length; i += size) {
      batches.push(items.slice(i, i + size));
    }

    // 处理批次
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

  // ========== 消息处理 ==========

  /**
   * 提取文本内容
   * @static
   * @param {string|Array|Object} message - 消息
   * @returns {string} 文本内容
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
   * 制作聊天记录
   * @static
   * @async
   * @param {Object} e - 事件对象
   * @param {Array} messages - 消息数组
   * @param {string} title - 标题
   * @param {string|Array} [description] - 描述
   * @returns {Promise<boolean>} 是否成功
   */
  static async makeChatRecord(e, messages, title, description = ["葵崽驾到，通通闪开"]) {
    if (!e) return false;

    messages = Array.isArray(messages) ? messages : (messages ? [messages] : []);
    if (messages.length === 0) return false;

    try {
      const adapterName = e.adapter_name?.toUpperCase() || e.platform?.toUpperCase() || '';

      if (adapterName === "ICQQ") {
        const bot = e.bot || {};
        const nickname = bot.nickname || "机器人";
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
      BotUtil.makeLog("error", ["制作聊天记录错误", err.message]);
      try {
        const simpleMessage = typeof messages[0] === 'string' ? messages[0] : '[复杂消息]';
        await e.reply(`${title || '消息'}: ${simpleMessage}${messages.length > 1 ? ' (等多条消息)' : ''}`);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * 转发消息
   * @static
   * @async
   * @param {Object} e - 事件对象
   * @param {Array} messages - 消息数组
   * @param {string} title - 标题
   * @param {string} description - 描述
   * @returns {Promise<boolean>} 是否成功
   */
  static async makeMsg(e, messages, title, description) {
    if (!e) return false;

    messages = Array.isArray(messages) ? messages : (messages ? [messages] : []);
    if (messages.length === 0) return false;

    try {
      // 获取一言
      const summary = await fetch("https://v1.hitokoto.cn", {
        signal: AbortSignal.timeout(5000)
      })
        .then(res => res.ok ? res.json() : null)
        .then(data => data?.hitokoto?.replace(/。/g, "+") || null)
        .catch(() => null);

      const finalSummary = summary || moment().format("HH:mm:ss.SSS.");

      // 查找makeForwardMsg方法
      const rawObj = e.group?.makeForwardMsg ? e.group :
        e.friend?.makeForwardMsg ? e.friend :
          e.makeForwardMsg ? e : null;

      if (!rawObj) throw new Error("找不到makeForwardMsg方法");

      // 创建转发消息
      const ngm = await rawObj.makeForwardMsg(messages);

      // 设置元数据
      if (ngm?.data?.meta) {
        if (!ngm.data.meta.detail) ngm.data.meta.detail = {};
        Object.assign(ngm.data.meta.detail, {
          news: [{ text: description || title || '查看详情' }],
          source: title || '转发消息',
          summary: finalSummary
        });

        if (ngm.data.prompt) {
          ngm.data.prompt = title || '转发消息';
        }
      }

      await e.reply(ngm);
      BotUtil.makeLog("mark", `『${title || '转发消息'}』已发送`);
      return true;

    } catch (error) {
      BotUtil.makeLog("error", ["转发消息错误", error.message]);

      try {
        // 降级处理
        const firstMsg = Array.isArray(messages[0]) ? messages[0].join("\n") :
          typeof messages[0] === 'object' ?
            (messages[0].message || messages[0].content || JSON.stringify(messages[0])) :
            String(messages[0]);

        await e.reply(`${title ? `【${title}】\n` : ''}${firstMsg}${messages.length > 1 ? '\n(消息过长，已省略)' : ''}`);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * 解析JSON
   * @static
   * @param {string} str - JSON字符串
   * @param {any} [defaultValue={}] - 默认值
   * @returns {any} 解析结果
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

// 导出兼容函数
export async function makemsg(e, messages, title, description) {
  return BotUtil.makeMsg(e, messages, title, description);
}

export async function 制作聊天记录(e, messages, title, description) {
  return BotUtil.makeChatRecord(e, messages, title, description);
}