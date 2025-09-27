import path from 'path';
import fs from 'node:fs/promises';
import * as fsSync from 'fs';
import { EventEmitter } from "events";
import express from "express";
import http from "node:http";
import https from "node:https";
import { WebSocketServer } from "ws";
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import os from 'node:os';
import dgram from 'node:dgram';

import PluginsLoader from "./plugins/loader.js";
import ListenerLoader from "./listener/loader.js";
import ApiLoader from "./http/loader.js";
import init from "./config/loader.js";
import BotUtil from './common/util.js';
import cfg from './config/config.js';

/**
 * Bot 主类 - 管理 HTTP/HTTPS 服务器、WebSocket 连接和机器人实例
 * 提供统一的服务器管理、认证、静态文件服务等功能
 * @class Bot
 * @extends EventEmitter
 */
export default class Bot extends EventEmitter {
  /**
   * 构造函数 - 初始化 Bot 实例
   */
  constructor() {
    super();
    
    // 设置最大监听器数量，防止内存泄漏警告
    this.setMaxListeners(100);

    // 核心属性初始化
    this.stat = { start_time: Date.now() / 1000 };
    this.bot = this;
    this.bots = {};
    this.adapter = [];

    // 账号管理初始化
    this.uin = this._createUinManager();

    // 服务器组件初始化
    this.express = Object.assign(express(), { skip_auth: [], quiet: [] });
    this.server = null;
    this.httpsServer = null;
    this.wss = null; // 延迟初始化，避免过早创建
    this.wsf = Object.create(null);
    
    // 使用 Map 替代 Object 以优化内存管理
    this.fs = new Map();
    
    // 用于追踪活动连接
    this.activeConnections = new Set();
    this.activeTimeouts = new Set();

    // 配置初始化
    this.apiKey = '';
    this._cache = BotUtil.getMap('yunzai_cache', { ttl: 60000, autoClean: true });
    this._rateLimiters = new Map();
    this.httpPort = null;
    this.httpsPort = null;
    this.url = cfg.server?.server?.url || '';

    // API 加载器引用
    this.ApiLoader = ApiLoader;

    // 清理标记
    this._isShuttingDown = false;
    
    // 初始化 HTTP 服务器
    this._initHttpServer();

    // 设置进程信号处理
    this._setupSignalHandlers();

    // 生成 API 密钥
    this.generateApiKey();

    // 返回代理对象
    return this._createProxy();
  }

  /**
   * 创建 UIN 管理器 - 管理多账号的智能选择
   * @private
   * @returns {Array} 扩展的 UIN 数组
   */
  _createUinManager() {
    const uinArray = [];
    
    // 定义自定义方法
    Object.defineProperties(uinArray, {
      now: {
        writable: true,
        configurable: true,
        value: undefined
      },
      _timeoutId: {
        writable: true,
        configurable: true,
        value: null
      },
      toJSON: {
        value: function() {
          if (!this.now) {
            if (this.length <= 2) return this[this.length - 1] || "";
            const array = this.slice(1);
            this.now = array[Math.floor(Math.random() * array.length)];
            
            // 清理旧的定时器
            if (this._timeoutId) {
              clearTimeout(this._timeoutId);
              this.activeTimeouts?.delete(this._timeoutId);
            }
            
            // 设置新的定时器并追踪
            this._timeoutId = setTimeout(() => {
              delete this.now;
              this._timeoutId = null;
            }, 60000);
            
            // 追踪定时器（如果有 activeTimeouts）
            if (this.activeTimeouts) {
              this.activeTimeouts.add(this._timeoutId);
            }
          }
          return this.now;
        }
      },
      toString: {
        value: function(raw, ...args) {
          return raw === true ?
            Array.prototype.toString.apply(this, args) :
            this.toJSON().toString(raw, ...args);
        }
      },
      includes: {
        value: function(value) {
          return this.some(i => i == value);
        }
      }
    });

    return uinArray;
  }

  /**
   * 初始化 HTTP 服务器
   * @private
   */
  _initHttpServer() {
    this.server = http.createServer(this.express);
    
    // 使用箭头函数避免 this 绑定问题
    this.server.on("error", (err) => this._handleServerError(err, false));
    this.server.on("upgrade", (req, socket, head) => this.wsConnect(req, socket, head));
    
    // 追踪连接
    this.server.on('connection', (socket) => {
      this.activeConnections.add(socket);
      socket.on('close', () => {
        this.activeConnections.delete(socket);
      });
    });
  }

  /**
   * 处理服务器错误
   * @private
   * @param {Error} err - 错误对象
   * @param {boolean} isHttps - 是否为 HTTPS 服务器
   */
  _handleServerError(err, isHttps) {
    const handler = this[`server${err.code}`];
    if (typeof handler === "function") {
      return handler.call(this, err, isHttps);
    }
    BotUtil.makeLog("error", err, isHttps ? "HTTPS Server" : "Server");
  }

