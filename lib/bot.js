import path from 'path';
import fs from 'node:fs/promises';
import fsSync from 'fs';
import { EventEmitter } from 'events';
import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import os from 'node:os';
import dgram from 'node:dgram';
import crypto from 'crypto';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// 模块导入
import PluginsLoader from './plugins/loader.js';
import ListenerLoader from './listener/loader.js';
import ApiLoader from './http/loader.js';
import init from './config/loader.js';
import BotUtil from './common/util.js';
import cfg from './config/config.js';

/**
 * Bot 主类
 * @class Bot
 * @extends EventEmitter
 */
export default class Bot extends EventEmitter {
  constructor() {
    super();
    
    // 初始化基础属性
    this.stat = { start_time: Date.now() / 1000 };
    this.bot = this;
    this.bots = {};
    this.adapter = [];
    this.wsf = Object.create(null);
    this.fs = Object.create(null);
    this.apiKey = '';
    this._cache = null;
    this._rateLimiters = new Map();
    
    // 初始化 UIN 数组
    this.initUinArray();
    
    // 初始化服务器组件
    this.initServers();
    
    // 初始化缓存
    this._cache = BotUtil.getMap('yunzai_cache', { 
      ttl: 60000, 
      autoClean: true 
    });
    
    // 配置中间件和路由
    this.setupMiddleware();
    this.setupStaticServing();
    this.setupAPIRoutes();
    
    // 注册进程信号处理
    this.registerProcessHandlers();
    
    // 生成 API 密钥
    this.generateApiKey();
    
    // 返回代理对象
    return this.createProxy();
  }

  /**
   * 初始化 UIN 数组
   */
  initUinArray() {
    this.uin = Object.assign([], {
      toJSON() {
        if (!this.now) {
          switch (this.length) {
            case 0: return "";
            case 1:
            case 2: return this[this.length - 1];
          }
          const array = this.slice(1);
          this.now = array[Math.floor(Math.random() * array.length)];
          // 修复：确保超时值在合理范围内
          setTimeout(() => delete this.now, Math.min(60000, 2147483647));
        }
        return this.now;
      },
      toString(raw, ...args) {
        return raw === true 
          ? this.__proto__.toString.apply(this, args) 
          : this.toJSON().toString(raw, ...args);
      },
      includes(value) {
        return this.some(i => i == value);
      }
    });
  }

  /**
   * 初始化服务器组件
   */
  initServers() {
    // Express 应用
    this.express = Object.assign(express(), { 
      skip_auth: [], 
      quiet: [] 
    });
    
    // HTTP 服务器
    this.server = http.createServer(this.express)
      .on("error", this.handleServerError.bind(this))
      .on("upgrade", this.wsConnect.bind(this));
    
    // WebSocket 服务器
    this.wss = new WebSocketServer({ noServer: true });
  }

  /**
   * 创建代理对象
   */
  createProxy() {
    return new Proxy(this.bots, {
      get: (target, prop) => {
        // 优先返回 target 中的属性
        if (target[prop] !== undefined) return target[prop];
        
        // 其次返回 this 中的属性
        if (this[prop] !== undefined) return this[prop];
        
        // 再次返回 BotUtil 中的属性
        const utilValue = BotUtil[prop];
        if (utilValue !== undefined) {
          return typeof utilValue === 'function' 
            ? utilValue.bind(BotUtil) 
            : utilValue;
        }
        
        // 最后尝试从 bots 中查找
        for (const i of [this.uin.toString(), ...this.uin]) {
          const bot = target[i];
          if (bot && bot[prop] !== undefined) {
            BotUtil.makeLog("trace", `重定向: Bot.${prop} -> Bot.${i}.${prop}`);
            return typeof bot[prop] === "function" && bot[prop].bind
              ? bot[prop].bind(bot)
              : bot[prop];
          }
        }
        
        BotUtil.makeLog("trace", `属性不存在: Bot.${prop}`);
        return undefined;
      }
    });
  }

  /**
   * 注册进程信号处理
   */
  registerProcessHandlers() {
    process.on('SIGINT', async () => await this.closeServer());
    process.on('SIGTERM', async () => await this.closeServer());
  }

  /**
   * 处理服务器错误
   */
  handleServerError(err, isHttps = false) {
    const handler = this[`server${err.code}`];
    if (typeof handler === "function") {
      return handler.call(this, err, isHttps);
    }
    BotUtil.makeLog("error", err, "Server");
  }

  /**
   * 配置中间件
   */
  setupMiddleware() {
    const app = this.express;
    
    // 压缩中间件
    if (cfg.server?.compression !== false) {
      app.use(compression({
        filter: (req, res) => {
          if (req.headers['x-no-compression']) return false;
          return compression.filter(req, res);
        },
        level: 6
      }));
    }
    
    // 安全头部中间件
    if (cfg.server?.security?.helmet !== false) {
      app.use(helmet({
        contentSecurityPolicy: cfg.server?.security?.csp || false,
        crossOriginEmbedderPolicy: false
      }));
    }
    
    // CORS 配置
    app.use(this.corsMiddleware.bind(this));
    
    // 请求日志中间件
    if (cfg.server?.logging?.requests !== false) {
      app.use(this.requestLogger.bind(this));
    }
  }

