import path from 'path';
import fs from 'node:fs/promises';
import * as fsSync from 'fs';
import { EventEmitter } from 'events';
import Fastify from 'fastify';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'crypto';
import os from 'node:os';
import dgram from 'node:dgram';
import chalk from 'chalk';

import PluginsLoader from './plugins/loader.js';
import ListenerLoader from './listener/loader.js';
import ApiLoader from './http/loader.js';
import Packageloader from './config/loader.js';
import StreamLoader from './aistream/loader.js';
import BotUtil from './common/util.js';
import cfg from './config/config.js';

/**
 * Bot 主服务类
 * 基于 Fastify 的高性能服务器实现
 * @class Bot
 * @extends EventEmitter
 */
export default class Bot extends EventEmitter {
  constructor() {
    super();
    
    // 核心属性初始化
    this.stat = { start_time: Date.now() / 1000 };
    this.bot = this;
    this.bots = {};
    this.adapter = [];
    this.uin = this._createUinManager();
    
    // Fastify 应用和服务器
    this.fastify = null;
    this.server = null;
    this.httpsServer = null;
    this.wsf = Object.create(null);
    this.fs = Object.create(null);
    
    // 配置属性
    this.apiKey = '';
    this._cache = BotUtil.getMap('yunzai_cache', { ttl: 60000, autoClean: true });
    this._rateLimiters = new Map();
    this.httpPort = null;
    this.httpsPort = null;
    this.actualPort = null;
    this.actualHttpsPort = null;
    this.url = cfg.server?.server?.url || '';
    
    // 反向代理相关
    this.proxyEnabled = false;
    this.proxyApp = null;
    this.proxyServer = null;
    this.proxyHttpsServer = null;
    this.proxyMiddlewares = new Map();
    this.domainConfigs = new Map();
    this.sslContexts = new Map();
    
    this.ApiLoader = ApiLoader;
    this._setupSignalHandlers();
    this.generateApiKey();
    
    return this._createProxy();
  }

