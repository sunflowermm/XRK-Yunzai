// bot.js  —— Fastify 版，完整无省略
import path from 'node:path';
import fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import os from 'node:os';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import chalk from 'chalk';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createProxyServer } from 'http-proxy';

// Fastify & plugins
import Fastify from 'fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyCompress from '@fastify/compress';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';

// 你的项目模块
import PluginsLoader from './plugins/loader.js';
import ListenerLoader from './listener/loader.js';
import ApiLoader from './http/loader.js'; 
import Packageloader from './config/loader.js';
import StreamLoader from './aistream/loader.js';
import BotUtil from './common/util.js';
import cfg from './config/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 尽量面向“零 GC 压力”的 WS 配置
 */
const WS_TUNING = {
  noServer: true,
  perMessageDeflate: false,
  clientTracking: false,
  maxPayload: 4 * 1024 * 1024, // 4MB
  backlog: 1024,               // 内核 listen backlog
  // 流水线高水位，兼顾吞吐与内存
  WebSocketServer: { highWaterMark: 1 << 20 }
};

export default class Bot extends EventEmitter {
  constructor() {
    super();

    // ─────────── 核心属性 ───────────
    this.stat = { start_time: Date.now() / 1000 };
    this.bot = this;
    this.bots = {};
    this.adapter = [];
    this.uin = this._createUinManager();

    // ─────────── Fastify & Server ───────────
    this.fastify = this._createFastify();
    this.server = null;       // HTTP server
    this.httpsServer = null;  // HTTPS server

    // WS 部分：沿用 ws，并用 noServer（性能可控）
    this.wss = new WebSocketServer(WS_TUNING);
    this.wsf = Object.create(null);   // 路径 → 处理器数组
    this.fs = Object.create(null);    // /File 的内存缓存文件

    // ─────────── 认证 & 速率限制 ───────────
    this.apiKey = '';
    this._cache = BotUtil.getMap('yunzai_cache', { ttl: 60000, autoClean: true });
    this._rateLimiters = new Map();

    // ─────────── 端口、URL ───────────
    this.httpPort = null;
    this.httpsPort = null;
    this.actualPort = null;
    this.actualHttpsPort = null;
    this.url = cfg.server?.server?.url || '';

    // ─────────── 反向代理 ───────────
    this.proxyEnabled = false;
    this.proxyServer = null;      // 80
    this.proxyHttpsServer = null; // 443
    this.domainConfigs = new Map(); // 域名 → 配置
    this.sslContexts = new Map();   // 域名 → tls.SecureContext

    // 采用 http-proxy（与框架无关），支持 ws 透传
    this._proxy = createProxyServer({ ws: true, changeOrigin: true, secure: false });
    this._bindProxyEvents();

    // ─────────── 初始化 ───────────
    this._setupSignalHandlers();
    this.generateApiKey();

    return this._createProxyFacade();
  }

  // ========== 工具 & 通用 ==========

