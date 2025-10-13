// bot.js - 主Bot类实现，负责服务器管理、事件处理和Bot逻辑
// 使用Fastify替换Express，提高性能和访问速度
// 优化WS性能：集成fastify-websocket，支持更高并发，降低内存占用
// 适配最新Node.js版本（v22+），使用原生HTTP/HTTPS和TLS
// 标准化注释，提供完整实现

import path from 'path';
import fs from 'node:fs/promises';
import * as fsSync from 'fs';
import { EventEmitter } from "events";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import crypto from 'crypto';
import os from 'node:os';
import dgram from 'node:dgram';
import chalk from 'chalk';
import { createProxyMiddleware } from 'http-proxy-middleware';
import fastify from 'fastify';
import fastifyCompress from '@fastify/compress';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';

import PluginsLoader from "./plugins/loader.js";
import ListenerLoader from "./listener/loader.js";
import ApiLoader from "./http/loader.js";
import Packageloader from "./config/loader.js";
import StreamLoader from "./aistream/loader.js";
import BotUtil from './common/util.js';
import cfg from './config/config.js';

/**
 * Bot主类，继承EventEmitter，管理服务器、WebSocket和Bot逻辑
 * @class Bot
 * @extends EventEmitter
 */
export default class Bot extends EventEmitter {
  constructor() {
    super();
    
    this.stat = { start_time: Date.now() / 1000 };
    this.bot = this;
    this.bots = {};
    this.adapter = [];
    this.uin = this._createUinManager();
    
    this.fastify = fastify({
      logger: false,
      ignoreTrailingSlash: true,
      maxParamLength: 500,
      bodyLimit: 10 * 1024 * 1024
    });
    this.fastify.skip_auth = [];
    this.fastify.quiet = [];
    this.server = null;
    this.httpsServer = null;
    this.wsf = Object.create(null); // WebSocket处理函数映射
    this.wsRoutes = new Set(); // 已注册的WS路由
    this.fs = Object.create(null);
    
    this.apiKey = '';
    this._cache = BotUtil.getMap('yunzai_cache', { ttl: 60000, autoClean: true });
    this._rateLimiters = new Map();
    this.httpPort = null;
    this.httpsPort = null;
    this.actualPort = null;
    this.actualHttpsPort = null;
    this.url = cfg.server?.server?.url || '';
    
    this.proxyEnabled = false;
    this.proxyApp = null;
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

  static makeError(message, type = 'Error', details = {}) {
    let error;

    if (message instanceof Error) {
      error = message;
      if (type === 'Error' && error.type) {
        type = error.type;
      }
    } else {
      error = new Error(message);
    }

    error.type = type;
    error.timestamp = Date.now();

    if (details && typeof details === 'object') {
      Object.assign(error, details);
    }

    error.source = 'Bot';
    const logMessage = `${type}: ${error.message}`;
    const logDetails = Object.keys(details).length > 0 ?
      chalk.gray(` Details: ${JSON.stringify(details)}`) : '';

    if (typeof BotUtil !== 'undefined' && BotUtil.makeLog) {
      BotUtil.makeLog('error', chalk.red(`✗ ${logMessage}${logDetails}`), type);

      if (error.stack && cfg?.debug) {
        BotUtil.makeLog('debug', chalk.gray(error.stack), type);
      }
    } else {
      console.error(`[${type}] ${error.message}`, details);
    }

    return error;
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
    this.server = http.createServer(this.fastify.server)
      .on("error", err => this._handleServerError(err, false));
  }

  _handleServerError(err, isHttps) {
    const handler = this[`server${err.code}`];
    if (typeof handler === "function") {
      return handler.call(this, err, isHttps);
    }
    BotUtil.makeLog("error", err, isHttps ? "HTTPS服务器" : "HTTP服务器");
  }

  async _initProxyApp() {
    const proxyConfig = cfg.server?.proxy;
    if (!proxyConfig?.enabled) return;
    
    this.proxyApp = fastify({
      logger: false,
      ignoreTrailingSlash: true
    });
    
    await this._loadDomainCertificates();
    
    this.proxyApp.addHook('onRequest', async (req, reply) => {
      const hostname = req.hostname;
      
      if (!hostname) {
        reply.code(400).send('错误请求：缺少Host头');
        return reply;
      }
      
      const domainConfig = this._findDomainConfig(hostname);
      
      if (!domainConfig) {
        reply.code(404).send(`域名 ${hostname} 未配置`);
        return reply;
      }
      
      if (domainConfig.rewritePath) {
        const { from, to } = domainConfig.rewritePath;
        if (from && req.url.startsWith(from)) {
          req.url = req.url.replace(from, to || '');
          BotUtil.makeLog('debug', `路径重写：${req.url} → ${req.url}`, '代理');
        }
      }
      
      if (domainConfig.target) {
        let middleware = this.proxyMiddlewares.get(domainConfig.domain);
        if (!middleware) {
          middleware = this._createProxyMiddleware(domainConfig);
          this.proxyMiddlewares.set(domainConfig.domain, middleware);
        }
        await middleware(req.raw, reply.raw, () => {});
        return reply;
      }
      
      const targetPort = this.actualPort;
      const proxyOptions = {
        target: `http://127.0.0.1:${targetPort}`,
        changeOrigin: true,
        ws: domainConfig.ws !== false,
        secure: false,
        logLevel: 'warn',
        onError: (err, req, res) => {
          BotUtil.makeLog('error', `代理错误 [${hostname}]: ${err.message}`, '代理');
          if (!res.headersSent) {
            res.statusCode = 502;
            res.end(JSON.stringify({
              error: '网关错误',
              message: '无法连接到上游服务器',
              upstream: `http://127.0.0.1:${targetPort}`
            }));
          }
        }
      };
      
      const proxy = createProxyMiddleware(proxyOptions);
      await proxy(req.raw, reply.raw, () => {});
      return reply;
    });
    
    this.proxyServer = http.createServer(this.proxyApp.server);
    this.proxyServer.on("error", err => {
      BotUtil.makeLog("error", `HTTP代理服务器错误：${err.message}`, '代理');
    });
    
    if (this.sslContexts.size > 0) {
      await this._createHttpsProxyServer();
    }
  }

  async _loadDomainCertificates() {
    const proxyConfig = cfg.server?.proxy;
    if (!proxyConfig?.domains) return;
    
    for (const domainConfig of proxyConfig.domains) {
      if (!domainConfig.ssl?.enabled || !domainConfig.ssl?.certificate) continue;
      
      const cert = domainConfig.ssl.certificate;
      if (!cert.key || !cert.cert) {
        BotUtil.makeLog("warn", `域名 ${domainConfig.domain} 缺少证书配置`, '代理');
        continue;
      }
      
      if (!fsSync.existsSync(cert.key) || !fsSync.existsSync(cert.cert)) {
        BotUtil.makeLog("warn", `域名 ${domainConfig.domain} 的证书文件不存在`, '代理');
        continue;
      }
      
      try {
        const context = tls.createSecureContext({
          key: await fs.readFile(cert.key),
          cert: await fs.readFile(cert.cert),
          ca: cert.ca && fsSync.existsSync(cert.ca) ? await fs.readFile(cert.ca) : undefined
        });
        
        this.sslContexts.set(domainConfig.domain, context);
        this.domainConfigs.set(domainConfig.domain, domainConfig);
        BotUtil.makeLog("info", `✓ 加载SSL证书：${domainConfig.domain}`, '代理');
      } catch (err) {
        BotUtil.makeLog("error", `加载SSL证书失败 [${domainConfig.domain}]: ${err.message}`, '代理');
      }
    }
  }

  async _createHttpsProxyServer() {
    const [firstDomain] = this.sslContexts.keys();
    const domainConfig = this.domainConfigs.get(firstDomain);
    
    if (!domainConfig?.ssl?.certificate) {
      BotUtil.makeLog("error", "没有可用的SSL证书", '代理');
      return;
    }
    
    const cert = domainConfig.ssl.certificate;
    
    const httpsOptions = {
      key: await fs.readFile(cert.key),
      cert: await fs.readFile(cert.cert),
      ca: cert.ca && fsSync.existsSync(cert.ca) ? await fs.readFile(cert.ca) : undefined,
      SNICallback: (servername, cb) => {
        const context = this.sslContexts.get(servername) || this._findWildcardContext(servername);
        cb(null, context);
      }
    };
    
    this.proxyHttpsServer = https.createServer(httpsOptions, this.proxyApp.server);
    this.proxyHttpsServer.on("error", err => {
      BotUtil.makeLog("error", `HTTPS代理服务器错误：${err.message}`, '代理');
    });
  }

  _createProxyMiddleware(domainConfig) {
    const proxyOptions = {
      target: domainConfig.target,
      changeOrigin: true,
      ws: domainConfig.ws !== false,
      preserveHostHeader: domainConfig.preserveHostHeader === true,
      timeout: domainConfig.timeout || 30000,
      proxyTimeout: domainConfig.timeout || 30000,
      secure: false,
      logLevel: 'warn',
      
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
        BotUtil.makeLog('error', `代理错误 [${domainConfig.domain}]: ${err.message}`, '代理');
        if (!res.headersSent) {
          res.statusCode = 502;
          res.end(JSON.stringify({
            error: '网关错误',
            message: '代理服务器错误',
            domain: domainConfig.domain,
            target: domainConfig.target
          }));
        }
      }
    };
    
    if (domainConfig.pathRewrite && typeof domainConfig.pathRewrite === 'object') {
      proxyOptions.pathRewrite = domainConfig.pathRewrite;
    }
    
    return createProxyMiddleware(proxyOptions);
  }

