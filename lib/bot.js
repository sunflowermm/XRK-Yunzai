/**
 * Yunzai Bot 核心类
 * @description 处理机器人服务器、WebSocket、API路由等核心功能
 * @author XRK-Yunzai
 */

import path from 'path';
import fs from 'node:fs/promises';
import * as fsSync from 'fs';
import { EventEmitter } from "events";
import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import os from 'node:os';
import dgram from 'node:dgram';
import crypto from 'crypto';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// 内部模块
import PluginsLoader from "./plugins/loader.js";
import ListenerLoader from "./listener/loader.js";
import ApiLoader from "./http/loader.js";
import init from "./config/loader.js";
import BotUtil from './common/util.js';
import cfg from './config/config.js';

/**
 * Bot 核心类
 * @extends EventEmitter
 */
export default class Bot extends EventEmitter {
  constructor() {
    super();
    
    // 核心属性初始化
    this.initializeProperties();
    
    // 设置中间件
    this.setupMiddleware();
    
    // 设置静态文件服务
    this.setupStaticServing();
    
    // 设置API路由
    this.setupAPIRoutes();
    
    // 设置进程信号处理
    this.setupProcessHandlers();
    
    // 生成API密钥
    this.generateApiKey();
    
    // 返回代理对象
    return this.createBotProxy();
  }

  /**
   * 初始化核心属性
   */
  initializeProperties() {
    // 统计信息
    this.stat = { start_time: Date.now() / 1000 };
    
    // Bot相关
    this.bot = this;
    this.bots = {};
    this.adapter = [];
    
    // UIN数组（支持多账号）
    this.uin = this.createUinArray();
    
    // Express应用
    this.express = Object.assign(express(), { 
      skip_auth: [], 
      quiet: [] 
    });
    
    // HTTP服务器
    this.server = this.createHttpServer();
    
    // WebSocket
    this.wss = new WebSocketServer({ noServer: true });
    this.wsf = Object.create(null);
    
    // 文件系统
    this.fs = Object.create(null);
    
    // API密钥
    this.apiKey = '';
    
    // 缓存系统
    this._cache = BotUtil.getMap('yunzai_cache', { 
      ttl: 60000, 
      autoClean: true 
    });
    
    // 速率限制器
    this._rateLimiters = new Map();
    
    // API加载器引用
    this.ApiLoader = ApiLoader;
  }

