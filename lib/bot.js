import path from 'path';
import fs from 'node:fs/promises';
import * as fsSync from 'fs';
import { EventEmitter } from "events";
import express from "express";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { WebSocketServer } from "ws";
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import os from 'node:os';
import dgram from 'node:dgram';
import chalk from 'chalk';
import { createProxyMiddleware } from 'http-proxy-middleware';

import PluginsLoader from "./plugins/loader.js";
import ListenerLoader from "./listener/loader.js";
import ApiLoader from "./http/loader.js";
import init from "./config/loader.js";
import BotUtil from './common/util.js';
import cfg from './config/config.js';

/**
 * Bot主类 - 管理HTTP/HTTPS服务器、WebSocket连接和机器人实例
 */
export default class Bot extends EventEmitter {
  constructor() {
    super();
    
    // 核心属性
    this.stat = { start_time: Date.now() / 1000 };
    this.bot = this;
    this.bots = {};
    this.adapter = [];
    this.uin = this._createUinManager();
    
    // 服务器组件
    this.express = Object.assign(express(), { skip_auth: [], quiet: [] });
    this.server = null;
    this.httpsServer = null;
    this.wss = new WebSocketServer({ noServer: true });
    this.wsf = Object.create(null);
    this.fs = Object.create(null);
    
    // 配置属性
    this.apiKey = '';
    this._cache = BotUtil.getMap('yunzai_cache', { ttl: 60000, autoClean: true });
    this._rateLimiters = new Map();
    this.httpPort = null;
    this.httpsPort = null;
    this.url = cfg.server?.server?.url || '';
    
    // 反向代理
    this.proxyEnabled = false;
    this.proxyMiddlewares = new Map();
    this.domainConfigs = new Map();
    this.sslContexts = new Map();
    
    this.ApiLoader = ApiLoader;
    this._initHttpServer();
    this._setupSignalHandlers();
    this.generateApiKey();
    
    return this._createProxy();
  }

  _createUinManager() {
    return Object.assign([], {
      toJSON() {
        if (!this.now) {
          if (this.length <= 2) return this[this.length - 1] || "";
          const array = this.slice(1);
          this.now = array[Math.floor(Math.random() * array.length)];
          setTimeout(() => delete this.now, 60000);
        }
        return this.now;
      },
      toString(raw, ...args) {
        return raw === true ?
          Array.prototype.toString.apply(this, args) :
          this.toJSON().toString(raw, ...args);
      },
      includes(value) {
        return this.some(i => i == value);
      }
    });
  }

  _initHttpServer() {
    this.server = http.createServer(this.express)
      .on("error", err => this._handleServerError(err, false))
      .on("upgrade", this.wsConnect.bind(this));
  }

  _handleServerError(err, isHttps) {
    const handler = this[`server${err.code}`];
    if (typeof handler === "function") {
      return handler.call(this, err, isHttps);
    }
    BotUtil.makeLog("error", err, isHttps ? "HTTPS Server" : "Server");
  }

  _initializeMiddlewareAndRoutes() {
    const serverConfig = cfg.server || {};
    
    // 压缩中间件
    if (serverConfig.compression?.enabled !== false) {
      this.express.use(compression({
        filter: (req, res) =>
          !req.headers['x-no-compression'] && compression.filter(req, res),
        level: serverConfig.compression?.level || 6,
        threshold: serverConfig.compression?.threshold || 1024
      }));
    }
    
    // 安全头部
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
    
    this._setupCors();
    this._setupRequestLogging();
    this._setupRateLimiting();
    
    if (this.proxyEnabled) {
      this._setupProxyMiddleware();
    }
    
    this._setupBodyParsers();
    this.express.use(this._authMiddleware.bind(this));
    
    // 系统路由
    this.express.get('/status', this._statusHandler.bind(this));
    this.express.get('/health', this._healthHandler.bind(this));
    this.express.use('/File', this._fileHandler.bind(this));
    
    this._setupStaticServing();
  }

  _setupProxyMiddleware() {
    const proxyConfig = cfg.server?.proxy;
    if (!proxyConfig?.enabled || !proxyConfig?.domains?.length) {
      return;
    }
    
    BotUtil.makeLog('info', chalk.cyan('⚡ 初始化反向代理中间件'), 'Proxy');
    
    for (const domainConfig of proxyConfig.domains) {
      this._createDomainProxy(domainConfig);
    }
    
    this.express.use((req, res, next) => {
      const hostname = req.hostname || req.headers.host?.split(':')[0];
      
      if (!hostname) {
        return next();
      }
      
      const domainConfig = this._findDomainConfig(hostname);
      
      if (!domainConfig) {
        return next();
      }
      
      req.domainConfig = domainConfig;
      
      if (domainConfig.rewritePath) {
        const { from, to } = domainConfig.rewritePath;
        
        if (from && req.path.startsWith(from)) {
          const newPath = req.path.replace(from, to || '');
          req.url = newPath + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
          
          BotUtil.makeLog('debug',
            chalk.gray(`路径重写: ${req.path} → ${newPath}`),
            'Proxy');
        }
      }
      
      if (domainConfig.target) {
        const proxyMiddleware = this.proxyMiddlewares.get(domainConfig.domain);
        if (proxyMiddleware) {
          return proxyMiddleware(req, res, next);
        }
      }
      
      if (domainConfig.staticRoot) {
        req.staticRoot = domainConfig.staticRoot;
      }
      
      next();
    });
  }

