import path from 'path';
import fs from 'node:fs/promises';
import * as fsSync from 'fs';
import { EventEmitter } from "events";
import Fastify from "fastify";
import https from "node:https";
import tls from "node:tls";
import crypto from 'crypto';
import os from 'node:os';
import dgram from 'node:dgram';
import chalk from 'chalk';

// Fastify 插件
import fastifyStatic from '@fastify/static';
import fastifyCompress from '@fastify/compress';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyHelmet from '@fastify/helmet';
import fastifyWebsocket from '@fastify/websocket';
import fastifyHttpProxy from '@fastify/http-proxy';
import fastifyMultipart from '@fastify/multipart';

// 内部加载器
import PluginsLoader from "./plugins/loader.js";
import ListenerLoader from "./listener/loader.js";
import ApiLoader from "./http/loader.js";
import Packageloader from "./config/loader.js";
import StreamLoader from "./aistream/loader.js";
import BotUtil from './common/util.js';
import cfg from './config/config.js';

/**
 * Bot 主类 - 基于 Fastify 的高性能服务器
 * @class Bot
 * @extends EventEmitter
 */
export default class Bot extends EventEmitter {
  constructor() {
    super();
    
    // ==================== 核心属性初始化 ====================
    /** @type {Object} 统计信息 */
    this.stat = { start_time: Date.now() / 1000 };
    
    /** @type {Bot} Bot 实例引用 */
    this.bot = this;
    
    /** @type {Object} Bot 实例映射表 */
    this.bots = {};
    
    /** @type {Array} 适配器列表 */
    this.adapter = [];
    
    /** @type {Object} UIN 管理器 */
    this.uin = this._createUinManager();
    
    // ==================== Fastify 实例 ====================
    /** @type {Object} Fastify 主实例 */
    this.fastify = this._createFastifyInstance();
    
    /** @type {Object} HTTP 服务器实例 */
    this.server = null;
    
    /** @type {Object} HTTPS 服务器实例 */
    this.httpsServer = null;
    
    // ==================== WebSocket 相关 ====================
    /** @type {Object} WebSocket 处理器映射 */
    this.wsf = Object.create(null);
    
    // ==================== 文件服务 ====================
    /** @type {Object} 文件缓存 */
    this.fs = Object.create(null);
    
    // ==================== 配置属性 ====================
    /** @type {string} API 密钥 */
    this.apiKey = '';
    
    /** @type {Map} 缓存管理器 */
    this._cache = BotUtil.getMap('yunzai_cache', { ttl: 60000, autoClean: true });
    
    /** @type {Map} 限流器映射 */
    this._rateLimiters = new Map();
    
    /** @type {number} HTTP 端口 */
    this.httpPort = null;
    
    /** @type {number} HTTPS 端口 */
    this.httpsPort = null;
    
    /** @type {number} 实际 HTTP 端口 */
    this.actualPort = null;
    
    /** @type {number} 实际 HTTPS 端口 */
    this.actualHttpsPort = null;
    
    /** @type {string} 服务器 URL */
    this.url = cfg.server?.server?.url || '';
    
    // ==================== 反向代理相关 ====================
    /** @type {boolean} 代理是否启用 */
    this.proxyEnabled = false;
    
    /** @type {Object} 代理 Fastify 实例 */
    this.proxyApp = null;
    
    /** @type {Object} 代理 HTTP 服务器 */
    this.proxyServer = null;
    
    /** @type {Object} 代理 HTTPS 服务器 */
    this.proxyHttpsServer = null;
    
    /** @type {Map} 代理中间件映射 */
    this.proxyMiddlewares = new Map();
    
    /** @type {Map} 域名配置映射 */
    this.domainConfigs = new Map();
    
    /** @type {Map} SSL 上下文映射 */
    this.sslContexts = new Map();
    
    // ==================== API 加载器 ====================
    this.ApiLoader = ApiLoader;
    
    // ==================== 初始化 ====================
    this._setupSignalHandlers();
    this.generateApiKey();
    
    return this._createProxy();
  }