  /**
   * 创建特殊的UIN数组
   */
  createUinArray() {
    return Object.assign([], {
      toJSON() {
        if (!this.now) {
          switch (this.length) {
            case 0: return "";
            case 1:
            case 2: return this[this.length - 1];
          }
          const array = this.slice(1);
          this.now = array[Math.floor(Math.random() * array.length)];
          // 修复：使用较小的超时值，避免32位整数溢出
          setTimeout(() => delete this.now, 60 * 1000); // 60秒
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
   * 创建HTTP服务器
   */
  createHttpServer() {
    return http.createServer(this.express)
      .on("error", err => {
        if (typeof this[`server${err.code}`] === "function") {
          return this[`server${err.code}`](err);
        }
        BotUtil.makeLog("error", err, "Server");
      })
      .on("upgrade", this.wsConnect.bind(this));
  }

  /**
   * 创建Bot代理对象
   */
  createBotProxy() {
    return new Proxy(this.bots, {
      get: (target, prop) => {
        // 优先返回bots中的属性
        if (target[prop] !== undefined) return target[prop];
        
        // 然后返回this的属性
        if (this[prop] !== undefined) return this[prop];
        
        // 再尝试BotUtil的属性
        if (BotUtil[prop] !== undefined) {
          return typeof BotUtil[prop] === 'function' 
            ? BotUtil[prop].bind(BotUtil)
            : BotUtil[prop];
        }
        
        // 最后尝试从在线的bot中获取
        for (const uin of [this.uin.toString(), ...this.uin]) {
          const bot = target[uin];
          if (bot && bot[prop] !== undefined) {
            BotUtil.makeLog("trace", `重定向 Bot.${prop} 到 Bot.${uin}.${prop}`);
            return typeof bot[prop] === "function" 
              ? bot[prop].bind(bot)
              : bot[prop];
          }
        }
        
        BotUtil.makeLog("trace", `属性 Bot.${prop} 不存在`);
        return undefined;
      }
    });
  }

  /**
   * 设置Express中间件
   */
  setupMiddleware() {
    // 压缩中间件
    if (cfg.server?.compression !== false) {
      this.express.use(compression({
        filter: (req, res) => {
          if (req.headers['x-no-compression']) return false;
          return compression.filter(req, res);
        },
        level: 6
      }));
    }

    // 安全头部中间件
    if (cfg.server?.security?.helmet !== false) {
      this.express.use(helmet({
        contentSecurityPolicy: cfg.server?.security?.csp || false,
        crossOriginEmbedderPolicy: false
      }));
    }

    // CORS配置
    this.setupCORS();

    // 请求日志中间件
    if (cfg.server?.logging?.requests !== false) {
      this.setupRequestLogging();
    }
  }

  /**
   * 设置CORS
   */
  setupCORS() {
    this.express.use((req, res, next) => {
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
    });
  }

  /**
   * 设置请求日志
   */
  setupRequestLogging() {
    this.express.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        if (!this.express.quiet.some(p => req.path.startsWith(p))) {
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
   */
  setupStaticServing() {
    const staticDirs = cfg.server?.static || [{
      route: '/www',
      path: 'www',
      options: {
        index: true,
        dotfiles: 'deny',
        extensions: ['html', 'htm'],
        fallthrough: true,
        maxAge: '1d'
      }
    }];

    staticDirs.forEach(dir => {
      this.setupStaticDirectory(dir);
    });

    // 处理favicon
    this.setupFavicon();
  }

  /**
   * 设置单个静态目录
   */
  setupStaticDirectory(dir) {
    const dirPath = path.isAbsolute(dir.path) 
      ? dir.path 
      : path.join(process.cwd(), dir.path);

    // 确保目录存在
    if (!fsSync.existsSync(dirPath)) {
      fsSync.mkdirSync(dirPath, { recursive: true });
    }

    // 安全中间件
    this.express.use(dir.route, this.createSecurityMiddleware());

    // 静态文件服务
    const staticOptions = this.createStaticOptions(dir);
    this.express.use(dir.route, express.static(dirPath, staticOptions));

    // 目录浏览（可选）
    if (dir.options?.browse) {
      this.express.use(dir.route, this.createDirectoryListing(dirPath));
    }

    BotUtil.makeLog('info', `静态服务: ${dir.route} -> ${dirPath}`, 'Server');
  }

  /**
   * 创建安全中间件
   */
  createSecurityMiddleware() {
    return (req, res, next) => {
      const normalizedPath = path.normalize(req.path);
      
      // 防止路径遍历
      if (normalizedPath.includes('..')) {
        return res.status(403).json({ error: '禁止访问' });
      }

      // 检查隐藏文件
      const hiddenPatterns = cfg.server?.security?.hiddenFiles || [
        /^\./,
        /\/\./,
        /node_modules/,
        /\.git/,
        /\.env/,
        /config\//,
        /private/
      ];

      if (hiddenPatterns.some(pattern => 
        pattern instanceof RegExp 
          ? pattern.test(normalizedPath) 
          : normalizedPath.includes(pattern)
      )) {
        return res.status(404).json({ error: '文件未找到' });
      }

      next();
    };
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
      setHeaders: (res, filePath) => this.setStaticHeaders(res, filePath, dir)
    };
  }

  /**
   * 设置静态文件头部
   */
  setStaticHeaders(res, filePath, dir) {
    const ext = path.extname(filePath).toLowerCase();
    
    // MIME类型映射
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

    if (mimeTypes[ext]) {
      res.setHeader('Content-Type', mimeTypes[ext]);
    }

    // 安全头部
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // 缓存控制
    if (ext === '.html' || ext === '.htm') {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }

    // 自定义头部
    if (dir.options?.headers) {
      Object.entries(dir.options.headers).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
    }
  }

  /**
   * 设置favicon
   */
  setupFavicon() {
    this.express.get('/favicon.ico', (req, res) => {
      const faviconPaths = [
        path.join(process.cwd(), 'www', 'favicon.ico'),
        path.join(process.cwd(), 'public', 'favicon.ico'),
        path.join(process.cwd(), 'favicon.ico')
      ];

      for (const faviconPath of faviconPaths) {
        if (fsSync.existsSync(faviconPath)) {
          res.set('Content-Type', 'image/x-icon');
          res.set('Cache-Control', 'public, max-age=86400');
          return res.sendFile(faviconPath);
        }
      }

      res.status(204).end();
    });
  }

  /**
   * 设置API路由
   */
  setupAPIRoutes() {
    // 速率限制
    this.setupRateLimit();
    
    // 认证中间件
    this.express.use(this.serverAuth.bind(this));
    
    // 状态端点
    this.express.use('/status', this.serverStatus.bind(this));
    
    // 健康检查
    this.express.get('/health', this.healthCheck.bind(this));
    
    // 请求体解析
    this.setupBodyParsers();
    
    // 请求处理
    this.express.use(this.serverHandle.bind(this));
    
    // 文件服务
    this.express.use('/File', this.fileSend.bind(this));
  }

  /**
   * 设置速率限制
   */
  setupRateLimit() {
    if (cfg.server?.rateLimit?.enabled === false) return;
    
    const createLimiter = (options) => rateLimit({
      windowMs: options.windowMs || 15 * 60 * 1000,
      max: options.max || 100,
      message: options.message || '请求过于频繁',
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => this.isLocalConnection(req.ip)
    });

    this.express.use('/api', createLimiter(
      cfg.server?.rateLimit?.api || {
        windowMs: 15 * 60 * 1000,
        max: 100
      }
    ));
  }

  /**
   * 设置请求体解析器
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
   * 设置进程信号处理
   */
  setupProcessHandlers() {
    process.on('SIGINT', () => this.closeServer());
    process.on('SIGTERM', () => this.closeServer());
  }

  /**
   * 生成API密钥
   */
  async generateApiKey() {
    const apiKeyPath = path.join(process.cwd(), 'config/server_config/api_key.json');

    try {
      if (fsSync.existsSync(apiKeyPath)) {
        const keyData = JSON.parse(await fs.readFile(apiKeyPath, 'utf8'));
        this.apiKey = keyData.key;
        if (BotUtil) BotUtil.apiKey = this.apiKey;
        return this.apiKey;
      }

      // 生成新密钥
      this.apiKey = BotUtil.randomString(64, 
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
      
      // 保存密钥
      const apiKeyDir = path.dirname(apiKeyPath);
      await BotUtil.mkdir(apiKeyDir);
      
      const apiKeyData = {
        key: this.apiKey,
        generated: new Date().toISOString(),
        note: '此密钥用于远程API访问，请妥善保管'
      };

      await fs.writeFile(apiKeyPath, JSON.stringify(apiKeyData, null, 2), 'utf8');

      // 设置文件权限（仅Unix系统）
      if (process.platform !== 'win32') {
        try {
          await fs.chmod(apiKeyPath, 0o600);
        } catch { /* 忽略权限设置失败 */ }
      }

      if (BotUtil) BotUtil.apiKey = this.apiKey;
      BotUtil.makeLog('success', `生成新API密钥: ${this.apiKey}`, 'Server');
      
      return this.apiKey;
      
    } catch (error) {
      BotUtil.makeLog('error', `API密钥处理失败: ${error.message}`, 'Server');
      this.apiKey = BotUtil.randomString(64);
      if (BotUtil) BotUtil.apiKey = this.apiKey;
      return this.apiKey;
    }
  }

  /**
   * 检查API授权
   */
  checkApiAuthorization(req) {
    if (!req) return false;

    const remoteAddress = req.socket?.remoteAddress ?? req.ip ?? "";

    // 本地连接跳过认证
    if (this.isLocalConnection(remoteAddress)) return true;

    // 检查白名单路径
    const whitelistPaths = cfg.server?.auth?.whitelist || [
      '/www',
      '/public', 
      '/static',
      '/favicon.ico',
      '/health'
    ];
    
    if (whitelistPaths.some(path => req.path.startsWith(path))) {
      return true;
    }

    // 获取认证密钥
    const authKey = req.headers?.["x-api-key"] ?? 
                   req.headers?.["authorization"]?.replace('Bearer ', '') ??
                   req.query?.api_key ?? 
                   req.body?.api_key;

    if (!this.apiKey || !authKey) {
      BotUtil.makeLog("debug", `API鉴权失败: 缺少密钥`, 'Server');
      return false;
    }

    try {
      // 使用时间安全比较防止时序攻击
      const authKeyBuffer = Buffer.from(String(authKey));
      const apiKeyBuffer = Buffer.from(String(this.apiKey));

      if (authKeyBuffer.length !== apiKeyBuffer.length) {
        BotUtil.makeLog("warn", `未授权访问尝试来自: ${remoteAddress}`, 'Server');
        return false;
      }

      const isValid = crypto.timingSafeEqual(authKeyBuffer, apiKeyBuffer);

      if (!isValid) {
        BotUtil.makeLog("warn", `未授权访问尝试来自: ${remoteAddress}`, 'Server');
      }

      return isValid;
    } catch (error) {
      BotUtil.makeLog("error", `API鉴权错误: ${error.message}`, 'Server');
      return false;
    }
  }

  /**
   * 检查是否为本地连接
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
   * 检查是否为私有IP
   */
  isPrivateIP(ip) {
    if (!ip) return false;

    // IPv4私有地址范围
    const ipv4Private = [
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^127\./,
      /^169\.254\./,
      /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./
    ];

    // IPv6私有地址范围
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
   * 获取本地IP地址
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
      const skipPatterns = ['lo', 'localhost'];

      for (const [name, ifaces] of Object.entries(interfaces)) {
        if (skipPatterns.some(p => name.toLowerCase().includes(p))) continue;

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

      // 获取主要IP
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
      } catch { /* 忽略错误 */ }

      // 获取公网IP
      if (cfg.server?.detectPublicIP !== false) {
        result.public = await this.getPublicIP();
      }

      this._cache.set(cacheKey, result);
      return result;

    } catch (err) {
      BotUtil.makeLog("debug", `获取IP地址失败: ${err.message}`, 'Server');
      return result;
    }
  }

  /**
   * 检查是否为虚拟网卡
   */
  isVirtualInterface(name, mac) {
    const virtualPatterns = [
      /^(docker|br-|veth|virbr|vnet)/i,
      /^(vmnet|vmware)/i,
      /^(vboxnet|virtualbox)/i,
      /^(utun|tap|tun)/i
    ];

    if (virtualPatterns.some(p => p.test(name))) return true;

    // 虚拟机MAC地址前缀
    const virtualMacPrefixes = [
      '00:50:56', '00:0c:29', '00:05:69', '00:1c:42',
      '08:00:27', '00:15:5d', '02:42:', '00:16:3e', '52:54:00'
    ];

    return mac && virtualMacPrefixes.some(prefix =>
      mac.toLowerCase().startsWith(prefix.toLowerCase())
    );
  }

  /**
   * 通过UDP获取IP
   */
  async getIpByUdp() {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
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
   * 获取公网IP
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
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(api.url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        clearTimeout(timeoutId);

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
   * 验证IP地址格式
   */
  isValidIP(ip) {
    if (!ip) return false;

    const ipv4Regex = /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
    if (ipv4Regex.test(ip)) return true;

    const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
    return ipv6Regex.test(ip);
  }

  /**
   * 服务器认证中间件
   */
  serverAuth(req, res, next) {
    // 设置请求标识
    req.rid = `${req.ip}:${req.socket.remotePort}`;
    req.sid = `${req.protocol}://${req.hostname}:${req.socket.localPort}${req.originalUrl}`;

    // 跳过静态资源认证
    const skipAuthPaths = cfg.server?.auth?.skip || [
      '/www',
      '/public',
      '/static', 
      '/media',
      '/favicon.ico',
      '/health'
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
        error: '未授权',
        message: '无效或缺少API密钥',
        hint: '请提供 X-API-Key 头部或 api_key 参数'
      });
      BotUtil.makeLog("error", 
        `HTTP鉴权失败: ${req.method} ${req.originalUrl} 来自 ${req.ip}`, 
        'Server');
      return;
    }

    next();
  }

  /**
   * 服务器状态端点
   */
  serverStatus(req, res) {
    res.type("json");
    const report = JSON.stringify(process.report.getReport())
      .replace(/(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)/g, 
        "[IPv4]");
    res.send(report);
  }

  /**
   * 健康检查端点
   */
  healthCheck(req, res) {
    res.json({ 
      status: '健康',
      uptime: process.uptime(),
      timestamp: Date.now()
    });
  }

  /**
   * 服务器请求处理中间件
   */
  serverHandle(req, res, next) {
    const quiet = this.express.quiet.some(i => req.originalUrl.startsWith(i));
    if (!quiet) {
      BotUtil.makeLog("debug", `HTTP ${req.method} ${req.originalUrl}`, 'Server');
    }
    next();
  }

  /**
   * WebSocket连接处理
   */
  wsConnect(req, socket, head) {
    // 设置请求标识
    req.rid = `${req.socket.remoteAddress}:${req.socket.remotePort}-${req.headers["sec-websocket-key"]}`;
    req.sid = `ws://${req.headers["x-forwarded-host"] ?? req.headers.host ?? 
      `${req.socket.localAddress}:${req.socket.localPort}`}${req.url}`;
    req.query = Object.fromEntries(new URL(req.sid).searchParams.entries());
    
    const remoteAddress = req.socket.remoteAddress;

    // 非本地连接需要认证
    if (!this.isLocalConnection(remoteAddress)) {
      if (!this.checkApiAuthorization(req)) {
        BotUtil.makeLog("error", `WebSocket鉴权失败: ${req.url}`, 'Server');
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return socket.destroy();
      }
    }

    // 检查路径是否注册
    const path = req.url.split("/")[1];
    if (!(path in this.wsf)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      return socket.destroy();
    }

    // 处理升级
    this.wss.handleUpgrade(req, socket, head, conn => {
      BotUtil.makeLog("debug", `WebSocket连接建立: ${req.url}`, 'Server');
      
      // 错误处理
      conn.on("error", err => BotUtil.makeLog("error", err, 'Server'));
      
      // 断开处理
      conn.on("close", () => BotUtil.makeLog("debug", `WebSocket断开: ${req.url}`, 'Server'));
      
      // 消息处理
      conn.on("message", msg => {
        const logMsg = Buffer.isBuffer(msg) && msg.length > 1024
          ? `[二进制消息，长度: ${msg.length}]`
          : BotUtil.String(msg);
        BotUtil.makeLog("trace", `WS消息: ${logMsg}`, 'Server');
      });
      
      // 扩展发送方法
      conn.sendMsg = msg => {
        if (!Buffer.isBuffer(msg)) msg = BotUtil.String(msg);
        const logMsg = Buffer.isBuffer(msg) && msg.length > 1024
          ? `[二进制发送，长度: ${msg.length}]`
          : msg;
        BotUtil.makeLog("trace", `WS发送: ${logMsg}`, 'Server');
        return conn.send(msg);
      };
      
      // 调用处理函数
      for (const handler of this.wsf[path]) {
        handler(conn, req, socket, head);
      }
    });
  }

  /**
   * 端口被占用错误处理
   */
  async serverEADDRINUSE(err, https) {
    BotUtil.makeLog("error", `端口 ${this.port} 已被占用`, 'Server');
    
    if (!https) {
      this.server_listen_time = (this.server_listen_time || 0) + 1;
      await BotUtil.sleep(Math.min(this.server_listen_time * 1000, 10000)); // 最多等待10秒
      this.server.listen(this.port);
    }
  }

  /**
   * 服务器加载
   */
  async serverLoad(https) {
    const server = https ? "httpsServer" : "server";
    const port = this.port;
    
    this[server].listen(port, cfg.server?.host || '0.0.0.0');
    
    await BotUtil.promiseEvent(this[server], "listening", https && "error")
      .catch(() => { /* 忽略错误 */ });
    
    const { address, port: listenedPort } = this[server].address();
    const protocol = https ? 'https' : 'http';

    this.url = cfg.server.url 
      ? `${cfg.server.url}:${listenedPort}` 
      : `${protocol}://${address}:${listenedPort}`;

    // 打印启动信息
    await this.printServerInfo(protocol, listenedPort);
  }

  /**
   * 打印服务器信息
   */
  async printServerInfo(protocol, port) {
    BotUtil.makeLog("info", `${cfg.server.name} 启动成功`, 'Server');
    BotUtil.makeLog("info", `API密钥: ${this.apiKey}`, 'Server');

    const addresses = [];
    addresses.push(`${protocol}://localhost:${port}`);

    const ipInfo = await this.getLocalIpAddress();

    // 内网地址
    if (ipInfo.local.length > 0) {
      BotUtil.makeLog("info", "内网访问地址:", 'Server');
      ipInfo.local.forEach(info => {
        const url = `${protocol}://${info.ip}:${port}`;
        const label = info.primary ? ' (主要)' : info.virtual ? ' (虚拟)' : '';
        BotUtil.makeLog("info", `  ${url} [${info.interface}]${label}`, 'Server');
        addresses.push(url);
      });
    }

    // 公网地址
    if (ipInfo.public) {
      const publicUrl = `${protocol}://${ipInfo.public}:${port}`;
      BotUtil.makeLog("info", `外网访问地址: ${publicUrl}`, 'Server');
      addresses.push(publicUrl);
    }

    // 配置地址
    if (cfg.server.url) {
      BotUtil.makeLog("info", `配置地址: ${cfg.server.url}:${port}`, 'Server');
    }

    // 静态目录
    const staticDirs = cfg.server?.static || [{ route: '/www', path: 'www' }];
    staticDirs.forEach(dir => {
      BotUtil.makeLog("info", `静态目录: ${addresses[0]}${dir.route}`, 'Server');
    });
  }

  /**
   * HTTPS服务器加载
   */
  async httpsLoad() {
    if (!cfg.server.https?.enabled || 
        !cfg.server.https?.key || 
        !cfg.server.https?.cert) return;
    
    try {
      const https = await import("node:https");
      this.httpsServer = https.createServer({
        key: await fs.readFile(cfg.server.https.key),
        cert: await fs.readFile(cfg.server.https.cert),
      }, this.express)
        .on("error", err => {
          if (typeof this[`server${err.code}`] === "function") {
            return this[`server${err.code}`](err, true);
          }
          BotUtil.makeLog("error", err, 'Server');
        })
        .on("upgrade", this.wsConnect.bind(this));
      
      await this.serverLoad(true);
    } catch (err) {
      BotUtil.makeLog("error", `HTTPS服务器创建失败: ${err.message}`, 'Server');
    }
  }

  /**
   * 启动Bot
   */
  async run(options = {}) {
    const { port } = options;
    this.port = port;

    // 初始化配置
    await init();
    
    // 生成API密钥
    await this.generateApiKey();
    
    // 加载插件
    await PluginsLoader.load();
    
    // 加载API
    await ApiLoader.load();
    await ApiLoader.register(this.express, this);
    
    // 启动服务器
    await this.serverLoad(false);
    
    // 启动HTTPS（如果配置）
    if (cfg.server.https?.enabled) {
      await this.httpsLoad();
    }

    // 设置404处理
    this.setup404Handler();

    // 加载监听器
    await ListenerLoader.load();
    
    // 监控API更改
    await ApiLoader.watch(true);

    // 打印WebSocket信息
    if (Object.keys(this.wsf).length > 0) {
      BotUtil.makeLog("info", 
        `WebSocket服务: ${this.url.replace(/^http/, "ws")}/ [${Object.keys(this.wsf).join(', ')}]`, 
        'Server');
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
   * 设置404处理
   */
  setup404Handler() {
    this.express.use((req, res) => {
      const defaultRoute = cfg.server?.defaultRoute || '/www';
      
      if (req.accepts('html')) {
        res.redirect(defaultRoute);
      } else {
        res.status(404).json({ 
          error: '未找到', 
          path: req.path 
        });
      }
    });
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
        return res.status(404).send('文件未找到');
      }
    }

    // 处理访问次数限制
    if (typeof file.times === "number") {
      if (file.times > 0) {
        file.times--;
      } else {
        file = this.fs.timeout;
        if (!file) {
          return res.status(410).send('文件已过期');
        }
      }
    }

    // 设置MIME类型
    if (file.type?.mime) {
      res.setHeader("Content-Type", file.type.mime);
    }
    
    BotUtil.makeLog("debug", 
      `文件发送: ${file.name} (${BotUtil.formatFileSize(file.buffer.length)})`, 
      'Server');
    
    res.send(file.buffer);
  }

  /**
   * 文件转URL
   */
  async fileToUrl(file, opts = {}) {
    return await BotUtil.fileToUrl(file, opts);
  }

  /**
   * 关闭服务器
   */
  async closeServer() {
    BotUtil.makeLog("info", "正在关闭服务器...", 'Server');
    
    // 关闭HTTP服务器
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
    }
    
    // 关闭HTTPS服务器
    if (this.httpsServer) {
      await new Promise(resolve => this.httpsServer.close(resolve));
    }
    
    // 等待连接关闭
    await BotUtil.sleep(2000);
    
    // 退出Redis
    await this.redisExit();
    
    BotUtil.makeLog("info", "服务器已关闭", 'Server');
  }

  /**
   * Redis退出处理
   */
  async redisExit() {
    if (!(typeof redis === 'object' && redis.process)) return false;
    
    const p = redis.process;
    delete redis.process;
    
    // 保存数据并等待
    await BotUtil.sleep(5000, redis.save().catch(() => { /* 忽略错误 */ }));
    
    return p.kill();
  }

  /**
   * 准备事件数据
   */
  prepareEvent(data) {
    if (!this.bots[data.self_id]) return;

    // 设置bot属性
    if (!data.bot) {
      Object.defineProperty(data, "bot", { 
        value: this.bots[data.self_id] 
      });
    }

    // 处理设备相关事件
    this.prepareDeviceEvent(data);

    // 处理用户相关数据
    this.prepareUserEvent(data);

    // 处理群组相关数据  
    this.prepareGroupEvent(data);

    // 设置适配器信息
    if (data.bot.adapter?.id) data.adapter_id = data.bot.adapter.id;
    if (data.bot.adapter?.name) data.adapter_name = data.bot.adapter.name;

    // 扩展对象方法
    this.extendEventObjects(data);

    // 设置回复方法
    this.setupReplyMethod(data);
  }

  /**
   * 准备设备事件
   */
  prepareDeviceEvent(data) {
    if (!data.post_type === 'device' && !data.device_id) return;
    
    const deviceBot = this.bots[data.device_id];
    if (!deviceBot) return;
    
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
        } else {
          return await deviceBot.display(msg);
        }
      };
    }
  }

  /**
   * 准备用户事件
   */
  prepareUserEvent(data) {
    if (!data.user_id) return;
    
    if (!data.friend) {
      Object.defineProperty(data, "friend", {
        value: data.bot.pickFriend(data.user_id)
      });
    }
    
    data.sender ||= { user_id: data.user_id };
    data.sender.nickname ||= data.friend?.name || data.friend?.nickname;
  }

  /**
   * 准备群组事件
   */
  prepareGroupEvent(data) {
    if (!data.group_id) return;
    
    if (!data.group) {
      Object.defineProperty(data, "group", {
        value: data.bot.pickGroup(data.group_id)
      });
    }
    
    data.group_name ||= data.group?.name || data.group?.group_name;

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
   * 扩展事件对象
   */
  extendEventObjects(data) {
    for (const obj of [data.friend, data.group, data.member]) {
      if (typeof obj !== "object" || !obj) continue;

      obj.sendFile ??= (file, name) => obj.sendMsg(segment.file(file, name));
      obj.makeForwardMsg ??= this.makeForwardMsg;
      obj.sendForwardMsg ??= msg => this.sendForwardMsg(
        msg => obj.sendMsg(msg), 
        msg
      );
      obj.getInfo ??= () => obj.info || obj;
    }
  }

  /**
   * 设置回复方法
   */
  setupReplyMethod(data) {
    if (data.reply) return;
    
    if (data.group?.sendMsg) {
      data.reply = data.group.sendMsg.bind(data.group);
    } else if (data.friend?.sendMsg) {
      data.reply = data.friend.sendMsg.bind(data.friend);
    }
  }

  /**
   * 触发事件
   */
  em(name = "", data = {}) {
    this.prepareEvent(data);
    
    // 逐级触发事件
    while (true) {
      this.emit(name, data);
      const i = name.lastIndexOf(".");
      if (i === -1) break;
      name = name.slice(0, i);
    }
  }

  /**
   * 创建目录列表
   */
  createDirectoryListing(dirPath) {
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

  // === Bot管理方法 ===

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

  get fl() { 
    return this.getFriendMap(); 
  }

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

  get gl() { 
    return this.getGroupMap(); 
  }

  /**
   * 获取群成员列表映射
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
    
    // 从群成员中查找
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

    if (user) {
      return this.bots[user.bot_id].pickFriend(user_id);
    }
    
    if (strict) return false;

    BotUtil.makeLog("trace", 
      `用户 ${user_id} 不存在，随机选择Bot ${this.uin.toJSON()}`, 
      'Server');
    
    return this.bots[this.uin].pickFriend(user_id);
  }

  get pickUser() { 
    return this.pickFriend; 
  }

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
    if (group) {
      return this.bots[group.bot_id].pickGroup(group_id);
    }
    
    if (strict) return false;

    BotUtil.makeLog("trace", 
      `群 ${group_id} 不存在，随机选择Bot ${this.uin.toJSON()}`, 
      'Server');
    
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
  async sendFriendMsg(bot_id, user_id, ...args) {
    // 无指定bot，使用默认
    if (!bot_id) {
      return this.pickFriend(user_id).sendMsg(...args);
    }
    
    // 指定bot存在且在线
    if (this.uin.includes(bot_id) && this.bots[bot_id]) {
      return this.bots[bot_id].pickFriend(user_id).sendMsg(...args);
    }
    
    // 尝试其他方式
    if (this.pickFriend(bot_id, true)) {
      return this.pickFriend(bot_id).sendMsg(user_id, ...args);
    }

    // 等待bot上线
    return new Promise((resolve, reject) => {
      const listener = data => { 
        resolve(data.bot.pickFriend(user_id).sendMsg(...args)); 
        clearTimeout(timeout); 
      };
      
      const timeout = setTimeout(() => { 
        reject(Object.assign(
          Error("等待Bot上线超时"), 
          { bot_id, user_id, args }
        )); 
        this.off(`connect.${bot_id}`, listener); 
      }, 30000); // 修改为30秒超时
      
      this.once(`connect.${bot_id}`, listener);
    });
  }

  /**
   * 发送群组消息
   */
  async sendGroupMsg(bot_id, group_id, ...args) {
    // 无指定bot，使用默认
    if (!bot_id) {
      return this.pickGroup(group_id).sendMsg(...args);
    }
    
    // 指定bot存在且在线
    if (this.uin.includes(bot_id) && this.bots[bot_id]) {
      return this.bots[bot_id].pickGroup(group_id).sendMsg(...args);
    }
    
    // 尝试其他方式
    if (this.pickGroup(bot_id, true)) {
      return this.pickGroup(bot_id).sendMsg(group_id, ...args);
    }

    // 等待bot上线
    return new Promise((resolve, reject) => {
      const listener = data => { 
        resolve(data.bot.pickGroup(group_id).sendMsg(...args)); 
        clearTimeout(timeout); 
      };
      
      const timeout = setTimeout(() => { 
        reject(Object.assign(
          Error("等待Bot上线超时"), 
          { bot_id, group_id, args }
        )); 
        this.off(`connect.${bot_id}`, listener); 
      }, 30000); // 修改为30秒超时
      
      this.once(`connect.${bot_id}`, listener);
    });
  }

  /**
   * 获取文本消息
   */
  getTextMsg(fnc = () => true) {
    if (typeof fnc !== "function") {
      const criteria = fnc;
      fnc = data => data.self_id == criteria.self_id && 
                     data.user_id == criteria.user_id;
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

    for (const user_id of masterQQs) {
      try {
        const friend = this.pickFriend(user_id);
        
        if (friend && friend.sendMsg) {
          results[user_id] = await friend.sendMsg(msg);
          BotUtil.makeLog("debug", `成功发送消息给主人 ${user_id}`, 'Server');
        } else {
          results[user_id] = { error: "无法找到可用的Bot" };
          BotUtil.makeLog("warn", `无法向主人 ${user_id} 发送消息`, 'Server');
        }

        // 延时发送
        if (sleep && masterQQs.indexOf(user_id) < masterQQs.length - 1) {
          await BotUtil.sleep(sleep);
        }
      } catch (err) {
        results[user_id] = { error: err.message };
        BotUtil.makeLog("error", 
          `向主人 ${user_id} 发送消息失败: ${err.message}`, 
          'Server');
      }
    }

    return results;
  }

  /**
   * 创建转发消息
   */
  makeForwardMsg(msg) { 
    return { 
      type: "node", 
      data: msg 
    }; 
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
   * 修复：增加错误处理和超时控制
   */
  async sendForwardMsg(send, msg) {
    const messages = Array.isArray(msg) ? msg : [msg];
    const promises = messages.map(({ message }) => {
      // 为每个消息发送添加超时控制
      return Promise.race([
        send(message),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('消息发送超时')), 10000)
        )
      ]).catch(err => {
        BotUtil.makeLog("error", `转发消息失败: ${err.message}`, 'Server');
        return { error: err.message };
      });
    });
    
    return Promise.all(promises);
  }
}