  _createDomainProxy(domainConfig) {
    if (!domainConfig.target) {
      this.domainConfigs.set(domainConfig.domain, domainConfig);
      return;
    }
    
    const proxyOptions = {
      target: domainConfig.target,
      changeOrigin: true,
      ws: domainConfig.ws !== false,
      preserveHostHeader: domainConfig.preserveHostHeader === true,
      timeout: domainConfig.timeout || 30000,
      proxyTimeout: domainConfig.timeout || 30000,
      
      onProxyReq: (proxyReq, req, res) => {
        if (domainConfig.headers?.request) {
          for (const [key, value] of Object.entries(domainConfig.headers.request)) {
            proxyReq.setHeader(key, value);
          }
        }
      },
      
      onProxyRes: (proxyRes, req, res) => {
        if (domainConfig.headers?.response) {
          for (const [key, value] of Object.entries(domainConfig.headers.response)) {
            res.setHeader(key, value);
          }
        }
      },
      
      onError: (err, req, res) => {
        BotUtil.makeLog('error',
          chalk.red(`✗ 代理错误 [${domainConfig.domain}]: ${err.message}`),
          'Proxy');
        
        res.status(502).json({
          error: 'Bad Gateway',
          message: 'Proxy server error',
          domain: domainConfig.domain
        });
      }
    };
    
    if (domainConfig.pathRewrite && typeof domainConfig.pathRewrite === 'object') {
      proxyOptions.pathRewrite = domainConfig.pathRewrite;
    }
    
    const middleware = createProxyMiddleware(proxyOptions);
    this.proxyMiddlewares.set(domainConfig.domain, middleware);
    this.domainConfigs.set(domainConfig.domain, domainConfig);
    
    BotUtil.makeLog('info',
      chalk.green(`✓ 创建代理: ${domainConfig.domain} → ${domainConfig.target}`),
      'Proxy');
  }

  _findDomainConfig(hostname) {
    if (this.domainConfigs.has(hostname)) {
      return this.domainConfigs.get(hostname);
    }
    
    for (const [domain, config] of this.domainConfigs) {
      if (domain.startsWith('*.')) {
        const baseDomain = domain.substring(2);
        if (hostname.endsWith(baseDomain)) {
          const subdomain = hostname.substring(0, hostname.length - baseDomain.length - 1);
          const configCopy = { ...config, subdomain };
          
          if (config.rewritePath?.to?.includes('${subdomain}')) {
            configCopy.rewritePath = {
              ...config.rewritePath,
              to: config.rewritePath.to.replace('${subdomain}', subdomain)
            };
          }
          
          return configCopy;
        }
      }
    }
    
    return null;
  }

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

