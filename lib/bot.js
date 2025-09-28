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
import chalk from 'chalk';
import httpProxy from 'http-proxy-middleware';

import PluginsLoader from "./plugins/loader.js";
import ListenerLoader from "./listener/loader.js";
import ApiLoader from "./http/loader.js";
import init from "./config/loader.js";
import BotUtil from './common/util.js';
import cfg from './config/config.js';

/**
 * Bot主类 - 管理HTTP/HTTPS服务器、WebSocket连接和机器人实例
 * 提供统一的服务器管理、认证、静态文件服务、反向代理等功能
 * @class Bot
 * @extends EventEmitter
 */
export default class Bot extends EventEmitter {
  /**
   * 构造函数 - 初始化Bot实例
   */
  constructor() {
    super();

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
    this.wss = new WebSocketServer({ noServer: true });
    this.wsf = Object.create(null);
    this.fs = Object.create(null);

    // 反向代理相关
    this.proxyApp = null;
    this.proxyServer = null;
    this.proxyHttpsServer = null;
    this.proxies = new Map();
    
    // 配置初始化
    this.apiKey = '';
    this._cache = BotUtil.getMap('yunzai_cache', { ttl: 60000, autoClean: true });
    this._rateLimiters = new Map();
    this.httpPort = null;
    this.httpsPort = null;
    this.url = cfg.server?.server?.url || '';

    // API加载器引用
    this.ApiLoader = ApiLoader;

    // 初始化HTTP服务器
    this._initHttpServer();

    // 设置进程信号处理
    this._setupSignalHandlers();

    // 生成API密钥
    this.generateApiKey();

    // 返回代理对象
    return this._createProxy();
  }

  /**
   * 创建UIN管理器 - 管理多账号的智能选择
   * @private
   * @returns {Array} 扩展的UIN数组
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
   * 初始化HTTP服务器
   * @private
   */
  _initHttpServer() {
    this.server = http.createServer(this.express)
      .on("error", err => this._handleServerError(err, false))
      .on("upgrade", this.wsConnect.bind(this));
  }

  /**
   * 初始化反向代理服务器
   * @private
   * @async
   */
  async _initProxyServer() {
    const proxyConfig = cfg.proxy || cfg.server?.proxy;
    
    if (!proxyConfig?.enabled) return;

    BotUtil.makeLog('info', chalk.cyan('⚡ 正在初始化反向代理服务器...'), 'Proxy');

    // 创建独立的Express应用用于反向代理
    this.proxyApp = express();

    // 设置基础中间件
    this.proxyApp.use(compression({
      filter: (req, res) => compression.filter(req, res),
      level: 6
    }));

    // 设置域名路由中间件
    this.proxyApp.use(this._domainRoutingMiddleware.bind(this));

    // 创建HTTP代理服务器
    const proxyHttpPort = proxyConfig.httpPort || 80;
    this.proxyServer = http.createServer(this.proxyApp);
    
    this.proxyServer.on("error", err => {
      BotUtil.makeLog('error', chalk.red(`✗ 代理HTTP服务器错误: ${err.message}`), 'Proxy');
    });

    // 处理WebSocket升级
    this.proxyServer.on('upgrade', (req, socket, head) => {
      const domainConfig = this._getDomainConfig(req);
      if (domainConfig?.ws && domainConfig.target) {
        const proxy = this._getOrCreateProxy(domainConfig);
        proxy.ws(req, socket, head, {
          target: domainConfig.target,
          ws: true
        });
      } else {
        socket.end();
      }
    });

    // 启动HTTP代理服务器
    this.proxyServer.listen(proxyHttpPort, cfg.server?.host || '0.0.0.0', () => {
      BotUtil.makeLog('success', chalk.green(`✓ 反向代理HTTP服务器已启动在端口 ${proxyHttpPort}`), 'Proxy');
    });

    // 如果需要，创建HTTPS代理服务器
    if (proxyConfig.httpsPort) {
      await this._initProxyHttpsServer(proxyConfig);
    }
  }