  /**
   * 初始化所有中间件和路由
   * 按照标准顺序加载中间件，确保认证和安全性
   * @private
   */
  _initializeMiddlewareAndRoutes() {
    const serverConfig = cfg.server || {};

    // ========== 第一层：基础中间件 ==========

    // 压缩中间件 - 减少传输数据量
    if (serverConfig.compression?.enabled !== false) {
      this.express.use(compression({
        filter: (req, res) =>
          !req.headers['x-no-compression'] && compression.filter(req, res),
        level: serverConfig.compression?.level || 6,
        threshold: serverConfig.compression?.threshold || 1024
      }));
    }

    // 安全头部 - 增强安全性
    if (serverConfig.security?.helmet?.enabled !== false) {
      this.express.use(helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        hsts: serverConfig.security?.hsts?.enabled === true ? {
          maxAge: serverConfig.security.hsts.maxAge || 31536000,
          includeSubDomains: serverConfig.security.hsts.includeSubDomains !== false,
          preload: serverConfig.security.hsts.preload === true
        } : false
      }));
    }

    // CORS 配置
    this._setupCors();

    // 请求日志
    this._setupRequestLogging();

    // ========== 第二层：速率限制 ==========
    this._setupRateLimiting();

    // ========== 第三层：请求体解析 ==========
    this._setupBodyParsers();

    // ========== 第四层：认证中间件 ==========
    this.express.use((req, res, next) => this._authMiddleware(req, res, next));

    // ========== 第五层：系统路由 ==========
    
    // 状态和健康检查
    this.express.get('/status', (req, res) => this._statusHandler(req, res));
    this.express.get('/health', (req, res) => this._healthHandler(req, res));

    // 文件服务（用于 Bot 发送的临时文件）
    this.express.use('/File', (req, res) => this._fileHandler(req, res));

    // ========== 第六层：静态文件服务 ==========
    this._setupStaticServing();
  }

  /**
   * 设置 CORS 跨域配置
   * @private
   */
  _setupCors() {
    const corsConfig = cfg.server?.cors;
    if (corsConfig?.enabled === false) return;

    this.express.use((req, res, next) => {
      const config = corsConfig || {};
      const allowedOrigins = config.origins || ['*'];
      const origin = req.headers.origin;

      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin || '*');
      }

      res.header('Access-Control-Allow-Methods',
        config.methods?.join(', ') || 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers',
        config.headers?.join(', ') || 'Content-Type, Authorization, X-API-Key');
      res.header('Access-Control-Allow-Credentials',
        config.credentials ? 'true' : 'false');

      if (config.maxAge) {
        res.header('Access-Control-Max-Age', String(config.maxAge));
      }

      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });
  }

  /**
   * 设置请求日志
   * @private
   */
  _setupRequestLogging() {
    if (cfg.server?.logging?.requests === false) return;

    this.express.use((req, res, next) => {
      const start = Date.now();
      
      // 使用 once 避免重复监听
      res.once('finish', () => {
        const duration = Date.now() - start;
        const quietPaths = cfg.server?.logging?.quiet || [];

        if (!quietPaths.some(p => req.path.startsWith(p))) {
          BotUtil.makeLog('debug',
            `${req.method} ${req.path} ${res.statusCode} ${duration}ms`,
            'HTTP');
        }
      });
      
      next();
    });
  }

  /**
   * 设置静态文件服务
   * www 目录作为默认根目录
   * @private
   */
  _setupStaticServing() {
    const wwwPath = path.join(process.cwd(), 'www');

    // 确保 www 目录存在
    if (!fsSync.existsSync(wwwPath)) {
      fsSync.mkdirSync(wwwPath, { recursive: true });
      BotUtil.makeLog('info', `创建 www 目录: ${wwwPath}`, 'Server');
    }

    // 静态文件安全中间件
    this.express.use((req, res, next) => this._staticSecurityMiddleware(req, res, next));

    // 配置静态文件选项
    const staticOptions = {
      index: cfg.server?.static?.index || ['index.html', 'index.htm'],
      dotfiles: 'deny',
      extensions: cfg.server?.static?.extensions || false,
      fallthrough: true,
      maxAge: cfg.server?.static?.cacheTime || '1d',
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => this._setStaticHeaders(res, filePath)
    };

    // 设置 www 为根目录
    this.express.use(express.static(wwwPath, staticOptions));

    // 特殊文件处理
    this.express.get('/favicon.ico', (req, res) => this._handleFavicon(req, res));
    this.express.get('/robots.txt', (req, res) => this._handleRobotsTxt(req, res));

    BotUtil.makeLog('info', `静态文件服务: / -> ${wwwPath}`, 'Server');
  }

  /**
   * 设置静态文件响应头
   * @private
   * @param {Object} res - 响应对象
   * @param {string} filePath - 文件路径
   */
  _setStaticHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip'
    };

    if (mimeTypes[ext]) {
      res.setHeader('Content-Type', mimeTypes[ext]);
    }

    // 安全头
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // 缓存策略
    const cacheConfig = cfg.server?.static?.cache || {};
    if (['.html', '.htm'].includes(ext)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else if (['.css', '.js', '.json'].includes(ext)) {
      res.setHeader('Cache-Control', `public, max-age=${cacheConfig.static || 86400}`);
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'].includes(ext)) {
      res.setHeader('Cache-Control', `public, max-age=${cacheConfig.images || 604800}`);
    }
  }

  /**
   * 静态文件安全中间件
   * @private
   * @param {Object} req - 请求对象
   * @param {Object} res - 响应对象
   * @param {Function} next - 下一个中间件
   */
  _staticSecurityMiddleware(req, res, next) {
    const normalizedPath = path.normalize(req.path);

    // 防止目录遍历
    if (normalizedPath.includes('..')) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // 检查隐藏文件
    const hiddenPatterns = cfg.server?.security?.hiddenFiles || [
      /^\./, /\/\./, /node_modules/, /\.git/
    ];

    const isHidden = hiddenPatterns.some(pattern => {
      if (typeof pattern === 'string') {
        return normalizedPath.includes(pattern);
      }
      return pattern.test(normalizedPath);
    });

    if (isHidden) {
      return res.status(404).json({ error: 'Not Found' });
    }

    next();
  }

  /**
   * 处理 favicon 请求
   * @private
   * @param {Object} req - 请求对象
   * @param {Object} res - 响应对象
   */
  async _handleFavicon(req, res) {
    const faviconPath = path.join(process.cwd(), 'www', 'favicon.ico');

    try {
      if (fsSync.existsSync(faviconPath)) {
        res.set({
          'Content-Type': 'image/x-icon',
          'Cache-Control': 'public, max-age=604800'
        });
        return res.sendFile(faviconPath);
      }
    } catch (err) {
      BotUtil.makeLog('debug', `Favicon 读取失败: ${err.message}`, 'Server');
    }

    res.status(204).end();
  }

  /**
   * 处理 robots.txt 请求
   * @private
   * @param {Object} req - 请求对象
   * @param {Object} res - 响应对象
   */
  async _handleRobotsTxt(req, res) {
    const robotsPath = path.join(process.cwd(), 'www', 'robots.txt');

    try {
      if (fsSync.existsSync(robotsPath)) {
        res.set({
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=86400'
        });
        return res.sendFile(robotsPath);
      }
    } catch (err) {
      BotUtil.makeLog('debug', `Robots.txt 读取失败: ${err.message}`, 'Server');
    }

    // 默认 robots.txt 内容
    const defaultRobots = `User-agent: *
Disallow: /api/
Disallow: /config/
Disallow: /data/
Disallow: /lib/
Disallow: /plugins/
Disallow: /temp/
Allow: /

Sitemap: ${this.getServerUrl()}/sitemap.xml`;

    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(defaultRobots);
  }

  /**
   * 设置速率限制
   * @private
   */
  _setupRateLimiting() {
    const rateLimitConfig = cfg.server?.rateLimit;
    if (rateLimitConfig?.enabled === false) return;

    const createLimiter = (options) => {
      const limiter = rateLimit({
        windowMs: options.windowMs || 15 * 60 * 1000,
        max: options.max || 100,
        message: options.message || 'Too many requests',
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) => this._isLocalConnection(req.ip),
        keyGenerator: (req) => {
          // 使用更稳定的键生成
          return req.ip || req.socket?.remoteAddress || 'unknown';
        }
      });
      
      // 存储限制器引用
      this._rateLimiters.set(limiter, options);
      
      return limiter;
    };

    // 全局限制
    if (rateLimitConfig?.global) {
      this.express.use(createLimiter(rateLimitConfig.global));
    }

    // API 限制
    if (rateLimitConfig?.api) {
      this.express.use('/api', createLimiter(rateLimitConfig.api));
    }
  }

  /**
   * 设置请求体解析器
   * @private
   */
  _setupBodyParsers() {
    const limits = cfg.server?.limits || {};

    this.express.use(express.urlencoded({
      extended: false,
      limit: limits.urlencoded || '10mb',
      parameterLimit: 1000
    }));

    this.express.use(express.json({
      limit: limits.json || '10mb',
      strict: true
    }));

    this.express.use(express.raw({
      limit: limits.raw || '10mb',
      type: '*/*'
    }));
  }

  /**
   * 设置进程信号处理
   * @private
   */
  _setupSignalHandlers() {
    const closeHandler = async () => {
      if (this._isShuttingDown) return;
      this._isShuttingDown = true;
      await this.closeServer();
      process.exit(0);
    };
    
    // 只监听一次，避免重复处理
    process.once('SIGINT', closeHandler);
    process.once('SIGTERM', closeHandler);
    
    // 处理未捕获的异常
    process.on('uncaughtException', (err) => {
      BotUtil.makeLog('error', `未捕获的异常: ${err.stack}`, 'Process');
      if (err.message?.includes('double free') || err.message?.includes('corruption')) {
        BotUtil.makeLog('error', '检测到内存错误，尝试安全关闭', 'Process');
        closeHandler();
      }
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      BotUtil.makeLog('error', `未处理的 Promise 拒绝: ${reason}`, 'Process');
    });
  }

  /**
   * 创建代理对象
   * @private
   * @returns {Proxy} 代理对象
   */
  _createProxy() {
    // 使用 WeakRef 避免循环引用
    const botWeakRef = new WeakRef(this);
    
    return new Proxy(this.bots, {
      get: (target, prop) => {
        const bot = botWeakRef.deref();
        if (!bot) return undefined;
        
        // 检查 bots 对象的属性
        if (target[prop] !== undefined) return target[prop];

        // 检查 Bot 实例的属性
        if (bot[prop] !== undefined) return bot[prop];

        // 检查工具类的属性
        const utilValue = BotUtil[prop];
        if (utilValue !== undefined) {
          return typeof utilValue === 'function' ?
            utilValue.bind(BotUtil) : utilValue;
        }

        // 查找 Bot 实例的属性
        for (const botId of [bot.uin.toString(), ...bot.uin]) {
          const botInstance = target[botId];
          if (botInstance?.[prop] !== undefined) {
            BotUtil.makeLog("trace",
              `因不存在 Bot.${prop} 而重定向到 Bot.${botId}.${prop}`);
            return typeof botInstance[prop] === "function" ?
              botInstance[prop].bind(botInstance) : botInstance[prop];
          }
        }

        BotUtil.makeLog("trace", `不存在 Bot.${prop}`);
        return undefined;
      }
    });
  }

  /**
   * 生成或加载 API 密钥
   * @async
   * @returns {Promise<string>} API 密钥
   */
  async generateApiKey() {
    const apiKeyConfig = cfg.server?.auth?.apiKey || {};
    const apiKeyPath = path.join(process.cwd(),
      apiKeyConfig.file || 'config/server_config/api_key.json');

    try {
      // 尝试加载现有密钥
      if (fsSync.existsSync(apiKeyPath)) {
        const keyData = JSON.parse(await fs.readFile(apiKeyPath, 'utf8'));
        this.apiKey = keyData.key;
        BotUtil.apiKey = this.apiKey;
        BotUtil.makeLog('info', '已加载 API 密钥', 'Server');
        return this.apiKey;
      }

      // 生成新密钥
      const keyLength = apiKeyConfig.length || 64;
      this.apiKey = BotUtil.randomString(keyLength);

      // 保存密钥
      await BotUtil.mkdir(path.dirname(apiKeyPath));
      await fs.writeFile(apiKeyPath, JSON.stringify({
        key: this.apiKey,
        generated: new Date().toISOString(),
        note: '此密钥用于远程 API 访问，请妥善保管'
      }, null, 2), 'utf8');

      // 设置文件权限（仅限 Unix 系统）
      if (process.platform !== 'win32') {
        try { await fs.chmod(apiKeyPath, 0o600); } catch { }
      }

      BotUtil.apiKey = this.apiKey;
      BotUtil.makeLog('success', `生成新的 API 密钥: ${this.apiKey}`, 'Server');
      return this.apiKey;

    } catch (error) {
      BotUtil.makeLog('error', `API 密钥处理失败: ${error.message}`, 'Server');
      // 回退：生成临时密钥
      this.apiKey = BotUtil.randomString(64);
      BotUtil.apiKey = this.apiKey;
      return this.apiKey;
    }
  }

  /**
   * 认证中间件
   * @private
   * @param {Object} req - 请求对象
   * @param {Object} res - 响应对象
   * @param {Function} next - 下一个中间件
   */
  _authMiddleware(req, res, next) {
    req.rid = `${req.ip}:${req.socket?.remotePort || 'unknown'}`;
    req.sid = `${req.protocol}://${req.hostname}:${req.socket?.localPort || 'unknown'}${req.originalUrl}`;

    // 检查白名单路径
    const whitelist = cfg.server?.auth?.whitelist || [
      '/', '/favicon.ico', '/health', '/status', '/robots.txt'
    ];

    // 检查是否是白名单路径或静态文件
    const isWhitelisted = whitelist.some(path => {
      if (path === req.path) return true;
      if (path.endsWith('*') && req.path.startsWith(path.slice(0, -1))) return true;
      return false;
    });

    // 静态文件默认允许访问
    const isStaticFile = /\.(html|css|js|json|png|jpg|jpeg|gif|svg|webp|ico|mp4|webm|mp3|wav|pdf|zip)$/i.test(req.path);

    if (isWhitelisted || isStaticFile) {
      return next();
    }

    // 本地连接跳过认证
    if (this._isLocalConnection(req.ip)) {
      BotUtil.makeLog("debug", `本地连接，跳过鉴权: ${req.ip}`, 'Auth');
      return next();
    }

    // 验证 API 密钥
    if (!this._checkApiAuthorization(req)) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or missing API key',
        hint: 'Please provide X-API-Key header or api_key parameter'
      });

      BotUtil.makeLog("warn",
        `HTTP 鉴权失败: ${req.method} ${req.originalUrl} 来自 ${req.ip}`,
        'Auth');
      return;
    }

    BotUtil.makeLog("debug", `鉴权成功: ${req.method} ${req.originalUrl}`, 'Auth');
    next();
  }

  /**
   * 检查 API 授权
   * @private
   * @param {Object} req - 请求对象
   * @returns {boolean} 是否授权
   */
  _checkApiAuthorization(req) {
    if (!req) return false;

    // 获取请求中的 API 密钥
    const authKey = req.headers?.["x-api-key"] ??
      req.headers?.["authorization"]?.replace('Bearer ', '') ??
      req.query?.api_key ??
      req.body?.api_key;

    if (!this.apiKey || !authKey) {
      BotUtil.makeLog("debug", `API 鉴权失败: 缺少密钥`, 'Auth');
      return false;
    }

    try {
      // 时间安全比较，防止时序攻击
      const authKeyBuffer = Buffer.from(String(authKey));
      const apiKeyBuffer = Buffer.from(String(this.apiKey));

      if (authKeyBuffer.length !== apiKeyBuffer.length) {
        BotUtil.makeLog("warn",
          `来自 ${req.socket?.remoteAddress || req.ip} 的未授权访问尝试`,
          'Auth');
        return false;
      }

      return crypto.timingSafeEqual(authKeyBuffer, apiKeyBuffer);

    } catch (error) {
      BotUtil.makeLog("error", `API 鉴权错误: ${error.message}`, 'Auth');
      return false;
    }
  }

  /**
   * 公共 API 授权检查方法
   * @param {Object} req - 请求对象  
   * @returns {boolean} 是否授权
   */
  checkApiAuthorization(req) {
    return this._checkApiAuthorization(req);
  }

  /**
   * 检查是否为本地连接
   * @private
   * @param {string} address - IP 地址
   * @returns {boolean} 是否为本地连接
   */
  _isLocalConnection(address) {
    if (!address || typeof address !== 'string') return false;

    const ip = address.toLowerCase().trim()
      .replace(/^::ffff:/, '')
      .replace(/%.+$/, '');

    return ip === 'localhost' ||
      ip === '127.0.0.1' ||
      ip === '::1' ||
      this._isPrivateIP(ip);
  }

  /**
   * 检查是否为私有 IP
   * @private
   * @param {string} ip - IP 地址
   * @returns {boolean} 是否为私有 IP
   */
  _isPrivateIP(ip) {
    if (!ip) return false;

    const patterns = {
      ipv4: [
        /^10\./,
        /^172\.(1[6-9]|2\d|3[01])\./,
        /^192\.168\./,
        /^127\./
      ],
      ipv6: [
        /^fe80:/i,
        /^fc00:/i,
        /^fd00:/i
      ]
    };

    const isIPv4 = ip.includes('.');
    const testPatterns = isIPv4 ? patterns.ipv4 : patterns.ipv6;

    return testPatterns.some(pattern => pattern.test(ip));
  }

  /**
   * 状态处理器
   * @private
   * @param {Object} req - 请求对象
   * @param {Object} res - 响应对象
   */
  _statusHandler(req, res) {
    const status = {
      status: 'running',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      timestamp: Date.now(),
      version: process.version,
      platform: process.platform,
      server: {
        httpPort: this.httpPort,
        httpsPort: this.httpsPort,
        https: cfg.server?.https?.enabled || false
      }
    };

    res.type('json').send(JSON.stringify(status, null, 2));
  }

  /**
   * 健康检查处理器
   * @private
   * @param {Object} req - 请求对象
   * @param {Object} res - 响应对象
   */
  _healthHandler(req, res) {
    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: Date.now()
    });
  }

  /**
   * 文件处理器 - 处理 Bot 发送的临时文件
   * @private
   * @param {Object} req - 请求对象
   * @param {Object} res - 响应对象
   */
  _fileHandler(req, res) {
    const url = req.url.replace(/^\//, "");
    
    // 使用 Map 代替 Object
    let file = this.fs.get(url) || this.fs.get('404');
    
    if (!file) {
      return res.status(404).json({ error: 'Not Found', file: url });
    }

    // 克隆文件对象避免修改原始数据
    file = { ...file };

    // 处理访问次数限制
    if (typeof file.times === "number") {
      if (file.times > 0) {
        file.times--;
        // 更新原始数据
        const originalFile = this.fs.get(url);
        if (originalFile) {
          originalFile.times = file.times;
        }
      } else {
        file = this.fs.get('timeout');
        if (!file) {
          return res.status(410).json({
            error: 'Gone',
            message: 'File access limit exceeded'
          });
        }
      }
    }

    // 安全处理 Buffer
    try {
      const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer);
      
      // 设置响应头
      if (file.type?.mime) {
        res.setHeader("Content-Type", file.type.mime);
      }
      res.setHeader("Content-Length", buffer.length);
      res.setHeader("Cache-Control", "no-cache");

      BotUtil.makeLog("debug",
        `文件发送: ${file.name} (${BotUtil.formatFileSize(buffer.length)})`,
        'Server');

      res.send(buffer);
    } catch (err) {
      BotUtil.makeLog("error", `文件处理错误: ${err.message}`, 'Server');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  /**
   * WebSocket 连接处理
   * @param {Object} req - 请求对象
   * @param {Object} socket - Socket 对象
   * @param {Buffer} head - 头部数据
   */
  wsConnect(req, socket, head) {
    // 防止在关闭过程中接受新连接
    if (this._isShuttingDown) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return socket.destroy();
    }
    
    // 延迟初始化 WebSocket 服务器
    if (!this.wss) {
      this.wss = new WebSocketServer({ noServer: true });
    }
    
    // 构建请求标识
    req.rid = `${req.socket.remoteAddress}:${req.socket.remotePort}-${req.headers["sec-websocket-key"]}`;
    req.sid = `ws://${req.headers.host || `${req.socket.localAddress}:${req.socket.localPort}`}${req.url}`;
    
    // 安全解析查询参数
    try {
      const url = new URL(req.sid);
      req.query = Object.fromEntries(url.searchParams.entries());
    } catch (err) {
      BotUtil.makeLog("error", `WebSocket URL 解析失败: ${err.message}`, 'Server');
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      return socket.destroy();
    }

    // 验证授权
    if (!this._isLocalConnection(req.socket.remoteAddress)) {
      if (!this._checkApiAuthorization(req)) {
        BotUtil.makeLog("error", `WebSocket 鉴权失败: ${req.url}`, 'Server');
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return socket.destroy();
      }
    }

    // 检查路径
    const path = req.url.split("/")[1];
    if (!(path in this.wsf)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      return socket.destroy();
    }

    // 处理升级
    this.wss.handleUpgrade(req, socket, head, (conn) => {
      // 追踪连接
      this.activeConnections.add(conn);
      
      BotUtil.makeLog("debug", `WebSocket 连接建立: ${req.url}`, 'Server');

      // 设置事件处理
      conn.on("error", (err) => BotUtil.makeLog("error", err, 'Server'));
      conn.on("close", () => {
        this.activeConnections.delete(conn);
        BotUtil.makeLog("debug", `WebSocket 断开: ${req.url}`, 'Server');
      });

      // 消息处理
      conn.on("message", (msg) => {
        try {
          const logMsg = Buffer.isBuffer(msg) && msg.length > 1024 ?
            `[Binary message, length: ${msg.length}]` : BotUtil.String(msg);
          BotUtil.makeLog("trace", `WS 消息: ${logMsg}`, 'Server');
        } catch (err) {
          BotUtil.makeLog("error", `消息处理错误: ${err.message}`, 'Server');
        }
      });

      // 扩展发送方法
      conn.sendMsg = (msg) => {
        try {
          if (!Buffer.isBuffer(msg)) msg = BotUtil.String(msg);
          BotUtil.makeLog("trace", `WS 发送: ${msg}`, 'Server');
          return conn.send(msg);
        } catch (err) {
          BotUtil.makeLog("error", `发送错误: ${err.message}`, 'Server');
          return false;
        }
      };

      // 调用处理函数
      for (const handler of this.wsf[path]) {
        try {
          handler(conn, req, socket, head);
        } catch (err) {
          BotUtil.makeLog("error", `WebSocket 处理器错误: ${err.message}`, 'Server');
        }
      }
    });
  }

  /**
   * 端口占用错误处理
   * @async
   * @param {Error} err - 错误对象
   * @param {boolean} isHttps - 是否为 HTTPS
   */
  async serverEADDRINUSE(err, isHttps) {
    const serverType = isHttps ? 'HTTPS' : 'HTTP';
    const port = isHttps ? this.httpsPort : this.httpPort;

    BotUtil.makeLog("error", `${serverType} 端口 ${port} 已被占用`, 'Server');

    // 重试计数
    const retryKey = isHttps ? 'https_retry_count' : 'http_retry_count';
    this[retryKey] = (this[retryKey] || 0) + 1;

    // 超过最大重试次数
    if (this[retryKey] > 5) {
      BotUtil.makeLog("error", `${serverType} 端口重试次数过多，放弃重试`, 'Server');
      return;
    }

    // 延迟重试
    await BotUtil.sleep(this[retryKey] * 1000);

    // 重新监听
    const server = isHttps ? this.httpsServer : this.server;
    const host = cfg.server?.host || '0.0.0.0';

    if (server && !this._isShuttingDown) {
      server.listen(port, host);
    }
  }

  /**
   * 加载服务器
   * @async
   * @param {boolean} isHttps - 是否为 HTTPS
   */
  async serverLoad(isHttps) {
    const server = isHttps ? this.httpsServer : this.server;
    const port = isHttps ? this.httpsPort : this.httpPort;
    const host = cfg.server?.host || '0.0.0.0';

    if (!server) return;

    // 开始监听
    server.listen(port, host);

    // 等待监听成功
    try {
      await BotUtil.promiseEvent(server, "listening", isHttps && "error");
    } catch (err) {
      BotUtil.makeLog('error', `${isHttps ? 'HTTPS' : 'HTTP'} 服务器启动失败: ${err}`, 'Server');
      return;
    }

    const serverInfo = server.address();
    if (!serverInfo) {
      BotUtil.makeLog('error',
        `${isHttps ? 'HTTPS' : 'HTTP'} 服务器未能成功启动`, 'Server');
      return;
    }

    // 更新端口
    if (isHttps) {
      this.httpsPort = serverInfo.port;
    } else {
      this.httpPort = serverInfo.port;
    }

    // 获取地址信息
    const protocol = isHttps ? 'https' : 'http';
    const serverType = isHttps ? 'HTTPS' : 'HTTP';

    BotUtil.makeLog("info",
      `${cfg.server?.name || 'Yunzai'} ${serverType} 服务器启动成功`, 'Server');
    BotUtil.makeLog("info",
      `${serverType} 监听地址: ${host}:${serverInfo.port}`, 'Server');

    // 显示访问地址
    if (!isHttps) {
      await this._displayAccessUrls(protocol, serverInfo.port);
    }
  }

  /**
   * 显示访问地址
   * @private
   * @async
   * @param {string} protocol - 协议
   * @param {number} port - 端口
   */
  async _displayAccessUrls(protocol, port) {
    const addresses = [`${protocol}://localhost:${port}`];

    try {
      // 获取 IP 地址信息
      const ipInfo = await this.getLocalIpAddress();

      // 显示内网地址
      if (ipInfo.local.length > 0) {
        BotUtil.makeLog("info", "内网访问地址:", 'Server');
        ipInfo.local.forEach(info => {
          const url = `${protocol}://${info.ip}:${port}`;
          const label = info.primary ? ' (主要)' : '';
          BotUtil.makeLog("info", `  ${url} [${info.interface}]${label}`, 'Server');
          addresses.push(url);
        });
      }

      // 显示公网地址
      if (ipInfo.public) {
        const publicUrl = `${protocol}://${ipInfo.public}:${port}`;
        BotUtil.makeLog("info", `公网访问地址: ${publicUrl}`, 'Server');
      }

      // 显示 API 密钥
      if (cfg.server?.auth?.apiKey?.enabled !== false) {
        BotUtil.makeLog("info", `API 密钥: ${this.apiKey}`, 'Server');
      }
    } catch (err) {
      BotUtil.makeLog("debug", `获取访问地址失败: ${err.message}`, 'Server');
    }
  }

  /**
   * 加载 HTTPS 服务器
   * @async
   */
  async httpsLoad() {
    const httpsConfig = cfg.server?.https;
    if (!httpsConfig?.enabled) return;

    const cert = httpsConfig.certificate;
    if (!cert?.key || !cert?.cert) {
      BotUtil.makeLog("error", "HTTPS 已启用但未配置证书", 'Server');
      return;
    }

    try {
      // 检查证书文件
      if (!fsSync.existsSync(cert.key)) {
        throw new Error(`HTTPS 密钥文件不存在: ${cert.key}`);
      }

      if (!fsSync.existsSync(cert.cert)) {
        throw new Error(`HTTPS 证书文件不存在: ${cert.cert}`);
      }

      // 读取证书
      const httpsOptions = {
        key: await fs.readFile(cert.key),
        cert: await fs.readFile(cert.cert)
      };

      if (cert.ca && fsSync.existsSync(cert.ca)) {
        httpsOptions.ca = await fs.readFile(cert.ca);
      }

      // TLS 配置
      if (httpsConfig.tls?.minVersion) {
        httpsOptions.minVersion = httpsConfig.tls.minVersion;
      }

      // 创建 HTTPS 服务器
      this.httpsServer = https.createServer(httpsOptions, this.express);
      
      // 设置事件处理
      this.httpsServer.on("error", (err) => this._handleServerError(err, true));
      this.httpsServer.on("upgrade", (req, socket, head) => this.wsConnect(req, socket, head));
      
      // 追踪连接
      this.httpsServer.on('connection', (socket) => {
        this.activeConnections.add(socket);
        socket.on('close', () => {
          this.activeConnections.delete(socket);
        });
      });

      // 启动服务器
      await this.serverLoad(true);

      BotUtil.makeLog("info", "HTTPS 服务器已启动", 'Server');

    } catch (err) {
      BotUtil.makeLog("error", `HTTPS 服务器创建失败: ${err.message}`, 'Server');
    }
  }

  /**
   * 设置 404 和错误处理（最后注册）
   * @private
   */
  _setupFinalHandlers() {
    // 404 处理
    this.express.use((req, res) => {
      if (req.accepts('html')) {
        // 对 HTML 请求，重定向到首页
        res.redirect('/');
      } else {
        // 对 API 请求，返回 JSON 错误
        res.status(404).json({
          error: 'Not Found',
          path: req.path,
          timestamp: Date.now()
        });
      }
    });

    // 错误处理
    this.express.use((err, req, res, next) => {
      BotUtil.makeLog('error', `请求错误: ${err.message}`, 'Server');

      res.status(err.status || 500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'production' ?
          'An error occurred' : err.message,
        timestamp: Date.now()
      });
    });
  }

  /**
   * 关闭服务器
   * @async
   */
  async closeServer() {
    if (this._isShuttingDown) return;
    this._isShuttingDown = true;
    
    BotUtil.makeLog('info', '正在关闭服务器...', 'Server');

    // 清理所有定时器
    for (const timeout of this.activeTimeouts) {
      clearTimeout(timeout);
    }
    this.activeTimeouts.clear();

    // 关闭所有 WebSocket 连接
    if (this.wss) {
      for (const conn of this.wss.clients) {
        conn.close();
      }
      this.wss.close();
    }

    // 关闭所有活动连接
    for (const conn of this.activeConnections) {
      if (conn.destroy) conn.destroy();
      else if (conn.close) conn.close();
    }
    this.activeConnections.clear();

    // 关闭服务器
    const closePromises = [];
    
    if (this.server) {
      closePromises.push(new Promise(resolve => this.server.close(resolve)));
    }

    if (this.httpsServer) {
      closePromises.push(new Promise(resolve => this.httpsServer.close(resolve)));
    }

    await Promise.all(closePromises);

    // 清理文件缓存
    this.fs.clear();

    // 清理速率限制器
    this._rateLimiters.clear();

    // 清理缓存
    if (this._cache?.clear) {
      this._cache.clear();
    }

    // 清理资源
    await BotUtil.sleep(2000);
    await this.redisExit();

    BotUtil.makeLog('info', '服务器已关闭', 'Server');
  }

  /**
   * 获取服务器 URL
   * @returns {string} 服务器 URL
   */
  getServerUrl() {
    const protocol = cfg.server?.https?.enabled ? 'https' : 'http';
    const port = protocol === 'https' ? this.httpsPort : this.httpPort;
    const host = cfg.server?.url || 'localhost';

    return `${protocol}://${host}:${port}`;
  }

  /**
   * 获取本地 IP 地址
   * @async
   * @returns {Promise<Object>} IP 地址信息
   */
  async getLocalIpAddress() {
    const cacheKey = 'local_ip_addresses';
    const cached = this._cache.get(cacheKey);
    if (cached) return cached;

    const result = {
      local: [],
      public: null,
      primary: null
    };

    try {
      const interfaces = os.networkInterfaces();

      // 收集本地 IP
      for (const [name, ifaces] of Object.entries(interfaces)) {
        if (name.toLowerCase().includes('lo')) continue;

        for (const iface of ifaces) {
          if (iface.family !== 'IPv4' || iface.internal) continue;

          result.local.push({
            ip: iface.address,
            interface: name,
            mac: iface.mac,
            virtual: this._isVirtualInterface(name, iface.mac)
          });
        }
      }

      // 获取主要 IP
      try {
        result.primary = await this._getIpByUdp();
        const existingItem = result.local.find(item => item.ip === result.primary);
        if (existingItem) {
          existingItem.primary = true;
        }
      } catch { }

      // 获取公网 IP
      if (cfg.server?.misc?.detectPublicIP !== false) {
        result.public = await this._getPublicIP();
      }

      this._cache.set(cacheKey, result);
      return result;

    } catch (err) {
      BotUtil.makeLog("debug", `获取 IP 地址失败: ${err.message}`, 'Server');
      return result;
    }
  }

  /**
   * 检查是否为虚拟网络接口
   * @private
   * @param {string} name - 接口名称
   * @param {string} mac - MAC 地址
   * @returns {boolean} 是否为虚拟接口
   */
  _isVirtualInterface(name, mac) {
    const virtualPatterns = [
      /^(docker|br-|veth|virbr|vnet)/i,
      /^(vmnet|vmware)/i,
      /^(vboxnet|virtualbox)/i
    ];

    return virtualPatterns.some(p => p.test(name));
  }

  /**
   * 通过 UDP 获取本机 IP
   * @private
   * @async
   * @returns {Promise<string>} IP 地址
   */
  async _getIpByUdp() {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('UDP 获取 IP 超时'));
      }, 3000);

      // 追踪定时器
      if (this.activeTimeouts) {
        this.activeTimeouts.add(timeout);
      }

      try {
        socket.connect(80, '223.5.5.5', () => {
          clearTimeout(timeout);
          if (this.activeTimeouts) {
            this.activeTimeouts.delete(timeout);
          }
          const address = socket.address();
          socket.close();
          resolve(address.address);
        });
        
        socket.on('error', (err) => {
          clearTimeout(timeout);
          if (this.activeTimeouts) {
            this.activeTimeouts.delete(timeout);
          }
          socket.close();
          reject(err);
        });
      } catch (err) {
        clearTimeout(timeout);
        if (this.activeTimeouts) {
          this.activeTimeouts.delete(timeout);
        }
        socket.close();
        reject(err);
      }
    });
  }

  /**
   * 获取公网 IP
   * @private
   * @async
   * @returns {Promise<string|null>} 公网 IP
   */
  async _getPublicIP() {
    const apis = [
      { url: 'https://api.ipify.org?format=json', field: 'ip' },
      { url: 'https://api.myip.la/json', field: 'ip' }
    ];

    for (const api of apis) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        // 追踪定时器
        if (this.activeTimeouts) {
          this.activeTimeouts.add(timeout);
        }

        const response = await fetch(api.url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        clearTimeout(timeout);
        if (this.activeTimeouts) {
          this.activeTimeouts.delete(timeout);
        }

        if (response.ok) {
          const data = await response.json();
          const ip = data[api.field];
          if (ip && this._isValidIP(ip)) return ip;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * 验证 IP 地址格式
   * @private
   * @param {string} ip - IP 地址
   * @returns {boolean} 是否有效
   */
  _isValidIP(ip) {
    if (!ip) return false;

    const ipv4Regex = /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
    return ipv4Regex.test(ip);
  }

  /**
   * 运行服务器
   * @async
   * @param {Object} options - 选项
   * @returns {Promise<void>}
   */
  async run(options = {}) {
    const { port } = options;

    // 设置端口
    this.httpPort = port;
    this.httpsPort = port + 1;

    BotUtil.makeLog('info',
      `配置端口: HTTP=${this.httpPort}, HTTPS=${this.httpsPort}`, 'Server');

    try {
      // 初始化组件
      await init();
      await this.generateApiKey();
      await PluginsLoader.load();
      await ApiLoader.load();

      // 初始化所有中间件和基础路由
      this._initializeMiddlewareAndRoutes();

      // 注册 API 路由
      await ApiLoader.register(this.express, this);

      // 设置 404 和错误处理
      this._setupFinalHandlers();

      // 启动服务器
      await this.serverLoad(false);

      // 启动 HTTPS
      if (cfg.server?.https?.enabled) {
        await this.httpsLoad();
      }

      // 加载监听器
      await ListenerLoader.load();
      await ApiLoader.watch(true);

      // WebSocket 服务
      if (Object.keys(this.wsf).length > 0) {
        BotUtil.makeLog("info",
          `WebSocket 服务: ${this.getServerUrl().replace(/^http/, "ws")}/ [${Object.keys(this.wsf).join(', ')}]`,
          'Server');
      }

      // 触发上线事件
      this.emit("online", {
        bot: this,
        timestamp: Date.now(),
        url: this.getServerUrl(),
        uptime: process.uptime(),
        apis: ApiLoader.getApiList()
      });
      
    } catch (err) {
      BotUtil.makeLog('error', `服务器启动失败: ${err.stack}`, 'Server');
      await this.closeServer();
      throw err;
    }
  }

  // ========== Bot 功能方法 ==========

  /**
   * 准备事件数据
   * @param {Object} data - 事件数据
   */
  prepareEvent(data) {
    if (!this.bots[data.self_id]) return;

    // 添加 bot 引用
    if (!data.bot) {
      Object.defineProperty(data, "bot", {
        value: this.bots[data.self_id],
        enumerable: false,
        configurable: true
      });
    }

    // 处理用户相关
    if (data.user_id) {
      if (!data.friend) {
        Object.defineProperty(data, "friend", {
          value: data.bot.pickFriend(data.user_id),
          enumerable: false,
          configurable: true
        });
      }
      data.sender ||= { user_id: data.user_id };
      data.sender.nickname ||= data.friend?.nickname;
    }

    // 处理群组相关
    if (data.group_id) {
      if (!data.group) {
        Object.defineProperty(data, "group", {
          value: data.bot.pickGroup(data.group_id),
          enumerable: false,
          configurable: true
        });
      }
      data.group_name ||= data.group?.name;
    }

    // 处理群成员
    if (data.group && data.user_id) {
      if (!data.member) {
        Object.defineProperty(data, "member", {
          value: data.group.pickMember(data.user_id),
          enumerable: false,
          configurable: true
        });
      }
      data.sender.nickname ||= data.member?.nickname;
      data.sender.card ||= data.member?.card;
    }

    // 添加适配器信息
    if (data.bot.adapter?.id) data.adapter_id = data.bot.adapter.id;
    if (data.bot.adapter?.name) data.adapter_name = data.bot.adapter.name;

    // 扩展方法
    this._extendEventMethods(data);
  }

  /**
   * 扩展事件方法
   * @private
   * @param {Object} data - 事件数据
   */
  _extendEventMethods(data) {
    for (const target of [data.friend, data.group, data.member]) {
      if (!target || typeof target !== "object") continue;

      target.sendFile ??= (file, name) =>
        target.sendMsg(segment.file(file, name));
      target.makeForwardMsg ??= this.makeForwardMsg.bind(this);
      target.sendForwardMsg ??= (msg) =>
        this.sendForwardMsg((msg) => target.sendMsg(msg), msg);
      target.getInfo ??= () => target.info || target;
    }

    // 设置回复方法
    if (!data.reply) {
      data.reply = data.group?.sendMsg?.bind(data.group) ||
        data.friend?.sendMsg?.bind(data.friend);
    }
  }

  /**
   * 触发事件
   * @param {string} name - 事件名称
   * @param {Object} data - 事件数据
   */
  em(name = "", data = {}) {
    this.prepareEvent(data);

    // 触发事件链
    while (name) {
      this.emit(name, data);
      const lastDot = name.lastIndexOf(".");
      if (lastDot === -1) break;
      name = name.slice(0, lastDot);
    }
  }

  /**
   * 获取好友列表映射
   * @returns {Map} 好友映射
   */
  get fl() {
    const map = new Map();

    for (const bot_id of this.uin) {
      const bot = this.bots[bot_id];
      if (!bot?.fl) continue;

      for (const [id, friend] of bot.fl) {
        map.set(id, { ...friend, bot_id });
      }
    }

    return map;
  }

  /**
   * 获取群列表映射
   * @returns {Map} 群映射
   */
  get gl() {
    const map = new Map();

    for (const bot_id of this.uin) {
      const bot = this.bots[bot_id];
      if (!bot?.gl) continue;

      for (const [id, group] of bot.gl) {
        map.set(id, { ...group, bot_id });
      }
    }

    return map;
  }

  /**
   * 获取群成员列表映射
   * @returns {Map} 群成员映射
   */
  get gml() {
    const map = new Map();

    for (const bot_id of this.uin) {
      const bot = this.bots[bot_id];
      if (!bot?.gml) continue;

      for (const [group_id, memberMap] of bot.gml) {
        const newMemberMap = new Map(memberMap);
        newMemberMap.bot_id = bot_id;
        map.set(group_id, newMemberMap);
      }
    }

    return map;
  }

  /**
   * 选择好友
   * @param {number|string} user_id - 用户 ID
   * @param {boolean} strict - 严格模式
   * @returns {Object|false} 好友对象
   */
  pickFriend(user_id, strict) {
    user_id = Number(user_id) || user_id;

    // 优先使用主 Bot
    const mainBot = this.bots[this.uin];
    if (mainBot?.fl?.has(user_id)) {
      return mainBot.pickFriend(user_id);
    }

    // 查找其他 Bot
    const friend = this.fl.get(user_id);
    if (friend) {
      return this.bots[friend.bot_id].pickFriend(user_id);
    }

    // 严格模式返回 false
    if (strict) return false;

    // 随机选择 Bot
    BotUtil.makeLog("trace",
      `因不存在用户 ${user_id} 而随机选择 Bot ${this.uin.toJSON()}`, 'Server');
    return this.bots[this.uin].pickFriend(user_id);
  }

  /**
   * pickUser 别名
   */
  get pickUser() {
    return this.pickFriend;
  }

  /**
   * 选择群
   * @param {number|string} group_id - 群 ID
   * @param {boolean} strict - 严格模式
   * @returns {Object|false} 群对象
   */
  pickGroup(group_id, strict) {
    group_id = Number(group_id) || group_id;

    // 优先使用主 Bot
    const mainBot = this.bots[this.uin];
    if (mainBot?.gl?.has(group_id)) {
      return mainBot.pickGroup(group_id);
    }

    // 查找其他 Bot
    const group = this.gl.get(group_id);
    if (group) {
      return this.bots[group.bot_id].pickGroup(group_id);
    }

    // 严格模式返回 false
    if (strict) return false;

    // 随机选择 Bot
    BotUtil.makeLog("trace",
      `因不存在群 ${group_id} 而随机选择 Bot ${this.uin.toJSON()}`, 'Server');
    return this.bots[this.uin].pickGroup(group_id);
  }

  /**
   * 选择群成员
   * @param {number|string} group_id - 群 ID
   * @param {number|string} user_id - 用户 ID
   * @returns {Object} 成员对象
   */
  pickMember(group_id, user_id) {
    return this.pickGroup(group_id).pickMember(user_id);
  }

  /**
   * 发送好友消息
   * @async
   * @param {number|string} bot_id - Bot ID
   * @param {number|string} user_id - 用户 ID
   * @param {...any} args - 消息内容
   * @returns {Promise<Object>} 发送结果
   */
  async sendFriendMsg(bot_id, user_id, ...args) {
    // 无 Bot ID 时使用默认
    if (!bot_id) {
      return this.pickFriend(user_id).sendMsg(...args);
    }

    // 指定 Bot 发送
    if (this.uin.includes(bot_id) && this.bots[bot_id]) {
      return this.bots[bot_id].pickFriend(user_id).sendMsg(...args);
    }

    // 等待 Bot 上线
    return new Promise((resolve, reject) => {
      const listener = (data) => {
        resolve(data.bot.pickFriend(user_id).sendMsg(...args));
        clearTimeout(timeout);
        if (this.activeTimeouts) {
          this.activeTimeouts.delete(timeout);
        }
      };

      const timeout = setTimeout(() => {
        reject(Object.assign(Error("等待 Bot 上线超时"),
          { bot_id, user_id, args }));
        this.off(`connect.${bot_id}`, listener);
        if (this.activeTimeouts) {
          this.activeTimeouts.delete(timeout);
        }
      }, 300000);

      // 追踪定时器
      if (this.activeTimeouts) {
        this.activeTimeouts.add(timeout);
      }

      this.once(`connect.${bot_id}`, listener);
    });
  }

  /**
   * 发送群消息
   * @async
   * @param {number|string} bot_id - Bot ID
   * @param {number|string} group_id - 群 ID
   * @param {...any} args - 消息内容
   * @returns {Promise<Object>} 发送结果
   */
  async sendGroupMsg(bot_id, group_id, ...args) {
    // 无 Bot ID 时使用默认
    if (!bot_id) {
      return this.pickGroup(group_id).sendMsg(...args);
    }

    // 指定 Bot 发送
    if (this.uin.includes(bot_id) && this.bots[bot_id]) {
      return this.bots[bot_id].pickGroup(group_id).sendMsg(...args);
    }

    // 等待 Bot 上线
    return new Promise((resolve, reject) => {
      const listener = (data) => {
        resolve(data.bot.pickGroup(group_id).sendMsg(...args));
        clearTimeout(timeout);
        if (this.activeTimeouts) {
          this.activeTimeouts.delete(timeout);
        }
      };

      const timeout = setTimeout(() => {
        reject(Object.assign(Error("等待 Bot 上线超时"),
          { bot_id, group_id, args }));
        this.off(`connect.${bot_id}`, listener);
        if (this.activeTimeouts) {
          this.activeTimeouts.delete(timeout);
        }
      }, 300000);

      // 追踪定时器
      if (this.activeTimeouts) {
        this.activeTimeouts.add(timeout);
      }

      this.once(`connect.${bot_id}`, listener);
    });
  }

  /**
   * 发送主人消息
   * @async
   * @param {string} msg - 消息内容
   * @param {number} sleep - 发送间隔
   * @returns {Promise<Object>} 发送结果
   */
  async sendMasterMsg(msg, sleep = 5000) {
    const masterQQs = cfg.masterQQ;
    if (!masterQQs?.length) {
      throw new Error("未配置主人 QQ");
    }

    const results = {};

    for (let i = 0; i < masterQQs.length; i++) {
      const user_id = masterQQs[i];

      try {
        const friend = this.pickFriend(user_id);
        if (friend?.sendMsg) {
          results[user_id] = await friend.sendMsg(msg);
          BotUtil.makeLog("debug", `成功发送消息给主人 ${user_id}`, 'Server');
        } else {
          results[user_id] = { error: "无法找到可用的 Bot" };
          BotUtil.makeLog("warn", `无法向主人 ${user_id} 发送消息`, 'Server');
        }

        // 发送间隔
        if (sleep && i < masterQQs.length - 1) {
          await BotUtil.sleep(sleep);
        }
      } catch (err) {
        results[user_id] = { error: err.message };
        BotUtil.makeLog("error",
          `向主人 ${user_id} 发送消息失败: ${err.message}`, 'Server');
      }
    }

    return results;
  }

  /**
   * 创建转发消息
   * @param {Array} msg - 消息数组
   * @returns {Object} 转发消息对象
   */
  makeForwardMsg(msg) {
    return { type: "node", data: msg };
  }

  /**
   * 发送转发消息
   * @async
   * @param {Function} send - 发送函数
   * @param {Array|Object} msg - 消息内容
   * @returns {Promise<Array>} 发送结果
   */
  async sendForwardMsg(send, msg) {
    const messages = Array.isArray(msg) ? msg : [msg];
    return Promise.all(messages.map(({ message }) => send(message)));
  }

  /**
   * 退出 Redis
   * @async
   * @returns {Promise<boolean>} 是否成功
   */
  async redisExit() {
    if (!(typeof redis === 'object' && redis.process)) return false;

    const process = redis.process;
    delete redis.process;

    await BotUtil.sleep(5000, redis.save().catch(() => { }));
    return process.kill();
  }

  /**
   * 文件转 URL
   * @async
   * @param {string|Buffer} file - 文件
   * @param {Object} opts - 选项
   * @returns {Promise<string>} 文件 URL
   */
  async fileToUrl(file, opts = {}) {
    return await BotUtil.fileToUrl(file, opts);
  }
}