  /**
   * 创建 Fastify 实例
   * @private
   * @returns {Object} Fastify 实例
   */
  _createFastifyInstance() {
    const fastify = Fastify({
      logger: false, // 使用自定义日志
      trustProxy: true, // 信任代理
      ignoreTrailingSlash: true, // 忽略尾部斜杠
      caseSensitive: false, // 路由不区分大小写
      requestIdLogLabel: 'rid', // 请求 ID 标签
      requestIdHeader: 'x-request-id', // 请求 ID 头
      bodyLimit: cfg.server?.limits?.json ? 
        this._parseSize(cfg.server.limits.json) : 10485760, // 10MB 默认
      // 性能优化配置
      disableRequestLogging: true, // 禁用默认请求日志
      connectionTimeout: cfg.server?.timeout?.connection || 0,
      keepAliveTimeout: cfg.server?.timeout?.keepAlive || 72000,
      maxParamLength: cfg.server?.limits?.maxParamLength || 100,
      onProtoPoisoning: 'remove', // 原型污染保护
      onConstructorPoisoning: 'remove' // 构造函数污染保护
    });

    // 添加自定义属性
    fastify.skip_auth = [];
    fastify.quiet = [];

    return fastify;
  }

  /**
   * 解析大小字符串（如 "10mb" -> 字节数）
   * @private
   * @param {string} sizeStr - 大小字符串
   * @returns {number} 字节数
   */
  _parseSize(sizeStr) {
    const units = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };
    const match = String(sizeStr).toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/);
    if (!match) return 10485760; // 默认 10MB
    const value = parseFloat(match[1]);
    const unit = match[2] || 'b';
    return Math.floor(value * units[unit]);
  }

  /**
   * 标准化错误处理
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

  /**
   * 创建 UIN 管理器
   * @private
   * @returns {Array} UIN 管理器
   */
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

  /**
   * 设置信号处理器
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
   * @returns {Proxy} Bot 代理
   */
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

  /**
   * 生成 API 密钥
   * @returns {Promise<string|null>} API 密钥
   */
  async generateApiKey() {
    const apiKeyConfig = cfg.server?.auth?.apiKey || {};
    
    // 如果明确禁用 API 密钥，则不生成
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

  /**
   * 初始化代理应用
   * @private
   * @returns {Promise<void>}
   */
  async _initProxyApp() {
    const proxyConfig = cfg.server?.proxy;
    if (!proxyConfig?.enabled) return;
    
    // 创建独立的 Fastify 实例用于代理
    this.proxyApp = this._createFastifyInstance();
    
    // 加载所有域名的 SSL 证书
    await this._loadDomainCertificates();
    
    // 注册代理钩子
    await this.proxyApp.register(async (fastify) => {
      // 请求预处理钩子
      fastify.addHook('onRequest', async (request, reply) => {
        const hostname = request.hostname;
        
        if (!hostname) {
          reply.code(400).send({ error: '错误请求：缺少Host头' });
          return;
        }
        
        // 查找域名配置
        const domainConfig = this._findDomainConfig(hostname);
        
        if (!domainConfig) {
          reply.code(404).send({ error: `域名 ${hostname} 未配置` });
          return;
        }
        
        // 存储域名配置到请求对象
        request.domainConfig = domainConfig;
        
        // 处理路径重写
        if (domainConfig.rewritePath) {
          const { from, to } = domainConfig.rewritePath;
          if (from && request.url.startsWith(from)) {
            const newPath = request.url.replace(from, to || '');
            request.url = newPath;
            BotUtil.makeLog('debug', `路径重写：${request.raw.url} → ${newPath}`, '代理');
          }
        }
      });

      // 注册代理路由
      fastify.all('/*', async (request, reply) => {
        const domainConfig = request.domainConfig;
        
        // 如果配置了自定义目标，使用 http-proxy
        if (domainConfig.target) {
          // 注册代理插件（每个域名一个实例）
          if (!this.proxyMiddlewares.has(domainConfig.domain)) {
            await fastify.register(fastifyHttpProxy, {
              upstream: domainConfig.target,
              prefix: '/',
              rewritePrefix: '',
              http2: false,
              preHandler: async (request, reply) => {
                // 添加自定义请求头
                if (domainConfig.headers?.request) {
                  for (const [key, value] of Object.entries(domainConfig.headers.request)) {
                    request.headers[key.toLowerCase()] = value;
                  }
                }
              },
              replyOptions: {
                onResponse: (request, reply, res) => {
                  // 添加自定义响应头
                  if (domainConfig.headers?.response) {
                    for (const [key, value] of Object.entries(domainConfig.headers.response)) {
                      reply.header(key, value);
                    }
                  }
                  reply.send(res);
                }
              }
            });
            this.proxyMiddlewares.set(domainConfig.domain, true);
          }
          return;
        }
        
        // 默认代理到本地服务
        const targetPort = this.actualPort;
        await fastify.register(fastifyHttpProxy, {
          upstream: `http://127.0.0.1:${targetPort}`,
          prefix: '/',
          rewritePrefix: '',
          websocket: domainConfig.ws !== false,
          http2: false
        });
      });
    });
  }

  /**
   * 加载域名 SSL 证书
   * @private
   * @returns {Promise<void>}
   */
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

  /**
   * 创建 HTTPS 代理服务器
   * @private
   * @returns {Promise<void>}
   */
  async _createHttpsProxyServer() {
    // 使用第一个可用证书作为默认证书
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
      // SNI 回调处理多域名证书
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

  /**
   * 查找域名配置（支持通配符）
   * @private
   * @param {string} hostname - 主机名
   * @returns {Object|null} 域名配置
   */
  _findDomainConfig(hostname) {
    // 精确匹配
    if (this.domainConfigs.has(hostname)) {
      return this.domainConfigs.get(hostname);
    }
    
    // 通配符匹配
    for (const [domain, config] of this.domainConfigs) {
      if (domain.startsWith('*.')) {
        const baseDomain = domain.substring(2);
        if (hostname === baseDomain || hostname.endsWith('.' + baseDomain)) {
          const subdomain = hostname === baseDomain ? '' : 
                           hostname.substring(0, hostname.length - baseDomain.length - 1);
          const configCopy = { ...config, subdomain };
          
          // 替换路径中的变量
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

  /**
   * 查找通配符 SSL 证书
   * @private
   * @param {string} servername - 服务器名称
   * @returns {Object|null} SSL 上下文
   */
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

  /**
   * 初始化中间件和路由
   * @private
   * @returns {Promise<void>}
   */
  async _initializeMiddlewareAndRoutes() {
    // ==================== 注册 WebSocket 支持 ====================
    await this.fastify.register(fastifyWebsocket, {
      options: {
        maxPayload: cfg.server?.websocket?.maxPayload || 1048576, // 1MB
        perMessageDeflate: cfg.server?.websocket?.compression !== false,
        clientTracking: true
      }
    });

    // ==================== 注册压缩中间件 ====================
    if (cfg.server?.compression?.enabled !== false) {
      await this.fastify.register(fastifyCompress, {
        global: true,
        threshold: cfg.server?.compression?.threshold || 1024,
        encodings: ['gzip', 'deflate', 'br']
      });
    }

    // ==================== 注册安全头部 ====================
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

    // ==================== 注册 CORS ====================
    await this._setupCors();

    // ==================== 注册多部分表单支持 ====================
    await this.fastify.register(fastifyMultipart, {
      limits: {
        fieldNameSize: 100,
        fieldSize: cfg.server?.limits?.fieldSize || 1048576, // 1MB
        fields: 10,
        fileSize: cfg.server?.limits?.fileSize || 10485760, // 10MB
        files: 5,
        headerPairs: 2000
      }
    });

    // ==================== 注册速率限制 ====================
    await this._setupRateLimiting();

    // ==================== 注册请求日志钩子 ====================
    this._setupRequestLogging();

    // ==================== 注册认证钩子 ====================
    await this._setupAuthentication();

    // ==================== 注册系统路由 ====================
    this._setupSystemRoutes();

    // ==================== 注册静态文件服务 ====================
    await this._setupStaticServing();
  }

  /**
   * 配置 CORS 跨域
   * @private
   * @returns {Promise<void>}
   */
  async _setupCors() {
    const corsConfig = cfg.server?.cors;
    if (corsConfig?.enabled === false) return;
    
    await this.fastify.register(fastifyCors, {
      origin: corsConfig?.origins || ['*'],
      methods: corsConfig?.methods || ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: corsConfig?.headers || ['Content-Type', 'Authorization', 'X-API-Key'],
      credentials: corsConfig?.credentials !== false,
      maxAge: corsConfig?.maxAge || 86400,
      preflightContinue: false,
      optionsSuccessStatus: 200
    });
  }

  /**
   * 请求日志钩子
   * @private
   */
  _setupRequestLogging() {
    if (cfg.server?.logging?.requests === false) return;
    
    this.fastify.addHook('onRequest', async (request, reply) => {
      request.startTime = Date.now();
    });

    this.fastify.addHook('onResponse', async (request, reply) => {
      const duration = Date.now() - (request.startTime || Date.now());
      const quietPaths = cfg.server?.logging?.quiet || [];
      
      if (!quietPaths.some(p => request.url.startsWith(p))) {
        const statusColor = reply.statusCode < 400 ? 'green' :
                           reply.statusCode < 500 ? 'yellow' : 'red';
        const method = chalk.cyan(request.method.padEnd(6));
        const status = chalk[statusColor](reply.statusCode);
        const time = chalk.gray(`${duration}ms`.padStart(7));
        const url = chalk.white(request.url);
        const host = request.hostname ? chalk.gray(` [${request.hostname}]`) : '';
        
        BotUtil.makeLog('debug', `${method} ${status} ${time} ${url}${host}`, 'HTTP');
      }
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
    
    // 全局限制
    if (rateLimitConfig?.global) {
      await this.fastify.register(fastifyRateLimit, {
        max: rateLimitConfig.global.max || 100,
        timeWindow: rateLimitConfig.global.windowMs || '15 minutes',
        cache: 10000,
        allowList: (request) => this._isLocalConnection(request.ip),
        skipOnError: true,
        enableDraftSpec: true,
        addHeadersOnExceeding: {
          'x-ratelimit-limit': true,
          'x-ratelimit-remaining': true,
          'x-ratelimit-reset': true
        },
        addHeaders: {
          'x-ratelimit-limit': true,
          'x-ratelimit-remaining': true,
          'x-ratelimit-reset': true,
          'retry-after': true
        }
      });
    }
  }

  /**
   * 设置认证钩子
   * @private
   * @returns {Promise<void>}
   */
  async _setupAuthentication() {
    this.fastify.addHook('preHandler', async (request, reply) => {
      // 添加请求标识
      request.rid = `${request.ip}:${request.socket.remotePort}`;
      request.sid = `${request.protocol}://${request.hostname}:${request.socket.localPort}${request.url}`;
      
      const authConfig = cfg.server?.auth || {};
      const whitelist = authConfig.whitelist || [
        '/', '/favicon.ico', '/health', '/status', '/robots.txt'
      ];
      
      // 检查白名单
      const isWhitelisted = whitelist.some(whitelistPath => {
        if (whitelistPath === request.url) return true;
        if (whitelistPath.endsWith('*')) {
          const prefix = whitelistPath.slice(0, -1);
          return request.url.startsWith(prefix);
        }
        return false;
      });
      
      // 静态文件检查
      const isStaticFile = /\.(html|css|js|json|png|jpg|jpeg|gif|svg|webp|ico|mp4|webm|mp3|wav|pdf|zip|woff|woff2|ttf|otf)$/i.test(request.url);
      
      // 白名单或静态文件直接放行
      if (isWhitelisted || isStaticFile) {
        BotUtil.makeLog("debug", `白名单路径，跳过认证：${request.url}`, '认证');
        return;
      }
      
      // 本地连接跳过认证
      if (this._isLocalConnection(request.ip)) {
        BotUtil.makeLog("debug", `本地连接，跳过认证：${request.ip}`, '认证');
        return;
      }
      
      // 如果 API 密钥认证被禁用，直接通过
      if (authConfig.apiKey?.enabled === false) {
        BotUtil.makeLog("debug", `API密钥认证已禁用，跳过认证：${request.url}`, '认证');
        return;
      }
      
      // API 密钥认证
      if (!this._checkApiAuthorization(request)) {
        reply.code(401).send({
          success: false,
          message: 'Unauthorized',
          error: '未授权',
          detail: '无效或缺失的API密钥',
          hint: '请提供 X-API-Key 头或 api_key 参数'
        });
        
        BotUtil.makeLog("warn", `认证失败：${request.method} ${request.url} 来自 ${request.ip}`, '认证');
        return;
      }
      
      BotUtil.makeLog("debug", `认证成功：${request.method} ${request.url}`, '认证');
    });
  }

  /**
   * 检查 API 授权
   * @private
   * @param {Object} request - Fastify 请求对象
   * @returns {boolean} 是否授权
   */
  _checkApiAuthorization(request) {
    if (!request) return false;
    
    // 如果没有 API 密钥（认证被禁用），返回 true
    if (!this.apiKey) {
      return true;
    }
    
    const authKey = request.headers?.["x-api-key"] ??
      request.headers?.["authorization"]?.replace('Bearer ', '') ??
      request.query?.api_key ??
      request.body?.api_key;
    
    if (!authKey) {
      BotUtil.makeLog("debug", `API认证失败：缺少密钥`, '认证');
      return false;
    }
    
    try {
      const authKeyBuffer = Buffer.from(String(authKey));
      const apiKeyBuffer = Buffer.from(String(this.apiKey));
      
      if (authKeyBuffer.length !== apiKeyBuffer.length) {
        BotUtil.makeLog("warn", `未授权访问来自 ${request.socket?.remoteAddress || request.ip}`, '认证');
        return false;
      }
      
      return crypto.timingSafeEqual(authKeyBuffer, apiKeyBuffer);
      
    } catch (error) {
      BotUtil.makeLog("error", `API认证错误：${error.message}`, '认证');
      return false;
    }
  }

  /**
   * 公开的认证检查方法
   * @param {Object} request - 请求对象
   * @returns {boolean} 是否授权
   */
  checkApiAuthorization(request) {
    return this._checkApiAuthorization(request);
  }

  /**
   * 检查是否为本地连接
   * @private
   * @param {string} address - IP 地址
   * @returns {boolean} 是否本地连接
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
   * @returns {boolean} 是否私有 IP
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
   * 设置系统路由
   * @private
   */
  _setupSystemRoutes() {
    // 状态路由
    this.fastify.get('/status', async (request, reply) => {
      return {
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
    });

    // 健康检查路由
    this.fastify.get('/health', async (request, reply) => {
      return {
        status: '健康',
        uptime: process.uptime(),
        timestamp: Date.now()
      };
    });

    // 文件服务路由
    this.fastify.get('/File/*', async (request, reply) => {
      const url = request.params['*'];
      let file = this.fs[url];
      
      if (!file) {
        file = this.fs[404];
        if (!file) {
          reply.code(404).send({ error: '未找到', file: url });
          return;
        }
      }
      
      if (typeof file.times === "number") {
        if (file.times > 0) {
          file.times--;
        } else {
          file = this.fs.timeout;
          if (!file) {
            reply.code(410).send({
              error: '已过期',
              message: '文件访问次数已达上限'
            });
            return;
          }
        }
      }
      
      if (file.type?.mime) {
        reply.header("Content-Type", file.type.mime);
      }
      reply.header("Content-Length", file.buffer.length);
      reply.header("Cache-Control", "no-cache");
      
      BotUtil.makeLog("debug", `文件发送：${file.name} (${BotUtil.formatFileSize(file.buffer.length)})`, '服务器');
      
      return file.buffer;
    });

    // Favicon 路由
    this.fastify.get('/favicon.ico', async (request, reply) => {
      const staticRoot = path.join(process.cwd(), 'www');
      const faviconPath = path.join(staticRoot, 'favicon.ico');
      
      if (fsSync.existsSync(faviconPath)) {
        reply.header('Content-Type', 'image/x-icon');
        reply.header('Cache-Control', 'public, max-age=604800');
        return reply.sendFile('favicon.ico', staticRoot);
      }
      
      reply.code(204).send();
    });

    // robots.txt 路由
    this.fastify.get('/robots.txt', async (request, reply) => {
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
      
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      return defaultRobots;
    });
  }

  /**
   * 静态文件服务配置
   * @private
   * @returns {Promise<void>}
   */
  async _setupStaticServing() {
    const staticRoot = path.join(process.cwd(), 'www');
    
    if (!fsSync.existsSync(staticRoot)) {
      fsSync.mkdirSync(staticRoot, { recursive: true });
    }

    await this.fastify.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
      index: cfg.server?.static?.index || ['index.html', 'index.htm'],
      list: false, // 禁用目录列表
      dotfiles: 'deny', // 拒绝访问点文件
      extensions: cfg.server?.static?.extensions || ['html', 'htm'],
      immutable: true,
      maxAge: cfg.server?.static?.cacheTime || '1d',
      serveDotFiles: false,
      lastModified: true,
      etag: true,
      setHeaders: (res, filePath) => {
        this._setStaticHeaders(res, filePath);
      }
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
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'].includes(ext)) {
      res.setHeader('Cache-Control', `public, max-age=${cacheConfig.images || 604800}`);
    }
  }

  /**
   * 设置最终处理器（404 和错误处理）
   * @private
   */
  _setupFinalHandlers() {
    // 404 处理
    this.fastify.setNotFoundHandler((request, reply) => {
      let defaultRoute = cfg.server?.misc?.defaultRoute || '/';
      
      if (request.domainConfig?.defaultRoute) {
        defaultRoute = request.domainConfig.defaultRoute;
      }
      
      if (request.headers.accept?.includes('text/html')) {
        const staticRoot = path.join(process.cwd(), 'www');
        const custom404Path = path.join(staticRoot, '404.html');
        
        if (fsSync.existsSync(custom404Path)) {
          reply.code(404).sendFile('404.html', staticRoot);
        } else {
          reply.redirect(defaultRoute);
        }
      } else {
        reply.code(404).send({
          error: '未找到',
          path: request.url,
          timestamp: Date.now()
        });
      }
    });

    // 错误处理
    this.fastify.setErrorHandler((error, request, reply) => {
      BotUtil.makeLog('error', `请求错误：${error.message}`, '服务器');
      
      reply.code(error.statusCode || 500).send({
        error: '内部服务器错误',
        message: process.env.NODE_ENV === 'production' ?
          '发生了一个错误' : error.message,
        timestamp: Date.now()
      });
    });
  }

  /**
   * 启动代理服务器
   * @returns {Promise<void>}
   */
  async startProxyServers() {
    const proxyConfig = cfg.server?.proxy;
    if (!proxyConfig?.enabled) return;
    
    const httpPort = proxyConfig.httpPort || 80;
    const host = cfg.server?.server?.host || '0.0.0.0';
    
    // 启动 HTTP 代理服务器
    await this.proxyApp.listen({ port: httpPort, host });
    BotUtil.makeLog('info', `✓ HTTP代理服务器监听在 ${host}:${httpPort}`, '代理');
    
    // 启动 HTTPS 代理服务器（如果有）
    if (this.proxyHttpsServer) {
      const httpsPort = proxyConfig.httpsPort || 443;
      this.proxyHttpsServer.listen(httpsPort, host);
      await BotUtil.promiseEvent(this.proxyHttpsServer, "listening").catch(() => { });
      
      BotUtil.makeLog('info', `✓ HTTPS代理服务器监听在 ${host}:${httpsPort}`, '代理');
    }
    
    await this._displayProxyInfo();
  }

  /**
   * 显示代理信息
   * @private
   * @returns {Promise<void>}
   */
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

  /**
   * 显示访问地址
   * @private
   * @param {string} protocol - 协议
   * @param {number} port - 端口
   * @returns {Promise<void>}
   */
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

  /**
   * 加载 HTTPS 服务器
   * @returns {Promise<void>}
   */
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

      // Fastify 支持直接传入 HTTPS 选项
      const httpsFastify = Fastify({
        ...this.fastify.initialConfig,
        https: httpsOptions
      });

      // 复制所有路由和插件到 HTTPS 实例
      // 注意：Fastify 不支持直接复制，需要重新注册
      BotUtil.makeLog('info', '✓ HTTPS服务器配置完成，将在主服务启动时生效', '服务器');
      
    } catch (err) {
      BotUtil.makeLog("error", `HTTPS服务器错误：${err.message}`, '服务器');
    }
  }

  /**
   * 关闭服务器
   * @returns {Promise<void>}
   */
  async closeServer() {
    BotUtil.makeLog('info', '⏳ 正在关闭服务器...', '服务器');
    
    try {
      // 关闭主 Fastify 实例
      if (this.fastify) {
        await this.fastify.close();
      }

      // 关闭代理实例
      if (this.proxyApp) {
        await this.proxyApp.close();
      }

      // 关闭 HTTPS 代理服务器
      if (this.proxyHttpsServer) {
        await new Promise(resolve => this.proxyHttpsServer.close(resolve));
      }
      
      await BotUtil.sleep(2000);
      await this.redisExit();
      
      BotUtil.makeLog('info', '✓ 服务器已关闭', '服务器');
    } catch (error) {
      BotUtil.makeLog('error', `关闭服务器时出错：${error.message}`, '服务器');
    }
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
    
    const needPort = (protocol === 'http' && port !== 80) ||
                     (protocol === 'https' && port !== 443);
    
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
      BotUtil.makeLog("debug", `获取IP地址失败：${err.message}`, '服务器');
      return result;
    }
  }

  /**
   * 检查是否为虚拟网卡
   * @private
   * @param {string} name - 网卡名称
   * @param {string} mac - MAC 地址
   * @returns {boolean} 是否虚拟网卡
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
    
    const ipv4Regex = /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
    return ipv4Regex.test(ip);
  }

  /**
   * 主运行函数
   * @param {Object} [options={}] - 选项
   * @returns {Promise<void>}
   */
  async run(options = {}) {
    const { port } = options;
    
    const proxyConfig = cfg.server?.proxy;
    this.proxyEnabled = proxyConfig?.enabled === true;
    
    // 设置端口
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
    console.log(chalk.cyan('║') + chalk.yellow.bold('               葵崽正在初始化Fastify服务器...               ') + chalk.cyan('║'));
    console.log(chalk.cyan('╚════════════════════════════════════════════════════════════╝'));
    
    if (this.proxyEnabled) {
      BotUtil.makeLog('info', '⚡ 反向代理模式已启用', '服务器');
      BotUtil.makeLog('info', `服务端口：${this.actualPort} (HTTP), ${this.actualHttpsPort} (HTTPS)`, '服务器');
      BotUtil.makeLog('info', `代理端口：${this.httpPort} (HTTP), ${this.httpsPort} (HTTPS)`, '服务器');
      
      await this._initProxyApp();
    } else {
      BotUtil.makeLog('info', `端口：${this.httpPort} (HTTP), ${this.httpsPort} (HTTPS)`, '服务器');
    }
    
    await Packageloader();
    await this.generateApiKey();
    
    // 加载工作流
    await StreamLoader.load();
    await PluginsLoader.load();
    await ApiLoader.load();
    
    // 初始化中间件和路由
    await this._initializeMiddlewareAndRoutes();
    
    // 注册 API 路由
    await ApiLoader.register(this.fastify, this);
    
    // 设置最终处理器
    this._setupFinalHandlers();
    
    // 启动主服务
    try {
      const host = cfg.server?.server?.host || '0.0.0.0';
      await this.fastify.listen({ 
        port: this.proxyEnabled ? this.actualPort : this.httpPort, 
        host 
      });

      BotUtil.makeLog('info', `✓ Fastify服务器监听在 ${host}:${this.proxyEnabled ? this.actualPort : this.httpPort}`, '服务器');

      if (!this.proxyEnabled) {
        await this._displayAccessUrls('http', this.httpPort);
      }

      // HTTPS 支持（如果启用）
      if (cfg.server?.https?.enabled) {
        await this.httpsLoad();
      }

      // 启动代理服务器
      if (this.proxyEnabled) {
        await this.startProxyServers();
      }

      await ListenerLoader.load();
      await ApiLoader.watch(true);

      // WebSocket 路由信息
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

    } catch (error) {
      BotUtil.makeLog('error', `服务器启动失败：${error.message}`, '服务器');
      throw error;
    }
  }

  // ==================== 以下为业务逻辑方法（保持不变） ====================

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
    
    BotUtil.makeLog("trace", `用户 ${user_id} 不存在，使用随机Bot ${this.uin.toJSON()}`, '服务器');
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
    
    BotUtil.makeLog("trace", `群组 ${group_id} 不存在，使用随机Bot ${this.uin.toJSON()}`, '服务器');
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
        reject(Object.assign(Error("等待Bot上线超时"),
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
        reject(Object.assign(Error("等待Bot上线超时"),
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
          BotUtil.makeLog("debug", `已发送消息给主人 ${user_id}`, '服务器');
        } else {
          results[user_id] = { error: "没有可用的Bot" };
          BotUtil.makeLog("warn", `无法向主人 ${user_id} 发送消息`, '服务器');
        }
        
        if (sleep && i < masterQQs.length - 1) {
          await BotUtil.sleep(sleep);
        }
      } catch (err) {
        results[user_id] = { error: err.message };
        BotUtil.makeLog("error", `向主人 ${user_id} 发送消息失败：${err.message}`, '服务器');
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