  /**
   * 初始化HTTPS反向代理服务器
   * @private
   * @async
   */
  async _initProxyHttpsServer(proxyConfig) {
    const httpsPort = proxyConfig.httpsPort || 443;

    // 收集所有域名的证书
    const certificates = {};
    
    for (const domainConfig of (proxyConfig.domains || [])) {
      if (domainConfig.ssl?.enabled && domainConfig.ssl.certificate) {
        const cert = domainConfig.ssl.certificate;
        
        try {
          // 检查证书文件
          if (!fsSync.existsSync(cert.key) || !fsSync.existsSync(cert.cert)) {
            BotUtil.makeLog('warn', chalk.yellow(`⚠ 域名 ${domainConfig.domain} 的证书文件不存在`), 'Proxy');
            continue;
          }

          // 读取证书
          const certData = {
            key: await fs.readFile(cert.key),
            cert: await fs.readFile(cert.cert)
          };

          if (cert.ca && fsSync.existsSync(cert.ca)) {
            certData.ca = await fs.readFile(cert.ca);
          }

          // 处理通配符域名
          const domainPattern = domainConfig.domain.replace('*.', '');
          certificates[domainPattern] = certData;

          BotUtil.makeLog('debug', chalk.gray(`已加载域名 ${domainConfig.domain} 的SSL证书`), 'Proxy');

        } catch (err) {
          BotUtil.makeLog('error', chalk.red(`✗ 加载域名 ${domainConfig.domain} 的证书失败: ${err.message}`), 'Proxy');
        }
      }
    }

    // 使用默认证书作为后备
    let defaultCert = null;
    if (cfg.server?.https?.certificate) {
      const cert = cfg.server.https.certificate;
      if (fsSync.existsSync(cert.key) && fsSync.existsSync(cert.cert)) {
        defaultCert = {
          key: await fs.readFile(cert.key),
          cert: await fs.readFile(cert.cert)
        };
        if (cert.ca && fsSync.existsSync(cert.ca)) {
          defaultCert.ca = await fs.readFile(cert.ca);
        }
      }
    }

    if (Object.keys(certificates).length === 0 && !defaultCert) {
      BotUtil.makeLog('warn', chalk.yellow('⚠ 未找到任何可用的SSL证书，跳过HTTPS代理服务器'), 'Proxy');
      return;
    }

    // 创建SNI回调来处理多域名证书
    const SNICallback = (servername, callback) => {
      // 查找匹配的证书
      let cert = null;
      
      for (const [pattern, certData] of Object.entries(certificates)) {
        if (servername.endsWith(pattern)) {
          cert = certData;
          break;
        }
      }

      // 使用默认证书
      if (!cert && defaultCert) {
        cert = defaultCert;
      }

      if (cert) {
        const context = require('tls').createSecureContext(cert);
        callback(null, context);
      } else {
        callback(new Error(`No certificate for ${servername}`));
      }
    };

    // 创建HTTPS服务器
    const httpsOptions = defaultCert ? { ...defaultCert, SNICallback } : { SNICallback };
    
    this.proxyHttpsServer = https.createServer(httpsOptions, this.proxyApp);

    this.proxyHttpsServer.on("error", err => {
      BotUtil.makeLog('error', chalk.red(`✗ 代理HTTPS服务器错误: ${err.message}`), 'Proxy');
    });

    // 处理WebSocket升级
    this.proxyHttpsServer.on('upgrade', (req, socket, head) => {
      const domainConfig = this._getDomainConfig(req);
      if (domainConfig?.ws && domainConfig.target) {
        const proxy = this._getOrCreateProxy(domainConfig);
        proxy.ws(req, socket, head, {
          target: domainConfig.target,
          ws: true,
          secure: false
        });
      } else {
        socket.end();
      }
    });

    // 启动HTTPS代理服务器
    this.proxyHttpsServer.listen(httpsPort, cfg.server?.host || '0.0.0.0', () => {
      BotUtil.makeLog('success', chalk.green(`✓ 反向代理HTTPS服务器已启动在端口 ${httpsPort}`), 'Proxy');
      this._displayProxyInfo();
    });
  }

