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

export default class Bot extends EventEmitter {
  constructor() {
    super();
    
    this.stat = { start_time: Date.now() / 1000 };
    this.bot = this;
    this.bots = {};
    this.adapter = [];
    this.uin = this._createUinManager();
    
    this.express = Object.assign(express(), { skip_auth: [], quiet: [] });
    this.server = null;
    this.httpsServer = null;
    this.wss = new WebSocketServer({ noServer: true });
    this.wsf = Object.create(null);
    this.fs = Object.create(null);
    
    this.apiKey = '';
    this._cache = BotUtil.getMap('yunzai_cache', { ttl: 60000, autoClean: true });
    this._rateLimiters = new Map();
    this.httpPort = null;
    this.httpsPort = null;
    this.actualPort = null; // 实际服务端口
    this.actualHttpsPort = null;
    this.url = cfg.server?.server?.url || '';
    
    this.proxyEnabled = false;
    this.proxyServer = null;
    this.proxyHttpsServer = null;
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
    // 压缩
    if (cfg.server?.compression?.enabled !== false) {
      this.express.use(compression({
        filter: (req, res) =>
          !req.headers['x-no-compression'] && compression.filter(req, res),
        level: cfg.server?.compression?.level || 6,
        threshold: cfg.server?.compression?.threshold || 1024
      }));
    }
    
    // 安全头部
    if (cfg.server?.security?.helmet?.enabled !== false) {
      this.express.use(helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        hsts: cfg.server?.security?.hsts?.enabled === true ? {
          maxAge: cfg.server.security.hsts.maxAge || 31536000,
          includeSubDomains: cfg.server.security.hsts.includeSubDomains !== false,
          preload: cfg.server.security.hsts.preload === true
        } : false
      }));
    }
    
    this._setupCors();
    this._setupRequestLogging();
    this._setupRateLimiting();
    this._setupBodyParsers();
    this.express.use(this._authMiddleware.bind(this));
    
    this.express.get('/status', this._statusHandler.bind(this));
    this.express.get('/health', this._healthHandler.bind(this));
    this.express.use('/File', this._fileHandler.bind(this));
    
    this._setupStaticServing();
  }

  _initProxyServers() {
    const proxyConfig = cfg.server?.proxy;
    if (!proxyConfig?.enabled) return;
    
    // 创建代理服务器应用
    const proxyApp = express();
    
    // 添加域名路由中间件
    proxyApp.use((req, res, next) => {
      const hostname = req.hostname || req.headers.host?.split(':')[0];
      
      if (!hostname) {
        return res.status(400).send('Bad Request: Missing Host header');
      }
      
      const domainConfig = this._findDomainConfig(hostname);
      
      if (!domainConfig) {
        return res.status(404).send('Domain not configured');
      }
      
      req.domainConfig = domainConfig;
      
      // 路径重写
      if (domainConfig.rewritePath) {
        const { from, to } = domainConfig.rewritePath;
        if (from && req.path.startsWith(from)) {
          const newPath = req.path.replace(from, to || '');
          req.url = newPath + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
          BotUtil.makeLog('debug', `Path rewrite: ${req.path} → ${newPath}`, 'Proxy');
        }
      }
      
      // 如果配置了目标服务器，使用代理
      if (domainConfig.target) {
        const proxyMiddleware = this.proxyMiddlewares.get(domainConfig.domain);
        if (proxyMiddleware) {
          return proxyMiddleware(req, res, next);
        }
      }
      
      // 否则代理到本地实际服务
      const targetPort = req.secure ? this.actualHttpsPort : this.actualPort;
      const targetProtocol = req.secure ? 'https' : 'http';
      const proxyOptions = {
        target: `${targetProtocol}://127.0.0.1:${targetPort}`,
        changeOrigin: true,
        ws: true,
        xfwd: true,
        secure: false
      };
      
      const proxy = createProxyMiddleware(proxyOptions);
      return proxy(req, res, next);
    });
    
    // 创建HTTP代理服务器
    this.proxyServer = http.createServer(proxyApp);
    this.proxyServer.on("error", err => this._handleProxyServerError(err, false));
    
    // 创建HTTPS代理服务器（如果有域名启用SSL）
    if (proxyConfig.domains?.some(d => d.ssl?.enabled)) {
      this._initHttpsProxyServer(proxyApp);
    }
  }

  _initHttpsProxyServer(proxyApp) {
    const httpsOptions = {};
    
    // 加载域名SSL证书
    for (const domainConfig of cfg.server.proxy.domains) {
      if (domainConfig.ssl?.enabled && domainConfig.ssl?.certificate) {
        const cert = domainConfig.ssl.certificate;
        
        if (!cert.key || !cert.cert) continue;
        if (!fsSync.existsSync(cert.key) || !fsSync.existsSync(cert.cert)) continue;
        
        try {
          const context = tls.createSecureContext({
            key: fsSync.readFileSync(cert.key),
            cert: fsSync.readFileSync(cert.cert),
            ca: cert.ca && fsSync.existsSync(cert.ca) ? fsSync.readFileSync(cert.ca) : undefined
          });
          
          this.sslContexts.set(domainConfig.domain, context);
          BotUtil.makeLog("info", `✓ Loaded SSL cert for ${domainConfig.domain}`, 'Proxy');
        } catch (err) {
          BotUtil.makeLog("error", `Failed to load SSL cert for ${domainConfig.domain}: ${err.message}`, 'Proxy');
        }
      }
    }
    
    // SNI callback
    httpsOptions.SNICallback = (servername, cb) => {
      const context = this.sslContexts.get(servername) || this._findWildcardContext(servername);
      cb(null, context);
    };
    
    // 使用第一个可用的证书作为默认
    if (this.sslContexts.size > 0) {
      const [firstDomain, firstContext] = this.sslContexts.entries().next().value;
      const cert = cfg.server.proxy.domains.find(d => d.domain === firstDomain)?.ssl?.certificate;
      if (cert) {
        httpsOptions.key = fsSync.readFileSync(cert.key);
        httpsOptions.cert = fsSync.readFileSync(cert.cert);
      }
    }
    
    this.proxyHttpsServer = https.createServer(httpsOptions, proxyApp);
    this.proxyHttpsServer.on("error", err => this._handleProxyServerError(err, true));
  }

  _handleProxyServerError(err, isHttps) {
    BotUtil.makeLog("error", `Proxy ${isHttps ? 'HTTPS' : 'HTTP'} Server Error: ${err.message}`, 'Proxy');
  }

  _createDomainProxy(domainConfig) {
    this.domainConfigs.set(domainConfig.domain, domainConfig);
    
    if (!domainConfig.target) return;
    
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
        BotUtil.makeLog('error', `Proxy error [${domainConfig.domain}]: ${err.message}`, 'Proxy');
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
    
    BotUtil.makeLog('info', `✓ Created proxy: ${domainConfig.domain} → ${domainConfig.target}`, 'Proxy');
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
          
          BotUtil.makeLog('debug', `${method} ${status} ${time} ${path}${host}`, 'HTTP');
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
    
    BotUtil.makeLog('info', '⚡ Static file serving enabled', 'Server');
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
          BotUtil.makeLog('debug', `Directory redirect: ${req.path} → ${redirectUrl}`, 'Server');
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
            BotUtil.makeLog("trace", `Redirecting Bot.${prop} to Bot.${botId}.${prop}`);
            return typeof bot[prop] === "function" ?
              bot[prop].bind(bot) : bot[prop];
          }
        }
        
        BotUtil.makeLog("trace", `Bot.${prop} not found`);
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
        BotUtil.makeLog('info', '✓ API key loaded', 'Server');
        return this.apiKey;
      }
      
      const keyLength = apiKeyConfig.length || 64;
      this.apiKey = BotUtil.randomString(keyLength);
      
      await BotUtil.mkdir(path.dirname(apiKeyPath));
      await fs.writeFile(apiKeyPath, JSON.stringify({
        key: this.apiKey,
        generated: new Date().toISOString(),
        note: 'API key for remote access'
      }, null, 2), 'utf8');
      
      if (process.platform !== 'win32') {
        try { await fs.chmod(apiKeyPath, 0o600); } catch { }
      }
      
      BotUtil.apiKey = this.apiKey;
      BotUtil.makeLog('success', `⚡ Generated API key: ${this.apiKey}`, 'Server');
      return this.apiKey;
      
    } catch (error) {
      BotUtil.makeLog('error', `API key error: ${error.message}`, 'Server');
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
      BotUtil.makeLog("debug", `Local connection, skip auth: ${req.ip}`, 'Auth');
      return next();
    }
    
    if (!this._checkApiAuthorization(req)) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or missing API key',
        hint: 'Provide X-API-Key header or api_key parameter'
      });
      
      BotUtil.makeLog("warn", `Auth failed: ${req.method} ${req.originalUrl} from ${req.ip}`, 'Auth');
      return;
    }
    
    BotUtil.makeLog("debug", `Auth success: ${req.method} ${req.originalUrl}`, 'Auth');
    next();
  }

  _checkApiAuthorization(req) {
    if (!req) return false;
    
    const authKey = req.headers?.["x-api-key"] ??
      req.headers?.["authorization"]?.replace('Bearer ', '') ??
      req.query?.api_key ??
      req.body?.api_key;
    
    if (!this.apiKey || !authKey) {
      BotUtil.makeLog("debug", `API auth failed: missing key`, 'Auth');
      return false;
    }
    
    try {
      const authKeyBuffer = Buffer.from(String(authKey));
      const apiKeyBuffer = Buffer.from(String(this.apiKey));
      
      if (authKeyBuffer.length !== apiKeyBuffer.length) {
        BotUtil.makeLog("warn", `Unauthorized access from ${req.socket?.remoteAddress || req.ip}`, 'Auth');
        return false;
      }
      
      return crypto.timingSafeEqual(authKeyBuffer, apiKeyBuffer);
      
    } catch (error) {
      BotUtil.makeLog("error", `API auth error: ${error.message}`, 'Auth');
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
        actualPort: this.actualPort,
        actualHttpsPort: this.actualHttpsPort,
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
    
    BotUtil.makeLog("debug", `File sent: ${file.name} (${BotUtil.formatFileSize(file.buffer.length)})`, 'Server');
    
    res.send(file.buffer);
  }

  wsConnect(req, socket, head) {
    req.rid = `${req.socket.remoteAddress}:${req.socket.remotePort}-${req.headers["sec-websocket-key"]}`;
    req.sid = `ws://${req.headers.host || `${req.socket.localAddress}:${req.socket.localPort}`}${req.url}`;
    req.query = Object.fromEntries(new URL(req.sid).searchParams.entries());
    
    if (!this._isLocalConnection(req.socket.remoteAddress)) {
      if (!this._checkApiAuthorization(req)) {
        BotUtil.makeLog("error", `WebSocket auth failed: ${req.url}`, 'Server');
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
      BotUtil.makeLog("debug", `WebSocket connected: ${req.url}`, 'Server');
      
      conn.on("error", err => BotUtil.makeLog("error", err, 'Server'));
      conn.on("close", () => BotUtil.makeLog("debug", `WebSocket disconnected: ${req.url}`, 'Server'));
      
      conn.on("message", msg => {
        const logMsg = Buffer.isBuffer(msg) && msg.length > 1024 ?
          `[Binary message, length: ${msg.length}]` : BotUtil.String(msg);
        BotUtil.makeLog("trace", `WS message: ${logMsg}`, 'Server');
      });
      
      conn.sendMsg = msg => {
        if (!Buffer.isBuffer(msg)) msg = BotUtil.String(msg);
        BotUtil.makeLog("trace", `WS send: ${msg}`, 'Server');
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
    
    BotUtil.makeLog("error", `${serverType} port ${port} already in use`, 'Server');
    
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
      BotUtil.makeLog('error', `${isHttps ? 'HTTPS' : 'HTTP'} server failed to start`, 'Server');
      return;
    }
    
    if (isHttps) {
      this.httpsPort = serverInfo.port;
    } else {
      this.httpPort = serverInfo.port;
    }
    
    const protocol = isHttps ? 'https' : 'http';
    const serverType = isHttps ? 'HTTPS' : 'HTTP';
    
    BotUtil.makeLog("info", `✓ ${serverType} server listening on ${host}:${serverInfo.port}`, 'Server');
    
    if (!isHttps && !this.proxyEnabled) {
      await this._displayAccessUrls(protocol, serverInfo.port);
    }
  }

  async startProxyServers() {
    const proxyConfig = cfg.server?.proxy;
    if (!proxyConfig?.enabled) return;
    
    BotUtil.makeLog('info', '⚡ Starting proxy servers', 'Proxy');
    
    // Initialize domain proxies
    for (const domainConfig of proxyConfig.domains) {
      this._createDomainProxy(domainConfig);
    }
    
    // Start HTTP proxy server
    const httpPort = proxyConfig.httpPort || 80;
    const host = cfg.server?.server?.host || '0.0.0.0';
    
    this.proxyServer.listen(httpPort, host);
    await BotUtil.promiseEvent(this.proxyServer, "listening").catch(() => { });
    
    BotUtil.makeLog('info', `✓ HTTP proxy server listening on ${host}:${httpPort}`, 'Proxy');
    
    // Start HTTPS proxy server if needed
    if (this.proxyHttpsServer) {
      const httpsPort = proxyConfig.httpsPort || 443;
      this.proxyHttpsServer.listen(httpsPort, host);
      await BotUtil.promiseEvent(this.proxyHttpsServer, "listening").catch(() => { });
      
      BotUtil.makeLog('info', `✓ HTTPS proxy server listening on ${host}:${httpsPort}`, 'Proxy');
    }
    
    await this._displayProxyInfo();
  }

  async _displayProxyInfo() {
    console.log(chalk.cyan('\n╔════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.yellow.bold('                Proxy Server Configuration                 ') + chalk.cyan('║'));
    console.log(chalk.cyan('╚════════════════════════════════════════════════════════════╝\n'));
    
    console.log(chalk.cyan('▶ Proxy Domains:'));
    console.log(chalk.gray('─'.repeat(60)));
    
    const proxyConfig = cfg.server?.proxy;
    const domains = proxyConfig?.domains || [];
    
    for (const domainConfig of domains) {
      const protocol = domainConfig.ssl?.enabled ? 'https' : 'http';
      const port = protocol === 'https' ? 
        (proxyConfig.httpsPort || 443) : 
        (proxyConfig.httpPort || 80);
      const displayPort = (port === 80 && protocol === 'http') || 
                          (port === 443 && protocol === 'https') ? '' : `:${port}`;
      
      console.log(chalk.yellow(`\n  ${domainConfig.domain}:`));
      console.log(`    ${chalk.cyan('•')} Access: ${chalk.white(`${protocol}://${domainConfig.domain}${displayPort}`)}`);
      
      if (domainConfig.target) {
        console.log(`    ${chalk.cyan('•')} Target: ${chalk.gray(domainConfig.target)}`);
      } else {
        console.log(`    ${chalk.cyan('•')} Target: ${chalk.gray(`Local service on port ${this.actualPort}`)}`);
      }
      
      if (domainConfig.staticRoot) {
        console.log(`    ${chalk.cyan('•')} Static: ${chalk.gray(domainConfig.staticRoot)}`);
      }
      
      if (domainConfig.rewritePath) {
        console.log(`    ${chalk.cyan('•')} Rewrite: ${chalk.gray(`${domainConfig.rewritePath.from} → ${domainConfig.rewritePath.to}`)}`);
      }
    }
    
    console.log(chalk.gray('\n─'.repeat(60)));
    
    console.log(chalk.yellow('\n▶ Local Service:'));
    console.log(`    ${chalk.cyan('•')} HTTP: ${chalk.white(`http://localhost:${this.actualPort}`)}`);
    if (this.actualHttpsPort) {
      console.log(`    ${chalk.cyan('•')} HTTPS: ${chalk.white(`https://localhost:${this.actualHttpsPort}`)}`);
    }
    
    if (cfg.server?.auth?.apiKey?.enabled !== false) {
      console.log(chalk.yellow('\n▶ API Key:'));
      console.log(`    ${chalk.cyan('•')} ${chalk.white(this.apiKey)}`);
      console.log(chalk.gray(`    Use X-API-Key header for authentication`));
    }
    
    console.log(chalk.gray('─'.repeat(60)) + '\n');
  }

  async _displayAccessUrls(protocol, port) {
    const addresses = [`${protocol}://localhost:${port}`];
    
    const ipInfo = await this.getLocalIpAddress();
    
    console.log(chalk.cyan('\n▶ Access URLs:'));
    console.log(chalk.gray('─'.repeat(50)));
    
    if (ipInfo.local.length > 0) {
      console.log(chalk.yellow('  Local:'));
      ipInfo.local.forEach(info => {
        const url = `${protocol}://${info.ip}:${port}`;
        const label = info.primary ? chalk.green(' ★') : '';
        const interfaceInfo = chalk.gray(` [${info.interface}]`);
        console.log(`    ${chalk.cyan('•')} ${chalk.white(url)}${interfaceInfo}${label}`);
        addresses.push(url);
      });
    }
    
    if (ipInfo.public && cfg.server?.misc?.detectPublicIP !== false) {
      console.log(chalk.yellow('\n  Public:'));
      const publicUrl = `${protocol}://${ipInfo.public}:${port}`;
      console.log(`    ${chalk.cyan('•')} ${chalk.white(publicUrl)}`);
    }
    
    if (cfg.server?.server?.url) {
      console.log(chalk.yellow('\n  Configured:'));
      const configUrl = cfg.server.server.url.startsWith('http') ? 
        cfg.server.server.url : 
        `${protocol}://${cfg.server.server.url}`;
      console.log(`    ${chalk.cyan('•')} ${chalk.white(`${configUrl}:${port}`)}`);
    }
    
    if (cfg.server?.auth?.apiKey?.enabled !== false) {
      console.log(chalk.yellow('\n  API Key:'));
      console.log(`    ${chalk.cyan('•')} ${chalk.white(this.apiKey)}`);
      console.log(chalk.gray(`    Use X-API-Key header`));
    }
    
    console.log(chalk.gray('─'.repeat(50)) + '\n');
  }

  async httpsLoad() {
    const httpsConfig = cfg.server?.https;
    
    if (!httpsConfig?.enabled) {
      return;
    }
    
    try {
      let httpsOptions = {};
      
      if (httpsConfig?.certificate) {
        const cert = httpsConfig.certificate;
        
        if (!cert.key || !cert.cert) {
          throw new Error("HTTPS enabled but no certificate configured");
        }
        
        if (!fsSync.existsSync(cert.key)) {
          throw new Error(`HTTPS key file not found: ${cert.key}`);
        }
        
        if (!fsSync.existsSync(cert.cert)) {
          throw new Error(`HTTPS cert file not found: ${cert.cert}`);
        }
        
        httpsOptions = {
          key: await fs.readFile(cert.key),
          cert: await fs.readFile(cert.cert)
        };
        
        if (cert.ca && fsSync.existsSync(cert.ca)) {
          httpsOptions.ca = await fs.readFile(cert.ca);
        }
      }
      
      if (httpsConfig?.tls?.minVersion) {
        httpsOptions.minVersion = httpsConfig.tls.minVersion;
      }
      
      this.httpsServer = https.createServer(httpsOptions, this.express)
        .on("error", err => this._handleServerError(err, true))
        .on("upgrade", this.wsConnect.bind(this));
      
      await this.serverLoad(true);
      
      BotUtil.makeLog("info", "✓ HTTPS server started", 'Server');
      
    } catch (err) {
      BotUtil.makeLog("error", `HTTPS server error: ${err.message}`, 'Server');
    }
  }

  _setupFinalHandlers() {
    this.express.use((req, res) => {
      let defaultRoute = cfg.server?.misc?.defaultRoute || '/';
      
      if (req.domainConfig?.defaultRoute) {
        defaultRoute = req.domainConfig.defaultRoute;
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
      BotUtil.makeLog('error', `Request error: ${err.message}`, 'Server');
      
      res.status(err.status || 500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'production' ?
          'An error occurred' : err.message,
        timestamp: Date.now()
      });
    });
  }

  async closeServer() {
    BotUtil.makeLog('info', '⏳ Closing servers...', 'Server');
    
    const servers = [
      this.server,
      this.httpsServer,
      this.proxyServer,
      this.proxyHttpsServer
    ].filter(Boolean);
    
    await Promise.all(servers.map(server =>
      new Promise(resolve => server.close(resolve))
    ));
    
    await BotUtil.sleep(2000);
    await this.redisExit();
    
    BotUtil.makeLog('info', '✓ Servers closed', 'Server');
  }

  getServerUrl() {
    if (this.proxyEnabled && cfg.server?.proxy?.domains?.[0]) {
      const domain = cfg.server.proxy.domains[0];
      const protocol = domain.ssl?.enabled ? 'https' : 'http';
      return `${protocol}://${domain.domain}`;
    }
    
    const protocol = cfg.server?.https?.enabled ? 'https' : 'http';
    const port = protocol === 'https' ? this.actualHttpsPort : this.actualPort;
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
      BotUtil.makeLog("debug", `Get IP failed: ${err.message}`, 'Server');
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
        reject(new Error('UDP timeout'));
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
    
    // Store actual service ports
    this.actualPort = port || 2537;
    this.actualHttpsPort = this.actualPort + 1;
    
    // Set ports based on proxy configuration
    if (this.proxyEnabled) {
      // Proxy servers will listen on configured ports (80/443)
      this.httpPort = proxyConfig.httpPort || 80;
      this.httpsPort = proxyConfig.httpsPort || 443;
    } else {
      // Direct access mode
      this.httpPort = this.actualPort;
      this.httpsPort = this.actualHttpsPort;
    }
    
    console.log(chalk.cyan('\n╔════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.yellow.bold('                Initializing Server...                     ') + chalk.cyan('║'));
    console.log(chalk.cyan('╚════════════════════════════════════════════════════════════╝\n'));
    
    if (this.proxyEnabled) {
      BotUtil.makeLog('info', '⚡ Proxy mode enabled', 'Server');
      BotUtil.makeLog('info', `Service ports: ${this.actualPort} (HTTP), ${this.actualHttpsPort} (HTTPS)`, 'Server');
      BotUtil.makeLog('info', `Proxy ports: ${this.httpPort} (HTTP), ${this.httpsPort} (HTTPS)`, 'Server');
    } else {
      BotUtil.makeLog('info', `Ports: ${this.httpPort} (HTTP), ${this.httpsPort} (HTTPS)`, 'Server');
    }
    
    await init();
    await this.generateApiKey();
    await PluginsLoader.load();
    await ApiLoader.load();
    
    this._initializeMiddlewareAndRoutes();
    
    await ApiLoader.register(this.express, this);
    
    this._setupFinalHandlers();
    
    // Start main service server on actual port
    const originalHttpPort = this.httpPort;
    const originalHttpsPort = this.httpsPort;
    
    if (this.proxyEnabled) {
      this.httpPort = this.actualPort;
      this.httpsPort = this.actualHttpsPort;
    }
    
    await this.serverLoad(false);
    
    if (cfg.server?.https?.enabled) {
      await this.httpsLoad();
    }
    
    // Restore proxy ports and start proxy servers
    if (this.proxyEnabled) {
      this.httpPort = originalHttpPort;
      this.httpsPort = originalHttpsPort;
      
      this._initProxyServers();
      await this.startProxyServers();
    }
    
    await ListenerLoader.load();
    await ApiLoader.watch(true);
    
    if (Object.keys(this.wsf).length > 0) {
      BotUtil.makeLog("info", `⚡ WebSocket: ${this.getServerUrl().replace(/^http/, "ws")}/ [${Object.keys(this.wsf).join(', ')}]`, 'Server');
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
    
    BotUtil.makeLog("trace", `User ${user_id} not found, using random Bot ${this.uin.toJSON()}`, 'Server');
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
    
    BotUtil.makeLog("trace", `Group ${group_id} not found, using random Bot ${this.uin.toJSON()}`, 'Server');
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
        reject(Object.assign(Error("Bot online timeout"),
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
        reject(Object.assign(Error("Bot online timeout"),
          { bot_id, group_id, args }));
        this.off(`connect.${bot_id}`, listener);
      }, 300000);
      
      this.once(`connect.${bot_id}`, listener);
    });
  }

  async sendMasterMsg(msg, sleep = 5000) {
    const masterQQs = cfg.masterQQ;
    if (!masterQQs?.length) {
      throw new Error("No master QQ configured");
    }
    
    const results = {};
    
    for (let i = 0; i < masterQQs.length; i++) {
      const user_id = masterQQs[i];
      
      try {
        const friend = this.pickFriend(user_id);
        if (friend?.sendMsg) {
          results[user_id] = await friend.sendMsg(msg);
          BotUtil.makeLog("debug", `Sent to master ${user_id}`, 'Server');
        } else {
          results[user_id] = { error: "No bot available" };
          BotUtil.makeLog("warn", `Cannot send to master ${user_id}`, 'Server');
        }
        
        if (sleep && i < masterQQs.length - 1) {
          await BotUtil.sleep(sleep);
        }
      } catch (err) {
        results[user_id] = { error: err.message };
        BotUtil.makeLog("error", `Failed to send to master ${user_id}: ${err.message}`, 'Server');
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