  /**
   * CORS 中间件
   */
  corsMiddleware(req, res, next) {
    const allowedOrigins = cfg.server?.cors?.origins || ['*'];
    const origin = req.headers.origin;
    
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin || '*');
    }
    
    res.header('Access-Control-Allow-Methods', 
      cfg.server?.cors?.methods || 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 
      cfg.server?.cors?.headers || 'Origin, X-Requested-With, Content-Type, Accept, X-API-Key, Authorization');
    res.header('Access-Control-Allow-Credentials', 
      cfg.server?.cors?.credentials ? 'true' : 'false');
    
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  }

  /**
   * 请求日志记录器
   */
  requestLogger(req, res, next) {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      const isQuiet = this.express.quiet.some(p => req.path.startsWith(p));
      if (!isQuiet) {
        BotUtil.makeLog('debug', 
          `${req.method} ${req.path} ${res.statusCode} ${duration}ms`, 
          'HTTP');
      }
    });
    next();
  }

  /**
   * 配置静态文件服务
   */
  setupStaticServing() {
    const staticDirs = cfg.server?.static || [
      { 
        route: '/www', 
        path: 'www',
        options: {
          index: true,
          dotfiles: 'deny',
          extensions: ['html', 'htm'],
          fallthrough: true,
          maxAge: '1d'
        }
      }
    ];

    staticDirs.forEach(dir => this.setupStaticDirectory(dir));
    this.setupFavicon();
  }

  /**
   * 配置单个静态目录
   */
  setupStaticDirectory(dir) {
    const dirPath = path.isAbsolute(dir.path) 
      ? dir.path 
      : path.join(process.cwd(), dir.path);

    // 确保目录存在
    if (!fsSync.existsSync(dirPath)) {
      fsSync.mkdirSync(dirPath, { recursive: true });
    }

    // 配置静态文件选项
    const staticOptions = this.createStaticOptions(dir);
    
    // 安全中间件
    this.express.use(dir.route, this.staticSecurityMiddleware);
    
    // 应用静态文件服务
    this.express.use(dir.route, express.static(dirPath, staticOptions));
    
    // 目录浏览（可选）
    if (dir.options?.browse) {
      this.express.use(dir.route, this.createDirectoryListing(dirPath));
    }

    BotUtil.makeLog('info', `静态服务: ${dir.route} -> ${dirPath}`, 'Server');
  }

  /**
   * 创建静态文件选项
   */
  createStaticOptions(dir) {
    return {
      index: dir.options?.index !== false ? ['index.html', 'index.htm'] : false,
      dotfiles: dir.options?.dotfiles || 'deny',
      extensions: dir.options?.extensions || false,
      fallthrough: dir.options?.fallthrough !== false,
      maxAge: dir.options?.maxAge || '1d',
      etag: dir.options?.etag !== false,
      lastModified: dir.options?.lastModified !== false,
      setHeaders: this.createSetHeaders(dir)
    };
  }

  /**
   * 创建设置头部函数
   */
  createSetHeaders(dir) {
    return (res, filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = this.getMimeType(ext);
      
      if (mimeType) {
        res.setHeader('Content-Type', mimeType);
      }
      
      // 安全头部
      res.setHeader('X-Content-Type-Options', 'nosniff');
      
      // 缓存控制
      this.setCacheControl(res, ext, dir.options?.maxAge);
      
      // 自定义头部
      if (dir.options?.headers) {
        Object.entries(dir.options.headers).forEach(([key, value]) => {
          res.setHeader(key, value);
        });
      }
    };
  }

  /**
   * 获取 MIME 类型
   */
  getMimeType(ext) {
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
      '.ico': 'image/x-icon'
    };
    return mimeTypes[ext];
  }

  /**
   * 设置缓存控制
   */
  setCacheControl(res, ext, maxAge) {
    if (ext === '.html' || ext === '.htm') {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else if (ext === '.css' || ext === '.js') {
      res.setHeader('Cache-Control', `public, max-age=${maxAge || 86400}`);
    } else if (ext === '.json') {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }

  /**
   * 静态文件安全中间件
   */
  staticSecurityMiddleware(req, res, next) {
    const normalizedPath = path.normalize(req.path);
    
    // 防止路径遍历
    if (normalizedPath.includes('..')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
    // 检查隐藏文件
    const hiddenPatterns = [/^\./, /\/\./, /node_modules/, /\.git/, /\.env/, /config\//, /private/];
    
    const isHidden = hiddenPatterns.some(pattern => 
      pattern instanceof RegExp 
        ? pattern.test(normalizedPath) 
        : normalizedPath.includes(pattern)
    );
    
    if (isHidden) {
      return res.status(404).json({ error: 'Not Found' });
    }
    
    next();
  }

  /**
   * 设置 favicon
   */
  setupFavicon() {
    this.express.get('/favicon.ico', (req, res) => {
      const paths = [
        path.join(process.cwd(), 'www', 'favicon.ico'),
        path.join(process.cwd(), 'public', 'favicon.ico'),
        path.join(process.cwd(), 'favicon.ico')
      ];

      for (const faviconPath of paths) {
        if (fsSync.existsSync(faviconPath)) {
          res.set({
            'Content-Type': 'image/x-icon',
            'Cache-Control': 'public, max-age=86400'
          });
          return res.sendFile(faviconPath);
        }
      }

      res.status(204).end();
    });
  }

  /**
   * 配置 API 路由
   */
  setupAPIRoutes() {
    const app = this.express;
    
    // 配置速率限制
    this.setupRateLimit();
    
    // 认证中间件
    app.use(this.serverAuth.bind(this));
    
    // API 端点
    app.use('/status', this.serverStatus.bind(this));
    app.get('/health', this.healthCheck.bind(this));
    
    // 请求体解析
    this.setupBodyParsers();
    
    // 请求处理
    app.use(this.serverHandle.bind(this));
    
    // 文件服务
    app.use('/File', this.fileSend.bind(this));
  }

  /**
   * 配置速率限制
   */
  setupRateLimit() {
    if (cfg.server?.rateLimit?.enabled === false) return;
    
    const createLimiter = (options) => rateLimit({
      windowMs: options.windowMs || 15 * 60 * 1000,
      max: options.max || 100,
      message: options.message || 'Too many requests',
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => this.isLocalConnection(req.ip)
    });

    const apiLimitOptions = cfg.server?.rateLimit?.api || {
      windowMs: 15 * 60 * 1000,
      max: 100
    };
    
    this.express.use('/api', createLimiter(apiLimitOptions));
  }

  /**
   * 配置请求体解析器
   */
  setupBodyParsers() {
    const limits = cfg.server?.limits || {};
    
    this.express.use(express.urlencoded({ 
      extended: false, 
      limit: limits.urlencoded || '10mb' 
    }));
    
    this.express.use(express.json({ 
      limit: limits.json || '10mb' 
    }));
    
    this.express.use(express.raw({ 
      limit: limits.raw || '10mb' 
    }));
    
    this.express.use(express.text({ 
      limit: limits.text || '10mb' 
    }));
  }

  /**
   * 健康检查端点
   */
  healthCheck(req, res) {
    res.json({ 
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: Date.now()
    });
  }

  /**
   * 生成 API 密钥
   */
  async generateApiKey() {
    const apiKeyPath = path.join(process.cwd(), 'config/server_config/api_key.json');

    try {
      // 尝试读取现有密钥
      if (fsSync.existsSync(apiKeyPath)) {
        const keyData = JSON.parse(await fs.readFile(apiKeyPath, 'utf8'));
        this.apiKey = keyData.key;
        if (BotUtil) BotUtil.apiKey = this.apiKey;
        return this.apiKey;
      }
      
      // 生成新密钥
      this.apiKey = BotUtil.randomString(64, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
      
      // 确保目录存在
      const apiKeyDir = path.dirname(apiKeyPath);
      await BotUtil.mkdir(apiKeyDir);
      
      // 保存密钥
      const apiKeyData = {
        key: this.apiKey,
        generated: new Date().toISOString(),
        note: '此密钥用于远程API访问，请妥善保管'
      };

      await fs.writeFile(apiKeyPath, JSON.stringify(apiKeyData, null, 2), 'utf8');

      // 设置文件权限（仅限 Unix）
      if (process.platform !== 'win32') {
        try {
          await fs.chmod(apiKeyPath, 0o600);
        } catch { }
      }

      if (BotUtil) BotUtil.apiKey = this.apiKey;
      BotUtil.makeLog('success', `生成新API密钥: ${this.apiKey}`, 'Server');
      
      return this.apiKey;
      
    } catch (error) {
      BotUtil.makeLog('error', `API密钥处理失败: ${error.message}`, 'Server');
      // 生成临时密钥
      this.apiKey = BotUtil.randomString(64);
      if (BotUtil) BotUtil.apiKey = this.apiKey;
      return this.apiKey;
    }
  }

  /**
   * 检查 API 授权
   */
  checkApiAuthorization(req) {
    if (!req) return false;

    const remoteAddress = req.socket?.remoteAddress ?? req.ip ?? "";

    // 本地连接跳过认证
    if (this.isLocalConnection(remoteAddress)) return true;

    // 检查白名单路径
    const whitelistPaths = cfg.server?.auth?.whitelist || [
      '/www', '/public', '/static', '/favicon.ico', '/health'
    ];
    
    if (whitelistPaths.some(path => req.path.startsWith(path))) {
      return true;
    }

    // 提取认证密钥
    const authKey = req.headers?.["x-api-key"] ?? 
                   req.headers?.["authorization"]?.replace('Bearer ', '') ??
                   req.query?.api_key ?? 
                   req.body?.api_key;

    if (!this.apiKey || !authKey) {
      BotUtil.makeLog("debug", `API鉴权失败: 缺少密钥`, 'Server');
      return false;
    }

    // 使用时间安全比较
    try {
      const authKeyBuffer = Buffer.from(String(authKey));
      const apiKeyBuffer = Buffer.from(String(this.apiKey));

      if (authKeyBuffer.length !== apiKeyBuffer.length) {
        BotUtil.makeLog("warn", `未授权访问尝试: ${remoteAddress}`, 'Server');
        return false;
      }

      const isValid = crypto.timingSafeEqual(authKeyBuffer, apiKeyBuffer);

      if (!isValid) {
        BotUtil.makeLog("warn", `未授权访问尝试: ${remoteAddress}`, 'Server');
      }

      return isValid;
      
    } catch (error) {
      BotUtil.makeLog("error", `API鉴权错误: ${error.message}`, 'Server');
      return false;
    }
  }

  /**
   * 判断是否为本地连接
   */
  isLocalConnection(address) {
    if (!address || typeof address !== 'string') return false;

    const ip = address.toLowerCase().trim()
      .replace(/^::ffff:/, '')
      .replace(/%.+$/, '');

    return ip === 'localhost' ||
           ip === '127.0.0.1' ||
           ip === '::1' ||
           this.isPrivateIP(ip);
  }

  /**
   * 判断是否为私有 IP
   */
  isPrivateIP(ip) {
    if (!ip) return false;

    // IPv4 私有地址范围
    const ipv4Private = [
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^127\./,
      /^169\.254\./,
      /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./
    ];

    // IPv6 私有地址范围
    const ipv6Private = [
      /^fe80:/i,
      /^fc00:/i,
      /^fd00:/i,
      /^fec0:/i,
      /^ff0[0-9a-f]:/i
    ];

    if (ip.includes('.')) {
      return ipv4Private.some(range => range.test(ip));
    }

    if (ip.includes(':')) {
      return ipv6Private.some(range => range.test(ip));
    }

    return false;
  }

  /**
   * 获取本地 IP 地址
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
      
      // 收集本地 IP 地址
      for (const [name, ifaces] of Object.entries(interfaces)) {
        if (name.toLowerCase().includes('lo') || name.toLowerCase().includes('localhost')) continue;

        for (const iface of ifaces) {
          if (iface.family !== 'IPv4' || iface.internal) continue;

          const info = {
            ip: iface.address,
            interface: name,
            mac: iface.mac,
            virtual: this.isVirtualInterface(name, iface.mac)
          };

          if (this.isPrivateIP(iface.address)) {
            result.local.push(info);
          }
        }
      }

      // 获取主要 IP
      try {
        const primaryIp = await this.getIpByUdp();
        if (primaryIp) {
          result.primary = primaryIp;
          const existing = result.local.find(item => item.ip === primaryIp);
          if (existing) {
            existing.primary = true;
          } else {
            result.local.unshift({
              ip: primaryIp,
              interface: 'auto-detected',
              primary: true
            });
          }
        }
      } catch { }

      // 获取公网 IP（可选）
      if (cfg.server?.detectPublicIP !== false) {
        result.public = await this.getPublicIP();
      }

      this._cache.set(cacheKey, result);
      return result;

    } catch (err) {
      BotUtil.makeLog("debug", `获取IP失败: ${err.message}`, 'Server');
      return result;
    }
  }

  /**
   * 判断是否为虚拟网络接口
   */
  isVirtualInterface(name, mac) {
    const virtualPatterns = [
      /^(docker|br-|veth|virbr|vnet)/i,
      /^(vmnet|vmware)/i,
      /^(vboxnet|virtualbox)/i,
      /^(utun|tap|tun)/i
    ];

    if (virtualPatterns.some(p => p.test(name))) return true;

    // 虚拟 MAC 地址前缀
    const virtualMacPrefixes = [
      '00:50:56', '00:0c:29', '00:05:69', '00:1c:42',
      '08:00:27', '00:15:5d', '02:42:', '00:16:3e', '52:54:00'
    ];

    return mac && virtualMacPrefixes.some(prefix =>
      mac.toLowerCase().startsWith(prefix.toLowerCase())
    );
  }

  /**
   * 通过 UDP 获取本机 IP
   */
  async getIpByUdp() {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      
      // 修复：设置合理的超时时间（3秒）
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('UDP获取IP超时'));
      }, 3000);

      try {
        socket.connect(80, '223.5.5.5', () => {
          clearTimeout(timeout);
          const address = socket.address();
          socket.close();
          resolve(address.address);
        });
      } catch (err) {
        clearTimeout(timeout);
        socket.close();
        reject(err);
      }
    });
  }

  /**
   * 获取公网 IP
   */
  async getPublicIP() {
    const apis = [
      { url: 'https://api.ipify.org?format=json', field: 'ip' },
      { url: 'https://api.myip.la/json', field: 'ip' },
      { url: 'https://api.ip.sb/geoip', field: 'ip' }
    ];

    for (const api of apis) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(api.url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        clearTimeout(timeout);

        if (response.ok) {
          const data = await response.json();
          const ip = api.field.split('.').reduce((obj, key) => obj?.[key], data);
          if (ip && this.isValidIP(ip)) return ip;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * 验证 IP 地址格式
   */
  isValidIP(ip) {
    if (!ip) return false;

    // IPv4 正则
    const ipv4Regex = /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
    if (ipv4Regex.test(ip)) return true;

    // IPv6 正则
    const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
    return ipv6Regex.test(ip);
  }

  /**
   * 服务器认证中间件
   */
  serverAuth(req, res, next) {
    req.rid = `${req.ip}:${req.socket.remotePort}`;
    req.sid = `${req.protocol}://${req.hostname}:${req.socket.localPort}${req.originalUrl}`;

    // 跳过静态资源认证
    const skipAuthPaths = cfg.server?.auth?.skip || [
      '/www', '/public', '/static', '/media', '/favicon.ico', '/health', '/api/files'
    ];

    if (skipAuthPaths.some(path => req.path.startsWith(path))) {
      return next();
    }

    const clientIp = req.ip.replace(/^::ffff:/, '');

    if (this.isLocalConnection(clientIp)) {
      BotUtil.makeLog("debug", `本地连接，跳过鉴权: ${clientIp}`, 'Server');
      return next();
    }

    if (!this.checkApiAuthorization(req)) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or missing API key',
        hint: 'Please provide X-API-Key header or api_key parameter'
      });
      BotUtil.makeLog("error", `HTTP鉴权失败: ${req.method} ${req.originalUrl} from ${req.ip}`, 'Server');
      return;
    }

    next();
  }

  /**
   * 服务器状态端点
   */
  serverStatus(req, res) {
    res.type("json");
    const report = JSON.stringify(process.report?.getReport() || {})
      .replace(/(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)/g, "[IPv4]");
    res.send(report);
  }

  /**
   * 服务器请求处理
   */
  serverHandle(req, res, next) {
    const quiet = this.express.quiet.some(i => req.originalUrl.startsWith(i));
    if (!quiet) {
      BotUtil.makeLog("debug", `HTTP ${req.method} ${req.originalUrl}`, 'Server');
    }
    next();
  }

  /**
   * WebSocket 连接处理
   */
  wsConnect(req, socket, head) {
    const rid = `${req.socket.remoteAddress}:${req.socket.remotePort}-${req.headers["sec-websocket-key"]}`;
    const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? `${req.socket.localAddress}:${req.socket.localPort}`;
    const sid = `ws://${host}${req.url}`;
    
    req.rid = rid;
    req.sid = sid;
    req.query = Object.fromEntries(new URL(sid).searchParams.entries());
    
    const remoteAddress = req.socket.remoteAddress;

    // 认证检查
    if (!this.isLocalConnection(remoteAddress)) {
      if (!this.checkApiAuthorization(req)) {
        BotUtil.makeLog("error", `WebSocket鉴权失败: ${req.url}`, 'Server');
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return socket.destroy();
      }
    }

    // 路径检查
    const path = req.url.split("/")[1];
    if (!(path in this.wsf)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      return socket.destroy();
    }

    // 升级连接
    this.wss.handleUpgrade(req, socket, head, conn => {
      BotUtil.makeLog("debug", `WebSocket连接建立: ${req.url}`, 'Server');
      
      conn.on("error", err => BotUtil.makeLog("error", err, 'Server'));
      conn.on("close", () => BotUtil.makeLog("debug", `WebSocket断开: ${req.url}`, 'Server'));
      
      // 消息处理
      conn.on("message", msg => {
        const logMsg = Buffer.isBuffer(msg) && msg.length > 1024
          ? `[Binary message, length: ${msg.length}]`
          : BotUtil.String(msg);
        BotUtil.makeLog("trace", `WS消息: ${logMsg}`, 'Server');
      });
      
      // 发送消息包装
      conn.sendMsg = msg => {
        if (!Buffer.isBuffer(msg)) msg = BotUtil.String(msg);
        const logMsg = Buffer.isBuffer(msg) && msg.length > 1024
          ? `[Binary send, length: ${msg.length}]`
          : msg;
        BotUtil.makeLog("trace", `WS发送: ${logMsg}`, 'Server');
        return conn.send(msg);
      };
      
      // 调用处理器
      for (const handler of this.wsf[path]) {
        handler(conn, req, socket, head);
      }
    });
  }

  /**
   * 处理端口占用错误
   */
  async serverEADDRINUSE(err, isHttps) {
    BotUtil.makeLog("error", `端口 ${this.port} 已被占用`, 'Server');
    if (!isHttps) {
      this.server_listen_time = (this.server_listen_time || 0) + 1;
      // 修复：确保等待时间合理
      await BotUtil.sleep(Math.min(this.server_listen_time * 1000, 10000));
      this.server.listen(this.port);
    }
  }

  /**
   * 加载服务器
   */
  async serverLoad(isHttps) {
    const server = isHttps ? "httpsServer" : "server";
    const port = this.port;
    
    this[server].listen(port, cfg.server?.host || '0.0.0.0');
    
    await BotUtil.promiseEvent(this[server], "listening", isHttps && "error")
      .catch(() => { });
    
    const { address, port: listenedPort } = this[server].address();
    const protocol = isHttps ? 'https' : 'http';
    
    this.url = cfg.server.url 
      ? `${cfg.server.url}:${listenedPort}` 
      : `${protocol}://${address}:${listenedPort}`;

    // 显示启动信息
    await this.displayServerInfo(protocol, listenedPort);
  }

  /**
   * 显示服务器信息
   */
  async displayServerInfo(protocol, port) {
    BotUtil.makeLog("info", `${cfg.server.name || 'Server'} 启动成功`, 'Server');
    BotUtil.makeLog("info", `API密钥: ${this.apiKey}`, 'Server');

    const addresses = [`${protocol}://localhost:${port}`];
    const ipInfo = await this.getLocalIpAddress();

    // 显示内网地址
    if (ipInfo.local.length > 0) {
      BotUtil.makeLog("info", "内网访问地址:", 'Server');
      ipInfo.local.forEach(info => {
        const url = `${protocol}://${info.ip}:${port}`;
        const label = info.primary ? ' (主要)' : info.virtual ? ' (虚拟)' : '';
        BotUtil.makeLog("info", `  ${url} [${info.interface}]${label}`, 'Server');
        addresses.push(url);
      });
    }

    // 显示公网地址
    if (ipInfo.public) {
      const publicUrl = `${protocol}://${ipInfo.public}:${port}`;
      BotUtil.makeLog("info", `外网访问地址: ${publicUrl}`, 'Server');
      addresses.push(publicUrl);
    }

    // 显示配置地址
    if (cfg.server.url) {
      BotUtil.makeLog("info", `配置地址: ${cfg.server.url}:${port}`, 'Server');
    }

    // 显示静态目录
    const staticDirs = cfg.server?.static || [{ route: '/www', path: 'www' }];
    staticDirs.forEach(dir => {
      BotUtil.makeLog("info", `静态目录: ${addresses[0]}${dir.route}`, 'Server');
    });
  }

  /**
   * 加载 HTTPS 服务器
   */
  async httpsLoad() {
    if (!cfg.server.https?.enabled || !cfg.server.https?.key || !cfg.server.https?.cert) {
      return;
    }
    
    try {
      const https = await import("node:https");
      this.httpsServer = https.createServer({
        key: await fs.readFile(cfg.server.https.key),
        cert: await fs.readFile(cfg.server.https.cert),
      }, this.express)
        .on("error", err => this.handleServerError(err, true))
        .on("upgrade", this.wsConnect.bind(this));
      
      await this.serverLoad(true);
    } catch (err) {
      BotUtil.makeLog("error", `HTTPS服务器创建失败: ${err.message}`, 'Server');
    }
  }

  /**
   * 启动服务器
   */
  async run(options = {}) {
    const { port } = options;
    this.port = port;

    // 初始化配置
    await init();
    await this.generateApiKey();
    
    // 加载插件和 API
    await PluginsLoader.load();
    await ApiLoader.load();
    await ApiLoader.register(this.express, this);
    
    // 启动服务器
    await this.serverLoad(false);
    if (cfg.server.https?.enabled) {
      await this.httpsLoad();
    }

    // 设置 404 处理
    this.express.use((req, res) => {
      const defaultRoute = cfg.server?.defaultRoute || '/www';
      if (req.accepts('html')) {
        res.redirect(defaultRoute);
      } else {
        res.status(404).json({ error: 'Not Found' });
      }
    });

    // 加载监听器
    await ListenerLoader.load();
    await ApiLoader.watch(true);

    // 显示 WebSocket 信息
    if (Object.keys(this.wsf).length > 0) {
      const wsUrl = this.url.replace(/^http/, "ws");
      BotUtil.makeLog("info", `WebSocket服务: ${wsUrl}/ [${Object.keys(this.wsf).join(', ')}]`, 'Server');
    }

    // 触发上线事件
    this.emit("online", {
      bot: this,
      timestamp: Date.now(),
      url: this.url,
      uptime: process.uptime(),
      apis: ApiLoader.getApiList()
    });
  }

  /**
   * 关闭服务器
   */
  async closeServer() {
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
    }
    if (this.httpsServer) {
      await new Promise(resolve => this.httpsServer.close(resolve));
    }
    
    // 修复：使用合理的延迟时间
    await BotUtil.sleep(2000);
    await this.redisExit();
  }

  /**
   * 文件转 URL
   */
  async fileToUrl(file, opts = {}) {
    return await BotUtil.fileToUrl(file, opts);
  }

  /**
   * 文件发送处理
   */
  fileSend(req, res) {
    const url = req.url.replace(/^\//, "");
    let file = this.fs[url];
    
    if (!file) {
      file = this.fs[404];
      if (!file) {
        return res.status(404).send('Not Found');
      }
    }

    // 处理访问次数限制
    if (typeof file.times === "number") {
      if (file.times > 0) {
        file.times--;
      } else {
        file = this.fs.timeout;
        if (!file) {
          return res.status(410).send('Gone');
        }
      }
    }

    // 设置响应头
    if (file.type?.mime) {
      res.setHeader("Content-Type", file.type.mime);
    }
    
    BotUtil.makeLog("debug", `文件发送: ${file.name} (${BotUtil.formatFileSize(file.buffer.length)})`, 'Server');
    res.send(file.buffer);
  }

  /**
   * 准备事件数据
   */
  prepareEvent(data) {
    if (!this.bots[data.self_id]) return;

    // 设置 bot 属性
    if (!data.bot) {
      Object.defineProperty(data, "bot", { 
        value: this.bots[data.self_id] 
      });
    }

    // 处理设备相关
    this.prepareDeviceEvent(data);
    
    // 处理用户相关
    this.prepareUserEvent(data);
    
    // 处理群组相关
    this.prepareGroupEvent(data);
    
    // 设置适配器信息
    if (data.bot.adapter?.id) data.adapter_id = data.bot.adapter.id;
    if (data.bot.adapter?.name) data.adapter_name = data.bot.adapter.name;

    // 扩展方法
    this.extendEventMethods(data);
    
    // 设置回复方法
    this.setupReplyMethod(data);
  }

  /**
   * 准备设备事件
   */
  prepareDeviceEvent(data) {
    if (data.post_type === 'device' || data.device_id) {
      const deviceBot = this.bots[data.device_id];
      if (deviceBot) {
        data.device = deviceBot;
        data.sendCommand = (cmd, params) => deviceBot.sendCommand(cmd, params);
        data.display = (text, x, y, clear) => deviceBot.display(text, x, y, clear);
        data.getDeviceLogs = (filter) => deviceBot.getLogs(filter);
        data.hasCapability = (cap) => deviceBot.hasCapability(cap);
        data.rebootDevice = () => deviceBot.reboot();

        if (!data.reply) {
          data.reply = async (msg, options = {}) => {
            if (options.command) {
              return await deviceBot.sendCommand(options.command, options.parameters || {});
            }
            return await deviceBot.display(msg);
          };
        }
      }
    }
  }

  /**
   * 准备用户事件
   */
  prepareUserEvent(data) {
    if (data.user_id) {
      if (!data.friend) {
        Object.defineProperty(data, "friend", {
          value: data.bot.pickFriend(data.user_id)
        });
      }
      data.sender ||= { user_id: data.user_id };
      data.sender.nickname ||= data.friend?.name || data.friend?.nickname;
    }
  }

  /**
   * 准备群组事件
   */
  prepareGroupEvent(data) {
    if (data.group_id) {
      if (!data.group) {
        Object.defineProperty(data, "group", {
          value: data.bot.pickGroup(data.group_id)
        });
      }
      data.group_name ||= data.group?.name || data.group?.group_name;
    }

    if (data.group && data.user_id) {
      if (!data.member) {
        Object.defineProperty(data, "member", {
          value: data.group.pickMember(data.user_id)
        });
      }
      data.sender.nickname ||= data.member?.name || data.member?.nickname;
      data.sender.card ||= data.member?.card;
    }
  }

  /**
   * 扩展事件方法
   */
  extendEventMethods(data) {
    for (const obj of [data.friend, data.group, data.member]) {
      if (typeof obj !== "object" || !obj) continue;

      obj.sendFile ??= (file, name) => obj.sendMsg(segment.file(file, name));
      obj.makeForwardMsg ??= this.makeForwardMsg;
      obj.sendForwardMsg ??= msg => this.sendForwardMsg(m => obj.sendMsg(m), msg);
      obj.getInfo ??= () => obj.info || obj;
    }
  }

  /**
   * 设置回复方法
   */
  setupReplyMethod(data) {
    if (!data.reply) {
      if (data.group?.sendMsg) {
        data.reply = data.group.sendMsg.bind(data.group);
      } else if (data.friend?.sendMsg) {
        data.reply = data.friend.sendMsg.bind(data.friend);
      }
    }
  }

  /**
   * 触发事件
   */
  em(name = "", data = {}) {
    this.prepareEvent(data);
    
    while (true) {
      this.emit(name, data);
      const i = name.lastIndexOf(".");
      if (i === -1) break;
      name = name.slice(0, i);
    }
  }

  // ========== Bot 管理方法 ==========

  /**
   * 获取好友数组
   */
  getFriendArray() {
    const array = [];
    for (const bot_id of this.uin) {
      const bot = this.bots[bot_id];
      if (!bot?.fl) continue;
      for (const [id, i] of bot.fl) {
        array.push({ ...i, bot_id });
      }
    }
    return array;
  }

  /**
   * 获取好友列表
   */
  getFriendList() {
    const array = [];
    for (const bot_id of this.uin) {
      const bot = this.bots[bot_id];
      if (!bot?.fl) continue;
      array.push(...bot.fl.keys());
    }
    return array;
  }

  /**
   * 获取好友映射
   */
  getFriendMap() {
    const map = new Map();
    for (const bot_id of this.uin) {
      const bot = this.bots[bot_id];
      if (!bot?.fl) continue;
      for (const [id, i] of bot.fl) {
        map.set(id, { ...i, bot_id });
      }
    }
    return map;
  }
  get fl() { return this.getFriendMap(); }

  /**
   * 获取群组数组
   */
  getGroupArray() {
    const array = [];
    for (const bot_id of this.uin) {
      const bot = this.bots[bot_id];
      if (!bot?.gl) continue;
      for (const [id, i] of bot.gl) {
        array.push({ ...i, bot_id });
      }
    }
    return array;
  }

  /**
   * 获取群组列表
   */
  getGroupList() {
    const array = [];
    for (const bot_id of this.uin) {
      const bot = this.bots[bot_id];
      if (!bot?.gl) continue;
      array.push(...bot.gl.keys());
    }
    return array;
  }

  /**
   * 获取群组映射
   */
  getGroupMap() {
    const map = new Map();
    for (const bot_id of this.uin) {
      const bot = this.bots[bot_id];
      if (!bot?.gl) continue;
      for (const [id, i] of bot.gl) {
        map.set(id, { ...i, bot_id });
      }
    }
    return map;
  }
  get gl() { return this.getGroupMap(); }

  /**
   * 获取群成员列表
   */
  get gml() {
    const map = new Map();
    for (const bot_id of this.uin) {
      const bot = this.bots[bot_id];
      if (!bot?.gml) continue;
      for (const [id, i] of bot.gml) {
        map.set(id, Object.assign(new Map(i), { bot_id }));
      }
    }
    return map;
  }

  /**
   * 选择好友
   */
  pickFriend(user_id, strict) {
    user_id = Number(user_id) === user_id ? Number(user_id) : user_id;
    const mainBot = this.bots[this.uin];
    
    if (mainBot?.fl?.has(user_id)) {
      return mainBot.pickFriend(user_id);
    }

    let user = this.fl.get(user_id);
    
    if (!user) {
      for (const [id, ml] of this.gml) {
        const memberUser = ml.get(user_id);
        if (memberUser) {
          user = memberUser;
          user.bot_id = ml.bot_id;
          break;
        }
      }
    }

    if (user) return this.bots[user.bot_id].pickFriend(user_id);
    if (strict) return false;

    BotUtil.makeLog("trace", `用户 ${user_id} 不存在，随机选择Bot: ${this.uin.toJSON()}`, 'Server');
    return this.bots[this.uin].pickFriend(user_id);
  }
  get pickUser() { return this.pickFriend; }

  /**
   * 选择群组
   */
  pickGroup(group_id, strict) {
    group_id = Number(group_id) === group_id ? Number(group_id) : group_id;
    const mainBot = this.bots[this.uin];
    
    if (mainBot?.gl?.has(group_id)) {
      return mainBot.pickGroup(group_id);
    }

    const group = this.gl.get(group_id);
    if (group) return this.bots[group.bot_id].pickGroup(group_id);
    if (strict) return false;

    BotUtil.makeLog("trace", `群 ${group_id} 不存在，随机选择Bot: ${this.uin.toJSON()}`, 'Server');
    return this.bots[this.uin].pickGroup(group_id);
  }

  /**
   * 选择群成员
   */
  pickMember(group_id, user_id) {
    return this.pickGroup(group_id).pickMember(user_id);
  }

  /**
   * 发送好友消息
   */
  sendFriendMsg(bot_id, user_id, ...args) {
    if (!bot_id) {
      return this.pickFriend(user_id).sendMsg(...args);
    }
    
    if (this.uin.includes(bot_id) && this.bots[bot_id]) {
      return this.bots[bot_id].pickFriend(user_id).sendMsg(...args);
    }
    
    if (this.pickFriend(bot_id, true)) {
      return this.pickFriend(bot_id).sendMsg(user_id, ...args);
    }

    // 等待 Bot 上线
    return new Promise((resolve, reject) => {
      const listener = data => {
        resolve(data.bot.pickFriend(user_id).sendMsg(...args));
        clearTimeout(timeout);
      };
      
      // 修复：设置合理的超时时间（5分钟）
      const timeout = setTimeout(() => {
        reject(Object.assign(Error("等待 Bot 上线超时"), { bot_id, user_id, args }));
        this.off(`connect.${bot_id}`, listener);
      }, 300000);
      
      this.once(`connect.${bot_id}`, listener);
    });
  }

  /**
   * 发送群组消息
   */
  sendGroupMsg(bot_id, group_id, ...args) {
    if (!bot_id) {
      return this.pickGroup(group_id).sendMsg(...args);
    }
    
    if (this.uin.includes(bot_id) && this.bots[bot_id]) {
      return this.bots[bot_id].pickGroup(group_id).sendMsg(...args);
    }
    
    if (this.pickGroup(bot_id, true)) {
      return this.pickGroup(bot_id).sendMsg(group_id, ...args);
    }

    // 等待 Bot 上线
    return new Promise((resolve, reject) => {
      const listener = data => {
        resolve(data.bot.pickGroup(group_id).sendMsg(...args));
        clearTimeout(timeout);
      };
      
      // 修复：设置合理的超时时间（5分钟）
      const timeout = setTimeout(() => {
        reject(Object.assign(Error("等待 Bot 上线超时"), { bot_id, group_id, args }));
        this.off(`connect.${bot_id}`, listener);
      }, 300000);
      
      this.once(`connect.${bot_id}`, listener);
    });
  }

  /**
   * 获取文本消息
   */
  getTextMsg(fnc = () => true) {
    if (typeof fnc !== "function") {
      const condition = fnc;
      fnc = data => data.self_id == condition.self_id && data.user_id == condition.user_id;
    }
    
    return new Promise(resolve => {
      const listener = data => {
        if (!fnc(data)) return;
        
        let msg = "";
        for (const i of data.message) {
          if (i.type === "text" && i.text) {
            msg += i.text.trim();
          }
        }
        
        if (msg) {
          resolve(msg);
          this.off("message", listener);
        }
      };
      
      this.on("message", listener);
    });
  }

  /**
   * 获取主人消息
   */
  getMasterMsg() {
    return this.getTextMsg(data => {
      if (!cfg.masterQQ) return false;
      return cfg.masterQQ.includes(String(data.user_id));
    });
  }

  /**
   * 发送主人消息
   */
  async sendMasterMsg(msg, sleep = 5000) {
    const masterQQs = cfg.masterQQ;
    if (!masterQQs || masterQQs.length === 0) {
      throw new Error("未配置主人QQ");
    }

    const results = {};

    for (let i = 0; i < masterQQs.length; i++) {
      const user_id = masterQQs[i];
      
      try {
        const friend = this.pickFriend(user_id);
        
        if (friend && friend.sendMsg) {
          results[user_id] = await friend.sendMsg(msg);
          BotUtil.makeLog("debug", `成功发送消息给主人 ${user_id}`, 'Server');
        } else {
          results[user_id] = { error: "无法找到可用的Bot发送消息" };
          BotUtil.makeLog("warn", `无法向主人 ${user_id} 发送消息`, 'Server');
        }

        // 发送间隔
        if (sleep && i < masterQQs.length - 1) {
          // 修复：确保睡眠时间合理
          await BotUtil.sleep(Math.min(sleep, 60000));
        }
      } catch (err) {
        results[user_id] = { error: err.message };
        BotUtil.makeLog("error", `向主人 ${user_id} 发送消息失败: ${err.message}`, 'Server');
      }
    }

    return results;
  }

  /**
   * 创建转发消息
   */
  makeForwardMsg(msg) {
    return { type: "node", data: msg };
  }

  /**
   * 创建转发消息数组
   */
  makeForwardArray(msg = [], node = {}) {
    const messages = Array.isArray(msg) ? msg : [msg];
    return this.makeForwardMsg(
      messages.map(message => ({ ...node, message }))
    );
  }

  /**
   * 发送转发消息
   */
  async sendForwardMsg(send, msg) {
    const messages = Array.isArray(msg) ? msg : [msg];
    return Promise.all(
      messages.map(({ message }) => send(message))
    );
  }

  /**
   * Redis 退出处理
   */
  async redisExit() {
    if (!(typeof redis === 'object' && redis.process)) {
      return false;
    }
    
    const p = redis.process;
    delete redis.process;
    
    // 修复：使用合理的等待时间
    await Promise.race([
      BotUtil.sleep(5000),
      redis.save().catch(() => {})
    ]);
    
    return p.kill();
  }

  /**
   * 创建目录列表
   */
  async createDirectoryListing(dirPath) {
    return async (req, res, next) => {
      const fullPath = path.join(dirPath, req.path);
      
      try {
        const stat = await fs.stat(fullPath);
        if (!stat.isDirectory()) return next();

        const files = await fs.readdir(fullPath);
        const fileList = await Promise.all(files.map(async file => {
          const filePath = path.join(fullPath, file);
          const fileStat = await fs.stat(filePath);
          return {
            name: file,
            isDirectory: fileStat.isDirectory(),
            size: fileStat.size,
            modified: fileStat.mtime
          };
        }));

        res.json({
          path: req.path,
          files: fileList.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) {
              return a.isDirectory ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
          })
        });
      } catch (error) {
        next();
      }
    };
  }
}