  /**
   * 域名路由中间件
   * @private
   */
  _domainRoutingMiddleware(req, res, next) {
    const domainConfig = this._getDomainConfig(req);

    if (!domainConfig) {
      // 没有匹配的域名配置，返回404
      return res.status(404).send('Domain not configured');
    }

    // 保存域名配置到请求对象
    req.domainConfig = domainConfig;

    // 处理路径重写
    if (domainConfig.rewritePath || domainConfig.pathRewrite) {
      this._rewritePath(req, domainConfig);
    }

    // 添加自定义请求头
    if (domainConfig.headers?.request) {
      for (const [key, value] of Object.entries(domainConfig.headers.request)) {
        req.headers[key] = value;
      }
    }

    // 如果有目标服务器，设置反向代理
    if (domainConfig.target) {
      const proxy = this._getOrCreateProxy(domainConfig);
      
      return proxy(req, res, next);
    }

    // 如果没有目标服务器，提供静态文件服务
    const staticRoot = domainConfig.staticRoot || path.join(process.cwd(), 'www');

    // 确保目录存在
    if (!fsSync.existsSync(staticRoot)) {
      fsSync.mkdirSync(staticRoot, { recursive: true });
    }

    // 设置静态文件中间件
    express.static(staticRoot, {
      index: cfg.server?.static?.index || ['index.html', 'index.htm'],
      dotfiles: 'deny',
      setHeaders: (res, filePath) => {
        // 添加自定义响应头
        if (domainConfig.headers?.response) {
          for (const [key, value] of Object.entries(domainConfig.headers.response)) {
            res.setHeader(key, value);
          }
        }
        this._setStaticHeaders(res, filePath);
      }
    })(req, res, next);
  }

  /**
   * 获取域名配置
   * @private
   */
  _getDomainConfig(req) {
    const proxyConfig = cfg.proxy || cfg.server?.proxy;
    if (!proxyConfig?.domains) return null;

    const hostname = req.hostname || req.headers.host?.split(':')[0];
    if (!hostname) return null;

    // 查找匹配的域名配置
    for (const config of proxyConfig.domains) {
      const domain = config.domain;

      // 精确匹配
      if (domain === hostname) {
        return config;
      }

      // 通配符匹配
      if (domain.startsWith('*.')) {
        const pattern = domain.slice(2);
        if (hostname.endsWith(pattern)) {
          // 提取子域名部分
          const subdomain = hostname.slice(0, hostname.length - pattern.length - 1);
          return { ...config, subdomain };
        }
      }
    }

    return null;
  }

  /**
   * 路径重写
   * @private
   */
  _rewritePath(req, domainConfig) {
    let originalPath = req.url;

    // 简单路径重写
    if (domainConfig.rewritePath) {
      const { from, to } = domainConfig.rewritePath;
      
      if (from && to) {
        // 替换子域名变量
        let toPath = to;
        if (domainConfig.subdomain) {
          toPath = toPath.replace('${subdomain}', domainConfig.subdomain);
        }

        if (from === '/' && to !== '/') {
          // 添加前缀
          req.url = toPath + req.url;
        } else if (req.url.startsWith(from)) {
          // 替换路径
          req.url = req.url.replace(from, toPath);
        }
      }
    }

    // 复杂路径重写规则
    if (domainConfig.pathRewrite && typeof domainConfig.pathRewrite === 'object') {
      for (const [pattern, replacement] of Object.entries(domainConfig.pathRewrite)) {
        const regex = new RegExp(pattern);
        if (regex.test(req.url)) {
          req.url = req.url.replace(regex, replacement);
          break;
        }
      }
    }

    if (originalPath !== req.url) {
      BotUtil.makeLog('debug', 
        chalk.gray(`路径重写: ${originalPath} → ${req.url} [${domainConfig.domain}]`), 
        'Proxy');
    }
  }