  makeError(message, type = 'Error', details = {}) {
    let error;
    if (message instanceof Error) {
      error = message;
      if (type === 'Error' && error.type) type = error.type;
    } else {
      error = new Error(message);
    }
    error.type = type;
    error.timestamp = Date.now();
    if (details && typeof details === 'object') Object.assign(error, details);
    error.source = 'Bot';

    const logMessage = `${type}: ${error.message}`;
    const logDetails = Object.keys(details).length > 0
      ? chalk.gray(` Details: ${JSON.stringify(details)}`) : '';

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
          if (this.length <= 2) return this[this.length - 1] || '';
          const array = this.slice(1);
          this.now = array[Math.floor(Math.random() * array.length)];
          setTimeout(() => delete this.now, 60000);
        }
        return this.now;
      },
      toString(raw, ...args) {
        return raw === true
          ? Array.prototype.toString.apply(this, args)
          : this.toJSON().toString(raw, ...args);
      },
      includes(value) {
        return this.some(i => i == value);
      }
    });
  }

  _createFastify() {
    const f = Fastify({
      // 高性能日志：Fastify logger 关闭，由我们的 BotUtil 控制
      logger: false,
      trustProxy: true,
      genReqId: () => crypto.randomBytes(8).toString('hex'),
      caseSensitive: true,
      ignoreTrailingSlash: false,
      return503OnClosing: true,
      ajv: { customOptions: { coerceTypes: true } },
      connectionTimeout: 0, // 由 Node 层面控制
      requestTimeout: 0
    });
    return f;
  }

  _bindProxyEvents() {
    // 代理层统一错误处理
    this._proxy.on('error', (err, req, res) => {
      const host = req?.headers?.host || '';
      BotUtil.makeLog('error', `代理错误 [${host}]: ${err.message}`, '代理');
      if (res && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          error: '网关错误',
          message: '无法连接到上游服务器'
        }));
      }
    });
    // 代理响应扩展头（按需）
    this._proxy.on('proxyRes', (proxyRes, req, res) => {
      // 可在此统一注入响应头（如 server、via 等）
    });
  }

  _setupSignalHandlers() {
    const closeHandler = async () => await this.closeServer();
    process.on('SIGINT', closeHandler);
    process.on('SIGTERM', closeHandler);
  }

  _createProxyFacade() {
    return new Proxy(this.bots, {
      get: (target, prop) => {
        if (target[prop] !== undefined) return target[prop];
        if (this[prop] !== undefined) return this[prop];

        const utilValue = BotUtil[prop];
        if (utilValue !== undefined) {
          return typeof utilValue === 'function' ? utilValue.bind(BotUtil) : utilValue;
        }

        for (const botId of [this.uin.toString(), ...this.uin]) {
          const bot = target[botId];
          if (bot?.[prop] !== undefined) {
            BotUtil.makeLog('trace', `重定向 Bot.${prop} 到 Bot.${botId}.${prop}`);
            return typeof bot[prop] === 'function' ? bot[prop].bind(bot) : bot[prop];
          }
        }
        BotUtil.makeLog('trace', `Bot.${prop} 不存在`);
        return undefined;
      }
    });
  }

  // ========== API Key / 认证 ==========

  async generateApiKey() {
    const apiKeyConfig = cfg.server?.auth?.apiKey || {};
    if (apiKeyConfig.enabled === false) {
      BotUtil.makeLog('info', '⚠ API密钥认证已禁用', '服务器');
      return null;
    }

    const apiKeyPath = path.join(process.cwd(), apiKeyConfig.file || 'config/server_config/api_key.json');
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
        key: this.apiKey, generated: new Date().toISOString(), note: '远程访问API密钥'
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

  _checkApiAuthorizationLikeExpressish(req) {
    // 注：WS 升级使用的“伪 req”（来源于 Node upgrade），也走这里，所以只依赖 headers/url
    const authConfig = cfg.server?.auth || {};
    if (authConfig.apiKey?.enabled === false) return true;
    if (!this.apiKey) return true;

    const url = req.url || '';
    const queryStr = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const params = new URLSearchParams(queryStr);
    const headerKey = req.headers?.['x-api-key'] || req.headers?.['authorization']?.replace(/^Bearer\s+/i, '');
    const queryKey = params.get('api_key');

    const authKey = headerKey || queryKey;
    if (!authKey) return false;

    try {
      const a = Buffer.from(String(authKey));
      const b = Buffer.from(String(this.apiKey));
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  _isLocalConnection(address) {
    if (!address || typeof address !== 'string') return false;
    const ip = address.toLowerCase().trim().replace(/^::ffff:/, '').replace(/%.+$/, '');
    return ip === 'localhost' || ip === '127.0.0.1' || ip === '::1' || this._isPrivateIP(ip);
  }

  _isPrivateIP(ip) {
    if (!ip) return false;
    const patterns = {
      ipv4: [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^127\./],
      ipv6: [/^fe80:/i, /^fc00:/i, /^fd00:/i]
    };
    const isIPv4 = ip.includes('.');
    const testPatterns = isIPv4 ? patterns.ipv4 : patterns.ipv6;
    return testPatterns.some(p => p.test(ip));
  }

  // ========== Fastify 插件/中间件 ==========

  async _registerFastifyPlugins(staticRoot) {
    // Helmet（兼容 CSP 可能影响前端调试）
    if (cfg.server?.security?.helmet?.enabled !== false) {
      await this.fastify.register(fastifyHelmet, {
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        hsts: cfg.server?.security?.hsts?.enabled === true
          ? {
              maxAge: cfg.server.security.hsts.maxAge || 31536000,
              includeSubDomains: cfg.server.security.hsts.includeSubDomains !== false,
              preload: cfg.server.security.hsts.preload === true
            }
          : false
      });
    }

    // 压缩
    if (cfg.server?.compression?.enabled !== false) {
      await this.fastify.register(fastifyCompress, {
        global: true,
        encodings: ['gzip', 'deflate', 'br'],
        threshold: cfg.server?.compression?.threshold || 1024
      });
    }

    // CORS
    const corsConfig = cfg.server?.cors;
    if (corsConfig?.enabled !== false) {
      await this.fastify.register(fastifyCors, {
        origin: corsConfig?.origins || true,
        methods: corsConfig?.methods || ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: corsConfig?.headers || ['Content-Type', 'Authorization', 'X-API-Key'],
        credentials: !!corsConfig?.credentials,
        maxAge: corsConfig?.maxAge || 0
      });
    }

    // 速率限制
    const rateLimitConfig = cfg.server?.rateLimit;
    if (rateLimitConfig?.enabled !== false) {
      if (rateLimitConfig?.global) {
        await this.fastify.register(fastifyRateLimit, {
          global: true,
          max: rateLimitConfig.global.max || 100,
          timeWindow: rateLimitConfig.global.windowMs || 15 * 60 * 1000,
          allowList: (ip) => this._isLocalConnection(ip)
        });
      }
    }

    // 静态资源
    await this.fastify.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/', // 与原逻辑一致
      list: false,
      decorateReply: true,
      setHeaders: (res, filePath) => this._setStaticHeadersNode(res, filePath)
    });
  }

  // ========== 路由、Hook、静态资源 特性保持 ==========

  _installLoggingHook() {
    if (cfg.server?.logging?.requests === false) return;
    this.fastify.addHook('onSend', async (req, reply, payload) => {
      const quietPaths = cfg.server?.logging?.quiet || [];
      if (quietPaths.some(p => (req.url || '').startsWith(p))) return payload;

      const statusColor = reply.statusCode < 400 ? 'green' :
                          reply.statusCode < 500 ? 'yellow' : 'red';
      const method = chalk.cyan((req.method || 'GET').padEnd(6));
      const status = chalk[statusColor](reply.statusCode);
      const time = chalk.gray(`${reply.getResponseTime().toFixed(0)}ms`.padStart(7));
      const pathStr = chalk.white(req.url || '/');
      const host = req.hostname ? chalk.gray(` [${req.hostname}]`) : '';
      BotUtil.makeLog('debug', `${method} ${status} ${time} ${pathStr}${host}`, 'HTTP');
      return payload;
    });
  }

  _installAuthHook() {
    const authConfig = cfg.server?.auth || {};
    const whitelist = authConfig.whitelist || ['/', '/favicon.ico', '/health', '/status', '/robots.txt'];
    const isStatic = (url) => /\.(html|css|js|json|png|jpe?g|gif|svg|webp|ico|mp4|webm|mp3|wav|pdf|zip|woff2?|ttf|otf)$/i.test(url);

    this.fastify.addHook('onRequest', async (req, reply) => {
      // 生成辅助字段（与原接口尽量一致）
      req.rid = `${req.ip}:${req.socket?.remotePort || 0}`;
      req.sid = `${req.protocol}://${req.hostname}:${req.socket?.localPort || ''}${req.url}`;

      // 白名单匹配
      const urlPath = (req.url || '').split('?')[0];
      const isWhitelisted = whitelist.some(p => {
        if (p === urlPath) return true;
        if (p.endsWith('*')) return urlPath.startsWith(p.slice(0, -1));
        if (!p.endsWith('/') && urlPath === `${p}/`) return true;
        return false;
      });

      if (isWhitelisted || isStatic(urlPath) || this._isLocalConnection(req.ip)) {
        return;
      }

      // API Key 验证
      if (authConfig.apiKey?.enabled === false) return;
      // Fastify 的 req 获取头与查询
      const headerKey = req.headers?.['x-api-key'] ||
                        (req.headers?.authorization?.startsWith('Bearer ')
                          ? req.headers.authorization.slice(7) : undefined);
      const queryKey = req.query?.api_key;
      const authKey = headerKey || queryKey;
      if (!this.apiKey) return; // 没配置 key 等同放行

      if (!authKey) {
        reply.code(401).send({
          success: false,
          message: 'Unauthorized',
          error: '未授权',
          detail: '无效或缺失的API密钥',
          hint: '请提供 X-API-Key 头或 api_key 参数'
        });
        BotUtil.makeLog('warn', `认证失败：${req.method} ${req.url} 来自 ${req.ip}`, '认证');
        return;
      }
      try {
        const a = Buffer.from(String(authKey));
        const b = Buffer.from(String(this.apiKey));
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          reply.code(401).send({ success: false, message: 'Unauthorized' });
          BotUtil.makeLog('warn', `认证失败：${req.method} ${req.url} 来自 ${req.ip}`, '认证');
          return;
        }
      } catch {
        reply.code(401).send({ success: false, message: 'Unauthorized' });
        return;
      }
      BotUtil.makeLog('debug', `认证成功：${req.method} ${req.url}`, '认证');
    });
  }

  _registerBasicRoutes(staticRoot) {
    // /status
    this.fastify.get('/status', async () => ({
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
        domains: this.proxyEnabled ? Array.from(this.domainConfigs.keys()) : []
      },
      auth: {
        apiKeyEnabled: cfg.server?.auth?.apiKey?.enabled !== false,
        whitelist: cfg.server?.auth?.whitelist || []
      }
    }));

    // /health
    this.fastify.get('/health', async () => ({
      status: '健康',
      uptime: process.uptime(),
      timestamp: Date.now()
    }));

    // /File/*
    this.fastify.get('/File/*', async (req, reply) => {
      const url = (req.url || '').replace(/^\/File\//, '');
      let file = this.fs[url];
      if (!file) {
        file = this.fs[404];
        if (!file) {
          reply.code(404).send({ error: '未找到', file: url });
          return;
        }
      }
      if (typeof file.times === 'number') {
        if (file.times > 0) file.times--;
        else {
          file = this.fs.timeout;
          if (!file) {
            reply.code(410).send({ error: '已过期', message: '文件访问次数已达上限' });
            return;
          }
        }
      }
      if (file.type?.mime) reply.header('Content-Type', file.type.mime);
      reply.header('Content-Length', file.buffer.length);
      reply.header('Cache-Control', 'no-cache');
      BotUtil.makeLog('debug', `文件发送：${file.name} (${BotUtil.formatFileSize(file.buffer.length)})`, '服务器');
      return reply.send(file.buffer);
    });

    // favicon
    this.fastify.get('/favicon.ico', async (req, reply) => {
      const faviconPath = path.join(staticRoot, 'favicon.ico');
      if (fsSync.existsSync(faviconPath)) {
        reply.header('Content-Type', 'image/x-icon');
        reply.header('Cache-Control', 'public, max-age=604800');
        return reply.send(fsSync.readFileSync(faviconPath));
      }
      reply.code(204).send();
    });

    // robots.txt
    this.fastify.get('/robots.txt', async (req, reply) => {
      const robotsPath = path.join(staticRoot, 'robots.txt');
      if (fsSync.existsSync(robotsPath)) {
        reply.header('Content-Type', 'text/plain; charset=utf-8');
        reply.header('Cache-Control', 'public, max-age=86400');
        return reply.send(fsSync.readFileSync(robotsPath, 'utf8'));
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
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      reply.send(defaultRobots);
    });

    // 404 & 错误处理（Fastify 自带 onNotFound/onError）
    this.fastify.setNotFoundHandler((req, reply) => {
      let defaultRoute = cfg.server?.misc?.defaultRoute || '/';
      if (req?.domainConfig?.defaultRoute) defaultRoute = req.domainConfig.defaultRoute;

      // 简化：JSON 404（如需跳转静态 404.html，可自行处理）
      reply.code(404).send({ error: '未找到', path: req.url, timestamp: Date.now() });
    });

    this.fastify.setErrorHandler((err, req, reply) => {
      BotUtil.makeLog('error', `请求错误：${err.message}`, '服务器');
      reply.code(err.statusCode || 500).send({
        error: '内部服务器错误',
        message: process.env.NODE_ENV === 'production' ? '发生了一个错误' : err.message,
        timestamp: Date.now()
      });
    });
  }

  _setStaticHeadersNode(res, filePath) {
    // Fastify Static 的 res 是 Node 原生 ServerResponse
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
    if (mimeTypes[ext]) res.setHeader('Content-Type', mimeTypes[ext]);
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

  // ========== 代理（http-proxy） & HTTPS SNI ==========

  async _loadDomainCertificates() {
    const proxyConfig = cfg.server?.proxy;
    if (!proxyConfig?.domains) return;
    for (const domainConfig of proxyConfig.domains) {
      this.domainConfigs.set(domainConfig.domain, domainConfig);
      if (!domainConfig.ssl?.enabled || !domainConfig.ssl?.certificate) continue;
      const cert = domainConfig.ssl.certificate;
      if (!cert.key || !cert.cert) {
        BotUtil.makeLog('warn', `域名 ${domainConfig.domain} 缺少证书配置`, '代理');
        continue;
      }
      if (!fsSync.existsSync(cert.key) || !fsSync.existsSync(cert.cert)) {
        BotUtil.makeLog('warn', `域名 ${domainConfig.domain} 的证书文件不存在`, '代理');
        continue;
      }
      try {
        const context = tls.createSecureContext({
          key: await fs.readFile(cert.key),
          cert: await fs.readFile(cert.cert),
          ca: cert.ca && fsSync.existsSync(cert.ca) ? await fs.readFile(cert.ca) : undefined
        });
        this.sslContexts.set(domainConfig.domain, context);
        BotUtil.makeLog('info', `✓ 加载SSL证书：${domainConfig.domain}`, '代理');
      } catch (err) {
        BotUtil.makeLog('error', `加载SSL证书失败 [${domainConfig.domain}]: ${err.message}`, '代理');
      }
    }
  }

  _findDomainConfig(hostname) {
    if (this.domainConfigs.has(hostname)) return this.domainConfigs.get(hostname);
    for (const [domain, config] of this.domainConfigs) {
      if (domain.startsWith('*.')) {
        const base = domain.slice(2);
        if (hostname === base || hostname.endsWith(`.${base}`)) {
          const subdomain = hostname === base ? '' : hostname.slice(0, hostname.length - base.length - 1);
          const copy = { ...config, subdomain };
          if (config.rewritePath?.to?.includes('${subdomain}')) {
            copy.rewritePath = { ...config.rewritePath, to: config.rewritePath.to.replace('${subdomain}', subdomain) };
          }
          return copy;
        }
      }
    }
    return null;
  }

  _findWildcardContext(servername) {
    for (const [domain, context] of this.sslContexts) {
      if (domain.startsWith('*.')) {
        const base = domain.slice(2);
        if (servername === base || servername.endsWith('.' + base)) return context;
      }
    }
    return null;
  }

  async _createHttpsProxyServer() {
    // 使用任意一个默认证书
    const [firstDomain] = this.sslContexts.keys();
    const domainConfig = this.domainConfigs.get(firstDomain);
    if (!domainConfig?.ssl?.certificate) {
      BotUtil.makeLog('error', '没有可用的SSL证书', '代理');
      return;
    }
    const cert = domainConfig.ssl.certificate;
    const httpsOptions = {
      key: await fs.readFile(cert.key),
      cert: await fs.readFile(cert.cert),
      ca: cert.ca && fsSync.existsSync(cert.ca) ? await fs.readFile(cert.ca) : undefined,
      SNICallback: (servername, cb) => {
        const ctx = this.sslContexts.get(servername) || this._findWildcardContext(servername);
        cb(null, ctx);
      }
    };
    this.proxyHttpsServer = https.createServer(httpsOptions, (req, res) => this._handleReverseProxy(req, res, true));
    this.proxyHttpsServer.on('upgrade', (req, socket, head) => this._handleReverseProxyUpgrade(req, socket, head, true));
    this.proxyHttpsServer.on('error', err => BotUtil.makeLog('error', `HTTPS代理服务器错误：${err.message}`, '代理'));
  }

  _handleReverseProxy(req, res, isHttps = false) {
    const hostname = (req.headers.host || '').split(':')[0];
    if (!hostname) {
      res.writeHead(400); res.end('错误请求：缺少Host头'); return;
    }
    const domainConfig = this._findDomainConfig(hostname);
    if (!domainConfig) {
      res.writeHead(404); res.end(`域名 ${hostname} 未配置`); return;
    }
    // 路径重写
    if (domainConfig.rewritePath?.from && req.url.startsWith(domainConfig.rewritePath.from)) {
      const qIndex = req.url.indexOf('?');
      const pathOnly = qIndex >= 0 ? req.url.slice(0, qIndex) : req.url;
      const query = qIndex >= 0 ? req.url.slice(qIndex) : '';
      const newPath = pathOnly.replace(domainConfig.rewritePath.from, domainConfig.rewritePath.to || '');
      req.url = `${newPath}${query}`;
      BotUtil.makeLog('debug', `路径重写：${pathOnly} → ${newPath}`, '代理');
    }
    // 目标
    const target = domainConfig.target || `http://127.0.0.1:${this.actualPort}`;
    this._proxy.web(req, res, { target, changeOrigin: true, ws: domainConfig.ws !== false, secure: false });
  }

  _handleReverseProxyUpgrade(req, socket, head, isHttps = false) {
    const hostname = (req.headers.host || '').split(':')[0];
    const domainConfig = this._findDomainConfig(hostname);
    const target = domainConfig?.target || `http://127.0.0.1:${this.actualPort}`;
    this._proxy.ws(req, socket, head, { target, changeOrigin: true, secure: false });
  }

  async _initProxyServers() {
    const proxyConfig = cfg.server?.proxy;
    if (!proxyConfig?.enabled) return;

    // 加载证书 & 域名配置
    await this._loadDomainCertificates();

    // HTTP 代理
    this.proxyServer = http.createServer((req, res) => this._handleReverseProxy(req, res, false));
    this.proxyServer.on('upgrade', (req, socket, head) => this._handleReverseProxyUpgrade(req, socket, head, false));
    this.proxyServer.on('error', err => BotUtil.makeLog('error', `HTTP代理服务器错误：${err.message}`, '代理'));

    // HTTPS 代理（如有证书）
    if (this.sslContexts.size > 0) {
      await this._createHttpsProxyServer();
    }
  }

  async startProxyServers() {
    const proxyConfig = cfg.server?.proxy;
    if (!proxyConfig?.enabled) return;

    const host = cfg.server?.server?.host || '0.0.0.0';
    const httpPort = proxyConfig.httpPort || 80;
    this.proxyServer.listen(httpPort, host);
    await BotUtil.promiseEvent(this.proxyServer, 'listening').catch(() => {});
    BotUtil.makeLog('info', `✓ HTTP代理服务器监听在 ${host}:${httpPort}`, '代理');

    if (this.proxyHttpsServer) {
      const httpsPort = proxyConfig.httpsPort || 443;
      this.proxyHttpsServer.listen(httpsPort, host);
      await BotUtil.promiseEvent(this.proxyHttpsServer, 'listening').catch(() => {});
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
      const port = protocol === 'https' ? (proxyConfig.httpsPort || 443) : (proxyConfig.httpPort || 80);
      const displayPort = (port === 80 && protocol === 'http') || (port === 443 && protocol === 'https') ? '' : `:${port}`;

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
      authConfig.whitelist.forEach(p => console.log(`    ${chalk.cyan('•')} ${chalk.white(p)}`));
      console.log('\n');
    }
  }

  // ========== Node HTTP/HTTPS 宿主 & WS Upgrade ==========

  async _attachFastifyToServers() {
    // 主 HTTP Server
    this.server = http.createServer((req, res) => this.fastify.server.emit('request', req, res));
    this.server.on('upgrade', (req, socket, head) => this.wsConnect(req, socket, head));
    this.server.on('error', (err) => this._handleServerError(err, false));

    // 可选 HTTPS（主站）
    if (cfg.server?.https?.enabled) {
      let httpsOptions = {};
      const httpsConfig = cfg.server.https;
      if (httpsConfig?.certificate) {
        const cert = httpsConfig.certificate;
        if (!cert.key || !cert.cert) throw new Error('HTTPS已启用但未配置证书');
        if (!fsSync.existsSync(cert.key)) throw new Error(`HTTPS密钥文件不存在：${cert.key}`);
        if (!fsSync.existsSync(cert.cert)) throw new Error(`HTTPS证书文件不存在：${cert.cert}`);
        httpsOptions.key = await fs.readFile(cert.key);
        httpsOptions.cert = await fs.readFile(cert.cert);
        if (cert.ca && fsSync.existsSync(cert.ca)) httpsOptions.ca = await fs.readFile(cert.ca);
      }
      if (httpsConfig?.tls?.minVersion) httpsOptions.minVersion = httpsConfig.tls.minVersion;

      this.httpsServer = https.createServer(httpsOptions, (req, res) => this.fastify.server.emit('request', req, res));
      this.httpsServer.on('upgrade', (req, socket, head) => this.wsConnect(req, socket, head));
      this.httpsServer.on('error', (err) => this._handleServerError(err, true));
    }
  }

  _handleServerError(err, isHttps) {
    const handler = this[`server${err.code}`];
    if (typeof handler === 'function') return handler.call(this, err, isHttps);
    BotUtil.makeLog('error', err, isHttps ? 'HTTPS服务器' : 'HTTP服务器');
  }

  async serverEADDRINUSE(err, isHttps) {
    const serverType = isHttps ? 'HTTPS' : 'HTTP';
    const port = isHttps ? this.httpsPort : this.httpPort;
    BotUtil.makeLog('error', `${serverType}端口 ${port} 已被占用`, '服务器');

    const retryKey = isHttps ? 'https_retry_count' : 'http_retry_count';
    this[retryKey] = (this[retryKey] || 0) + 1;

    await BotUtil.sleep(this[retryKey] * 1000);
    const server = isHttps ? this.httpsServer : this.server;
    const host = cfg.server?.server?.host || '0.0.0.0';
    if (server) server.listen(port, host);
  }

  async serverLoad(isHttps) {
    const server = isHttps ? this.httpsServer : this.server;
    const port = isHttps ? this.httpsPort : this.httpPort;
    const host = cfg.server?.server?.host || '0.0.0.0';
    if (!server) return;
    server.listen(port, host);

    await BotUtil.promiseEvent(server, 'listening', isHttps && 'error').catch(() => {});
    const address = server.address();
    if (!address) {
      BotUtil.makeLog('error', `${isHttps ? 'HTTPS' : 'HTTP'}服务器启动失败`, '服务器'); return;
    }
    if (isHttps) this.httpsPort = address.port; else this.httpPort = address.port;

    const serverType = isHttps ? 'HTTPS' : 'HTTP';
    BotUtil.makeLog('info', `✓ ${serverType}服务器监听在 ${host}:${address.port}`, '服务器');

    if (!isHttps && !this.proxyEnabled) {
      const protocol = 'http';
      await this._displayAccessUrls(protocol, address.port);
    }
  }

  // ========== WS（高性能） ==========

  wsConnect(req, socket, head) {
    try {
      // 为 WS 验证准备基础字段（兼容原逻辑）
      req.rid = `${req.socket.remoteAddress}:${req.socket.remotePort}-${req.headers['sec-websocket-key']}`;
      const hostStr = req.headers.host || `${req.socket.localAddress}:${req.socket.localPort}`;
      req.sid = `ws://${hostStr}${req.url}`;

      // 解析 query
      const base = `http://${hostStr}${req.url}`;
      req.query = Object.fromEntries(new URL(base).searchParams.entries());

      // 白名单/本地/认证
      const authConfig = cfg.server?.auth || {};
      const whitelist = authConfig.whitelist || [];
      const pathOnly = (req.url || '').split('?')[0];
      const isWhitelisted = whitelist.some(p => p === pathOnly || (p.endsWith('*') && pathOnly.startsWith(p.slice(0, -1))));
      const isLocal = this._isLocalConnection(req.socket.remoteAddress);

      if (!isWhitelisted && !isLocal) {
        if (authConfig.apiKey?.enabled !== false && !this._checkApiAuthorizationLikeExpressish(req)) {
          BotUtil.makeLog('error', `WebSocket认证失败：${req.url}`, '服务器');
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          return socket.destroy();
        }
      }

      const wsPath = pathOnly.split('/')[1];
      if (!(wsPath in this.wsf)) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        return socket.destroy();
      }

      this.wss.handleUpgrade(req, socket, head, (conn) => {
        BotUtil.makeLog('debug', `WebSocket连接建立：${req.url}`, '服务器');

        // 轻量日志
        conn.on('error', err => BotUtil.makeLog('error', err, '服务器'));
        conn.on('close', () => BotUtil.makeLog('debug', `WebSocket断开：${req.url}`, '服务器'));
        conn.on('message', (msg) => {
          const logMsg = Buffer.isBuffer(msg) && msg.length > 1024 ? `[二进制消息，长度：${msg.length}]` : BotUtil.String(msg);
          BotUtil.makeLog('trace', `WS消息：${logMsg}`, '服务器');
        });

        conn.sendMsg = (msg) => {
          if (!Buffer.isBuffer(msg)) msg = BotUtil.String(msg);
          BotUtil.makeLog('trace', `WS发送：${msg}`, '服务器');
          // 避免背压：readyState 检测
          if (conn.readyState === 1) return conn.send(msg);
          return false;
        };

        for (const handler of this.wsf[wsPath]) {
          handler(conn, req, socket, head);
        }
      });
    } catch (err) {
      try { socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n'); } catch {}
      try { socket.destroy(); } catch {}
      BotUtil.makeLog('error', `WS 升级异常：${err.message}`, '服务器');
    }
  }

  // ========== 启动流程 ==========

  async run(options = {}) {
    const { port } = options;

    this.proxyEnabled = cfg.server?.proxy?.enabled === true;
    this.actualPort = port || 2537;
    this.actualHttpsPort = this.actualPort + 1;

    if (this.proxyEnabled) {
      this.httpPort = cfg.server?.proxy?.httpPort || 80;
      this.httpsPort = cfg.server?.proxy?.httpsPort || 443;
    } else {
      this.httpPort = this.actualPort;
      this.httpsPort = this.actualHttpsPort;
    }

    console.log(chalk.cyan('╔════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.yellow.bold('               葵崽正在初始化http服务器...                  ') + chalk.cyan('║'));
    console.log(chalk.cyan('╚════════════════════════════════════════════════════════════╝'));

    if (this.proxyEnabled) {
      BotUtil.makeLog('info', '⚡ 反向代理模式已启用', '服务器');
      BotUtil.makeLog('info', `服务端口：${this.actualPort} (HTTP), ${this.actualHttpsPort} (HTTPS)`, '服务器');
      BotUtil.makeLog('info', `代理端口：${this.httpPort} (HTTP), ${this.httpsPort} (HTTPS)`, '服务器');
      await this._initProxyServers();
    } else {
      BotUtil.makeLog('info', `端口：${this.httpPort} (HTTP), ${this.httpsPort} (HTTPS)`, '服务器');
    }

    await Packageloader();
    await this.generateApiKey();

    // 加载业务模块
    await StreamLoader.load();
    await PluginsLoader.load();

    // Fastify 插件/中间件/路由
    const staticRoot = path.join(process.cwd(), 'www');
    if (!fsSync.existsSync(staticRoot)) fsSync.mkdirSync(staticRoot, { recursive: true });

    await this._registerFastifyPlugins(staticRoot);
    this._installLoggingHook();
    this._installAuthHook();
    this._registerBasicRoutes(staticRoot);

    // 由 ApiLoader 在 Fastify 中注册 API（避免注册问题）
    await ApiLoader.load();                 // 加载 API 模块（按照你提供的 loader 逻辑）
    await ApiLoader.register(this.fastify, this);

    // 宿主 HTTP/HTTPS + 升级
    await this._attachFastifyToServers();

    // 启动主服务
    const originalHttpPort = this.httpPort;
    const originalHttpsPort = this.httpsPort;
    if (this.proxyEnabled) {
      this.httpPort = this.actualPort;
      this.httpsPort = this.actualHttpsPort;
    }

    await this.serverLoad(false);
    if (cfg.server?.https?.enabled) {
      await this.serverLoad(true);
    }

    // 启动代理服务器（如启用）
    if (this.proxyEnabled) {
      this.httpPort = originalHttpPort;
      this.httpsPort = originalHttpsPort;
      await this.startProxyServers();
    }

    await ListenerLoader.load();
    await ApiLoader.watch(true);

    if (Object.keys(this.wsf).length > 0) {
      BotUtil.makeLog('info', `⚡ WebSocket服务：${this.getServerUrl().replace(/^http/, 'ws')}/ [${Object.keys(this.wsf).join(', ')}]`, '服务器');
    }

    this.emit('online', {
      bot: this,
      timestamp: Date.now(),
      url: this.getServerUrl(),
      uptime: process.uptime(),
      apis: ApiLoader.getApiList(),
      proxyEnabled: this.proxyEnabled
    });
  }

  // ========== 辅助 & 公共 API（保持兼容） ==========

  getServerUrl() {
    if (this.proxyEnabled && cfg.server?.proxy?.domains?.[0]) {
      const domain = cfg.server.proxy.domains[0];
      const protocol = domain.ssl?.enabled ? 'https' : 'http';
      return `${protocol}://${domain.domain}`;
    }
    const protocol = cfg.server?.https?.enabled ? 'https' : 'http';
    const port = protocol === 'https' ? this.actualHttpsPort : this.actualPort;
    const host = cfg.server?.server?.url || 'localhost';
    const needPort = (protocol === 'http' && port !== 80) || (protocol === 'https' && port !== 443);
    return `${protocol}://${host}${needPort ? ':' + port : ''}`;
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
      const configUrl = cfg.server.server.url.startsWith('http') ? cfg.server.server.url : `${protocol}://${cfg.server.server.url}`;
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
      authConfig.whitelist.forEach(p => console.log(`    ${chalk.cyan('•')} ${chalk.white(p)}`));
    }
  }

  async getLocalIpAddress() {
    const cacheKey = 'local_ip_addresses';
    const cached = this._cache.get(cacheKey);
    if (cached) return cached;

    const result = { local: [], public: null, primary: null };
    try {
      const ifaces = os.networkInterfaces();
      for (const [name, list] of Object.entries(ifaces)) {
        if (name.toLowerCase().includes('lo')) continue;
        for (const iface of list) {
          if (iface.family !== 'IPv4' || iface.internal) continue;
          result.local.push({ ip: iface.address, interface: name, mac: iface.mac, virtual: this._isVirtualInterface(name, iface.mac) });
        }
      }
      try {
        result.primary = await this._getIpByUdp();
        const existed = result.local.find(i => i.ip === result.primary);
        if (existed) existed.primary = true;
      } catch {}
      if (cfg.server?.misc?.detectPublicIP !== false) {
        result.public = await this._getPublicIP();
      }
      this._cache.set(cacheKey, result);
      return result;
    } catch (err) {
      BotUtil.makeLog('debug', `获取IP地址失败：${err.message}`, '服务器');
      return result;
    }
  }

  _isVirtualInterface(name) {
    const patterns = [/^(docker|br-|veth|virbr|vnet)/i, /^(vmnet|vmware)/i, /^(vboxnet|virtualbox)/i];
    return patterns.some(p => p.test(name));
  }

  async _getIpByUdp() {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const timeout = setTimeout(() => { socket.close(); reject(new Error('UDP超时')); }, 3000);
      try {
        socket.connect(80, '223.5.5.5', () => {
          clearTimeout(timeout);
          const address = socket.address();
          socket.close();
          resolve(address.address);
        });
      } catch (err) {
        clearTimeout(timeout); socket.close(); reject(err);
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
        const response = await fetch(api.url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
        clearTimeout(timeout);
        if (response.ok) {
          const data = await response.json();
          const ip = data[api.field];
          if (ip && this._isValidIP(ip)) return ip;
        }
      } catch { continue; }
    }
    return null;
  }

  _isValidIP(ip) {
    const ipv4Regex = /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
    return ipv4Regex.test(ip);
  }

  // ========== 事件/消息 兼容 ==========
  prepareEvent(data) {
    if (!this.bots[data.self_id]) return;
    if (!data.bot) Object.defineProperty(data, 'bot', { value: this.bots[data.self_id] });

    if (data.user_id) {
      if (!data.friend) Object.defineProperty(data, 'friend', { value: data.bot.pickFriend(data.user_id) });
      data.sender ||= { user_id: data.user_id };
      data.sender.nickname ||= data.friend?.nickname;
    }
    if (data.group_id) {
      if (!data.group) Object.defineProperty(data, 'group', { value: data.bot.pickGroup(data.group_id) });
      data.group_name ||= data.group?.name;
    }
    if (data.group && data.user_id) {
      if (!data.member) Object.defineProperty(data, 'member', { value: data.group.pickMember(data.user_id) });
      data.sender.nickname ||= data.member?.nickname;
      data.sender.card ||= data.member?.card;
    }
    if (data.bot.adapter?.id) data.adapter_id = data.bot.adapter.id;
    if (data.bot.adapter?.name) data.adapter_name = data.bot.adapter.name;

    this._extendEventMethods(data);
  }

  _extendEventMethods(data) {
    for (const target of [data.friend, data.group, data.member]) {
      if (!target || typeof target !== 'object') continue;
      target.sendFile ??= (file, name) => target.sendMsg(segment.file(file, name));
      target.makeForwardMsg ??= this.makeForwardMsg;
      target.sendForwardMsg ??= msg => this.sendForwardMsg(m => target.sendMsg(m), msg);
      target.getInfo ??= () => target.info || target;
    }
    if (!data.reply) {
      data.reply = data.group?.sendMsg?.bind(data.group) || data.friend?.sendMsg?.bind(data.friend);
    }
  }

  em(name = '', data = {}) {
    this.prepareEvent(data);
    while (name) {
      this.emit(name, data);
      const lastDot = name.lastIndexOf('.');
      if (lastDot === -1) break;
      name = name.slice(0, lastDot);
    }
  }

  getFriendArray() {
    const array = [];
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].fl || []) array.push({ ...i, bot_id });
    return array;
  }
  getFriendList() {
    const array = [];
    for (const bot_id of this.uin) array.push(...(this.bots[bot_id].fl?.keys() || []));
    return array;
  }
  getFriendMap() {
    const map = new Map();
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].fl || []) map.set(id, { ...i, bot_id });
    return map;
  }
  get fl() { return this.getFriendMap(); }

  getGroupArray() {
    const array = [];
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].gl || []) array.push({ ...i, bot_id });
    return array;
  }
  getGroupList() {
    const array = [];
    for (const bot_id of this.uin) array.push(...(this.bots[bot_id].gl?.keys() || []));
    return array;
  }
  getGroupMap() {
    const map = new Map();
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].gl || []) map.set(id, { ...i, bot_id });
    return map;
  }
  get gl() { return this.getGroupMap(); }
  get gml() {
    const map = new Map();
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].gml || [])
        map.set(id, Object.assign(new Map(i), { bot_id }));
    return map;
  }

  pickFriend(user_id, strict) {
    user_id = Number(user_id) || user_id;
    const mainBot = this.bots[this.uin];
    if (mainBot?.fl?.has(user_id)) return mainBot.pickFriend(user_id);
    const friend = this.fl.get(user_id);
    if (friend) return this.bots[friend.bot_id].pickFriend(user_id);
    if (strict) return false;
    BotUtil.makeLog('trace', `用户 ${user_id} 不存在，使用随机Bot ${this.uin.toJSON()}`, '服务器');
    return this.bots[this.uin].pickFriend(user_id);
  }
  get pickUser() { return this.pickFriend; }

  pickGroup(group_id, strict) {
    group_id = Number(group_id) || group_id;
    const mainBot = this.bots[this.uin];
    if (mainBot?.gl?.has(group_id)) return mainBot.pickGroup(group_id);
    const group = this.gl.get(group_id);
    if (group) return this.bots[group.bot_id].pickGroup(group_id);
    if (strict) return false;
    BotUtil.makeLog('trace', `群组 ${group_id} 不存在，使用随机Bot ${this.uin.toJSON()}`, '服务器');
    return this.bots[this.uin].pickGroup(group_id);
  }

  pickMember(group_id, user_id) {
    return this.pickGroup(group_id).pickMember(user_id);
  }

  async sendFriendMsg(bot_id, user_id, ...args) {
    if (!bot_id) return this.pickFriend(user_id).sendMsg(...args);
    if (this.uin.includes(bot_id) && this.bots[bot_id]) {
      return this.bots[bot_id].pickFriend(user_id).sendMsg(...args);
    }
    return new Promise((resolve, reject) => {
      const listener = data => { resolve(data.bot.pickFriend(user_id).sendMsg(...args)); clearTimeout(timeout); };
      const timeout = setTimeout(() => {
        reject(Object.assign(Error('等待Bot上线超时'), { bot_id, user_id, args }));
        this.off(`connect.${bot_id}`, listener);
      }, 300000);
      this.once(`connect.${bot_id}`, listener);
    });
  }

  async sendGroupMsg(bot_id, group_id, ...args) {
    if (!bot_id) return this.pickGroup(group_id).sendMsg(...args);
    if (this.uin.includes(bot_id) && this.bots[bot_id]) {
      return this.bots[bot_id].pickGroup(group_id).sendMsg(...args);
    }
    return new Promise((resolve, reject) => {
      const listener = data => { resolve(data.bot.pickGroup(group_id).sendMsg(...args)); clearTimeout(timeout); };
      const timeout = setTimeout(() => {
        reject(Object.assign(Error('等待Bot上线超时'), { bot_id, group_id, args }));
        this.off(`connect.${bot_id}`, listener);
      }, 300000);
      this.once(`connect.${bot_id}`, listener);
    });
  }

  async sendMasterMsg(msg, sleep = 5000) {
    const masterQQs = cfg.masterQQ;
    if (!masterQQs?.length) throw new Error('未配置主人QQ');

    const results = {};
    for (let i = 0; i < masterQQs.length; i++) {
      const user_id = masterQQs[i];
      try {
        const friend = this.pickFriend(user_id);
        if (friend?.sendMsg) {
          results[user_id] = await friend.sendMsg(msg);
          BotUtil.makeLog('debug', `已发送消息给主人 ${user_id}`, '服务器');
        } else {
          results[user_id] = { error: '没有可用的Bot' };
          BotUtil.makeLog('warn', `无法向主人 ${user_id} 发送消息`, '服务器');
        }
        if (sleep && i < masterQQs.length - 1) await BotUtil.sleep(sleep);
      } catch (err) {
        results[user_id] = { error: err.message };
        BotUtil.makeLog('error', `向主人 ${user_id} 发送消息失败：${err.message}`, '服务器');
      }
    }
    return results;
  }

  makeForwardMsg(msg) { return { type: 'node', data: msg }; }
  async sendForwardMsg(send, msg) {
    const messages = Array.isArray(msg) ? msg : [msg];
    return Promise.all(messages.map(({ message }) => send(message)));
  }

  async redisExit() {
    if (!(typeof redis === 'object' && redis.process)) return false;
    const processObj = redis.process;
    delete redis.process;
    await BotUtil.sleep(5000, redis.save().catch(() => {}));
    return processObj.kill();
  }

  async fileToUrl(file, opts = {}) { return await BotUtil.fileToUrl(file, opts); }

  // ========== 关闭 ==========
  async closeServer() {
    BotUtil.makeLog('info', '⏳ 正在关闭服务器...', '服务器');
    const servers = [this.server, this.httpsServer, this.proxyServer, this.proxyHttpsServer].filter(Boolean);
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    await BotUtil.sleep(2000);
    await this.redisExit();
    BotUtil.makeLog('info', '✓ 服务器已关闭', '服务器');
  }
}
