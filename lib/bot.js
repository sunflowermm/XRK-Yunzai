// bot.js
import path from 'node:path';
import fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import os from 'node:os';
import dgram from 'node:dgram';
import chalk from 'chalk';
import Fastify from 'fastify';
import fastifyCompress from '@fastify/compress';
import fastifyHelmet from '@fastify/helmet';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyFormbody from '@fastify/formbody';
import { WebSocketServer } from 'ws';
import httpProxy from 'http-proxy';

import PluginsLoader from "./plugins/loader.js";
import ListenerLoader from "./listener/loader.js";
import ApiLoader from "./http/loader.js";
import Packageloader from "./config/loader.js";
import StreamLoader from "./aistream/loader.js";
import BotUtil from './common/util.js';
import cfg from './config/config.js';

export default class Bot extends EventEmitter {
  constructor() {
    super();

    /** 运行状态与容器 */
    this.stat = { start_time: Date.now() / 1000 };
    this.bot = this;
    this.bots = {};
    this.adapter = [];
    this.uin = this._createUinManager();

    /** Fastify 应用与底层 HTTP/HTTPS 服务器 */
    this.fastify = this._buildFastify();
    this.server = /** @type {http.Server} */ (this.fastify.server);
    this.httpsServer = null;

    /** WebSocket（高性能参数） */
    this.wss = new WebSocketServer({
      noServer: true,
      clientTracking: false,             // 不在服务器维护连接列表，减少内存
      perMessageDeflate: cfg.server?.ws?.perMessageDeflate ?? false,
      maxPayload: cfg.server?.ws?.maxPayload ?? 1 * 1024 * 1024, // 1MB 默认，可配置
      skipUTF8Validation: cfg.server?.ws?.skipUTF8Validation ?? true
    });
    this.wsf = Object.create(null); // { [segment: string]: Array<handler> }
    this.fs = Object.create(null);  // /File 虚拟文件映射

    /** 配置/缓存/限流等 */
    this.apiKey = '';
    this._cache = BotUtil.getMap('yunzai_cache', { ttl: 60000, autoClean: true });
    this._rateLimiters = new Map();
    this.httpPort = null;
    this.httpsPort = null;
    this.actualPort = null;
    this.actualHttpsPort = null;
    this.url = cfg.server?.server?.url || '';

    /** 反向代理（多域+SNI） */
    this.proxyEnabled = false;
    this.proxyHttpServer = null;
    this.proxyHttpsServer = null;
    this.domainConfigs = new Map(); // domain => config
    this.sslContexts = new Map();   // domain => SecureContext
    this.httpProxy = httpProxy.createProxyServer({ xfwd: true, ignorePath: false });

    /** 绑定常用 */
    this.ApiLoader = ApiLoader;

    /** 信号与鉴权初始化 */
    this._setupSignalHandlers();
    this.generateApiKey();

    return this._createProxy();
  }

  /* -------------------- 基础工具与错误包装 -------------------- */
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
    const logDetails = Object.keys(details).length > 0 ? chalk.gray(` Details: ${JSON.stringify(details)}`) : '';