  _findDomainConfig(hostname) {
    if (this.domainConfigs.has(hostname)) {
      return this.domainConfigs.get(hostname);
    }
    
    for (const [domain, config] of this.domainConfigs) {
      if (domain.startsWith('*.')) {
        const baseDomain = domain.substring(2);
        if (hostname === baseDomain || hostname.endsWith('.' + baseDomain)) {
          const subdomain = hostname === baseDomain ? '' : 
                           hostname.substring(0, hostname.length - baseDomain.length - 1);
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
        if (servername === baseDomain || servername.endsWith('.' + baseDomain)) {
          return context;
        }
      }
    }
    return null;
  }

  async _initializeMiddlewareAndRoutes() {
    // 先注册 WebSocket 插件
    await this.fastify.register(fastifyWebsocket, {
      options: { maxPayload: 1048576 }
    });
    
    if (cfg.server?.compression?.enabled !== false) {
      await this.fastify.register(fastifyCompress, {
        threshold: cfg.server?.compression?.threshold || 1024,
        zlibOptions: { level: cfg.server?.compression?.level || 6 }
      });
    }
    
    if (cfg.server?.security?.helmet?.enabled !== false) {
      await this.fastify.register(fastifyHelmet, {
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        hsts: cfg.server?.security?.hsts?.enabled === true ? {
          maxAge: cfg.server.security.hsts.maxAge || 31536000,
          includeSubDomains: cfg.server.security.hsts.includeSubDomains !== false,
          preload: cfg.server.security.hsts.preload === true
        } : false
      });
    }
    
    await this._setupCors();
    this._setupRequestLogging();
    await this._setupRateLimiting();
    
    this.fastify.addHook('preHandler', this._authMiddleware.bind(this));
    
    this.fastify.get('/status', this._statusHandler.bind(this));
    this.fastify.get('/health', this._healthHandler.bind(this));
    this.fastify.get('/File/*', this._fileHandler.bind(this));
    
    await this._setupStaticServing();
  }

  /**
   * 注册 WebSocket 路由
   * @param {string} path - WebSocket 路径
   * @param {Function[]} handlers - 处理函数数组
   */
  registerWebSocketRoute(path, handlers) {
    if (this.wsRoutes.has(path)) {
      BotUtil.makeLog('debug', `WebSocket路由已存在，跳过注册: ${path}`, '服务器');
      return;
    }
    
    const wsPath = path.startsWith('/') ? path : `/${path}`;
    
    this.fastify.get(wsPath, { websocket: true }, (connection, req) => {
      const rid = `${req.socket.remoteAddress}:${req.socket.remotePort}-${req.headers["sec-websocket-key"]}`;
      const sid = `ws://${req.headers.host || `${req.socket.localAddress}:${req.socket.localPort}`}${req.url}`;
      
      BotUtil.makeLog("debug", `WebSocket连接建立：${sid}`, '服务器');
      
      // 扩展 connection 对象
      connection.req = req;
      connection.rid = rid;
      connection.sid = sid;
      
      connection.sendMsg = (msg) => {
        try {
          if (!Buffer.isBuffer(msg)) msg = BotUtil.String(msg);
          BotUtil.makeLog("trace", `WS发送：${msg}`, '服务器');
          connection.socket.send(msg);
        } catch (err) {
          BotUtil.makeLog("error", `WS发送失败：${err.message}`, '服务器');
        }
      };
      
      connection.socket.on('error', err => {
        BotUtil.makeLog("error", `WebSocket错误: ${err.message}`, '服务器');
      });
      
      connection.socket.on('close', () => {
        BotUtil.makeLog("debug", `WebSocket断开：${sid}`, '服务器');
      });
      
      connection.socket.on('message', (msg) => {
        const logMsg = Buffer.isBuffer(msg) && msg.length > 1024 ?
          `[二进制消息，长度：${msg.length}]` : BotUtil.String(msg);
        BotUtil.makeLog("trace", `WS消息：${logMsg}`, '服务器');
      });
      
      // 执行所有处理函数
      for (const handler of handlers) {
        try {
          handler(connection, req);
        } catch (err) {
          BotUtil.makeLog("error", `WebSocket处理函数错误: ${err.message}`, '服务器');
        }
      }
    });
    
    this.wsRoutes.add(path);
    BotUtil.makeLog("info", `✓ WebSocket路由已注册: ${wsPath}`, '服务器');
  }

  /**
   * 添加 WebSocket 处理函数
   * @param {string} path - WebSocket 路径
   * @param {Function} handler - 处理函数
   */
  addWebSocketHandler(path, handler) {
    if (!this.wsf[path]) {
      this.wsf[path] = [];
    }
    this.wsf[path].push(handler);
    
    // 如果还没注册路由，现在注册
    if (!this.wsRoutes.has(path)) {
      this.registerWebSocketRoute(path, this.wsf[path]);
    }
  }

  async _setupCors() {
    const corsConfig = cfg.server?.cors;
    if (corsConfig?.enabled === false) return;
    
    await this.fastify.register(fastifyCors, {
      origin: corsConfig.origins || true,
      methods: corsConfig.methods || ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: corsConfig.headers || ['Content-Type', 'Authorization', 'X-API-Key'],
      credentials: corsConfig.credentials || false,
      maxAge: corsConfig.maxAge || undefined
    });
  }

  _setupRequestLogging() {
    if (cfg.server?.logging?.requests === false) return;
    
    this.fastify.addHook('onResponse', (req, reply) => {
      const duration = reply.getResponseTime();
      const quietPaths = cfg.server?.logging?.quiet || [];
      
      if (!quietPaths.some(p => req.url.startsWith(p))) {
        const statusColor = reply.statusCode < 400 ? 'green' :
                           reply.statusCode < 500 ? 'yellow' : 'red';
        const method = chalk.cyan(req.method.padEnd(6));
        const status = chalk[statusColor](reply.statusCode);
        const time = chalk.gray(`${duration.toFixed(2)}ms`.padStart(7));
        const path = chalk.white(req.url);
        const host = req.hostname ? chalk.gray(` [${req.hostname}]`) : '';
        
        BotUtil.makeLog('debug', `${method} ${status} ${time} ${path}${host}`, 'HTTP');
      }
    });
  }

  async _setupStaticServing() {
    const staticRoot = path.join(process.cwd(), 'www');
    
    if (!fsSync.existsSync(staticRoot)) {
      fsSync.mkdirSync(staticRoot, { recursive: true });
    }
    
    await this.fastify.register(fastifyStatic, {
      root: staticRoot,
      index: cfg.server?.static?.index || ['index.html', 'index.htm'],
      dotfiles: 'deny',
      extensions: cfg.server?.static?.extensions || false,
      maxAge: cfg.server?.static?.cacheTime || '1d',
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => this._setStaticHeaders(res, filePath),
      preCompressed: true
    });
    
    this.fastify.addHook('preHandler', this._directoryIndexMiddleware.bind(this));
    this.fastify.addHook('preHandler', this._staticSecurityMiddleware.bind(this));
    
    this.fastify.get('/favicon.ico', this._handleFavicon.bind(this));
    this.fastify.get('/robots.txt', this._handleRobotsTxt.bind(this));
  }

  async _directoryIndexMiddleware(req, reply) {
    const hasExtension = path.extname(req.url);
    if (hasExtension || req.url.endsWith('/')) {
      return;
    }
    
    const staticRoot = path.join(process.cwd(), 'www');
    const dirPath = path.join(staticRoot, req.url);
    
    if (fsSync.existsSync(dirPath) && fsSync.statSync(dirPath).isDirectory()) {
      const indexFiles = cfg.server?.static?.index || ['index.html', 'index.htm'];
      
      for (const indexFile of indexFiles) {
        const indexPath = path.join(dirPath, indexFile);
        if (fsSync.existsSync(indexPath)) {
          const redirectUrl = req.url + '/';
          BotUtil.makeLog('debug', `目录重定向：${req.url} → ${redirectUrl}`, '服务器');
          return reply.redirect(301, redirectUrl);
        }
      }
    }
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

  async _staticSecurityMiddleware(req, reply) {
    const normalizedPath = path.normalize(req.url);
    
    if (normalizedPath.includes('..')) {
      return reply.code(403).send({ error: '禁止访问' });
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
      return reply.code(404).send({ error: '未找到' });
    }
  }

  async _handleFavicon(req, reply) {
    const staticRoot = path.join(process.cwd(), 'www');
    const faviconPath = path.join(staticRoot, 'favicon.ico');
    
    if (fsSync.existsSync(faviconPath)) {
      reply.header('Content-Type', 'image/x-icon');
      reply.header('Cache-Control', 'public, max-age=604800');
      return reply.sendFile('favicon.ico', staticRoot);
    }
    
    return reply.code(204).send();
  }

  async _handleRobotsTxt(req, reply) {
    const staticRoot = path.join(process.cwd(), 'www');
    const robotsPath = path.join(staticRoot, 'robots.txt');
    
    if (fsSync.existsSync(robotsPath)) {
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.sendFile('robots.txt', staticRoot);
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
    
    reply.type('text/plain; charset=utf-8');
    return reply.send(defaultRobots);
  }

  async _setupRateLimiting() {
    const rateLimitConfig = cfg.server?.rateLimit;
    if (rateLimitConfig?.enabled === false) return;
    
    await this.fastify.register(fastifyRateLimit, {
      max: rateLimitConfig.global?.max || 100,
      timeWindow: rateLimitConfig.global?.windowMs || 15 * 60 * 1000,
      errorResponseBuilder: () => ({ error: rateLimitConfig.global?.message || '请求过于频繁' }),
      skipOnError: true
    });
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
            BotUtil.makeLog("trace", `重定向 Bot.${prop} 到 Bot.${botId}.${prop}`);
            return typeof bot[prop] === "function" ?
              bot[prop].bind(bot) : bot[prop];
          }
        }
        
        BotUtil.makeLog("trace", `Bot.${prop} 不存在`);
        return undefined;
      }
    });
  }

  async generateApiKey() {
    const apiKeyConfig = cfg.server?.auth?.apiKey || {};
    
    if (apiKeyConfig.enabled === false) {
      BotUtil.makeLog('info', '⚠ API密钥认证已禁用', '服务器');
      return null;
    }
    
    const apiKeyPath = path.join(process.cwd(),
      apiKeyConfig.file || 'config/server_config/api_key.json');
    
    try {
      if (fsSync.existsSync(apiKeyPath)) {
        const keyData = JSON.parse(await fs.readFile(apiKeyPath, 'utf8'));
        this.apiKey = keyData.key;
        BotUtil.apiKey = this.apiKey;
        BotUtil.makeLog('info', '✓ 已加载API密钥', '服务器');
        return this.apiKey;
      }
      
      const keyLength = apiKeyConfig.length || 64;
      this.apiKey = BotUtil.randomString(keyLength);
      
      await BotUtil.mkdir(path.dirname(apiKeyPath));
      await fs.writeFile(apiKeyPath, JSON.stringify({
        key: this.apiKey,
        generated: new Date().toISOString(),
        note: '远程访问API密钥'
      }, null, 2), 'utf8');
      
      if (process.platform !== 'win32') {
        try { await fs.chmod(apiKeyPath, 0o600); } catch { }
      }
      
      BotUtil.apiKey = this.apiKey;
      BotUtil.makeLog('success', `⚡ 生成新API密钥：${this.apiKey}`, '服务器');
      return this.apiKey;
      
    } catch (error) {
      BotUtil.makeLog('error', `API密钥处理失败：${error.message}`, '服务器');
      this.apiKey = BotUtil.randomString(64);
      BotUtil.apiKey = this.apiKey;
      return this.apiKey;
    }
  }

  async _authMiddleware(req, reply) {
    req.rid = `${req.ip}:${req.raw.socket.remotePort}`;
    req.sid = `${req.protocol}://${req.hostname}:${req.raw.socket.localPort}${req.url}`;
    
    const authConfig = cfg.server?.auth || {};
    const whitelist = authConfig.whitelist || [
      '/', '/favicon.ico', '/health', '/status', '/robots.txt'
    ];
    
    const isWhitelisted = whitelist.some(whitelistPath => {
      if (whitelistPath === req.url) return true;
      if (whitelistPath.endsWith('*')) {
        return req.url.startsWith(whitelistPath.slice(0, -1));
      }
      if (!whitelistPath.endsWith('/') && req.url === whitelistPath + '/') return true;
      return false;
    });
    
    const isStaticFile = /\.(html|css|js|json|png|jpg|jpeg|gif|svg|webp|ico|mp4|webm|mp3|wav|pdf|zip|woff|woff2|ttf|otf)$/i.test(req.url);
    
    if (isWhitelisted || isStaticFile || this._isLocalConnection(req.ip) || authConfig.apiKey?.enabled === false) {
      return;
    }
    
    if (!this._checkApiAuthorization(req)) {
      return reply.code(401).send({
        success: false,
        message: 'Unauthorized',
        error: '未授权',
        detail: '无效或缺失的API密钥',
        hint: '请提供 X-API-Key 头或 api_key 参数'
      });
    }
  }

  _checkApiAuthorization(req) {
    if (!this.apiKey) return true;
    
    const authKey = req.headers['x-api-key'] ||
      req.headers['authorization']?.replace('Bearer ', '') ||
      req.query.api_key ||
      req.body?.api_key;
    
    if (!authKey) return false;
    
    try {
      const authKeyBuffer = Buffer.from(String(authKey));
      const apiKeyBuffer = Buffer.from(String(this.apiKey));
      
      if (authKeyBuffer.length !== apiKeyBuffer.length) return false;
      
      return crypto.timingSafeEqual(authKeyBuffer, apiKeyBuffer);
    } catch {
      return false;
    }
  }

  _isLocalConnection(address) {
    if (!address) return false;
    
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

  async _statusHandler(req, reply) {
    const status = {
      status: '运行中',
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
        domains: this.proxyEnabled ? Array.from(this.domainConfigs.keys()) : [],
        websocket: {
          enabled: true,
          routes: Array.from(this.wsRoutes)
        }
      },
      auth: {
        apiKeyEnabled: cfg.server?.auth?.apiKey?.enabled !== false,
        whitelist: cfg.server?.auth?.whitelist || []
      }
    };
    
    reply.type('application/json').send(status);
  }

  async _healthHandler(req, reply) {
    reply.send({
      status: '健康',
      uptime: process.uptime(),
      timestamp: Date.now()
    });
  }

  async _fileHandler(req, reply) {
    const url = req.url.replace(/^\/File\//, "");
    let file = this.fs[url];
    
    if (!file) {
      file = this.fs[404];
      if (!file) {
        return reply.code(404).send({ error: '未找到', file: url });
      }
    }
    
    if (typeof file.times === "number") {
      if (file.times > 0) {
        file.times--;
      } else {
        file = this.fs.timeout;
        if (!file) {
          return reply.code(410).send({
            error: '已过期',
            message: '文件访问次数已达上限'
          });
        }
      }
    }
    
    if (file.type?.mime) {
      reply.header("Content-Type", file.type.mime);
    }
    reply.header("Content-Length", file.buffer.length);
    reply.header("Cache-Control", "no-cache");
    
    BotUtil.makeLog("debug", `文件发送：${file.name} (${BotUtil.formatFileSize(file.buffer.length)})`, '服务器');
    
    reply.send(file.buffer);
  }

  async serverEADDRINUSE(err, isHttps) {
    const serverType = isHttps ? 'HTTPS' : 'HTTP';
    const port = isHttps ? this.httpsPort : this.httpPort;
    
    BotUtil.makeLog("error", `${serverType}端口 ${port} 已被占用`, '服务器');
    
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
    const app = isHttps ? this.fastify : this.fastify;
    const port = isHttps ? this.httpsPort : this.httpPort;
    const host = cfg.server?.server?.host || '0.0.0.0';
    
    try {
      await app.listen({ port, host });
      const protocol = isHttps ? 'https' : 'http';
      BotUtil.makeLog("info", `✓ ${isHttps ? 'HTTPS' : 'HTTP'}服务器监听在 ${host}:${port}`, '服务器');
      
      if (isHttps) {
        this.actualHttpsPort = port;
      } else {
        this.actualPort = port;
      }
      
      if (!isHttps && !this.proxyEnabled) {
        await this._displayAccessUrls(protocol, port);
      }
    } catch (err) {
      BotUtil.makeLog('error', `${isHttps ? 'HTTPS' : 'HTTP'}服务器启动失败: ${err.message}`, '服务器');
    }
  }

  async startProxyServers() {
    const proxyConfig = cfg.server?.proxy;
    if (!proxyConfig?.enabled) return;
    
    const httpPort = proxyConfig.httpPort || 80;
    const host = cfg.server?.server?.host || '0.0.0.0';
    
    await this.proxyApp.listen({ port: httpPort, host });
    BotUtil.makeLog('info', `✓ HTTP代理服务器监听在 ${host}:${httpPort}`, '代理');
    
    if (this.proxyHttpsServer) {
      const httpsPort = proxyConfig.httpsPort || 443;
      this.proxyHttpsServer.listen(httpsPort, host);
      BotUtil.makeLog('info', `✓ HTTPS代理服务器监听在 ${host}:${httpsPort}`, '代理');
    }
    
    await this._displayProxyInfo();
  }

  async _displayProxyInfo() {
    console.log(chalk.cyan('\n╔════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.yellow.bold('                  反向代理服务器配置信息                    ') + chalk.cyan('║'));
    console.log(chalk.cyan('╚════════════════════════════════════════════════════════════╝\n'));
    
    console.log(chalk.cyan('▶ 代理域名：'));
    
    const proxyConfig = cfg.server?.proxy;
    const domains = proxyConfig?.domains || [];
    
    for (const domainConfig of domains) {
      const protocol = domainConfig.ssl?.enabled ? 'https' : 'http';
      const port = protocol === 'https' ? 
        (proxyConfig.httpsPort || 443) : 
        (proxyConfig.httpPort || 80);
      const displayPort = (port === 80 && protocol === 'http') || 
                          (port === 443 && protocol === 'https') ? '' : `:${port}`;
      
      console.log(chalk.yellow(`    ${domainConfig.domain}：`));
      console.log(`      ${chalk.cyan('•')} 访问地址：${chalk.white(`${protocol}://${domainConfig.domain}${displayPort}`)}`);
      
      if (domainConfig.target) {
        console.log(`      ${chalk.cyan('•')} 代理目标：${chalk.gray(domainConfig.target)}`);
      } else {
        console.log(`      ${chalk.cyan('•')} 代理目标：${chalk.gray(`本地服务端口 ${this.actualPort}`)}`);
      }
      
      if (domainConfig.staticRoot) {
        console.log(`      ${chalk.cyan('•')} 静态目录：${chalk.gray(domainConfig.staticRoot)}`);
      }
      
      if (domainConfig.rewritePath) {
        console.log(`      ${chalk.cyan('•')} 路径重写：${chalk.gray(`${domainConfig.rewritePath.from} → ${domainConfig.rewritePath.to}`)}`);
      }
    }
    
    console.log(chalk.yellow('\n▶ 本地服务：'));
    console.log(`    ${chalk.cyan('•')} HTTP：${chalk.white(`http://localhost:${this.actualPort}`)}`);
    if (this.actualHttpsPort) {
      console.log(`    ${chalk.cyan('•')} HTTPS：${chalk.white(`https://localhost:${this.actualHttpsPort}`)}`);
    }
    
    const authConfig = cfg.server?.auth || {};
    if (authConfig.apiKey?.enabled !== false) {
      console.log(chalk.yellow('\n▶ API密钥：'));
      console.log(`    ${chalk.cyan('•')} ${chalk.white(this.apiKey)}`);
      console.log(chalk.gray(`    使用 X-API-Key 请求头进行认证`));
    }
    
    if (authConfig.whitelist?.length) {
      console.log(chalk.yellow('\n▶ 白名单路径：'));
      authConfig.whitelist.forEach(path => {
        console.log(`    ${chalk.cyan('•')} ${chalk.white(path)}`);
      });
      console.log('\n');
    }
  }

  async _displayAccessUrls(protocol, port) {
    const addresses = [`${protocol}://localhost:${port}`];
    
    const ipInfo = await this.getLocalIpAddress();
    
    console.log(chalk.cyan('\n▶ 访问地址：'));
    
    if (ipInfo.local.length > 0) {
      console.log(chalk.yellow('  本地网络：'));
      ipInfo.local.forEach(info => {
        const url = `${protocol}://${info.ip}:${port}`;
        const label = info.primary ? chalk.green(' ★') : '';
        const interfaceInfo = chalk.gray(` [${info.interface}]`);
        console.log(`    ${chalk.cyan('•')} ${chalk.white(url)}${interfaceInfo}${label}`);
        addresses.push(url);
      });
    }
    
    if (ipInfo.public && cfg.server?.misc?.detectPublicIP !== false) {
      console.log(chalk.yellow('\n  公网访问：'));
      const publicUrl = `${protocol}://${ipInfo.public}:${port}`;
      console.log(`    ${chalk.cyan('•')} ${chalk.white(publicUrl)}`);
    }
    
    if (cfg.server?.server?.url) {
      console.log(chalk.yellow('\n  配置域名：'));
      const configUrl = cfg.server.server.url.startsWith('http') ? 
        cfg.server.server.url : 
        `${protocol}://${cfg.server.server.url}`;
      console.log(`    ${chalk.cyan('•')} ${chalk.white(`${configUrl}:${port}`)}`);
    }
    
    const authConfig = cfg.server?.auth || {};
    if (authConfig.apiKey?.enabled !== false) {
      console.log(chalk.yellow('\n  API密钥：'));
      console.log(`    ${chalk.cyan('•')} ${chalk.white(this.apiKey)}`);
      console.log(chalk.gray(`    使用 X-API-Key 请求头`));
    }
    
    if (authConfig.whitelist?.length) {
      console.log(chalk.yellow('\n  白名单路径：'));
      authConfig.whitelist.forEach(path => {
        console.log(`    ${chalk.cyan('•')} ${chalk.white(path)}`);
      });
    }
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
          throw new Error("HTTPS已启用但未配置证书");
        }
        
        if (!fsSync.existsSync(cert.key)) {
          throw new Error(`HTTPS密钥文件不存在：${cert.key}`);
        }
        
        if (!fsSync.existsSync(cert.cert)) {
          throw new Error(`HTTPS证书文件不存在：${cert.cert}`);
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
      
      this.httpsServer = https.createServer(httpsOptions, this.fastify.server)
        .on("error", err => this._handleServerError(err, true));
      
      await this.serverLoad(true);
      
      BotUtil.makeLog("info", "✓ HTTPS服务器已启动", '服务器');
      
    } catch (err) {
      BotUtil.makeLog("error", `HTTPS服务器错误：${err.message}`, '服务器');
    }
  }

// 接着 _setupFinalHandlers 方法继续

_setupFinalHandlers() {
  this.fastify.setNotFoundHandler((req, reply) => {
    let defaultRoute = cfg.server?.misc?.defaultRoute || '/';
    
    if (req.headers.accept?.includes('text/html')) {
      const staticRoot = path.join(process.cwd(), 'www');
      const indexPath = path.join(staticRoot, 'index.html');
      
      if (fsSync.existsSync(indexPath)) {
        return reply.sendFile('index.html', staticRoot);
      }
    }
    
    reply.code(404).send({
      success: false,
      error: '未找到',
      path: req.url,
      message: `请求的资源不存在：${req.url}`
    });
  });
  
  this.fastify.setErrorHandler((error, req, reply) => {
    const statusCode = error.statusCode || 500;
    
    BotUtil.makeLog('error', `请求错误 [${req.method} ${req.url}]: ${error.message}`, '服务器');
    
    if (cfg?.debug) {
      BotUtil.makeLog('debug', error.stack, '服务器');
    }
    
    const errorResponse = {
      success: false,
      error: error.name || 'Error',
      message: error.message,
      path: req.url,
      timestamp: Date.now()
    };
    
    if (cfg?.debug) {
      errorResponse.stack = error.stack;
    }
    
    reply.code(statusCode).send(errorResponse);
  });
}

async getLocalIpAddress() {
  const networkInterfaces = os.networkInterfaces();
  const ipInfo = { local: [], public: null };
  const priorityOrder = ['eth0', 'en0', 'wlan0', 'Wi-Fi', 'Ethernet'];
  
  for (const [name, interfaces] of Object.entries(networkInterfaces)) {
    for (const iface of interfaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const priority = priorityOrder.indexOf(name);
        ipInfo.local.push({
          ip: iface.address,
          interface: name,
          primary: priority >= 0,
          priority: priority >= 0 ? priority : 999
        });
      }
    }
  }
  
  ipInfo.local.sort((a, b) => a.priority - b.priority);
  
  if (cfg.server?.misc?.detectPublicIP !== false) {
    try {
      ipInfo.public = await this._detectPublicIP();
    } catch (err) {
      BotUtil.makeLog('debug', `公网IP检测失败: ${err.message}`, '服务器');
    }
  }
  
  return ipInfo;
}

async _detectPublicIP() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('超时')), 3000);
    
    const client = dgram.createSocket('udp4');
    
    client.on('error', err => {
      clearTimeout(timeout);
      client.close();
      reject(err);
    });
    
    client.send(Buffer.alloc(0), 53, '8.8.8.8', () => {
      const address = client.address();
      client.close();
      clearTimeout(timeout);
      resolve(address.address);
    });
  });
}