  /**
   * 创建标准化错误对象
   * @param {string|Error} message - 错误消息或错误对象
   * @param {string} [type='Error'] - 错误类型
   * @param {Object} [details={}] - 额外的错误详情
   * @returns {Error} 标准化的错误对象
   */
  makeError(message, type = 'Error', details = {}) {
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
    const logDetails = Object.keys(details).length > 0
      ? chalk.gray(` Details: ${JSON.stringify(details)}`)
      : '';

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

  /**
   * 创建 UIN 管理器
   * @private
   * @returns {Array} UIN 数组对象
   */
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
        return this.some((i) => i == value);
      }
    });
  }

  /**
   * 初始化 Fastify 应用
   * @private
   * @returns {Promise<void>}
   */
  async _initFastify() {
    const fastifyOptions = {
      logger: false,
      trustProxy: true,
      requestIdLogLabel: 'reqId',
      disableRequestLogging: true,
      bodyLimit: parseInt(cfg.server?.limits?.json || '10485760'), // 10MB
      keepAliveTimeout: 72000,
      connectionTimeout: 0,
      // 针对高并发优化
      ignoreTrailingSlash: true,
      ignoreDuplicateSlashes: true,
      caseSensitive: true
    };

    this.fastify = Fastify(fastifyOptions);

    // 注册压缩插件
    if (cfg.server?.compression?.enabled !== false) {
      await this.fastify.register(import('@fastify/compress'), {
        global: true,
        threshold: cfg.server?.compression?.threshold || 1024,
        encodings: ['gzip', 'deflate', 'br']
      });
    }

    // 注册安全头插件
    if (cfg.server?.security?.helmet?.enabled !== false) {
      await this.fastify.register(import('@fastify/helmet'), {
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

    // 注册 CORS
    await this._setupCors();

    // 注册速率限制
    await this._setupRateLimiting();

    // 注册 WebSocket
    await this._setupWebSocket();

    // 注册静态文件服务
    await this._setupStaticServing();

    // 注册钩子
    this._setupHooks();

    // 注册基础路由
    this._registerBaseRoutes();
  }

  /**
   * 配置 CORS
   * @private
   * @returns {Promise<void>}
   */
  async _setupCors() {
    const corsConfig = cfg.server?.cors;
    if (corsConfig?.enabled === false) return;

    await this.fastify.register(import('@fastify/cors'), {
      origin: corsConfig?.origins || ['*'],
      methods: corsConfig?.methods || ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: corsConfig?.headers || ['Content-Type', 'Authorization', 'X-API-Key'],
      credentials: corsConfig?.credentials || false,
      maxAge: corsConfig?.maxAge || 86400
    });
  }

  /**
   * 配置速率限制
   * @private
   * @returns {Promise<void>}
   */
  async _setupRateLimiting() {
    const rateLimitConfig = cfg.server?.rateLimit;
    if (rateLimitConfig?.enabled === false) return;

    await this.fastify.register(import('@fastify/rate-limit'), {
      global: true,
      max: rateLimitConfig?.global?.max || 100,
      timeWindow: rateLimitConfig?.global?.windowMs || '15 minutes',
      skipOnError: true,
      allowList: (req) => this._isLocalConnection(req.ip),
      errorResponseBuilder: (req, context) => {
        return {
          statusCode: 429,
          error: 'Too Many Requests',
          message: rateLimitConfig?.global?.message || '请求过于频繁',
          retryAfter: context.after
        };
      }
    });
  }

  /**
   * 配置 WebSocket
   * @private
   * @returns {Promise<void>}
   */
  async _setupWebSocket() {
    await this.fastify.register(import('@fastify/websocket'), {
      options: {
        maxPayload: 1048576, // 1MB
        verifyClient: (info, next) => {
          const req = info.req;
          req.rid = `${req.socket.remoteAddress}:${req.socket.remotePort}-${req.headers['sec-websocket-key']}`;
          req.sid = `ws://${req.headers.host || `${req.socket.localAddress}:${req.socket.localPort}`}${req.url}`;
          
          const urlObj = new URL(req.sid);
          req.query = Object.fromEntries(urlObj.searchParams.entries());

          // WebSocket 认证
          const authConfig = cfg.server?.auth || {};
          const whitelist = authConfig.whitelist || [];
          const path = urlObj.pathname;

          const isWhitelisted = whitelist.some((whitelistPath) => {
            if (whitelistPath === path) return true;
            if (whitelistPath.endsWith('*')) {
              return path.startsWith(whitelistPath.slice(0, -1));
            }
            return false;
          });

          if (!isWhitelisted && !this._isLocalConnection(req.socket.remoteAddress)) {
            if (authConfig.apiKey?.enabled !== false && !this._checkApiAuthorization(req)) {
              BotUtil.makeLog('error', `WebSocket认证失败：${req.url}`, '服务器');
              return next(false, 401, 'Unauthorized');
            }
          }

          next(true);
        }
      }
    });

    // 注册 WebSocket 路由
    this.fastify.register(async (fastify) => {
      Object.keys(this.wsf).forEach((wsPath) => {
        fastify.get(`/${wsPath}`, { websocket: true }, (connection, req) => {
          BotUtil.makeLog('debug', `WebSocket连接建立：/${wsPath}`, '服务器');

          connection.socket.on('error', (err) =>
            BotUtil.makeLog('error', err, '服务器')
          );
          connection.socket.on('close', () =>
            BotUtil.makeLog('debug', `WebSocket断开：/${wsPath}`, '服务器')
          );

          connection.socket.on('message', (msg) => {
            const logMsg =
              Buffer.isBuffer(msg) && msg.length > 1024
                ? `[二进制消息，长度：${msg.length}]`
                : BotUtil.String(msg);
            BotUtil.makeLog('trace', `WS消息：${logMsg}`, '服务器');
          });

          connection.socket.sendMsg = (msg) => {
            if (!Buffer.isBuffer(msg)) msg = BotUtil.String(msg);
            BotUtil.makeLog('trace', `WS发送：${msg}`, '服务器');
            return connection.socket.send(msg);
          };

          for (const handler of this.wsf[wsPath]) {
            handler(connection.socket, req);
          }
        });
      });
    });
  }

  /**
   * 配置静态文件服务
   * @private
   * @returns {Promise<void>}
   */
  async _setupStaticServing() {
    const staticRoot = path.join(process.cwd(), 'www');

    if (!fsSync.existsSync(staticRoot)) {
      fsSync.mkdirSync(staticRoot, { recursive: true });
    }

    await this.fastify.register(import('@fastify/static'), {
      root: staticRoot,
      prefix: '/',
      constraints: {},
      decorateReply: true,
      dotfiles: 'deny',
      index: cfg.server?.static?.index || ['index.html', 'index.htm'],
      maxAge: cfg.server?.static?.cacheTime || '1d',
      etag: true,
      lastModified: true,
      serveDotFiles: false,
      wildcard: false,
      setHeaders: (res, path) => this._setStaticHeaders(res, path)
    });

    // 注册特殊文件路由
    this.fastify.get('/favicon.ico', async (request, reply) => {
      return this._handleFavicon(request, reply);
    });

    this.fastify.get('/robots.txt', async (request, reply) => {
      return this._handleRobotsTxt(request, reply);
    });
  }

  /**
   * 设置 Fastify 钩子
   * @private
   */
  _setupHooks() {
    // 请求日志
    if (cfg.server?.logging?.requests !== false) {
      this.fastify.addHook('onRequest', async (request, reply) => {
        request.startTime = Date.now();
      });

      this.fastify.addHook('onResponse', async (request, reply) => {
        const duration = Date.now() - request.startTime;
        const quietPaths = cfg.server?.logging?.quiet || [];

        if (!quietPaths.some((p) => request.url.startsWith(p))) {
          const statusColor =
            reply.statusCode < 400 ? 'green' : reply.statusCode < 500 ? 'yellow' : 'red';
          const method = chalk.cyan(request.method.padEnd(6));
          const status = chalk[statusColor](reply.statusCode);
          const time = chalk.gray(`${duration}ms`.padStart(7));
          const urlPath = chalk.white(request.url);
          const host = request.hostname ? chalk.gray(` [${request.hostname}]`) : '';

          BotUtil.makeLog('debug', `${method} ${status} ${time} ${urlPath}${host}`, 'HTTP');
        }
      });
    }

    // 认证钩子
    this.fastify.addHook('onRequest', async (request, reply) => {
      request.rid = `${request.ip}:${request.socket.remotePort}`;
      request.sid = `${request.protocol}://${request.hostname}:${request.socket.localPort}${request.url}`;

      const authConfig = cfg.server?.auth || {};
      const whitelist = authConfig.whitelist || [
        '/',
        '/favicon.ico',
        '/health',
        '/status',
        '/robots.txt'
      ];

      // 白名单检查
      const isWhitelisted = whitelist.some((whitelistPath) => {
        if (whitelistPath === request.url) return true;
        if (whitelistPath.endsWith('*')) {
          return request.url.startsWith(whitelistPath.slice(0, -1));
        }
        if (whitelistPath.startsWith('/api/') && request.url === whitelistPath) return true;
        if (!whitelistPath.endsWith('/') && request.url === whitelistPath + '/') return true;
        return false;
      });

      // 静态文件检查
      const isStaticFile =
        /\.(html|css|js|json|png|jpg|jpeg|gif|svg|webp|ico|mp4|webm|mp3|wav|pdf|zip|woff|woff2|ttf|otf)$/i.test(
          request.url
        );

      if (isWhitelisted || isStaticFile) {
        return;
      }

      // 本地连接跳过认证
      if (this._isLocalConnection(request.ip)) {
        return;
      }

      // API 密钥认证
      if (authConfig.apiKey?.enabled === false) {
        return;
      }

      if (!this._checkApiAuthorization(request)) {
        reply.code(401).send({
          success: false,
          message: 'Unauthorized',
          error: '未授权',
          detail: '无效或缺失的API密钥',
          hint: '请提供 X-API-Key 头或 api_key 参数'
        });

        BotUtil.makeLog(
          'warn',
          `认证失败：${request.method} ${request.url} 来自 ${request.ip}`,
          '认证'
        );
      }
    });

    // 错误处理
    this.fastify.setErrorHandler(async (error, request, reply) => {
      BotUtil.makeLog('error', `请求错误：${error.message}`, '服务器');

      reply.code(error.statusCode || 500).send({
        error: '内部服务器错误',
        message:
          process.env.NODE_ENV === 'production' ? '发生了一个错误' : error.message,
        timestamp: Date.now()
      });
    });

    // 404 处理
    this.fastify.setNotFoundHandler(async (request, reply) => {
      const defaultRoute = cfg.server?.misc?.defaultRoute || '/';

      if (request.accepts().type(['html'])) {
        const staticRoot = path.join(process.cwd(), 'www');
        const custom404Path = path.join(staticRoot, '404.html');

        if (fsSync.existsSync(custom404Path)) {
          return reply.code(404).sendFile('404.html');
        } else {
          return reply.redirect(defaultRoute);
        }
      } else {
        reply.code(404).send({
          error: '未找到',
          path: request.url,
          timestamp: Date.now()
        });
      }
    });
  }

  /**
   * 注册基础路由
   * @private
   */
  _registerBaseRoutes() {
    // 状态路由
    this.fastify.get('/status', async (request, reply) => {
      return this._statusHandler(request, reply);
    });

    // 健康检查路由
    this.fastify.get('/health', async (request, reply) => {
      return this._healthHandler(request, reply);
    });

    // 文件处理路由
    this.fastify.get('/File/*', async (request, reply) => {
      return this._fileHandler(request, reply);
    });
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
    } else if (
      ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'].includes(ext)
    ) {
      res.setHeader('Cache-Control', `public, max-age=${cacheConfig.images || 604800}`);
    }
  }

  /**
   * 处理 favicon 请求
   * @private
   * @param {Object} request - 请求对象
   * @param {Object} reply - 响应对象
   * @returns {Promise<void>}
   */
  async _handleFavicon(request, reply) {
    const staticRoot = path.join(process.cwd(), 'www');
    const faviconPath = path.join(staticRoot, 'favicon.ico');

    if (fsSync.existsSync(faviconPath)) {
      reply.header('Content-Type', 'image/x-icon');
      reply.header('Cache-Control', 'public, max-age=604800');
      return reply.sendFile('favicon.ico');
    }

    return reply.code(204).send();
  }

  /**
   * 处理 robots.txt 请求
   * @private
   * @param {Object} request - 请求对象
   * @param {Object} reply - 响应对象
   * @returns {Promise<string>}
   */
  async _handleRobotsTxt(request, reply) {
    const staticRoot = path.join(process.cwd(), 'www');
    const robotsPath = path.join(staticRoot, 'robots.txt');

    if (fsSync.existsSync(robotsPath)) {
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.sendFile('robots.txt');
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
    return defaultRobots;
  }

  /**
   * 信号处理器设置
   * @private
   */
  _setupSignalHandlers() {
    const closeHandler = async () => await this.closeServer();
    process.on('SIGINT', closeHandler);
    process.on('SIGTERM', closeHandler);
  }

  /**
   * 创建 Bot 代理对象
   * @private
   * @returns {Proxy} 代理对象
   */
  _createProxy() {
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

  /**
   * 生成 API 密钥
   * @returns {Promise<string>} API 密钥
   */
  async generateApiKey() {
    const apiKeyConfig = cfg.server?.auth?.apiKey || {};

    if (apiKeyConfig.enabled === false) {
      BotUtil.makeLog('info', '⚠ API密钥认证已禁用', '服务器');
      return null;
    }

    const apiKeyPath = path.join(
      process.cwd(),
      apiKeyConfig.file || 'config/server_config/api_key.json'
    );

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
      await fs.writeFile(
        apiKeyPath,
        JSON.stringify(
          {
            key: this.apiKey,
            generated: new Date().toISOString(),
            note: '远程访问API密钥'
          },
          null,
          2
        ),
        'utf8'
      );

      if (process.platform !== 'win32') {
        try {
          await fs.chmod(apiKeyPath, 0o600);
        } catch {}
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

  /**
   * 检查 API 授权
   * @param {Object} request - 请求对象
   * @returns {boolean} 是否通过授权
   */
  _checkApiAuthorization(request) {
    if (!request) return false;

    if (!this.apiKey) {
      return true;
    }

    const authKey =
      request.headers?.['x-api-key'] ||
      request.headers?.['authorization']?.replace('Bearer ', '') ||
      request.query?.api_key ||
      request.body?.api_key;

    if (!authKey) {
      return false;
    }

    try {
      const authKeyBuffer = Buffer.from(String(authKey));
      const apiKeyBuffer = Buffer.from(String(this.apiKey));

      if (authKeyBuffer.length !== apiKeyBuffer.length) {
        BotUtil.makeLog(
          'warn',
          `未授权访问来自 ${request.socket?.remoteAddress || request.ip}`,
          '认证'
        );
        return false;
      }

      return crypto.timingSafeEqual(authKeyBuffer, apiKeyBuffer);
    } catch (error) {
      BotUtil.makeLog('error', `API认证错误：${error.message}`, '认证');
      return false;
    }
  }

  /**
   * 公开的授权检查方法
   * @param {Object} request - 请求对象
   * @returns {boolean} 是否通过授权
   */
  checkApiAuthorization(request) {
    return this._checkApiAuthorization(request);
  }

  /**
   * 检查是否为本地连接
   * @private
   * @param {string} address - IP 地址
   * @returns {boolean} 是否为本地连接
   */
  _isLocalConnection(address) {
    if (!address || typeof address !== 'string') return false;

    const ip = address
      .toLowerCase()
      .trim()
      .replace(/^::ffff:/, '')
      .replace(/%.+$/, '');

    return (
      ip === 'localhost' ||
      ip === '127.0.0.1' ||
      ip === '::1' ||
      this._isPrivateIP(ip)
    );
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
      ipv4: [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^127\./],
      ipv6: [/^fe80:/i, /^fc00:/i, /^fd00:/i]
    };

    const isIPv4 = ip.includes('.');
    const testPatterns = isIPv4 ? patterns.ipv4 : patterns.ipv6;

    return testPatterns.some((pattern) => pattern.test(ip));
  }

  /**
   * 状态处理器
   * @private
   * @param {Object} request - 请求对象
   * @param {Object} reply - 响应对象
   * @returns {Object} 状态信息
   */
  _statusHandler(request, reply) {
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

    reply.header('Content-Type', 'application/json; charset=utf-8');
    return status;
  }

  /**
   * 健康检查处理器
   * @private
   * @param {Object} request - 请求对象
   * @param {Object} reply - 响应对象
   * @returns {Object} 健康状态
   */
  _healthHandler(request, reply) {
    return {
      status: '健康',
      uptime: process.uptime(),
      timestamp: Date.now()
    };
  }

  /**
   * 文件处理器
   * @private
   * @param {Object} request - 请求对象
   * @param {Object} reply - 响应对象
   * @returns {*} 文件内容或错误
   */
  _fileHandler(request, reply) {
    const url = request.url.replace(/^\/File\//, '');
    let file = this.fs[url];

    if (!file) {
      file = this.fs[404];
      if (!file) {
        return reply.code(404).send({ error: '未找到', file: url });
      }
    }

    if (typeof file.times === 'number') {
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
      reply.header('Content-Type', file.type.mime);
    }
    reply.header('Content-Length', file.buffer.length);
    reply.header('Cache-Control', 'no-cache');

    BotUtil.makeLog(
      'debug',
      `文件发送：${file.name} (${BotUtil.formatFileSize(file.buffer.length)})`,
      '服务器'
    );

    return reply.send(file.buffer);
  }

  /**
   * 获取服务器 URL
   * @returns {string} 服务器 URL
   */
  getServerUrl() {
    if (this.proxyEnabled && cfg.server?.proxy?.domains?.[0]) {
      const domain = cfg.server.proxy.domains[0];
      const protocol = domain.ssl?.enabled ? 'https' : 'http';
      return `${protocol}://${domain.domain}`;
    }

    const protocol = cfg.server?.https?.enabled ? 'https' : 'http';
    const port = protocol === 'https' ? this.actualHttpsPort : this.actualPort;
    const host = cfg.server?.server?.url || 'localhost';

    const needPort =
      (protocol === 'http' && port !== 80) || (protocol === 'https' && port !== 443);

    return `${protocol}://${host}${needPort ? ':' + port : ''}`;
  }

  /**
   * 获取本地 IP 地址
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
        const existingItem = result.local.find((item) => item.ip === result.primary);
        if (existingItem) {
          existingItem.primary = true;
        }
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

  /**
   * 检查是否为虚拟网卡
   * @private
   * @param {string} name - 网卡名称
   * @param {string} mac - MAC 地址
   * @returns {boolean} 是否为虚拟网卡
   */
  _isVirtualInterface(name, mac) {
    const virtualPatterns = [
      /^(docker|br-|veth|virbr|vnet)/i,
      /^(vmnet|vmware)/i,
      /^(vboxnet|virtualbox)/i
    ];

    return virtualPatterns.some((p) => p.test(name));
  }

  /**
   * 通过 UDP 获取 IP
   * @private
   * @returns {Promise<string>} IP 地址
   */
  async _getIpByUdp() {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('UDP超时'));
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
   * @private
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

  /**
   * 验证 IP 地址格式
   * @private
   * @param {string} ip - IP 地址
   * @returns {boolean} 是否有效
   */
  _isValidIP(ip) {
    if (!ip) return false;

    const ipv4Regex =
      /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
    return ipv4Regex.test(ip);
  }

  /**
   * 显示访问地址
   * @private
   * @param {string} protocol - 协议
   * @param {number} port - 端口
   * @returns {Promise<void>}
   */
  async _displayAccessUrls(protocol, port) {
    const ipInfo = await this.getLocalIpAddress();

    console.log(chalk.cyan('\n▶ 访问地址：'));

    if (ipInfo.local.length > 0) {
      console.log(chalk.yellow('  本地网络：'));
      ipInfo.local.forEach((info) => {
        const url = `${protocol}://${info.ip}:${port}`;
        const label = info.primary ? chalk.green(' ★') : '';
        const interfaceInfo = chalk.gray(` [${info.interface}]`);
        console.log(
          `    ${chalk.cyan('•')} ${chalk.white(url)}${interfaceInfo}${label}`
        );
      });
    }

    if (ipInfo.public && cfg.server?.misc?.detectPublicIP !== false) {
      console.log(chalk.yellow('\n  公网访问：'));
      const publicUrl = `${protocol}://${ipInfo.public}:${port}`;
      console.log(`    ${chalk.cyan('•')} ${chalk.white(publicUrl)}`);
    }

    if (cfg.server?.server?.url) {
      console.log(chalk.yellow('\n  配置域名：'));
      const configUrl = cfg.server.server.url.startsWith('http')
        ? cfg.server.server.url
        : `${protocol}://${cfg.server.server.url}`;
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
      authConfig.whitelist.forEach((path) => {
        console.log(`    ${chalk.cyan('•')} ${chalk.white(path)}`);
      });
    }
  }

  /**
   * 关闭服务器
   * @returns {Promise<void>}
   */
  async closeServer() {
    BotUtil.makeLog('info', '⏳ 正在关闭服务器...', '服务器');

    if (this.fastify) {
      await this.fastify.close();
    }

    await BotUtil.sleep(2000);
    await this.redisExit();

    BotUtil.makeLog('info', '✓ 服务器已关闭', '服务器');
  }

  /**
   * 主运行函数
   * @param {Object} [options={}] - 选项
   * @returns {Promise<void>}
   */
  async run(options = {}) {
    const { port } = options;

    this.actualPort = port || 2537;
    this.actualHttpsPort = this.actualPort + 1;
    this.httpPort = this.actualPort;
    this.httpsPort = this.actualHttpsPort;

    console.log(chalk.cyan('╔════════════════════════════════════════════════════════════╗'));
    console.log(
      chalk.cyan('║') +
        chalk.yellow.bold('               葵崽正在初始化Fastify服务器...               ') +
        chalk.cyan('║')
    );
    console.log(chalk.cyan('╚════════════════════════════════════════════════════════════╝'));

    BotUtil.makeLog('info', `端口：${this.httpPort} (HTTP)`, '服务器');

    await Packageloader();
    await this.generateApiKey();

    // 初始化 Fastify
    await this._initFastify();

    // 加载工作流
    await StreamLoader.load();
    await PluginsLoader.load();
    await ApiLoader.load();

    // 注册 API
    await ApiLoader.register(this.fastify, this);

    // 启动服务器
    try {
      const host = cfg.server?.server?.host || '0.0.0.0';
      await this.fastify.listen({ port: this.httpPort, host });

      BotUtil.makeLog('info', `✓ HTTP服务器监听在 ${host}:${this.httpPort}`, '服务器');

      await this._displayAccessUrls('http', this.httpPort);
    } catch (err) {
      BotUtil.makeLog('error', `服务器启动失败：${err.message}`, '服务器');
      throw err;
    }

    await ListenerLoader.load();
    await ApiLoader.watch(true);

    if (Object.keys(this.wsf).length > 0) {
      BotUtil.makeLog(
        'info',
        `⚡ WebSocket服务：${this.getServerUrl().replace(/^http/, 'ws')}/ [${Object.keys(this.wsf).join(', ')}]`,
        '服务器'
      );
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

  /**
   * 准备事件数据
   * @param {Object} data - 事件数据
   */
  prepareEvent(data) {
    if (!this.bots[data.self_id]) return;

    if (!data.bot) {
      Object.defineProperty(data, 'bot', {
        value: this.bots[data.self_id]
      });
    }

    if (data.user_id) {
      if (!data.friend) {
        Object.defineProperty(data, 'friend', {
          value: data.bot.pickFriend(data.user_id)
        });
      }
      data.sender ||= { user_id: data.user_id };
      data.sender.nickname ||= data.friend?.nickname;
    }

    if (data.group_id) {
      if (!data.group) {
        Object.defineProperty(data, 'group', {
          value: data.bot.pickGroup(data.group_id)
        });
      }
      data.group_name ||= data.group?.name;
    }

    if (data.group && data.user_id) {
      if (!data.member) {
        Object.defineProperty(data, 'member', {
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

  /**
   * 扩展事件方法
   * @private
   * @param {Object} data - 事件数据
   */
  _extendEventMethods(data) {
    for (const target of [data.friend, data.group, data.member]) {
      if (!target || typeof target !== 'object') continue;

      target.sendFile ??= (file, name) => target.sendMsg(segment.file(file, name));
      target.makeForwardMsg ??= this.makeForwardMsg;
      target.sendForwardMsg ??= (msg) =>
        this.sendForwardMsg((msg) => target.sendMsg(msg), msg);
      target.getInfo ??= () => target.info || target;
    }

    if (!data.reply) {
      data.reply =
        data.group?.sendMsg?.bind(data.group) || data.friend?.sendMsg?.bind(data.friend);
    }
  }

  /**
   * 触发事件
   * @param {string} [name=''] - 事件名称
   * @param {Object} [data={}] - 事件数据
   */
  em(name = '', data = {}) {
    this.prepareEvent(data);

    while (name) {
      this.emit(name, data);
      const lastDot = name.lastIndexOf('.');
      if (lastDot === -1) break;
      name = name.slice(0, lastDot);
    }
  }

  /**
   * 获取好友数组
   * @returns {Array} 好友数组
   */
  getFriendArray() {
    const array = [];
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].fl || []) array.push({ ...i, bot_id });
    return array;
  }

  /**
   * 获取好友列表
   * @returns {Array} 好友 ID 列表
   */
  getFriendList() {
    const array = [];
    for (const bot_id of this.uin)
      array.push(...(this.bots[bot_id].fl?.keys() || []));
    return array;
  }

  /**
   * 获取好友映射
   * @returns {Map} 好友映射
   */
  getFriendMap() {
    const map = new Map();
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].fl || []) map.set(id, { ...i, bot_id });
    return map;
  }

  get fl() {
    return this.getFriendMap();
  }

  /**
   * 获取群组数组
   * @returns {Array} 群组数组
   */
  getGroupArray() {
    const array = [];
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].gl || []) array.push({ ...i, bot_id });
    return array;
  }

  /**
   * 获取群组列表
   * @returns {Array} 群组 ID 列表
   */
  getGroupList() {
    const array = [];
    for (const bot_id of this.uin) array.push(...(this.bots[bot_id].gl?.keys() || []));
    return array;
  }

  /**
   * 获取群组映射
   * @returns {Map} 群组映射
   */
  getGroupMap() {
    const map = new Map();
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].gl || []) map.set(id, { ...i, bot_id });
    return map;
  }

  get gl() {
    return this.getGroupMap();
  }

  get gml() {
    const map = new Map();
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].gml || [])
        map.set(id, Object.assign(new Map(i), { bot_id }));
    return map;
  }

  /**
   * 选择好友
   * @param {number|string} user_id - 用户 ID
   * @param {boolean} [strict] - 严格模式
   * @returns {Object|boolean} 好友对象或 false
   */
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

    BotUtil.makeLog(
      'trace',
      `用户 ${user_id} 不存在，使用随机Bot ${this.uin.toJSON()}`,
      '服务器'
    );
    return this.bots[this.uin].pickFriend(user_id);
  }

  get pickUser() {
    return this.pickFriend;
  }

  /**
   * 选择群组
   * @param {number|string} group_id - 群组 ID
   * @param {boolean} [strict] - 严格模式
   * @returns {Object|boolean} 群组对象或 false
   */
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

    BotUtil.makeLog(
      'trace',
      `群组 ${group_id} 不存在，使用随机Bot ${this.uin.toJSON()}`,
      '服务器'
    );
    return this.bots[this.uin].pickGroup(group_id);
  }

  /**
   * 选择群成员
   * @param {number|string} group_id - 群组 ID
   * @param {number|string} user_id - 用户 ID
   * @returns {Object} 群成员对象
   */
  pickMember(group_id, user_id) {
    return this.pickGroup(group_id).pickMember(user_id);
  }

  /**
   * 发送好友消息
   * @param {number|string} bot_id - Bot ID
   * @param {number|string} user_id - 用户 ID
   * @param {...*} args - 消息参数
   * @returns {Promise<*>} 发送结果
   */
  async sendFriendMsg(bot_id, user_id, ...args) {
    if (!bot_id) {
      return this.pickFriend(user_id).sendMsg(...args);
    }

    if (this.uin.includes(bot_id) && this.bots[bot_id]) {
      return this.bots[bot_id].pickFriend(user_id).sendMsg(...args);
    }

    return new Promise((resolve, reject) => {
      const listener = (data) => {
        resolve(data.bot.pickFriend(user_id).sendMsg(...args));
        clearTimeout(timeout);
      };

      const timeout = setTimeout(() => {
        reject(Object.assign(Error('等待Bot上线超时'), { bot_id, user_id, args }));
        this.off(`connect.${bot_id}`, listener);
      }, 300000);

      this.once(`connect.${bot_id}`, listener);
    });
  }

  /**
   * 发送群消息
   * @param {number|string} bot_id - Bot ID
   * @param {number|string} group_id - 群组 ID
   * @param {...*} args - 消息参数
   * @returns {Promise<*>} 发送结果
   */
  async sendGroupMsg(bot_id, group_id, ...args) {
    if (!bot_id) {
      return this.pickGroup(group_id).sendMsg(...args);
    }

    if (this.uin.includes(bot_id) && this.bots[bot_id]) {
      return this.bots[bot_id].pickGroup(group_id).sendMsg(...args);
    }

    return new Promise((resolve, reject) => {
      const listener = (data) => {
        resolve(data.bot.pickGroup(group_id).sendMsg(...args));
        clearTimeout(timeout);
      };

      const timeout = setTimeout(() => {
        reject(Object.assign(Error('等待Bot上线超时'), { bot_id, group_id, args }));
        this.off(`connect.${bot_id}`, listener);
      }, 300000);

      this.once(`connect.${bot_id}`, listener);
    });
  }

  /**
   * 发送主人消息
   * @param {*} msg - 消息内容
   * @param {number} [sleep=5000] - 发送间隔
   * @returns {Promise<Object>} 发送结果
   */
  async sendMasterMsg(msg, sleep = 5000) {
    const masterQQs = cfg.masterQQ;
    if (!masterQQs?.length) {
      throw new Error('未配置主人QQ');
    }

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

        if (sleep && i < masterQQs.length - 1) {
          await BotUtil.sleep(sleep);
        }
      } catch (err) {
        results[user_id] = { error: err.message };
        BotUtil.makeLog(
          'error',
          `向主人 ${user_id} 发送消息失败：${err.message}`,
          '服务器'
        );
      }
    }

    return results;
  }

  /**
   * 创建转发消息
   * @param {*} msg - 消息内容
   * @returns {Object} 转发消息对象
   */
  makeForwardMsg(msg) {
    return { type: 'node', data: msg };
  }

  /**
   * 发送转发消息
   * @param {Function} send - 发送函数
   * @param {*} msg - 消息内容
   * @returns {Promise<Array>} 发送结果
   */
  async sendForwardMsg(send, msg) {
    const messages = Array.isArray(msg) ? msg : [msg];
    return Promise.all(messages.map(({ message }) => send(message)));
  }

  /**
   * Redis 退出
   * @returns {Promise<boolean>} 是否成功
   */
  async redisExit() {
    if (!(typeof redis === 'object' && redis.process)) return false;

    const process = redis.process;
    delete redis.process;

    await BotUtil.sleep(5000, redis.save().catch(() => {}));
    return process.kill();
  }

  /**
   * 文件转 URL
   * @param {*} file - 文件
   * @param {Object} [opts={}] - 选项
   * @returns {Promise<string>} URL
   */
  async fileToUrl(file, opts = {}) {
    return await BotUtil.fileToUrl(file, opts);
  }
}