  _setupRequestLogging() {
    if (cfg.server?.logging?.requests === false) return;
    
    this.express.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        const quietPaths = cfg.server?.logging?.quiet || [];
        
        if (!quietPaths.some(p => req.path.startsWith(p))) {
          const statusColor = res.statusCode < 400 ? 'green' :
                             res.statusCode < 500 ? 'yellow' : 'red';
          const method = chalk.cyan(req.method.padEnd(6));
          const status = chalk[statusColor](res.statusCode);
          const time = chalk.gray(`${duration}ms`.padStart(7));
          const path = chalk.white(req.path);
          const host = req.hostname ? chalk.gray(` [${req.hostname}]`) : '';
          
          BotUtil.makeLog('debug',
            `${method} ${status} ${time} ${path}${host}`,
            'HTTP');
        }
      });
      next();
    });
  }

  _setupStaticServing() {
    this.express.use(this._directoryIndexMiddleware.bind(this));
    this.express.use(this._staticSecurityMiddleware.bind(this));
    
    this.express.use((req, res, next) => {
      const staticRoot = req.staticRoot || path.join(process.cwd(), 'www');
      
      if (!fsSync.existsSync(staticRoot)) {
        fsSync.mkdirSync(staticRoot, { recursive: true });
      }
      
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
      
      express.static(staticRoot, staticOptions)(req, res, next);
    });
    
    this.express.get('/favicon.ico', this._handleFavicon.bind(this));
    this.express.get('/robots.txt', this._handleRobotsTxt.bind(this));
    
    BotUtil.makeLog('info', chalk.cyan(`⚡ 静态文件服务已启用`), 'Server');
  }

  _directoryIndexMiddleware(req, res, next) {
    const hasExtension = path.extname(req.path);
    if (hasExtension || req.path.endsWith('/')) {
      return next();
    }
    
    const staticRoot = req.staticRoot || path.join(process.cwd(), 'www');
    const dirPath = path.join(staticRoot, req.path);
    
    if (fsSync.existsSync(dirPath) && fsSync.statSync(dirPath).isDirectory()) {
      const indexFiles = cfg.server?.static?.index || ['index.html', 'index.htm'];
      
      for (const indexFile of indexFiles) {
        const indexPath = path.join(dirPath, indexFile);
        if (fsSync.existsSync(indexPath)) {
          const redirectUrl = req.path + '/';
          BotUtil.makeLog('debug',
            chalk.gray(`目录重定向: ${req.path} → ${redirectUrl}`),
            'Server');
          return res.redirect(301, redirectUrl);
        }
      }
    }
    
    next();
  }

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
      '.zip': 'application/zip',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.otf': 'font/otf'
    };
    
    if (mimeTypes[ext]) {
      res.setHeader('Content-Type', mimeTypes[ext]);
    }
    
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    const cacheConfig = cfg.server?.static?.cache || {};
    if (['.html', '.htm'].includes(ext)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else if (['.css', '.js', '.json'].includes(ext)) {
      res.setHeader('Cache-Control', `public, max-age=${cacheConfig.static || 86400}`);
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'].includes(ext)) {
      res.setHeader('Cache-Control', `public, max-age=${cacheConfig.images || 604800}`);
    }
  }

  _staticSecurityMiddleware(req, res, next) {
    const normalizedPath = path.normalize(req.path);
    
    if (normalizedPath.includes('..')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
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

  async _handleFavicon(req, res) {
    const staticRoot = req.staticRoot || path.join(process.cwd(), 'www');
    const faviconPath = path.join(staticRoot, 'favicon.ico');
    
    if (fsSync.existsSync(faviconPath)) {
      res.set({
        'Content-Type': 'image/x-icon',
        'Cache-Control': 'public, max-age=604800'
      });
      return res.sendFile(faviconPath);
    }
    
    res.status(204).end();
  }

  async _handleRobotsTxt(req, res) {
    const staticRoot = req.staticRoot || path.join(process.cwd(), 'www');
    const robotsPath = path.join(staticRoot, 'robots.txt');
    
    if (fsSync.existsSync(robotsPath)) {
      res.set({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=86400'
      });
      return res.sendFile(robotsPath);
    }
    
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

  _setupRateLimiting() {
    const rateLimitConfig = cfg.server?.rateLimit;
    if (rateLimitConfig?.enabled === false) return;
    
    const createLimiter = (options) => rateLimit({
      windowMs: options.windowMs || 15 * 60 * 1000,
      max: options.max || 100,
      message: options.message || 'Too many requests',
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => this._isLocalConnection(req.ip)
    });
    
    if (rateLimitConfig?.global) {
      this.express.use(createLimiter(rateLimitConfig.global));
    }
    
    if (rateLimitConfig?.api) {
      this.express.use('/api', createLimiter(rateLimitConfig.api));
    }
  }

  _setupBodyParsers() {
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
  }

  _setupSignalHandlers() {
    const closeHandler = async () => await this.closeServer();
    process.on('SIGINT', closeHandler);
    process.on('SIGTERM', closeHandler);
  }

  _createProxy() {
    return new Proxy(this.bots, {
      get: (target, prop) => {
        if (target[prop] !== undefined) return target[prop];
        if (this[prop] !== undefined) return this[prop];
        
        const utilValue = BotUtil[prop];
        if (utilValue !== undefined) {
          return typeof utilValue === 'function' ?
            utilValue.bind(BotUtil) : utilValue;
        }
        
        for (const botId of [this.uin.toString(), ...this.uin]) {
          const bot = target[botId];
          if (bot?.[prop] !== undefined) {
            BotUtil.makeLog("trace",
              `因不存在 Bot.${prop} 而重定向到 Bot.${botId}.${prop}`);
            return typeof bot[prop] === "function" ?
              bot[prop].bind(bot) : bot[prop];
          }
        }
        
        BotUtil.makeLog("trace", `不存在 Bot.${prop}`);
        return undefined;
      }
    });
  }

  async generateApiKey() {
    const apiKeyConfig = cfg.server?.auth?.apiKey || {};
    const apiKeyPath = path.join(process.cwd(),
      apiKeyConfig.file || 'config/server_config/api_key.json');
    
    try {
      if (fsSync.existsSync(apiKeyPath)) {
        const keyData = JSON.parse(await fs.readFile(apiKeyPath, 'utf8'));
        this.apiKey = keyData.key;
        BotUtil.apiKey = this.apiKey;
        BotUtil.makeLog('info', chalk.green('✓ 已加载API密钥'), 'Server');
        return this.apiKey;
      }
      
      const keyLength = apiKeyConfig.length || 64;
      this.apiKey = BotUtil.randomString(keyLength);
      
      await BotUtil.mkdir(path.dirname(apiKeyPath));
      await fs.writeFile(apiKeyPath, JSON.stringify({
        key: this.apiKey,
        generated: new Date().toISOString(),
        note: '此密钥用于远程API访问，请妥善保管'
      }, null, 2), 'utf8');
      
      if (process.platform !== 'win32') {
        try { await fs.chmod(apiKeyPath, 0o600); } catch { }
      }
      
      BotUtil.apiKey = this.apiKey;
      BotUtil.makeLog('success', chalk.yellow(`⚡ 生成新的API密钥: ${this.apiKey}`), 'Server');
      return this.apiKey;
      
    } catch (error) {
      BotUtil.makeLog('error', chalk.red(`✗ API密钥处理失败: ${error.message}`), 'Server');
      this.apiKey = BotUtil.randomString(64);
      BotUtil.apiKey = this.apiKey;
      return this.apiKey;
    }
  }

  _authMiddleware(req, res, next) {
    req.rid = `${req.ip}:${req.socket.remotePort}`;
    req.sid = `${req.protocol}://${req.hostname}:${req.socket.localPort}${req.originalUrl}`;
    
    const whitelist = cfg.server?.auth?.whitelist || [
      '/', '/favicon.ico', '/health', '/status', '/robots.txt'
    ];
    
    const isWhitelisted = whitelist.some(path => {
      if (path === req.path) return true;
      if (path.endsWith('*')) {
        const prefix = path.slice(0, -1);
        return req.path.startsWith(prefix);
      }
      if (!path.endsWith('/') && req.path === path + '/') return true;
      return false;
    });
    
    const isStaticFile = /\.(html|css|js|json|png|jpg|jpeg|gif|svg|webp|ico|mp4|webm|mp3|wav|pdf|zip|woff|woff2|ttf|otf)$/i.test(req.path);
    
    if (isWhitelisted || isStaticFile) {
      return next();
    }
    
    if (this._isLocalConnection(req.ip)) {
      BotUtil.makeLog("debug", chalk.gray(`本地连接，跳过鉴权: ${req.ip}`), 'Auth');
      return next();
    }
    
    if (!this._checkApiAuthorization(req)) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or missing API key',
        hint: 'Please provide X-API-Key header or api_key parameter'
      });
      
      BotUtil.makeLog("warn",
        chalk.yellow(`⚠ HTTP鉴权失败: ${req.method} ${req.originalUrl} 来自 ${req.ip}`),
        'Auth');
      return;
    }
    
    BotUtil.makeLog("debug", chalk.green(`✓ 鉴权成功: ${req.method} ${req.originalUrl}`), 'Auth');
    next();
  }

  _checkApiAuthorization(req) {
    if (!req) return false;
    
    const authKey = req.headers?.["x-api-key"] ??
      req.headers?.["authorization"]?.replace('Bearer ', '') ??
      req.query?.api_key ??
      req.body?.api_key;
    
    if (!this.apiKey || !authKey) {
      BotUtil.makeLog("debug", chalk.gray(`API鉴权失败: 缺少密钥`), 'Auth');
      return false;
    }
    
    try {
      const authKeyBuffer = Buffer.from(String(authKey));
      const apiKeyBuffer = Buffer.from(String(this.apiKey));
      
      if (authKeyBuffer.length !== apiKeyBuffer.length) {
        BotUtil.makeLog("warn",
          chalk.yellow(`⚠ 来自 ${req.socket?.remoteAddress || req.ip} 的未授权访问尝试`),
          'Auth');
        return false;
      }
      
      return crypto.timingSafeEqual(authKeyBuffer, apiKeyBuffer);
      
    } catch (error) {
      BotUtil.makeLog("error", chalk.red(`✗ API鉴权错误: ${error.message}`), 'Auth');
      return false;
    }
  }

  checkApiAuthorization(req) {
    return this._checkApiAuthorization(req);
  }

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
        https: cfg.server?.https?.enabled || false,
        proxy: this.proxyEnabled,
        domains: this.proxyEnabled ? Array.from(this.domainConfigs.keys()) : []
      }
    };
    
    res.type('json').send(JSON.stringify(status, null, 2));
  }

  _healthHandler(req, res) {
    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: Date.now()
    });
  }

  _fileHandler(req, res) {
    const url = req.url.replace(/^\//, "");
    let file = this.fs[url];
    
    if (!file) {
      file = this.fs[404];
      if (!file) {
        return res.status(404).json({ error: 'Not Found', file: url });
      }
    }
    
    if (typeof file.times === "number") {
      if (file.times > 0) {
        file.times--;
      } else {
        file = this.fs.timeout;
        if (!file) {
          return res.status(410).json({
            error: 'Gone',
            message: 'File access limit exceeded'
          });
        }
      }
    }
    
    if (file.type?.mime) {
      res.setHeader("Content-Type", file.type.mime);
    }
    res.setHeader("Content-Length", file.buffer.length);
    res.setHeader("Cache-Control", "no-cache");
    
    BotUtil.makeLog("debug",
      chalk.gray(`文件发送: ${file.name} (${BotUtil.formatFileSize(file.buffer.length)})`),
      'Server');
    
    res.send(file.buffer);
  }

  wsConnect(req, socket, head) {
    req.rid = `${req.socket.remoteAddress}:${req.socket.remotePort}-${req.headers["sec-websocket-key"]}`;
    req.sid = `ws://${req.headers.host || `${req.socket.localAddress}:${req.socket.localPort}`}${req.url}`;
    req.query = Object.fromEntries(new URL(req.sid).searchParams.entries());
    
    if (!this._isLocalConnection(req.socket.remoteAddress)) {
      if (!this._checkApiAuthorization(req)) {
        BotUtil.makeLog("error", chalk.red(`✗ WebSocket鉴权失败: ${req.url}`), 'Server');
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return socket.destroy();
      }
    }
    
    const path = req.url.split("/")[1];
    if (!(path in this.wsf)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      return socket.destroy();
    }
    
    this.wss.handleUpgrade(req, socket, head, conn => {
      BotUtil.makeLog("debug", chalk.green(`✓ WebSocket连接建立: ${req.url}`), 'Server');
      
      conn.on("error", err => BotUtil.makeLog("error", err, 'Server'));
      conn.on("close", () => BotUtil.makeLog("debug", chalk.gray(`WebSocket断开: ${req.url}`), 'Server'));
      
      conn.on("message", msg => {
        const logMsg = Buffer.isBuffer(msg) && msg.length > 1024 ?
          `[Binary message, length: ${msg.length}]` : BotUtil.String(msg);
        BotUtil.makeLog("trace", `WS消息: ${logMsg}`, 'Server');
      });
      
      conn.sendMsg = msg => {
        if (!Buffer.isBuffer(msg)) msg = BotUtil.String(msg);
        BotUtil.makeLog("trace", `WS发送: ${msg}`, 'Server');
        return conn.send(msg);
      };
      
      for (const handler of this.wsf[path]) {
        handler(conn, req, socket, head);
      }
    });
  }

  async serverEADDRINUSE(err, isHttps) {
    const serverType = isHttps ? 'HTTPS' : 'HTTP';
    const port = isHttps ? this.httpsPort : this.httpPort;
    
    BotUtil.makeLog("error", chalk.red(`✗ ${serverType}端口 ${port} 已被占用`), 'Server');
    
    const retryKey = isHttps ? 'https_retry_count' : 'http_retry_count';
    this[retryKey] = (this[retryKey] || 0) + 1;
    
    await BotUtil.sleep(this[retryKey] * 1000);
    
    const server = isHttps ? this.httpsServer : this.server;
    const host = cfg.server?.server?.host || '0.0.0.0';
    
    if (server) {
      server.listen(port, host);
    }
  }

  async serverLoad(isHttps) {
    const server = isHttps ? this.httpsServer : this.server;
    const port = isHttps ? this.httpsPort : this.httpPort;
    const host = cfg.server?.server?.host || '0.0.0.0';
    
    if (!server) return;
    
    server.listen(port, host);
    
    await BotUtil.promiseEvent(server, "listening", isHttps && "error").catch(() => { });
    
    const serverInfo = server.address();
    if (!serverInfo) {
      BotUtil.makeLog('error',
        chalk.red(`✗ ${isHttps ? 'HTTPS' : 'HTTP'}服务器未能成功启动`), 'Server');
      return;
    }
    
    if (isHttps) {
      this.httpsPort = serverInfo.port;
    } else {
      this.httpPort = serverInfo.port;
    }
    
    const protocol = isHttps ? 'https' : 'http';
    const serverType = isHttps ? 'HTTPS' : 'HTTP';
    
    console.log(chalk.cyan('\n╔════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.green.bold(`  ${cfg.server?.server?.name || 'Yunzai'} ${serverType} Server Started Successfully!  `) + chalk.cyan('║'));
    console.log(chalk.cyan('╚════════════════════════════════════════════════════════════╝\n'));
    
    BotUtil.makeLog("info",
      chalk.green(`✓ ${serverType}监听地址: ${host}:${serverInfo.port}`), 'Server');
    
    if (this.proxyEnabled) {
      await this._displayProxyInfo();
    } else if (!isHttps) {
      await this._displayAccessUrls(protocol, serverInfo.port);
    } else {
      await this._displayHttpsGuide();
    }
  }

  async _displayProxyInfo() {
    console.log(chalk.cyan('\n╔════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.yellow.bold('           反向代理服务器配置信息                          ') + chalk.cyan('║'));
    console.log(chalk.cyan('╚════════════════════════════════════════════════════════════╝\n'));
    
    console.log(chalk.cyan('▶ 代理域名:'));
    console.log(chalk.gray('─'.repeat(60)));
    
    const proxyConfig = cfg.server?.proxy;
    const domains = proxyConfig?.domains || [];
    
    for (const domainConfig of domains) {
      const protocol = domainConfig.ssl?.enabled ? 'https' : 'http';
      const displayPort = this.proxyEnabled ? 
        (protocol === 'https' ? '' : '') : 
        (protocol === 'https' ? `:${this.httpsPort}` : `:${this.httpPort}`);
      
      console.log(chalk.yellow(`\n  ${domainConfig.domain}:`));
      console.log(`    ${chalk.cyan('•')} 访问地址: ${chalk.white(`${protocol}://${domainConfig.domain}${displayPort}`)}`);
      
      if (domainConfig.target) {
        console.log(`    ${chalk.cyan('•')} 代理目标: ${chalk.gray(domainConfig.target)}`);
      }
      
      if (domainConfig.staticRoot) {
        console.log(`    ${chalk.cyan('•')} 静态目录: ${chalk.gray(domainConfig.staticRoot)}`);
      }
      
      if (domainConfig.rewritePath) {
        console.log(`    ${chalk.cyan('•')} 路径重写: ${chalk.gray(`${domainConfig.rewritePath.from} → ${domainConfig.rewritePath.to}`)}`);
      }
    }
    
    console.log(chalk.gray('\n─'.repeat(60)));
    
    const ipInfo = await this.getLocalIpAddress();
    console.log(chalk.yellow('\n▶ 本地访问:'));
    
    if (ipInfo.local.length > 0) {
      ipInfo.local.forEach(info => {
        const url = `http://${info.ip}:${this.httpPort}`;
        const label = info.primary ? chalk.green(' ★') : '';
        const interfaceInfo = chalk.gray(` [${info.interface}]`);
        console.log(`    ${chalk.cyan('•')} ${chalk.white(url)}${interfaceInfo}${label}`);
      });
    }
    
    if (cfg.server?.auth?.apiKey?.enabled !== false) {
      console.log(chalk.yellow('\n▶ API密钥:'));
      console.log(`    ${chalk.cyan('•')} ${chalk.white(this.apiKey)}`);
      console.log(chalk.gray(`    提示: 使用 X-API-Key 请求头传递密钥`));
    }
    
    console.log(chalk.gray('─'.repeat(60)) + '\n');
  }

  async _displayHttpsGuide() {
    const domain = cfg.server?.server?.url || 'your-domain.com';
    
    console.log(chalk.yellow('\n╔════════════════════════════════════════════════════════════╗'));
    console.log(chalk.yellow('║') + chalk.white.bold('           HTTPS 反向代理配置指南                          ') + chalk.yellow('║'));
    console.log(chalk.yellow('╚════════════════════════════════════════════════════════════╝\n'));
    
    console.log(chalk.cyan('▶ Nginx 配置示例:'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(chalk.green(`
server {
    listen 443 ssl http2;
    server_name ${domain};
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        root ${process.cwd()}/www;
        index index.html index.htm;
        try_files $uri $uri/ @backend;
    }
    
    location @backend {
        proxy_pass https://127.0.0.1:${this.httpsPort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    location /ws {
        proxy_pass https://127.0.0.1:${this.httpsPort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}`));
    
    console.log(chalk.yellow('\n提示:'));
    console.log(chalk.gray('• 请根据您的实际情况修改域名和证书路径'));
    console.log(chalk.gray('• 静态文件建议由Web服务器直接提供以提升性能'));
    console.log(chalk.gray('• 记得重载Web服务器配置: nginx -s reload'));
    console.log(chalk.gray('─'.repeat(60)) + '\n');
  }

  async _displayAccessUrls(protocol, port) {
    const addresses = [`${protocol}://localhost:${port}`];
    
    const ipInfo = await this.getLocalIpAddress();
    
    console.log(chalk.cyan('\n▶ 访问地址:'));
    console.log(chalk.gray('─'.repeat(50)));
    
    if (ipInfo.local.length > 0) {
      console.log(chalk.yellow('  内网访问:'));
      ipInfo.local.forEach(info => {
        const url = `${protocol}://${info.ip}:${port}`;
        const label = info.primary ? chalk.green(' ★') : '';
        const interfaceInfo = chalk.gray(` [${info.interface}]`);
        console.log(`    ${chalk.cyan('•')} ${chalk.white(url)}${interfaceInfo}${label}`);
        addresses.push(url);
      });
    }
    
    if (ipInfo.public) {
      console.log(chalk.yellow('\n  公网访问:'));
      const publicUrl = `${protocol}://${ipInfo.public}:${port}`;
      console.log(`    ${chalk.cyan('•')} ${chalk.white(publicUrl)}`);
    }
    
    if (cfg.server?.server?.url) {
      console.log(chalk.yellow('\n  配置域名:'));
      const configUrl = `${protocol}://${cfg.server.server.url}${port !== 80 && port !== 443 ? ':' + port : ''}`;
      console.log(`    ${chalk.cyan('•')} ${chalk.white(configUrl)}`);
    }
    
    if (cfg.server?.auth?.apiKey?.enabled !== false) {
      console.log(chalk.yellow('\n  API密钥:'));
      console.log(`    ${chalk.cyan('•')} ${chalk.white(this.apiKey)}`);
      console.log(chalk.gray(`    提示: 使用 X-API-Key 请求头传递密钥`));
    }
    
    console.log(chalk.gray('─'.repeat(50)) + '\n');
  }

  async httpsLoad() {
    const httpsConfig = cfg.server?.https;
    const proxyConfig = cfg.server?.proxy;
    
    if (!httpsConfig?.enabled && !proxyConfig?.domains?.some(d => d.ssl?.enabled)) {
      return;
    }
    
    try {
      let httpsOptions = {};
      
      if (httpsConfig?.enabled && httpsConfig?.certificate) {
        const cert = httpsConfig.certificate;
        
        if (!cert.key || !cert.cert) {
          throw new Error("HTTPS已启用但未配置证书");
        }
        
        if (!fsSync.existsSync(cert.key)) {
          throw new Error(`HTTPS密钥文件不存在: ${cert.key}`);
        }
        
        if (!fsSync.existsSync(cert.cert)) {
          throw new Error(`HTTPS证书文件不存在: ${cert.cert}`);
        }
        
        httpsOptions = {
          key: await fs.readFile(cert.key),
          cert: await fs.readFile(cert.cert)
        };
        
        if (cert.ca && fsSync.existsSync(cert.ca)) {
          httpsOptions.ca = await fs.readFile(cert.ca);
        }
      }
      
      // 处理域名SSL证书
      if (proxyConfig?.enabled && proxyConfig?.domains) {
        for (const domainConfig of proxyConfig.domains) {
          if (domainConfig.ssl?.enabled && domainConfig.ssl?.certificate) {
            const cert = domainConfig.ssl.certificate;
            
            if (!cert.key || !cert.cert) {
              BotUtil.makeLog("warn",
                chalk.yellow(`⚠ 域名 ${domainConfig.domain} 启用SSL但未配置证书`),
                'Server');
              continue;
            }
            
            if (!fsSync.existsSync(cert.key) || !fsSync.existsSync(cert.cert)) {
              BotUtil.makeLog("warn",
                chalk.yellow(`⚠ 域名 ${domainConfig.domain} 的证书文件不存在`),
                'Server');
              continue;
            }
            
            // 使用tls.createSecureContext而非crypto
            const context = tls.createSecureContext({
              key: await fs.readFile(cert.key),
              cert: await fs.readFile(cert.cert),
              ca: cert.ca && fsSync.existsSync(cert.ca) ? await fs.readFile(cert.ca) : undefined
            });
            
            this.sslContexts.set(domainConfig.domain, context);
            BotUtil.makeLog("info",
              chalk.green(`✓ 加载SSL证书: ${domainConfig.domain}`),
              'Server');
          }
        }
      }
      
      if (httpsConfig?.tls?.minVersion) {
        httpsOptions.minVersion = httpsConfig.tls.minVersion;
      }
      
      // SNI处理
      if (this.sslContexts.size > 0) {
        httpsOptions.SNICallback = (servername, cb) => {
          const context = this.sslContexts.get(servername) ||
                         this._findWildcardContext(servername);
          
          if (context) {
            cb(null, context);
          } else {
            cb();
          }
        };
      }
      
      this.httpsServer = https.createServer(httpsOptions, this.express)
        .on("error", err => this._handleServerError(err, true))
        .on("upgrade", this.wsConnect.bind(this));
      
      await this.serverLoad(true);
      
      BotUtil.makeLog("info", chalk.green("✓ HTTPS服务器已启动"), 'Server');
      
    } catch (err) {
      BotUtil.makeLog("error", chalk.red(`✗ HTTPS服务器创建失败: ${err.message}`), 'Server');
    }
  }

  _findWildcardContext(servername) {
    for (const [domain, context] of this.sslContexts) {
      if (domain.startsWith('*.')) {
        const baseDomain = domain.substring(2);
        if (servername.endsWith(baseDomain)) {
          return context;
        }
      }
    }
    return null;
  }

  _setupFinalHandlers() {
    this.express.use((req, res) => {
      let defaultRoute = '/';
      
      if (req.domainConfig?.defaultRoute) {
        defaultRoute = req.domainConfig.defaultRoute;
      } else if (cfg.server?.misc?.defaultRoute) {
        defaultRoute = cfg.server.misc.defaultRoute;
      }
      
      if (req.accepts('html')) {
        const staticRoot = req.staticRoot || path.join(process.cwd(), 'www');
        const custom404Path = path.join(staticRoot, '404.html');
        
        if (fsSync.existsSync(custom404Path)) {
          res.status(404).sendFile(custom404Path);
        } else {
          res.redirect(defaultRoute);
        }
      } else {
        res.status(404).json({
          error: 'Not Found',
          path: req.path,
          timestamp: Date.now()
        });
      }
    });
    
    this.express.use((err, req, res, next) => {
      BotUtil.makeLog('error', chalk.red(`✗ 请求错误: ${err.message}`), 'Server');
      
      res.status(err.status || 500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'production' ?
          'An error occurred' : err.message,
        timestamp: Date.now()
      });
    });
  }

  async closeServer() {
    BotUtil.makeLog('info', chalk.yellow('⏳ 正在关闭服务器...'), 'Server');
    
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
    }
    
    if (this.httpsServer) {
      await new Promise(resolve => this.httpsServer.close(resolve));
    }
    
    await BotUtil.sleep(2000);
    await this.redisExit();
    
    BotUtil.makeLog('info', chalk.green('✓ 服务器已关闭'), 'Server');
  }

  getServerUrl() {
    const protocol = cfg.server?.https?.enabled ? 'https' : 'http';
    const port = protocol === 'https' ? this.httpsPort : this.httpPort;
    const host = cfg.server?.server?.url || 'localhost';
    
    const needPort = (protocol === 'http' && port !== 80) ||
                     (protocol === 'https' && port !== 443);
    
    return `${protocol}://${host}${needPort ? ':' + port : ''}`;
  }

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
      
      try {
        result.primary = await this._getIpByUdp();
        const existingItem = result.local.find(item => item.ip === result.primary);
        if (existingItem) {
          existingItem.primary = true;
        }
      } catch { }
      
      if (cfg.server?.misc?.detectPublicIP !== false) {
        result.public = await this._getPublicIP();
      }
      
      this._cache.set(cacheKey, result);
      return result;
      
    } catch (err) {
      BotUtil.makeLog("debug", chalk.gray(`获取IP地址失败: ${err.message}`), 'Server');
      return result;
    }
  }

  _isVirtualInterface(name, mac) {
    const virtualPatterns = [
      /^(docker|br-|veth|virbr|vnet)/i,
      /^(vmnet|vmware)/i,
      /^(vboxnet|virtualbox)/i
    ];
    
    return virtualPatterns.some(p => p.test(name));
  }

  async _getIpByUdp() {
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

  async _getPublicIP() {
    const apis = [
      { url: 'https://api.ipify.org?format=json', field: 'ip' },
      { url: 'https://api.myip.la/json', field: 'ip' }
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
          const ip = data[api.field];
          if (ip && this._isValidIP(ip)) return ip;
        }
      } catch {
        continue;
      }
    }
    
    return null;
  }

  _isValidIP(ip) {
    if (!ip) return false;
    
    const ipv4Regex = /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
    return ipv4Regex.test(ip);
  }

  async run(options = {}) {
    const { port } = options;
    
    const proxyConfig = cfg.server?.proxy;
    this.proxyEnabled = proxyConfig?.enabled === true;
    
    // 修正端口逻辑：反向代理模式仍使用传入的端口
    if (port) {
      this.httpPort = port;
      this.httpsPort = port + 1;
    } else {
      this.httpPort = 2537; // 默认端口
      this.httpsPort = 2538;
    }
    
    console.log(chalk.cyan('\n╔════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.yellow.bold('          正在初始化服务器...                              ') + chalk.cyan('║'));
    console.log(chalk.cyan('╚════════════════════════════════════════════════════════════╝\n'));
    
    BotUtil.makeLog('info',
      chalk.gray(`配置端口: HTTP=${this.httpPort}, HTTPS=${this.httpsPort}`), 'Server');
    
    if (this.proxyEnabled) {
      BotUtil.makeLog('info',
        chalk.cyan(`⚡ 反向代理模式已启用`), 'Server');
    }
    
    await init();
    await this.generateApiKey();
    await PluginsLoader.load();
    await ApiLoader.load();
    
    this._initializeMiddlewareAndRoutes();
    
    await ApiLoader.register(this.express, this);
    
    this._setupFinalHandlers();
    
    await this.serverLoad(false);
    
    if (cfg.server?.https?.enabled ||
        (this.proxyEnabled && proxyConfig?.domains?.some(d => d.ssl?.enabled))) {
      await this.httpsLoad();
    }
    
    await ListenerLoader.load();
    await ApiLoader.watch(true);
    
    if (Object.keys(this.wsf).length > 0) {
      BotUtil.makeLog("info",
        chalk.cyan(`⚡ WebSocket服务: ${this.getServerUrl().replace(/^http/, "ws")}/ [${Object.keys(this.wsf).join(', ')}]`),
        'Server');
    }
    
    this.emit("online", {
      bot: this,
      timestamp: Date.now(),
      url: this.getServerUrl(),
      uptime: process.uptime(),
      apis: ApiLoader.getApiList(),
      proxyEnabled: this.proxyEnabled
    });
  }

  // Bot功能方法
  prepareEvent(data) {
    if (!this.bots[data.self_id]) return;
    
    if (!data.bot) {
      Object.defineProperty(data, "bot", {
        value: this.bots[data.self_id]
      });
    }
    
    if (data.user_id) {
      if (!data.friend) {
        Object.defineProperty(data, "friend", {
          value: data.bot.pickFriend(data.user_id)
        });
      }
      data.sender ||= { user_id: data.user_id };
      data.sender.nickname ||= data.friend?.nickname;
    }
    
    if (data.group_id) {
      if (!data.group) {
        Object.defineProperty(data, "group", {
          value: data.bot.pickGroup(data.group_id)
        });
      }
      data.group_name ||= data.group?.name;
    }
    
    if (data.group && data.user_id) {
      if (!data.member) {
        Object.defineProperty(data, "member", {
          value: data.group.pickMember(data.user_id)
        });
      }
      data.sender.nickname ||= data.member?.nickname;
      data.sender.card ||= data.member?.card;
    }
    
    if (data.bot.adapter?.id) data.adapter_id = data.bot.adapter.id;
    if (data.bot.adapter?.name) data.adapter_name = data.bot.adapter.name;
    
    this._extendEventMethods(data);
  }

  _extendEventMethods(data) {
    for (const target of [data.friend, data.group, data.member]) {
      if (!target || typeof target !== "object") continue;
      
      target.sendFile ??= (file, name) =>
        target.sendMsg(segment.file(file, name));
      target.makeForwardMsg ??= this.makeForwardMsg;
      target.sendForwardMsg ??= msg =>
        this.sendForwardMsg(msg => target.sendMsg(msg), msg);
      target.getInfo ??= () => target.info || target;
    }
    
    if (!data.reply) {
      data.reply = data.group?.sendMsg?.bind(data.group) ||
        data.friend?.sendMsg?.bind(data.friend);
    }
  }

  em(name = "", data = {}) {
    this.prepareEvent(data);
    
    while (name) {
      this.emit(name, data);
      const lastDot = name.lastIndexOf(".");
      if (lastDot === -1) break;
      name = name.slice(0, lastDot);
    }
  }

  getFriendArray() {
    const array = []
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].fl || []) array.push({ ...i, bot_id })
    return array
  }

  getFriendList() {
    const array = []
    for (const bot_id of this.uin) array.push(...(this.bots[bot_id].fl?.keys() || []))
    return array
  }

  getFriendMap() {
    const map = new Map()
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].fl || []) map.set(id, { ...i, bot_id })
    return map
  }
  
  get fl() {
    return this.getFriendMap()
  }

  getGroupArray() {
    const array = []
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].gl || []) array.push({ ...i, bot_id })
    return array
  }

  getGroupList() {
    const array = []
    for (const bot_id of this.uin) array.push(...(this.bots[bot_id].gl?.keys() || []))
    return array
  }

  getGroupMap() {
    const map = new Map()
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].gl || []) map.set(id, { ...i, bot_id })
    return map
  }
  
  get gl() {
    return this.getGroupMap()
  }
  
  get gml() {
    const map = new Map()
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].gml || [])
        map.set(id, Object.assign(new Map(i), { bot_id }))
    return map
  }

  pickFriend(user_id, strict) {
    user_id = Number(user_id) || user_id;
    
    const mainBot = this.bots[this.uin];
    if (mainBot?.fl?.has(user_id)) {
      return mainBot.pickFriend(user_id);
    }
    
    const friend = this.fl.get(user_id);
    if (friend) {
      return this.bots[friend.bot_id].pickFriend(user_id);
    }
    
    if (strict) return false;
    
    BotUtil.makeLog("trace",
      chalk.gray(`因不存在用户 ${user_id} 而随机选择Bot ${this.uin.toJSON()}`), 'Server');
    return this.bots[this.uin].pickFriend(user_id);
  }

  get pickUser() {
    return this.pickFriend;
  }

  pickGroup(group_id, strict) {
    group_id = Number(group_id) || group_id;
    
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
      chalk.gray(`因不存在群 ${group_id} 而随机选择Bot ${this.uin.toJSON()}`), 'Server');
    return this.bots[this.uin].pickGroup(group_id);
  }

  pickMember(group_id, user_id) {
    return this.pickGroup(group_id).pickMember(user_id);
  }

  async sendFriendMsg(bot_id, user_id, ...args) {
    if (!bot_id) {
      return this.pickFriend(user_id).sendMsg(...args);
    }
    
    if (this.uin.includes(bot_id) && this.bots[bot_id]) {
      return this.bots[bot_id].pickFriend(user_id).sendMsg(...args);
    }
    
    return new Promise((resolve, reject) => {
      const listener = data => {
        resolve(data.bot.pickFriend(user_id).sendMsg(...args));
        clearTimeout(timeout);
      };
      
      const timeout = setTimeout(() => {
        reject(Object.assign(Error("等待 Bot 上线超时"),
          { bot_id, user_id, args }));
        this.off(`connect.${bot_id}`, listener);
      }, 300000);
      
      this.once(`connect.${bot_id}`, listener);
    });
  }

  async sendGroupMsg(bot_id, group_id, ...args) {
    if (!bot_id) {
      return this.pickGroup(group_id).sendMsg(...args);
    }
    
    if (this.uin.includes(bot_id) && this.bots[bot_id]) {
      return this.bots[bot_id].pickGroup(group_id).sendMsg(...args);
    }
    
    return new Promise((resolve, reject) => {
      const listener = data => {
        resolve(data.bot.pickGroup(group_id).sendMsg(...args));
        clearTimeout(timeout);
      };
      
      const timeout = setTimeout(() => {
        reject(Object.assign(Error("等待 Bot 上线超时"),
          { bot_id, group_id, args }));
        this.off(`connect.${bot_id}`, listener);
      }, 300000);
      
      this.once(`connect.${bot_id}`, listener);
    });
  }

  async sendMasterMsg(msg, sleep = 5000) {
    const masterQQs = cfg.masterQQ;
    if (!masterQQs?.length) {
      throw new Error("未配置主人QQ");
    }
    
    const results = {};
    
    for (let i = 0; i < masterQQs.length; i++) {
      const user_id = masterQQs[i];
      
      try {
        const friend = this.pickFriend(user_id);
        if (friend?.sendMsg) {
          results[user_id] = await friend.sendMsg(msg);
          BotUtil.makeLog("debug", chalk.green(`✓ 成功发送消息给主人 ${user_id}`), 'Server');
        } else {
          results[user_id] = { error: "无法找到可用的Bot" };
          BotUtil.makeLog("warn", chalk.yellow(`⚠ 无法向主人 ${user_id} 发送消息`), 'Server');
        }
        
        if (sleep && i < masterQQs.length - 1) {
          await BotUtil.sleep(sleep);
        }
      } catch (err) {
        results[user_id] = { error: err.message };
        BotUtil.makeLog("error",
          chalk.red(`✗ 向主人 ${user_id} 发送消息失败: ${err.message}`), 'Server');
      }
    }
    
    return results;
  }

  makeForwardMsg(msg) {
    return { type: "node", data: msg };
  }

  async sendForwardMsg(send, msg) {
    const messages = Array.isArray(msg) ? msg : [msg];
    return Promise.all(messages.map(({ message }) => send(message)));
  }

  async redisExit() {
    if (!(typeof redis === 'object' && redis.process)) return false;
    
    const process = redis.process;
    delete redis.process;
    
    await BotUtil.sleep(5000, redis.save().catch(() => { }));
    return process.kill();
  }

  async fileToUrl(file, opts = {}) {
    return await BotUtil.fileToUrl(file, opts);
  }
}