getServerUrl() {
  if (this.url) {
    return this.url.startsWith('http') ? this.url : `http://${this.url}`;
  }
  
  const protocol = this.actualHttpsPort ? 'https' : 'http';
  const port = this.actualHttpsPort || this.actualPort;
  return `${protocol}://localhost:${port}`;
}

async start() {
  try {
    BotUtil.makeLog("info", chalk.cyan("═══════════════════════════════════════════════════════"), '服务器');
    BotUtil.makeLog("info", chalk.yellow.bold("            启动 Fastify Bot 服务器"), '服务器');
    BotUtil.makeLog("info", chalk.cyan("═══════════════════════════════════════════════════════\n"), '服务器');
    
    await this._initializeMiddlewareAndRoutes();
    
    this.httpPort = cfg.server?.http?.port || 3000;
    this.httpsPort = cfg.server?.https?.port || 3443;
    
    this.emit("server.start");
    
    await Packageloader.load();
    await PluginsLoader.load();
    await ListenerLoader.load();
    
    const apiLoadResult = await ApiLoader.load(this);
    
    this._setupFinalHandlers();
    
    await this.httpsLoad();
    await this.serverLoad(false);
    
    const proxyConfig = cfg.server?.proxy;
    if (proxyConfig?.enabled) {
      this.proxyEnabled = true;
      await this._initProxyApp();
      
      const proxyDomains = proxyConfig.domains || [];
      for (const domainConfig of proxyDomains) {
        this.domainConfigs.set(domainConfig.domain, domainConfig);
      }
      
      await this.startProxyServers();
    }
    
    if (cfg.server?.aistream?.enabled !== false) {
      await StreamLoader.load();
    }
    
    this.emit("server.started");
    
    console.log(chalk.cyan('\n╔════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.green.bold('              🚀 服务器启动成功！                        ') + chalk.cyan('║'));
    console.log(chalk.cyan('╚════════════════════════════════════════════════════════════╝\n'));
    
    if (apiLoadResult?.hotReloadWarning) {
      console.log(chalk.yellow('⚠ 提示：') + chalk.gray(apiLoadResult.hotReloadWarning) + '\n');
    }
    
    BotUtil.makeLog("success", "✓ 所有服务已启动完成", '服务器');
    
  } catch (err) {
    BotUtil.makeLog("error", `服务器启动失败：${err.message}`, '服务器');
    if (cfg?.debug) {
      console.error(err);
    }
    process.exit(1);
  }
}

async closeServer() {
  BotUtil.makeLog("info", "正在关闭服务器...", '服务器');
  
  this.emit("server.stop");
  
  try {
    if (this.proxyServer) {
      await new Promise(resolve => this.proxyServer.close(resolve));
      BotUtil.makeLog("info", "✓ HTTP代理服务器已关闭", '服务器');
    }
    
    if (this.proxyHttpsServer) {
      await new Promise(resolve => this.proxyHttpsServer.close(resolve));
      BotUtil.makeLog("info", "✓ HTTPS代理服务器已关闭", '服务器');
    }
    
    if (this.proxyApp) {
      await this.proxyApp.close();
      BotUtil.makeLog("info", "✓ 代理应用已关闭", '服务器');
    }
    
    if (this.httpsServer) {
      await new Promise(resolve => this.httpsServer.close(resolve));
      BotUtil.makeLog("info", "✓ HTTPS服务器已关闭", '服务器');
    }
    
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
      BotUtil.makeLog("info", "✓ HTTP服务器已关闭", '服务器');
    }
    
    await this.fastify.close();
    BotUtil.makeLog("info", "✓ Fastify应用已关闭", '服务器');
    
    this.emit("server.stopped");
    
    BotUtil.makeLog("success", "服务器已安全关闭", '服务器');
    
    setTimeout(() => process.exit(0), 500);
    
  } catch (err) {
    BotUtil.makeLog("error", `关闭服务器时出错：${err.message}`, '服务器');
    process.exit(1);
  }
}

async reload() {
  BotUtil.makeLog("info", "正在重载服务器...", '服务器');
  
  try {
    await PluginsLoader.load();
    await ListenerLoader.load();
    
    const apiLoadResult = await ApiLoader.load(this);
    
    if (apiLoadResult?.hotReloadWarning) {
      BotUtil.makeLog("warn", apiLoadResult.hotReloadWarning, '服务器');
    }
    
    BotUtil.makeLog("success", "✓ 服务器重载完成", '服务器');
    this.emit("server.reload");
    
    return true;
  } catch (err) {
    BotUtil.makeLog("error", `服务器重载失败：${err.message}`, '服务器');
    return false;
  }
}
}