    if (typeof BotUtil !== 'undefined' && BotUtil.makeLog) {
      BotUtil.makeLog('error', chalk.red(`✗ ${logMessage}${logDetails}`), type);
      if (error.stack && cfg?.debug) BotUtil.makeLog('debug', chalk.gray(error.stack), type);
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
        return raw === true
          ? Array.prototype.toString.apply(this, args)
          : this.toJSON().toString(raw, ...args);
      },
      includes(value) {
        return this.some(i => i == value);
      }
    });
  }

  /* -------------------- Fastify 实例与底层服务器 -------------------- */
  _buildFastify() {
    /** 记录 serverFactory 提供的请求处理函数（同时供 HTTPS 共享） */
    let requestHandler = null;

    const app = Fastify({
      logger: false,
      trustProxy: true,
      caseSensitive: false,
      ignoreTrailingSlash: true,
      requestTimeout: cfg.server?.http?.requestTimeout ?? 0,     // 0 = 不超时
      connectionTimeout: cfg.server?.http?.connectionTimeout ?? 0,
      keepAliveTimeout: cfg.server?.http?.keepAliveTimeout ?? 65_000,
      bodyLimit: this._calcBodyLimitBytes(cfg.server?.limits),
      serverFactory: (handler /* (req,res) */, opts) => {
        requestHandler = handler;
        const server = http.createServer((req, res) => handler(req, res));
        // 统一处理 WebSocket Upgrade（共用一套认证与分发）
        server.on('upgrade', this.wsConnect.bind(this));
        // 常规错误
        server.on('error', (err) => this._handleServerError(err, false));
        return server;
      }
    });

    // 暴露供 HTTPS 共用
    this._getRequestHandler = () => requestHandler;

    return app;
  }

  _calcBodyLimitBytes(limits = {}) {
    const toBytes = (x) => {
      if (!x) return 10 * 1024 * 1024; // 默认 10MB
      if (typeof x === 'number') return x;
      const m = String(x).trim().toLowerCase().match(/^(\d+)(kb|mb|gb)?$/);
      if (!m) return 10 * 1024 * 1024;
      const n = Number(m[1]);
      const unit = m[2] || 'b';
      if (unit === 'kb') return n * 1024;
      if (unit === 'mb') return n * 1024 * 1024;
      if (unit === 'gb') return n * 1024 * 1024 * 1024;
      return n;
    };
    const m = Math.max(toBytes(limits.json || '10mb'), toBytes(limits.urlencoded || '10mb'), toBytes(limits.raw || '10mb'));
    return m;
  }

  _handleServerError(err, isHttps) {
    const handler = this[`server${err.code}`];
    if (typeof handler === "function") return handler.call(this, err, isHttps);
    BotUtil.makeLog("error", err, isHttps ? "HTTPS服务器" : "HTTP服务器");
  }

  /* -------------------- 反向代理（多域+SNI） -------------------- */
  async _initProxyServers() {
    const proxyConfig = cfg.server?.proxy;
    if (!proxyConfig?.enabled) return;

    // 预载证书与域名配置
    await this._loadDomainCertificates();

    // HTTP 代理
    const httpHandler = (req, res) => this._proxyRequest(req, res);
    this.proxyHttpServer = http.createServer(httpHandler);
    this.proxyHttpServer.on('upgrade', (req, socket, head) => this._proxyUpgrade(req, socket, head));
    this.proxyHttpServer.on('error', (err) => BotUtil.makeLog("error", `HTTP代理服务器错误：${err.message}`, '代理'));

    // HTTPS 代理（若存在证书）
    if (this.sslContexts.size > 0) {
      const [firstDomain] = this.sslContexts.keys();
      const domainConfig = this.domainConfigs.get(firstDomain);
      const cert = domainConfig?.ssl?.certificate;
      if (!cert?.key || !cert?.cert) {
        BotUtil.makeLog("error", "没有可用的SSL证书", '代理');
      } else {
        const httpsOptions = {
          key: await fs.readFile(cert.key),
          cert: await fs.readFile(cert.cert),
          ca: cert.ca && fsSync.existsSync(cert.ca) ? await fs.readFile(cert.ca) : undefined,
          SNICallback: (servername, cb) => {
            const context = this.sslContexts.get(servername) || this._findWildcardContext(servername);
            cb(null, context);
          }
        };
        const httpsHandler = (req, res) => this._proxyRequest(req, res);
        this.proxyHttpsServer = https.createServer(httpsOptions, httpsHandler);
        this.proxyHttpsServer.on('upgrade', (req, socket, head) => this._proxyUpgrade(req, socket, head));
        this.proxyHttpsServer.on('error', (err) => BotUtil.makeLog("error", `HTTPS代理服务器错误：${err.message}`, '代理'));
      }
    }
  }

  async _loadDomainCertificates() {
    const proxyConfig = cfg.server?.proxy;
    if (!proxyConfig?.domains) return;

    for (const domainConfig of proxyConfig.domains) {
      this.domainConfigs.set(domainConfig.domain, domainConfig);
      const ssl = domainConfig.ssl;
      if (!ssl?.enabled || !ssl?.certificate) continue;

      const cert = ssl.certificate;
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
        BotUtil.makeLog("info", `✓ 加载SSL证书：${domainConfig.domain}`, '代理');
      } catch (err) {
        BotUtil.makeLog("error", `加载SSL证书失败 [${domainConfig.domain}]: ${err.message}`, '代理');
      }
    }
  }

  _findDomainConfig(hostname) {
    if (this.domainConfigs.has(hostname)) return this.domainConfigs.get(hostname);

    for (const [domain, config] of this.domainConfigs) {
      if (domain.startsWith('*.')) {
        const base = domain.slice(2);
        if (hostname === base || hostname.endsWith(`.${base}`)) {
          const subdomain = hostname === base ? '' : hostname.substring(0, hostname.length - base.length - 1);
          const cfgCopy = { ...config, subdomain };
          if (cfgCopy.rewritePath?.to?.includes('${subdomain}')) {
            cfgCopy.rewritePath = { ...cfgCopy.rewritePath, to: cfgCopy.rewritePath.to.replace('${subdomain}', subdomain) };
          }
          return cfgCopy;
        }
      }
    }
    return null;
  }

  _findWildcardContext(servername) {
    for (const [domain, context] of this.sslContexts) {
      if (domain.startsWith('*.')) {
        const base = domain.slice(2);
        if (servername === base || servername.endsWith(`.${base}`)) return context;
      }
    }
    return null;
  }

  _rewritePathIfNeeded(urlPath, cfgRewrite) {
    if (!cfgRewrite?.from) return urlPath;
    if (urlPath.startsWith(cfgRewrite.from)) {
      return urlPath.replace(cfgRewrite.from, cfgRewrite.to || '');
    }
    return urlPath;
  }

  _proxyRequest(req, res) {
    const host = req.headers.host?.split(':')[0];
    if (!host) {
      res.statusCode = 400;
      res.end('错误请求：缺少Host头');
      return;
    }
    const domainCfg = this._findDomainConfig(host);
    if (!domainCfg) {
      res.statusCode = 404;
      res.end(`域名 ${host} 未配置`);
      return;
    }

    // 路径重写
    const urlObj = new URL(`http://${host}${req.url}`);
    const newPath = this._rewritePathIfNeeded(urlObj.pathname, domainCfg.rewritePath);
    if (newPath !== urlObj.pathname) {
      req.url = newPath + (urlObj.search || '');
      BotUtil.makeLog('debug', `路径重写：${urlObj.pathname} → ${newPath}`, '代理');
    }

    const target = domainCfg.target || `http://127.0.0.1:${this.actualPort}`;
    this.httpProxy.web(req, res, {
      target,
      changeOrigin: true,
      secure: false,
      preserveHeaderKeyCase: true
    }, (err) => {
      BotUtil.makeLog('error', `代理错误 [${host}]: ${err.message}`, '代理');
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '网关错误', message: '无法连接到上游服务器', upstream: target }));
      }
    });
  }

  _proxyUpgrade(req, socket, head) {
    const host = req.headers.host?.split(':')[0];
    const domainCfg = host && this._findDomainConfig(host);
    const target = domainCfg?.target || `http://127.0.0.1:${this.actualPort}`;
    this.httpProxy.ws(req, socket, head, { target, changeOrigin: true, secure: false }, (err) => {
      BotUtil.makeLog('error', `代理 WS 错误 [${host}]: ${err.message}`, '代理');
      try { socket.destroy(); } catch {}
    });
  }

  /* -------------------- 中间件/插件/路由（Fastify） -------------------- */
  async _initializeMiddlewareAndRoutes() {
    const f = this.fastify;

    // 压缩
    if (cfg.server?.compression?.enabled !== false) {
      await f.register(fastifyCompress, {
        global: true,
        threshold: cfg.server?.compression?.threshold ?? 1024,
        zlibOptions: { level: cfg.server?.compression?.level ?? 6 }
      });
    }

    // 安全头
    if (cfg.server?.security?.helmet?.enabled !== false) {
      await f.register(fastifyHelmet, {
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        hsts: cfg.server?.security?.hsts?.enabled === true ? {
          maxAge: cfg.server.security.hsts.maxAge || 31536000,
          includeSubDomains: cfg.server.security.hsts.includeSubDomains !== false,
          preload: cfg.server.security.hsts.preload === true
        } : false
      });
    }

    // CORS
    const corsCfg = cfg.server?.cors;
    if (corsCfg?.enabled !== false) {
      const origins = corsCfg?.origins || ['*'];
      await f.register(fastifyCors, {
        origin: (origin, cb) => {
          if (!origin) return cb(null, true);
          if (origins.includes('*') || origins.includes(origin)) return cb(null, true);
          return cb(new Error('CORS 不允许的来源'), false);
        },
        methods: corsCfg?.methods || ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: corsCfg?.headers || ['Content-Type', 'Authorization', 'X-API-Key'],
        credentials: !!corsCfg?.credentials,
        maxAge: corsCfg?.maxAge
      });
    }

    // URL-Encoded
    await f.register(fastifyFormbody);

    // 全局限流（允许本地跳过）
    const rl = cfg.server?.rateLimit;
    if (rl?.enabled !== false) {
      await f.register(fastifyRateLimit, {
        global: !!rl?.global,
        max: rl?.global?.max ?? 100,
        timeWindow: rl?.global?.windowMs ? `${rl.global.windowMs} ms` : '15 minutes',
        allowList: (req, key) => this._isLocalConnection(req.ip)
      });
    }

    // 请求日志（尽量轻量）
    if (cfg.server?.logging?.requests !== false) {
      f.addHook('onRequest', async (req, reply) => {
        req._startAt = Date.now();
      });
      f.addHook('onResponse', async (req, reply) => {
        const duration = Date.now() - (req._startAt || Date.now());
        const quietPaths = cfg.server?.logging?.quiet || [];
        const url = req.raw?.url || '';
        if (!quietPaths.some(p => url.startsWith(p))) {
          const status = reply.statusCode;
          const statusColor = status < 400 ? chalk.green : status < 500 ? chalk.yellow : chalk.red;
          const method = chalk.cyan((req.method || '').padEnd(6));
          const time = chalk.gray(`${duration}ms`.padStart(7));
          const path = chalk.white(url.split('?')[0] || '/');
          const host = req.hostname ? chalk.gray(` [${req.hostname}]`) : '';
          BotUtil.makeLog('debug', `${method} ${statusColor(status)} ${time} ${path}${host}`, 'HTTP');
        }
      });
    }

    // 鉴权（全局）
    f.addHook('onRequest', this._authHook.bind(this));

    // 系统路由
    f.get('/status', this._statusHandler.bind(this));
    f.get('/health', this._healthHandler.bind(this));
    f.get('/File/*', this._fileHandler.bind(this)); // 保持原行为

    // 静态资源（含目录索引重定向、隐藏防护、缓存头）
    await this._setupStaticServing();
  }

  async _setupStaticServing() {
    const f = this.fastify;

    // 目录规范化 + 隐藏文件保护
    f.addHook('onRequest', async (req, reply) => {
      const pathname = (req.raw?.url || '/').split('?')[0];
      const norm = path.posix.normalize(pathname);
      if (norm.includes('..')) {
        reply.code(403).type('application/json; charset=utf-8').send({ error: '禁止访问' });
        return reply.hijack();
      }

      const hiddenPatterns = cfg.server?.security?.hiddenFiles || [/^\./, /\/\./, /node_modules/, /\.git/];
      const isHidden = hiddenPatterns.some(p => (typeof p === 'string' ? norm.includes(p) : p.test(norm)));
      if (isHidden) {
        reply.code(404).type('application/json; charset=utf-8').send({ error: '未找到' });
        return reply.hijack();
      }

      // 目录无斜杠 → 301 到带斜杠（若有 index）
      const staticRoot = path.join(process.cwd(), 'www');
      const abs = path.join(staticRoot, norm);
      if (!path.extname(norm) && fsSync.existsSync(abs) && fsSync.statSync(abs).isDirectory()) {
        const indexes = cfg.server?.static?.index || ['index.html', 'index.htm'];
        for (const name of indexes) {
          if (fsSync.existsSync(path.join(abs, name))) {
            const redirectUrl = norm.endsWith('/') ? norm : `${norm}/`;
            BotUtil.makeLog('debug', `目录重定向：${norm} → ${redirectUrl}`, '服务器');
            reply.redirect(301, redirectUrl);
            return reply.hijack();
          }
        }
      }
    });

    // 静态服务
    const staticRoot = path.join(process.cwd(), 'www');
    if (!fsSync.existsSync(staticRoot)) fsSync.mkdirSync(staticRoot, { recursive: true });

    await this.fastify.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/', // 与站点根一致
      list: false,
      decorateReply: true,
      index: cfg.server?.static?.index || ['index.html', 'index.htm'],
      maxAge: cfg.server?.static?.cacheTime || '1d',
      etag: true,
      setHeaders: (res, filePath) => this._setStaticHeaders(res, filePath)
    });

    // favicon / robots
    this.fastify.get('/favicon.ico', this._handleFavicon.bind(this));
    this.fastify.get('/robots.txt', this._handleRobotsTxt.bind(this));

    // 404 与错误处理
    this._setupFinalHandlers();
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

  /* -------------------- 鉴权 -------------------- */
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
      await fs.writeFile(apiKeyPath, JSON.stringify({ key: this.apiKey, generated: new Date().toISOString(), note: '远程访问API密钥' }, null, 2), 'utf8');
      if (process.platform !== 'win32') { try { await fs.chmod(apiKeyPath, 0o600); } catch {} }
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
    return testPatterns.some(pattern => pattern.test(ip));
  }

  _extractAuthKeyFastify(req) {
    return req.headers?.['x-api-key']
      || (req.headers?.authorization && req.headers.authorization.replace('Bearer ', ''))
      || req.query?.api_key
      || (typeof req.body === 'object' && req.body?.api_key);
  }

  _checkApiAuthorizationFastify(req) {
    if (!this.apiKey) return true; // 认证禁用
    const authKey = this._extractAuthKeyFastify(req);
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

  _isStaticPath(pathname) {
    return /\.(html|css|js|json|png|jpg|jpeg|gif|svg|webp|ico|mp4|webm|mp3|wav|pdf|zip|woff|woff2|ttf|otf)$/i.test(pathname);
  }

  async _authHook(req, reply) {
    // 兼容字段
    req.rid = `${req.ip}:${req.socket.remotePort}`;
    const host = req.hostname || req.headers['host'] || 'localhost';
    req.sid = `${req.protocol || 'http'}://${host}${req.url}`;

    const authConfig = cfg.server?.auth || {};
    const whitelist = authConfig.whitelist || ['/', '/favicon.ico', '/health', '/status', '/robots.txt'];

    const pathOnly = (req.raw?.url || '').split('?')[0];

    const isWhitelisted = whitelist.some(wp => {
      if (wp === pathOnly) return true;
      if (wp.endsWith('*')) return pathOnly.startsWith(wp.slice(0, -1));
      if (!wp.endsWith('/') && pathOnly === `${wp}/`) return true;
      return false;
    });

    if (isWhitelisted || this._isStaticPath(pathOnly) || this._isLocalConnection(req.ip) || authConfig.apiKey?.enabled === false) {
      return; // 放行
    }

    if (!this._checkApiAuthorizationFastify(req)) {
      BotUtil.makeLog("warn", `认证失败：${req.method} ${req.raw?.url} 来自 ${req.ip}`, '认证');
      reply.code(401).type('application/json; charset=utf-8').send({
        success: false,
        message: 'Unauthorized',
        error: '未授权',
        detail: '无效或缺失的API密钥',
        hint: '请提供 X-API-Key 头或 api_key 参数'
      });
      return reply.hijack();
    }
    BotUtil.makeLog("debug", `认证成功：${req.method} ${req.raw?.url}`, '认证');
  }

  /* -------------------- 系统路由处理 -------------------- */
  _statusHandler(req, reply) {
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
        domains: this.proxyEnabled ? Array.from(this.domainConfigs.keys()) : []
      },
      auth: {
        apiKeyEnabled: cfg.server?.auth?.apiKey?.enabled !== false,
        whitelist: cfg.server?.auth?.whitelist || []
      }
    };
    reply.type('application/json; charset=utf-8').send(status);
  }

  _healthHandler(req, reply) {
    reply.type('application/json; charset=utf-8').send({ status: '健康', uptime: process.uptime(), timestamp: Date.now() });
  }

  _fileHandler(req, reply) {
    const url = (req.params['*'] || '').replace(/^\//, "");
    let file = this.fs[url];
    if (!file) file = this.fs[404];
    if (!file) return reply.code(404).send({ error: '未找到', file: url });

    if (typeof file.times === "number") {
      if (file.times > 0) file.times--;
      else {
        file = this.fs.timeout;
        if (!file) return reply.code(410).send({ error: '已过期', message: '文件访问次数已达上限' });
      }
    }
    if (file.type?.mime) reply.header("Content-Type", file.type.mime);
    reply.header("Content-Length", file.buffer.length);
    reply.header("Cache-Control", "no-cache");

    BotUtil.makeLog("debug", `文件发送：${file.name} (${BotUtil.formatFileSize(file.buffer.length)})`, '服务器');
    reply.send(file.buffer);
  }

  async _handleFavicon(req, reply) {
    const staticRoot = path.join(process.cwd(), 'www');
    const faviconPath = path.join(staticRoot, 'favicon.ico');
    if (fsSync.existsSync(faviconPath)) {
      reply.header('Content-Type', 'image/x-icon');
      reply.header('Cache-Control', 'public, max-age=604800');
      return reply.send(fsSync.createReadStream(faviconPath));
    }
    reply.code(204).send();
  }

  async _handleRobotsTxt(req, reply) {
    const staticRoot = path.join(process.cwd(), 'www');
    const robotsPath = path.join(staticRoot, 'robots.txt');
    if (fsSync.existsSync(robotsPath)) {
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.send(fsSync.createReadStream(robotsPath));
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
    reply.header('Content-Type', 'text/plain; charset=utf-8').send(defaultRobots);
  }

  /* -------------------- WebSocket 入口（共享认证逻辑） -------------------- */
  wsConnect(req, socket, head) {
    try {
      req.rid = `${req.socket.remoteAddress}:${req.socket.remotePort}-${req.headers["sec-websocket-key"]}`;
      const host = req.headers.host || `${req.socket.localAddress}:${req.socket.localPort}`;
      const proto = (req.socket.encrypted ? 'wss' : 'ws');
      req.sid = `${proto}://${host}${req.url}`;
      req.query = Object.fromEntries(new URL(req.sid).searchParams.entries());

      const authConfig = cfg.server?.auth || {};
      const whitelist = authConfig.whitelist || [];

      const path = req.url.split("?")[0];
      const isWhitelisted = whitelist.some(p => {
        if (p === path) return true;
        if (p.endsWith('*')) return path.startsWith(p.slice(0, -1));
        return false;
      });

      // 非白名单且非本地 → 需要 API Key
      if (!isWhitelisted && !this._isLocalConnection(req.socket.remoteAddress)) {
        if (authConfig.apiKey?.enabled !== false && !this._checkApiAuthorizationFastify({
          headers: req.headers,
          query: req.query,
          body: {}, // WS 升级无 body
        })) {
          BotUtil.makeLog("error", `WebSocket认证失败：${req.url}`, '服务器');
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          return socket.destroy();
        }
      }

      const wsKey = (req.url.split("/")[1] || '').split('?')[0];
      if (!(wsKey in this.wsf)) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        return socket.destroy();
      }

      this.wss.handleUpgrade(req, socket, head, (conn) => {
        BotUtil.makeLog("debug", `WebSocket连接建立：${req.url}`, '服务器');

        // 轻量 KeepAlive（可配置）
        const ka = cfg.server?.ws?.keepAlive ?? { enabled: true, interval: 30000, timeout: 10000 };
        if (ka.enabled) {
          let alive = true;
          conn.isAlive = true;
          conn.on('pong', () => (alive = true));
          const interval = setInterval(() => {
            if (!alive) return conn.terminate();
            alive = false;
            try { conn.ping(); } catch { /* ignore */ }
          }, ka.interval);
          conn.on('close', () => clearInterval(interval));
        }

        conn.on("error", err => BotUtil.makeLog("error", err, '服务器'));
        conn.on("close", () => BotUtil.makeLog("debug", `WebSocket断开：${req.url}`, '服务器'));

        conn.on("message", msg => {
          const logMsg = Buffer.isBuffer(msg) && msg.length > 1024 ? `[二进制消息，长度：${msg.length}]` : BotUtil.String(msg);
          BotUtil.makeLog("trace", `WS消息：${logMsg}`, '服务器');
        });

        conn.sendMsg = (msg) => {
          if (!Buffer.isBuffer(msg)) msg = BotUtil.String(msg);
          BotUtil.makeLog("trace", `WS发送：${msg}`, '服务器');
          return conn.send(msg);
        };

        for (const handler of this.wsf[wsKey]) {
          try { handler(conn, req, socket, head); } catch (e) { BotUtil.makeLog('error', e.message, '服务器'); }
        }
      });
    } catch (e) {
      try { socket.destroy(); } catch {}
      BotUtil.makeLog('error', `WS Upgrade 异常：${e.message}`, '服务器');
    }
  }

  /* -------------------- HTTP/HTTPS 启停 -------------------- */
  async serverEADDRINUSE(err, isHttps) {
    const serverType = isHttps ? 'HTTPS' : 'HTTP';
    const port = isHttps ? this.httpsPort : this.httpPort;
    BotUtil.makeLog("error", `${serverType}端口 ${port} 已被占用`, '服务器');

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
    await BotUtil.promiseEvent(server, "listening", isHttps && "error").catch(() => { });

    const info = server.address();
    if (!info) {
      BotUtil.makeLog('error', `${isHttps ? 'HTTPS' : 'HTTP'}服务器启动失败`, '服务器');
      return;
    }

    if (isHttps) this.httpsPort = info.port; else this.httpPort = info.port;

    const serverType = isHttps ? 'HTTPS' : 'HTTP';
    BotUtil.makeLog("info", `✓ ${serverType}服务器监听在 ${host}:${info.port}`, '服务器');

    if (!isHttps && !this.proxyEnabled) {
      const protocol = 'http';
      await this._displayAccessUrls(protocol, info.port);
    }
  }

  async httpsLoad() {
    const httpsConfig = cfg.server?.https;
    if (!httpsConfig?.enabled) return;

    try {
      let httpsOptions = {};
      if (httpsConfig?.certificate) {
        const cert = httpsConfig.certificate;
        if (!cert.key || !cert.cert) throw new Error("HTTPS已启用但未配置证书");
        if (!fsSync.existsSync(cert.key)) throw new Error(`HTTPS密钥文件不存在：${cert.key}`);
        if (!fsSync.existsSync(cert.cert)) throw new Error(`HTTPS证书文件不存在：${cert.cert}`);

        httpsOptions = { key: await fs.readFile(cert.key), cert: await fs.readFile(cert.cert) };
        if (cert.ca && fsSync.existsSync(cert.ca)) httpsOptions.ca = await fs.readFile(cert.ca);
      }
      if (httpsConfig?.tls?.minVersion) httpsOptions.minVersion = httpsConfig.tls.minVersion;

      const handler = this._getRequestHandler();
      this.httpsServer = https.createServer(httpsOptions, (req, res) => handler(req, res));
      this.httpsServer.on("error", err => this._handleServerError(err, true));
      this.httpsServer.on("upgrade", this.wsConnect.bind(this));

      await this.serverLoad(true);
      BotUtil.makeLog("info", "✓ HTTPS服务器已启动", '服务器');
    } catch (err) {
      BotUtil.makeLog("error", `HTTPS服务器错误：${err.message}`, '服务器');
    }
  }

  _setupFinalHandlers() {
    // 404
    this.fastify.setNotFoundHandler((req, reply) => {
      let defaultRoute = cfg.server?.misc?.defaultRoute || '/';
      if (req.domainConfig?.defaultRoute) defaultRoute = req.domainConfig.defaultRoute;

      const accept = req.headers['accept'] || '';
      if (/text\/html/.test(accept)) {
        const staticRoot = path.join(process.cwd(), 'www');
        const custom404Path = path.join(staticRoot, '404.html');
        if (fsSync.existsSync(custom404Path)) {
          return reply.code(404).type('text/html; charset=utf-8').send(fsSync.createReadStream(custom404Path));
        } else {
          return reply.redirect(defaultRoute);
        }
      } else {
        return reply.code(404).type('application/json; charset=utf-8').send({ error: '未找到', path: req.raw?.url || '/', timestamp: Date.now() });
      }
    });

    // 错误
    this.fastify.setErrorHandler((err, req, reply) => {
      BotUtil.makeLog('error', `请求错误：${err.message}`, '服务器');
      reply.code(err.statusCode || 500).type('application/json; charset=utf-8').send({
        error: '内部服务器错误',
        message: process.env.NODE_ENV === 'production' ? '发生了一个错误' : err.message,
        timestamp: Date.now()
      });
    });
  }

  /* -------------------- 关闭/工具 -------------------- */
  async closeServer() {
    BotUtil.makeLog('info', '⏳ 正在关闭服务器...', '服务器');

    const servers = [this.server, this.httpsServer, this.proxyHttpServer, this.proxyHttpsServer].filter(Boolean);
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));

    await BotUtil.sleep(2000);
    await this.redisExit();

    BotUtil.makeLog('info', '✓ 服务器已关闭', '服务器');
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
    const needPort = (protocol === 'http' && port !== 80) || (protocol === 'https' && port !== 443);
    return `${protocol}://${host}${needPort ? ':' + port : ''}`;
  }

  async getLocalIpAddress() {
    const cacheKey = 'local_ip_addresses';
    const cached = this._cache.get(cacheKey);
    if (cached) return cached;

    const result = { local: [], public: null, primary: null };
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
        const item = result.local.find(i => i.ip === result.primary);
        if (item) item.primary = true;
      } catch {}
      if (cfg.server?.misc?.detectPublicIP !== false) {
        result.public = await this._getPublicIP();
      }
      this._cache.set(cacheKey, result);
      return result;
    } catch (err) {
      BotUtil.makeLog("debug", `获取IP地址失败：${err.message}`, '服务器');
      return result;
    }
  }

  _isVirtualInterface(name, mac) {
    const virtualPatterns = [/^(docker|br-|veth|virbr|vnet)/i, /^(vmnet|vmware)/i, /^(vboxnet|virtualbox)/i];
    return virtualPatterns.some(p => p.test(name));
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
        const res = await fetch(api.url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
        clearTimeout(timeout);
        if (res.ok) {
          const data = await res.json();
          const ip = data[api.field];
          if (ip && this._isValidIP(ip)) return ip;
        }
      } catch {}
    }
    return null;
  }

  _isValidIP(ip) {
    const ipv4Regex = /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
    return ipv4Regex.test(ip || '');
  }

  async _displayAccessUrls(protocol, port) {
    const ipInfo = await this.getLocalIpAddress();
    console.log(chalk.cyan('\n▶ 访问地址：'));
    if (ipInfo.local.length > 0) {
      console.log(chalk.yellow('  本地网络：'));
      ipInfo.local.forEach(info => {
        const url = `${protocol}://${info.ip}:${port}`;
        const label = info.primary ? chalk.green(' ★') : '';
        const interfaceInfo = chalk.gray(` [${info.interface}]`);
        console.log(`    ${chalk.cyan('•')} ${chalk.white(url)}${interfaceInfo}${label}`);
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
    if (this.actualHttpsPort) console.log(`    ${chalk.cyan('•')} HTTPS：${chalk.white(`https://localhost:${this.actualHttpsPort}`)}`);

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

  /* -------------------- 运行入口 -------------------- */
  async run(options = {}) {
    const { port } = options;
    const proxyConfig = cfg.server?.proxy;
    this.proxyEnabled = proxyConfig?.enabled === true;

    // 端口
    this.actualPort = port || 2537;
    this.actualHttpsPort = this.actualPort + 1;

    if (this.proxyEnabled) {
      this.httpPort = proxyConfig.httpPort || 80;
      this.httpsPort = proxyConfig.httpsPort || 443;
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

    // 配置/插件加载
    await Packageloader();
    await this.generateApiKey();

    await StreamLoader.load();
    await PluginsLoader.load();

    // Fastify 插件/路由/静态
    await this._initializeMiddlewareAndRoutes();

    // API 模块收集与注册（只对一个 fastify 实例注册一次，HTTP/HTTPS 共用 handler）
    await ApiLoader.load();
    await ApiLoader.register(this.fastify, this);

    // Fastify 就绪（serverFactory 已创建 HTTP server）
    await this.fastify.ready();

    // 启动 HTTP
    await this.serverLoad(false);

    // 启动 HTTPS
    if (cfg.server?.https?.enabled) {
      await this.httpsLoad();
    }

    // 启动代理服务器
    if (this.proxyEnabled) {
      const host = cfg.server?.server?.host || '0.0.0.0';
      const httpPort = cfg.server?.proxy?.httpPort || 80;
      this.proxyHttpServer.listen(httpPort, host);
      await BotUtil.promiseEvent(this.proxyHttpServer, "listening").catch(() => {});
      BotUtil.makeLog('info', `✓ HTTP代理服务器监听在 ${host}:${httpPort}`, '代理');

      if (this.proxyHttpsServer) {
        const httpsPort = cfg.server?.proxy?.httpsPort || 443;
        this.proxyHttpsServer.listen(httpsPort, host);
        await BotUtil.promiseEvent(this.proxyHttpsServer, "listening").catch(() => {});
        BotUtil.makeLog('info', `✓ HTTPS代理服务器监听在 ${host}:${httpsPort}`, '代理');
      }
      await this._displayProxyInfo();
    }

    await ListenerLoader.load();
    await ApiLoader.watch(true);

    if (Object.keys(this.wsf).length > 0) {
      BotUtil.makeLog("info", `⚡ WebSocket服务：${this.getServerUrl().replace(/^http/, "ws")}/ [${Object.keys(this.wsf).join(', ')}]`, '服务器');
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

  /* -------------------- 事件准备和快捷方法，延续原行为 -------------------- */
  prepareEvent(data) {
    if (!this.bots[data.self_id]) return;

    if (!data.bot) Object.defineProperty(data, "bot", { value: this.bots[data.self_id] });

    if (data.user_id) {
      if (!data.friend) Object.defineProperty(data, "friend", { value: data.bot.pickFriend(data.user_id) });
      data.sender ||= { user_id: data.user_id };
      data.sender.nickname ||= data.friend?.nickname;
    }

    if (data.group_id) {
      if (!data.group) Object.defineProperty(data, "group", { value: data.bot.pickGroup(data.group_id) });
      data.group_name ||= data.group?.name;
    }

    if (data.group && data.user_id) {
      if (!data.member) Object.defineProperty(data, "member", { value: data.group.pickMember(data.user_id) });
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
      target.sendFile ??= (file, name) => target.sendMsg(segment.file(file, name));
      target.makeForwardMsg ??= this.makeForwardMsg;
      target.sendForwardMsg ??= msg => this.sendForwardMsg(m => target.sendMsg(m), msg);
      target.getInfo ??= () => target.info || target;
    }
    if (!data.reply) data.reply = data.group?.sendMsg?.bind(data.group) || data.friend?.sendMsg?.bind(data.friend);
  }

  em(name = "", data = {}) {
    this.prepareEvent(data);
    while (name) {
      this.emit(name, data);
      const i = name.lastIndexOf(".");
      if (i === -1) break;
      name = name.slice(0, i);
    }
  }

  getFriendArray() {
    const array = [];
    for (const bot_id of this.uin) for (const [id, i] of this.bots[bot_id].fl || []) array.push({ ...i, bot_id });
    return array;
  }
  getFriendList() {
    const array = [];
    for (const bot_id of this.uin) array.push(...(this.bots[bot_id].fl?.keys() || []));
    return array;
  }
  getFriendMap() {
    const map = new Map();
    for (const bot_id of this.uin) for (const [id, i] of this.bots[bot_id].fl || []) map.set(id, { ...i, bot_id });
    return map;
  }
  get fl() { return this.getFriendMap(); }

  getGroupArray() {
    const array = [];
    for (const bot_id of this.uin) for (const [id, i] of this.bots[bot_id].gl || []) array.push({ ...i, bot_id });
    return array;
  }
  getGroupList() {
    const array = [];
    for (const bot_id of this.uin) array.push(...(this.bots[bot_id].gl?.keys() || []));
    return array;
  }
  getGroupMap() {
    const map = new Map();
    for (const bot_id of this.uin) for (const [id, i] of this.bots[bot_id].gl || []) map.set(id, { ...i, bot_id });
    return map;
  }
  get gl() { return this.getGroupMap(); }
  get gml() {
    const map = new Map();
    for (const bot_id of this.uin) for (const [id, i] of this.bots[bot_id].gml || [])
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
    BotUtil.makeLog("trace", `用户 ${user_id} 不存在，使用随机Bot ${this.uin.toJSON()}`, '服务器');
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
    BotUtil.makeLog("trace", `群组 ${group_id} 不存在，使用随机Bot ${this.uin.toJSON()}`, '服务器');
    return this.bots[this.uin].pickGroup(group_id);
  }
  pickMember(group_id, user_id) { return this.pickGroup(group_id).pickMember(user_id); }

  async sendFriendMsg(bot_id, user_id, ...args) {
    if (!bot_id) return this.pickFriend(user_id).sendMsg(...args);
    if (this.uin.includes(bot_id) && this.bots[bot_id]) return this.bots[bot_id].pickFriend(user_id).sendMsg(...args);

    return new Promise((resolve, reject) => {
      const listener = data => { resolve(data.bot.pickFriend(user_id).sendMsg(...args)); clearTimeout(timeout); };
      const timeout = setTimeout(() => { reject(Object.assign(Error("等待Bot上线超时"), { bot_id, user_id, args })); this.off(`connect.${bot_id}`, listener); }, 300000);
      this.once(`connect.${bot_id}`, listener);
    });
  }

  async sendGroupMsg(bot_id, group_id, ...args) {
    if (!bot_id) return this.pickGroup(group_id).sendMsg(...args);
    if (this.uin.includes(bot_id) && this.bots[bot_id]) return this.bots[bot_id].pickGroup(group_id).sendMsg(...args);

    return new Promise((resolve, reject) => {
      const listener = data => { resolve(data.bot.pickGroup(group_id).sendMsg(...args)); clearTimeout(timeout); };
      const timeout = setTimeout(() => { reject(Object.assign(Error("等待Bot上线超时"), { bot_id, group_id, args })); this.off(`connect.${bot_id}`, listener); }, 300000);
      this.once(`connect.${bot_id}`, listener);
    });
  }

  async sendMasterMsg(msg, sleep = 5000) {
    const masterQQs = cfg.masterQQ;
    if (!masterQQs?.length) throw new Error("未配置主人QQ");

    const results = {};
    for (let i = 0; i < masterQQs.length; i++) {
      const user_id = masterQQs[i];
      try {
        const friend = this.pickFriend(user_id);
        if (friend?.sendMsg) {
          results[user_id] = await friend.sendMsg(msg);
          BotUtil.makeLog("debug", `已发送消息给主人 ${user_id}`, '服务器');
        } else {
          results[user_id] = { error: "没有可用的Bot" };
          BotUtil.makeLog("warn", `无法向主人 ${user_id} 发送消息`, '服务器');
        }
        if (sleep && i < masterQQs.length - 1) await BotUtil.sleep(sleep);
      } catch (err) {
        results[user_id] = { error: err.message };
        BotUtil.makeLog("error", `向主人 ${user_id} 发送消息失败：${err.message}`, '服务器');
      }
    }
    return results;
  }

  makeForwardMsg(msg) { return { type: "node", data: msg }; }
  async sendForwardMsg(send, msg) {
    const messages = Array.isArray(msg) ? msg : [msg];
    return Promise.all(messages.map(({ message }) => send(message)));
  }

  async redisExit() {
    if (!(typeof redis === 'object' && redis.process)) return false;
    const processRef = redis.process; delete redis.process;
    await BotUtil.sleep(5000, redis.save().catch(() => {}));
    return processRef.kill();
  }

  async fileToUrl(file, opts = {}) { return await BotUtil.fileToUrl(file, opts); }

  /* -------------------- 代理信息展示 -------------------- */
  async startProxyServers() { /* 兼容旧接口，已在 run() 内启动 */ }

  /* -------------------- 代理对象（Bot.xx 访问重定向） -------------------- */
  _createProxy() {
    return new Proxy(this.bots, {
      get: (target, prop) => {
        if (target[prop] !== undefined) return target[prop];
        if (this[prop] !== undefined) return this[prop];

        const utilValue = BotUtil[prop];
        if (utilValue !== undefined) return typeof utilValue === 'function' ? utilValue.bind(BotUtil) : utilValue;

        for (const botId of [this.uin.toString(), ...this.uin]) {
          const bot = target[botId];
          if (bot?.[prop] !== undefined) {
            BotUtil.makeLog("trace", `重定向 Bot.${prop} 到 Bot.${botId}.${prop}`);
            return typeof bot[prop] === "function" ? bot[prop].bind(bot) : bot[prop];
          }
        }
        BotUtil.makeLog("trace", `Bot.${prop} 不存在`);
        return undefined;
      }
    });
  }
}