  /**
   * 获取或创建代理实例
   * @private
   */
  _getOrCreateProxy(domainConfig) {
    const key = domainConfig.domain;

    if (!this.proxies.has(key)) {
      const { createProxyMiddleware } = httpProxy;

      const proxyOptions = {
        target: domainConfig.target,
        changeOrigin: true,
        ws: domainConfig.ws || false,
        preserveHostHeader: domainConfig.preserveHostHeader || false,
        timeout: domainConfig.timeout || 30000,
        proxyTimeout: domainConfig.timeout || 30000,
        secure: false,
        logLevel: 'warn',
        
        onProxyReq: (proxyReq, req, res) => {
          // 保持Host头
          if (!domainConfig.preserveHostHeader) {
            const targetUrl = new URL(domainConfig.target);
            proxyReq.setHeader('Host', targetUrl.host);
          }

          // 添加X-Forwarded头
          proxyReq.setHeader('X-Forwarded-For', req.ip || req.connection.remoteAddress);
          proxyReq.setHeader('X-Forwarded-Proto', req.secure ? 'https' : 'http');
          proxyReq.setHeader('X-Real-IP', req.ip || req.connection.remoteAddress);
        },

        onProxyRes: (proxyRes, req, res) => {
          // 添加自定义响应头
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
          
          if (!res.headersSent) {
            res.status(502).json({
              error: 'Bad Gateway',
              message: 'Proxy error',
              domain: domainConfig.domain
            });
          }
        }
      };

      const proxy = createProxyMiddleware(proxyOptions);
      this.proxies.set(key, proxy);

      BotUtil.makeLog('debug', 
        chalk.gray(`创建代理: ${domainConfig.domain} → ${domainConfig.target}`), 
        'Proxy');
    }

    return this.proxies.get(key);
  }

  /**
   * 显示代理服务器信息
   * @private
   */
  _displayProxyInfo() {
    const proxyConfig = cfg.proxy || cfg.server?.proxy;
    if (!proxyConfig?.enabled || !proxyConfig?.domains) return;

    console.log(chalk.cyan('\n╔════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.green.bold('          反向代理服务器配置信息                           ') + chalk.cyan('║'));
    console.log(chalk.cyan('╚════════════════════════════════════════════════════════════╝\n'));

    console.log(chalk.yellow('▶ 域名配置:'));
    console.log(chalk.gray('─'.repeat(60)));

    for (const config of proxyConfig.domains) {
      const protocol = config.ssl?.enabled ? 'https' : 'http';
      const domain = config.domain;
      const target = config.target || '(静态文件服务)';
      const root = config.staticRoot || './www';

      console.log(chalk.cyan(`\n  ${domain}:`));
      console.log(chalk.white(`    协议: ${protocol}`));
      console.log(chalk.white(`    目标: ${target}`));
      
      if (!config.target) {
        console.log(chalk.white(`    根目录: ${root}`));
      }

      if (config.rewritePath) {
        console.log(chalk.white(`    路径重写: ${config.rewritePath.from} → ${config.rewritePath.to}`));
      }

      if (config.ws) {
        console.log(chalk.white(`    WebSocket: ✓`));
      }

      if (config.ssl?.enabled) {
        console.log(chalk.green(`    SSL证书: ✓`));
      }
    }

    console.log(chalk.gray('\n─'.repeat(60)));
    console.log(chalk.yellow('\n提示:'));
    console.log(chalk.gray('• 请确保域名DNS已正确解析到此服务器'));
    console.log(chalk.gray('• 使用80/443端口可能需要管理员权限'));
    console.log(chalk.gray('• 建议在生产环境使用Nginx/Apache作为前端代理'));
    console.log(chalk.gray('─'.repeat(60)) + '\n');
  }

  /**
   * 处理服务器错误
   * @private
   * @param {Error} err - 错误对象
   * @param {boolean} isHttps - 是否为HTTPS服务器
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

    // CORS配置
    this._setupCors();

    // 请求日志
    this._setupRequestLogging();

    // ========== 第二层：速率限制 ==========
    this._setupRateLimiting();

    // ========== 第三层：请求体解析 ==========
    this._setupBodyParsers();

    // ========== 第四层：认证中间件 ==========
    this.express.use(this._authMiddleware.bind(this));

    // ========== 第五层：系统路由 ==========

    // 状态和健康检查
    this.express.get('/status', this._statusHandler.bind(this));
    this.express.get('/health', this._healthHandler.bind(this));

    // 文件服务（用于Bot发送的临时文件）
    this.express.use('/File', this._fileHandler.bind(this));

    // ========== 第六层：静态文件服务 ==========
    this._setupStaticServing();
  }

  /**
   * 设置CORS跨域配置
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
          
          BotUtil.makeLog('debug',
            `${method} ${status} ${time} ${path}`,
            'HTTP');
        }
      });
      next();
    });
  }

  /**
   * 设置静态文件服务
   * www目录作为默认根目录
   * @private
   */
  _setupStaticServing() {
    const wwwPath = path.join(process.cwd(), 'www');

    // 确保www目录存在
    if (!fsSync.existsSync(wwwPath)) {
      fsSync.mkdirSync(wwwPath, { recursive: true });
      BotUtil.makeLog('info', chalk.green(`✓ 创建www目录: ${wwwPath}`), 'Server');
    }

    // 处理目录请求的中间件（在静态文件服务之前）
    this.express.use(this._directoryIndexMiddleware.bind(this));

    // 静态文件安全中间件
    this.express.use(this._staticSecurityMiddleware.bind(this));

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

    // 设置www为根目录
    this.express.use(express.static(wwwPath, staticOptions));

    // 特殊文件处理
    this.express.get('/favicon.ico', this._handleFavicon.bind(this));
    this.express.get('/robots.txt', this._handleRobotsTxt.bind(this));

    BotUtil.makeLog('info', chalk.cyan(`⚡ 静态文件服务: / → ${wwwPath}`), 'Server');
  }

  /**
   * 目录索引中间件 - 自动加载目录下的index文件
   * @private
   */
  _directoryIndexMiddleware(req, res, next) {
    const hasExtension = path.extname(req.path);
    if (hasExtension || req.path.endsWith('/')) {
      return next();
    }

    // 构建目录路径
    const wwwPath = path.join(process.cwd(), 'www');
    const dirPath = path.join(wwwPath, req.path);

    // 检查是否是目录
    if (fsSync.existsSync(dirPath) && fsSync.statSync(dirPath).isDirectory()) {
      // 查找索引文件
      const indexFiles = cfg.server?.static?.index || ['index.html', 'index.htm'];
      
      for (const indexFile of indexFiles) {
        const indexPath = path.join(dirPath, indexFile);
        if (fsSync.existsSync(indexPath)) {
          // 重定向到目录+/
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

  /**
   * 设置静态文件响应头
   * @private
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
   * 处理favicon请求
   * @private
   */
  async _handleFavicon(req, res) {
    const faviconPath = path.join(process.cwd(), 'www', 'favicon.ico');

    if (fsSync.existsSync(faviconPath)) {
      res.set({
        'Content-Type': 'image/x-icon',
        'Cache-Control': 'public, max-age=604800'
      });
      return res.sendFile(faviconPath);
    }

    res.status(204).end();
  }

  /**
   * 处理robots.txt请求
   * @private
   */
  async _handleRobotsTxt(req, res) {
    const robotsPath = path.join(process.cwd(), 'www', 'robots.txt');

    if (fsSync.existsSync(robotsPath)) {
      res.set({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=86400'
      });
      return res.sendFile(robotsPath);
    }

    // 默认robots.txt内容
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

    const createLimiter = (options) => rateLimit({
      windowMs: options.windowMs || 15 * 60 * 1000,
      max: options.max || 100,
      message: options.message || 'Too many requests',
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => this._isLocalConnection(req.ip)
    });

    // 全局限制
    if (rateLimitConfig?.global) {
      this.express.use(createLimiter(rateLimitConfig.global));
    }

    // API限制
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
      limit: limits.urlencoded || '10mb'
    }));

    this.express.use(express.json({
      limit: limits.json || '10mb'
    }));

    this.express.use(express.raw({
      limit: limits.raw || '10mb'
    }));
  }

  /**
   * 设置进程信号处理
   * @private
   */
  _setupSignalHandlers() {
    const closeHandler = async () => await this.closeServer();
    process.on('SIGINT', closeHandler);
    process.on('SIGTERM', closeHandler);
  }

  /**
   * 创建代理对象
   * @private
   * @returns {Proxy} 代理对象
   */
  _createProxy() {
    return new Proxy(this.bots, {
      get: (target, prop) => {
        // 检查bots对象的属性
        if (target[prop] !== undefined) return target[prop];

        // 检查Bot实例的属性
        if (this[prop] !== undefined) return this[prop];

        // 检查工具类的属性
        const utilValue = BotUtil[prop];
        if (utilValue !== undefined) {
          return typeof utilValue === 'function' ?
            utilValue.bind(BotUtil) : utilValue;
        }

        // 查找Bot实例的属性
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

  // ... [继续保留其他所有原有方法，篇幅限制，这里省略]

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

    console.log(chalk.cyan('\n╔════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.yellow.bold('          正在初始化服务器...                              ') + chalk.cyan('║'));
    console.log(chalk.cyan('╚════════════════════════════════════════════════════════════╝\n'));

    BotUtil.makeLog('info',
      chalk.gray(`配置端口: HTTP=${this.httpPort}, HTTPS=${this.httpsPort}`), 'Server');

    // 初始化组件
    await init();
    await this.generateApiKey();
    await PluginsLoader.load();
    await ApiLoader.load();

    // 初始化反向代理服务器（如果启用）
    await this._initProxyServer();

    // 初始化所有中间件和基础路由
    this._initializeMiddlewareAndRoutes();

    // 注册API路由
    await ApiLoader.register(this.express, this);

    // 设置404和错误处理
    this._setupFinalHandlers();

    // 启动服务器
    await this.serverLoad(false);

    // 启动HTTPS
    if (cfg.server?.https?.enabled) {
      await this.httpsLoad();
    }

    // 加载监听器
    await ListenerLoader.load();
    await ApiLoader.watch(true);

    // WebSocket服务
    if (Object.keys(this.wsf).length > 0) {
      BotUtil.makeLog("info",
        chalk.cyan(`⚡ WebSocket服务: ${this.getServerUrl().replace(/^http/, "ws")}/ [${Object.keys(this.wsf).join(', ')}]`),
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
  }

  /**
   * 关闭服务器
   * @async
   */
  async closeServer() {
    BotUtil.makeLog('info', chalk.yellow('⏳ 正在关闭服务器...'), 'Server');

    // 关闭反向代理服务器
    if (this.proxyServer) {
      await new Promise(resolve => this.proxyServer.close(resolve));
    }

    if (this.proxyHttpsServer) {
      await new Promise(resolve => this.proxyHttpsServer.close(resolve));
    }

    // 关闭主服务器
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
    }

    if (this.httpsServer) {
      await new Promise(resolve => this.httpsServer.close(resolve));
    }

    // 清理资源
    await BotUtil.sleep(2000);
    await this.redisExit();

    BotUtil.makeLog('info', chalk.green('✓ 服务器已关闭'), 'Server');
  }

  // ========== Bot功能方法 ==========

  /**
   * 准备事件数据
   * @param {Object} data - 事件数据
   */
  prepareEvent(data) {
    if (!this.bots[data.self_id]) return;

    // 添加bot引用
    if (!data.bot) {
      Object.defineProperty(data, "bot", {
        value: this.bots[data.self_id]
      });
    }

    // 处理用户相关
    if (data.user_id) {
      if (!data.friend) {
        Object.defineProperty(data, "friend", {
          value: data.bot.pickFriend(data.user_id)
        });
      }
      data.sender ||= { user_id: data.user_id };
      data.sender.nickname ||= data.friend?.nickname;
    }

    // 处理群组相关
    if (data.group_id) {
      if (!data.group) {
        Object.defineProperty(data, "group", {
          value: data.bot.pickGroup(data.group_id)
        });
      }
      data.group_name ||= data.group?.name;
    }

    // 处理群成员
    if (data.group && data.user_id) {
      if (!data.member) {
        Object.defineProperty(data, "member", {
          value: data.group.pickMember(data.user_id)
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
   */
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

  /**
   * 选择好友
   * @param {number|string} user_id - 用户ID
   * @param {boolean} strict - 严格模式
   * @returns {Object|false} 好友对象
   */
  pickFriend(user_id, strict) {
    user_id = Number(user_id) || user_id;

    // 优先使用主Bot
    const mainBot = this.bots[this.uin];
    if (mainBot?.fl?.has(user_id)) {
      return mainBot.pickFriend(user_id);
    }

    // 查找其他Bot
    const friend = this.fl.get(user_id);
    if (friend) {
      return this.bots[friend.bot_id].pickFriend(user_id);
    }

    // 严格模式返回false
    if (strict) return false;

    // 随机选择Bot
    BotUtil.makeLog("trace",
      chalk.gray(`因不存在用户 ${user_id} 而随机选择Bot ${this.uin.toJSON()}`), 'Server');
    return this.bots[this.uin].pickFriend(user_id);
  }

  /**
   * pickUser别名
   */
  get pickUser() {
    return this.pickFriend;
  }

  /**
   * 选择群
   * @param {number|string} group_id - 群ID
   * @param {boolean} strict - 严格模式
   * @returns {Object|false} 群对象
   */
  pickGroup(group_id, strict) {
    group_id = Number(group_id) || group_id;

    // 优先使用主Bot
    const mainBot = this.bots[this.uin];
    if (mainBot?.gl?.has(group_id)) {
      return mainBot.pickGroup(group_id);
    }

    // 查找其他Bot
    const group = this.gl.get(group_id);
    if (group) {
      return this.bots[group.bot_id].pickGroup(group_id);
    }

    // 严格模式返回false
    if (strict) return false;

    // 随机选择Bot
    BotUtil.makeLog("trace",
      chalk.gray(`因不存在群 ${group_id} 而随机选择Bot ${this.uin.toJSON()}`), 'Server');
    return this.bots[this.uin].pickGroup(group_id);
  }

  /**
   * 选择群成员
   * @param {number|string} group_id - 群ID
   * @param {number|string} user_id - 用户ID
   * @returns {Object} 成员对象
   */
  pickMember(group_id, user_id) {
    return this.pickGroup(group_id).pickMember(user_id);
  }

  /**
   * 发送好友消息
   * @async
   * @param {number|string} bot_id - Bot ID
   * @param {number|string} user_id - 用户ID
   * @param {...any} args - 消息内容
   * @returns {Promise<Object>} 发送结果
   */
  async sendFriendMsg(bot_id, user_id, ...args) {
    // 无Bot ID时使用默认
    if (!bot_id) {
      return this.pickFriend(user_id).sendMsg(...args);
    }

    // 指定Bot发送
    if (this.uin.includes(bot_id) && this.bots[bot_id]) {
      return this.bots[bot_id].pickFriend(user_id).sendMsg(...args);
    }

    // 等待Bot上线
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

  /**
   * 发送群消息
   * @async
   * @param {number|string} bot_id - Bot ID
   * @param {number|string} group_id - 群ID
   * @param {...any} args - 消息内容
   * @returns {Promise<Object>} 发送结果
   */
  async sendGroupMsg(bot_id, group_id, ...args) {
    // 无Bot ID时使用默认
    if (!bot_id) {
      return this.pickGroup(group_id).sendMsg(...args);
    }

    // 指定Bot发送
    if (this.uin.includes(bot_id) && this.bots[bot_id]) {
      return this.bots[bot_id].pickGroup(group_id).sendMsg(...args);
    }

    // 等待Bot上线
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

        // 发送间隔
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
   * 退出Redis
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
   * 文件转URL
   * @async
   * @param {string|Buffer} file - 文件
   * @param {Object} opts - 选项
   * @returns {Promise<string>} 文件URL
   */
  async fileToUrl(file, opts = {}) {
    return await BotUtil.fileToUrl(file, opts);
  }
}