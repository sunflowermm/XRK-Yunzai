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
import { createProxyMiddleware } from 'http-proxy-middleware';

import PluginsLoader from "./plugins/loader.js";
import ListenerLoader from "./listener/loader.js";
import ApiLoader from "./http/loader.js";
import init from "./config/loader.js";
import BotUtil from './common/util.js';
import cfg from './config/config.js';

/**
 * Bot主类 - 管理HTTP/HTTPS服务器、WebSocket连接和机器人实例
 * 提供统一的服务器管理、认证、静态文件服务等功能
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

    // 配置初始化
    this.apiKey = '';
    this._cache = BotUtil.getMap('yunzai_cache', { ttl: 60000, autoClean: true });
    this._rateLimiters = new Map();
    this.httpPort = null;
    this.httpsPort = null;
    this.url = cfg.server?.url || '';

    // 反向代理相关
    this.proxyEnabled = cfg.proxy?.enabled || false;
    this.proxyDomains = new Map();

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
   * 初始化反向代理中间件
   * @private
   */
  _initializeProxyMiddleware() {
    const proxyConfig = cfg.proxy;
    if (!proxyConfig?.enabled || !proxyConfig?.domains) return;

    BotUtil.makeLog('info', chalk.cyan('⚡ 启用反向代理功能'), 'Proxy');

    // 处理每个域名配置
    proxyConfig.domains.forEach(domainConfig => {
      const { domain, target, staticRoot, ssl, rewritePath, headers, ws: enableWs, timeout, preserveHostHeader } = domainConfig;
      
      if (!domain) {
        BotUtil.makeLog('warn', chalk.yellow('⚠ 跳过无效的域名配置'), 'Proxy');
        return;
      }

      // 存储域名配置
      this.proxyDomains.set(domain.toLowerCase(), domainConfig);
      
      BotUtil.makeLog('info', chalk.green(`✓ 注册域名: ${domain}`), 'Proxy');

      // 如果配置了目标服务器，创建代理中间件
      if (target) {
        const proxyOptions = {
          target,
          changeOrigin: true,
          ws: enableWs || false,
          logLevel: 'warn',
          timeout: timeout || 30000,
          proxyTimeout: timeout || 30000,
          
          // 路径重写
          pathRewrite: (path, req) => {
            if (rewritePath) {
              // 简单的路径重写
              if (rewritePath.from && rewritePath.to !== undefined) {
                const rewrittenPath = path.replace(new RegExp(`^${rewritePath.from}`), rewritePath.to);
                
                // 处理${subdomain}变量
                if (rewritePath.to.includes('${subdomain}')) {
                  const subdomain = req.hostname.split('.')[0];
                  return rewrittenPath.replace('${subdomain}', subdomain);
                }
                
                return rewrittenPath;
              }
              
              // 复杂的路径重写规则
              if (domainConfig.pathRewrite) {
                for (const [pattern, replacement] of Object.entries(domainConfig.pathRewrite)) {
                  if (new RegExp(pattern).test(path)) {
                    return path.replace(new RegExp(pattern), replacement);
                  }
                }
              }
            }
            return path;
          },
          
          // 自定义请求头
          onProxyReq: (proxyReq, req, res) => {
            // 保持原始Host头
            if (!preserveHostHeader) {
              proxyReq.setHeader('X-Forwarded-Host', req.hostname);
            }
            
            // 添加自定义请求头
            if (headers?.request) {
              Object.entries(headers.request).forEach(([key, value]) => {
                proxyReq.setHeader(key, value);
              });
            }
          },
          
          // 自定义响应头
          onProxyRes: (proxyRes, req, res) => {
            // 添加自定义响应头
            if (headers?.response) {
              Object.entries(headers.response).forEach(([key, value]) => {
                res.setHeader(key, value);
              });
            }
          },
          
          // 错误处理
          onError: (err, req, res) => {
            BotUtil.makeLog('error', chalk.red(`✗ 代理错误 [${domain}]: ${err.message}`), 'Proxy');
            
            if (!res.headersSent) {
              res.status(502).json({
                error: 'Bad Gateway',
                message: 'Proxy server error',
                domain,
                timestamp: Date.now()
              });
            }
          }
        };

        // 创建代理中间件实例
        const proxyMiddleware = createProxyMiddleware(proxyOptions);
        
        // 存储代理中间件
        domainConfig.proxyMiddleware = proxyMiddleware;
      }
    });
  }

  /**
   * 虚拟主机路由中间件
   * @private
   */
  _virtualHostMiddleware(req, res, next) {
    // 如果没有启用代理，直接继续
    if (!this.proxyEnabled || this.proxyDomains.size === 0) {
      return next();
    }

    const hostname = req.hostname.toLowerCase();
    let domainConfig = this.proxyDomains.get(hostname);

    // 检查通配符域名
    if (!domainConfig) {
      for (const [pattern, config] of this.proxyDomains) {
        if (pattern.startsWith('*.')) {
          const baseDomain = pattern.slice(2);
          if (hostname.endsWith(baseDomain)) {
            domainConfig = config;
            break;
          }
        }
      }
    }

    // 如果找不到匹配的域名配置，使用默认处理
    if (!domainConfig) {
      // 检查是否配置了默认域名
      const defaultDomain = cfg.proxy?.defaultDomain;
      if (defaultDomain) {
        domainConfig = this.proxyDomains.get(defaultDomain);
      }
      
      if (!domainConfig) {
        return next();
      }
    }

    // 存储域名配置到请求对象
    req.domainConfig = domainConfig;

    // 处理静态文件根目录
    if (domainConfig.staticRoot && !domainConfig.target) {
      const staticRoot = path.resolve(process.cwd(), domainConfig.staticRoot);
      
      // 确保目录存在
      if (fsSync.existsSync(staticRoot)) {
        // 使用域名专用的静态文件服务
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
        
        return express.static(staticRoot, staticOptions)(req, res, (err) => {
          if (err) return next(err);
          
          // 如果静态文件未找到，且配置了目标服务器，则代理
          if (domainConfig.proxyMiddleware) {
            return domainConfig.proxyMiddleware(req, res, next);
          }
          
          next();
        });
      }
    }

    // 如果配置了代理中间件，使用它
    if (domainConfig.proxyMiddleware) {
      return domainConfig.proxyMiddleware(req, res, next);
    }

    next();
  }

  /**
   * 处理HTTP到HTTPS的重定向
   * @private
   */
  _httpsRedirectMiddleware(req, res, next) {
    // 检查是否需要重定向到HTTPS
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    
    // 如果已经是HTTPS，继续
    if (isHttps) {
      return next();
    }

    // 检查当前域名的SSL配置
    const hostname = req.hostname.toLowerCase();
    let domainConfig = this.proxyDomains.get(hostname);
    
    // 检查通配符
    if (!domainConfig) {
      for (const [pattern, config] of this.proxyDomains) {
        if (pattern.startsWith('*.')) {
          const baseDomain = pattern.slice(2);
          if (hostname.endsWith(baseDomain)) {
            domainConfig = config;
            break;
          }
        }
      }
    }

    // 如果该域名启用了SSL，重定向到HTTPS
    if (domainConfig?.ssl?.enabled) {
      const httpsUrl = `https://${req.hostname}${req.originalUrl}`;
      
      BotUtil.makeLog('debug', 
        chalk.gray(`HTTPS重定向: ${req.protocol}://${req.hostname}${req.originalUrl} → ${httpsUrl}`), 
        'Proxy');
      
      return res.redirect(301, httpsUrl);
    }

    // 检查全局HTTPS配置
    if (cfg.server?.https?.enabled && cfg.server?.https?.hsts?.enabled) {
      const httpsPort = this.httpsPort || 443;
      const portSuffix = httpsPort !== 443 ? `:${httpsPort}` : '';
      const httpsUrl = `https://${req.hostname}${portSuffix}${req.originalUrl}`;
      
      return res.redirect(301, httpsUrl);
    }

    next();
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

    // ========== 第二层：反向代理（新增） ==========
    if (this.proxyEnabled) {
      // 初始化代理配置
      this._initializeProxyMiddleware();
      
      // HTTPS重定向中间件
      this.express.use(this._httpsRedirectMiddleware.bind(this));
      
      // 虚拟主机路由
      this.express.use(this._virtualHostMiddleware.bind(this));
    }

    // ========== 第三层：速率限制 ==========
    this._setupRateLimiting();

    // ========== 第四层：请求体解析 ==========
    this._setupBodyParsers();

    // ========== 第五层：认证中间件 ==========
    this.express.use(this._authMiddleware.bind(this));

    // ========== 第六层：系统路由 ==========

    // 状态和健康检查
    this.express.get('/status', this._statusHandler.bind(this));
    this.express.get('/health', this._healthHandler.bind(this));

    // 文件服务（用于Bot发送的临时文件）
    this.express.use('/File', this._fileHandler.bind(this));

    // ========== 第七层：静态文件服务 ==========
    // 只有在没有启用代理或没有匹配域名时才使用默认静态服务
    if (!this.proxyEnabled) {
      this._setupStaticServing();
    } else {
      // 代理模式下的默认静态服务（作为后备）
      this._setupStaticServing();
    }
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
          const host = req.hostname !== 'localhost' ? chalk.gray(` [${req.hostname}]`) : '';
          
          BotUtil.makeLog('debug',
            `${method} ${status} ${time} ${path}${host}`,
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

    // 根据域名配置确定根目录
    let rootPath = path.join(process.cwd(), 'www');
    
    if (req.domainConfig?.staticRoot) {
      rootPath = path.resolve(process.cwd(), req.domainConfig.staticRoot);
    }

    // 构建目录路径
    const dirPath = path.join(rootPath, req.path);

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
    // 根据域名确定favicon路径
    let faviconPath = path.join(process.cwd(), 'www', 'favicon.ico');
    
    if (req.domainConfig?.staticRoot) {
      const customPath = path.join(path.resolve(process.cwd(), req.domainConfig.staticRoot), 'favicon.ico');
      if (fsSync.existsSync(customPath)) {
        faviconPath = customPath;
      }
    }

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
    // 根据域名确定robots.txt路径
    let robotsPath = path.join(process.cwd(), 'www', 'robots.txt');
    
    if (req.domainConfig?.staticRoot) {
      const customPath = path.join(path.resolve(process.cwd(), req.domainConfig.staticRoot), 'robots.txt');
      if (fsSync.existsSync(customPath)) {
        robotsPath = customPath;
      }
    }

    if (fsSync.existsSync(robotsPath)) {
      res.set({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=86400'
      });
      return res.sendFile(robotsPath);
    }

    // 默认robots.txt内容
    const hostname = req.hostname || 'localhost';
    const protocol = req.secure ? 'https' : 'http';
    const defaultRobots = `User-agent: *
Disallow: /api/
Disallow: /config/
Disallow: /data/
Disallow: /lib/
Disallow: /plugins/
Disallow: /temp/
Allow: /

Sitemap: ${protocol}://${hostname}/sitemap.xml`;

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

  /**
   * 生成或加载API密钥
   * @async
   * @returns {Promise<string>} API密钥
   */
  async generateApiKey() {
    const apiKeyConfig = cfg.server?.auth?.apiKey || {};
    const apiKeyPath = path.join(process.cwd(),
      apiKeyConfig.file || 'config/server_config/api_key.json');

    try {
      // 尝试加载现有密钥
      if (fsSync.existsSync(apiKeyPath)) {
        const keyData = JSON.parse(await fs.readFile(apiKeyPath, 'utf8'));
        this.apiKey = keyData.key;
        BotUtil.apiKey = this.apiKey;
        BotUtil.makeLog('info', chalk.green('✓ 已加载API密钥'), 'Server');
        return this.apiKey;
      }

      // 生成新密钥
      const keyLength = apiKeyConfig.length || 64;
      this.apiKey = BotUtil.randomString(keyLength);

      // 保存密钥
      await BotUtil.mkdir(path.dirname(apiKeyPath));
      await fs.writeFile(apiKeyPath, JSON.stringify({
        key: this.apiKey,
        generated: new Date().toISOString(),
        note: '此密钥用于远程API访问，请妥善保管'
      }, null, 2), 'utf8');

      // 设置文件权限（仅限Unix系统）
      if (process.platform !== 'win32') {
        try { await fs.chmod(apiKeyPath, 0o600); } catch { }
      }

      BotUtil.apiKey = this.apiKey;
      BotUtil.makeLog('success', chalk.yellow(`⚡ 生成新的API密钥: ${this.apiKey}`), 'Server');
      return this.apiKey;

    } catch (error) {
      BotUtil.makeLog('error', chalk.red(`✗ API密钥处理失败: ${error.message}`), 'Server');
      // 回退：生成临时密钥
      this.apiKey = BotUtil.randomString(64);
      BotUtil.apiKey = this.apiKey;
      return this.apiKey;
    }
  }

  /**
   * 认证中间件
   * @private
   */
  _authMiddleware(req, res, next) {
    req.rid = `${req.ip}:${req.socket.remotePort}`;
    req.sid = `${req.protocol}://${req.hostname}:${req.socket.localPort}${req.originalUrl}`;

    // 检查白名单路径
    const whitelist = cfg.server?.auth?.whitelist || [
      '/', '/favicon.ico', '/health', '/status', '/robots.txt'
    ];

    // 检查是否是白名单路径（支持通配符）
    const isWhitelisted = whitelist.some(path => {
      if (path === req.path) return true;
      if (path.endsWith('*')) {
        const prefix = path.slice(0, -1);
        return req.path.startsWith(prefix);
      }
      // 处理目录路径（如 /xrk 应该匹配 /xrk/）
      if (!path.endsWith('/') && req.path === path + '/') return true;
      return false;
    });

    // 静态文件默认允许访问
    const isStaticFile = /\.(html|css|js|json|png|jpg|jpeg|gif|svg|webp|ico|mp4|webm|mp3|wav|pdf|zip|woff|woff2|ttf|otf)$/i.test(req.path);

    if (isWhitelisted || isStaticFile) {
      return next();
    }

    // 本地连接跳过认证
    if (this._isLocalConnection(req.ip)) {
      BotUtil.makeLog("debug", chalk.gray(`本地连接，跳过鉴权: ${req.ip}`), 'Auth');
      return next();
    }

    // 验证API密钥
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

  /**
   * 检查API授权
   * @private
   * @param {Object} req - 请求对象
   * @returns {boolean} 是否授权
   */
  _checkApiAuthorization(req) {
    if (!req) return false;

    // 获取请求中的API密钥
    const authKey = req.headers?.["x-api-key"] ??
      req.headers?.["authorization"]?.replace('Bearer ', '') ??
      req.query?.api_key ??
      req.body?.api_key;

    if (!this.apiKey || !authKey) {
      BotUtil.makeLog("debug", chalk.gray(`API鉴权失败: 缺少密钥`), 'Auth');
      return false;
    }

    try {
      // 时间安全比较，防止时序攻击
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

  /**
   * 公共API授权检查方法
   * @param {Object} req - 请求对象  
   * @returns {boolean} 是否授权
   */
  checkApiAuthorization(req) {
    return this._checkApiAuthorization(req);
  }

  /**
   * 检查是否为本地连接
   * @private
   * @param {string} address - IP地址
   * @returns {boolean} 是否为本地连接
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
   * 检查是否为私有IP
   * @private
   * @param {string} ip - IP地址
   * @returns {boolean} 是否为私有IP
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
   * 状态处理器
   * @private
   */
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
        domains: this.proxyEnabled ? Array.from(this.proxyDomains.keys()) : []
      }
    };

    res.type('json').send(JSON.stringify(status, null, 2));
  }

  /**
   * 健康检查处理器
   * @private
   */
  _healthHandler(req, res) {
    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: Date.now()
    });
  }

  /**
   * 文件处理器 - 处理Bot发送的临时文件
   * @private
   */
  _fileHandler(req, res) {
    const url = req.url.replace(/^\//, "");
    let file = this.fs[url];

    if (!file) {
      file = this.fs[404];
      if (!file) {
        return res.status(404).json({ error: 'Not Found', file: url });
      }
    }

    // 处理访问次数限制
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

    // 设置响应头
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

  /**
   * WebSocket连接处理
   * @param {Object} req - 请求对象
   * @param {Object} socket - Socket对象
   * @param {Buffer} head - 头部数据
   */
  wsConnect(req, socket, head) {
    // 构建请求标识
    req.rid = `${req.socket.remoteAddress}:${req.socket.remotePort}-${req.headers["sec-websocket-key"]}`;
    req.sid = `ws://${req.headers.host || `${req.socket.localAddress}:${req.socket.localPort}`}${req.url}`;
    req.query = Object.fromEntries(new URL(req.sid).searchParams.entries());

    // 验证授权
    if (!this._isLocalConnection(req.socket.remoteAddress)) {
      if (!this._checkApiAuthorization(req)) {
        BotUtil.makeLog("error", chalk.red(`✗ WebSocket鉴权失败: ${req.url}`), 'Server');
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return socket.destroy();
      }
    }

    // 检查路径
    const path = req.url.split("/")[1];
    if (!(path in this.wsf)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      return socket.destroy();
    }

    // 处理升级
    this.wss.handleUpgrade(req, socket, head, conn => {
      BotUtil.makeLog("debug", chalk.green(`✓ WebSocket连接建立: ${req.url}`), 'Server');

      // 设置事件处理
      conn.on("error", err => BotUtil.makeLog("error", err, 'Server'));
      conn.on("close", () => BotUtil.makeLog("debug", chalk.gray(`WebSocket断开: ${req.url}`), 'Server'));

      // 消息处理
      conn.on("message", msg => {
        const logMsg = Buffer.isBuffer(msg) && msg.length > 1024 ?
          `[Binary message, length: ${msg.length}]` : BotUtil.String(msg);
        BotUtil.makeLog("trace", `WS消息: ${logMsg}`, 'Server');
      });

      // 扩展发送方法
      conn.sendMsg = msg => {
        if (!Buffer.isBuffer(msg)) msg = BotUtil.String(msg);
        BotUtil.makeLog("trace", `WS发送: ${msg}`, 'Server');
        return conn.send(msg);
      };

      // 调用处理函数
      for (const handler of this.wsf[path]) {
        handler(conn, req, socket, head);
      }
    });
  }

  /**
   * 端口占用错误处理
   * @async
   * @param {Error} err - 错误对象
   * @param {boolean} isHttps - 是否为HTTPS
   */
  async serverEADDRINUSE(err, isHttps) {
    const serverType = isHttps ? 'HTTPS' : 'HTTP';
    const port = isHttps ? this.httpsPort : this.httpPort;

    BotUtil.makeLog("error", chalk.red(`✗ ${serverType}端口 ${port} 已被占用`), 'Server');

    // 重试计数
    const retryKey = isHttps ? 'https_retry_count' : 'http_retry_count';
    this[retryKey] = (this[retryKey] || 0) + 1;

    // 延迟重试
    await BotUtil.sleep(this[retryKey] * 1000);

    // 重新监听
    const server = isHttps ? this.httpsServer : this.server;
    const host = cfg.server?.host || '0.0.0.0';

    if (server) {
      server.listen(port, host);
    }
  }

  /**
   * 加载域名SSL证书
   * @private
   * @async
   */
  async _loadDomainCertificates() {
    if (!this.proxyEnabled) return {};

    const certificates = {};

    for (const [domain, config] of this.proxyDomains) {
      if (!config.ssl?.enabled) continue;

      const cert = config.ssl.certificate;
      if (!cert?.key || !cert?.cert) continue;

      try {
        // 检查证书文件
        if (!fsSync.existsSync(cert.key)) {
          throw new Error(`SSL密钥文件不存在: ${cert.key}`);
        }

        if (!fsSync.existsSync(cert.cert)) {
          throw new Error(`SSL证书文件不存在: ${cert.cert}`);
        }

        // 读取证书
        const sslContext = {
          key: await fs.readFile(cert.key),
          cert: await fs.readFile(cert.cert)
        };

        if (cert.ca && fsSync.existsSync(cert.ca)) {
          sslContext.ca = await fs.readFile(cert.ca);
        }

        certificates[domain] = sslContext;

        BotUtil.makeLog('info', chalk.green(`✓ 加载SSL证书: ${domain}`), 'SSL');

      } catch (err) {
        BotUtil.makeLog('error', chalk.red(`✗ 加载SSL证书失败 [${domain}]: ${err.message}`), 'SSL');
      }
    }

    return certificates;
  }

  /**
   * 创建SNI回调
   * @private
   */
  _createSNICallback(certificates) {
    return (servername, cb) => {
      servername = servername.toLowerCase();
      
      // 精确匹配
      if (certificates[servername]) {
        return cb(null, require('tls').createSecureContext(certificates[servername]));
      }

      // 通配符匹配
      for (const [pattern, context] of Object.entries(certificates)) {
        if (pattern.startsWith('*.')) {
          const baseDomain = pattern.slice(2);
          if (servername.endsWith(baseDomain)) {
            return cb(null, require('tls').createSecureContext(context));
          }
        }
      }

      // 使用默认证书
      cb(null, null);
    };
  }

  /**
   * 加载服务器
   * @async
   * @param {boolean} isHttps - 是否为HTTPS
   */
  async serverLoad(isHttps) {
    const server = isHttps ? this.httpsServer : this.server;
    const port = isHttps ? this.httpsPort : this.httpPort;
    const host = cfg.server?.host || '0.0.0.0';

    if (!server) return;

    // 开始监听
    server.listen(port, host);

    // 等待监听成功
    await BotUtil.promiseEvent(server, "listening", isHttps && "error").catch(() => { });

    const serverInfo = server.address();
    if (!serverInfo) {
      BotUtil.makeLog('error',
        chalk.red(`✗ ${isHttps ? 'HTTPS' : 'HTTP'}服务器未能成功启动`), 'Server');
      return;
    }

    // 更新端口
    if (isHttps) {
      this.httpsPort = serverInfo.port;
    } else {
      this.httpPort = serverInfo.port;
    }

    // 获取地址信息
    const protocol = isHttps ? 'https' : 'http';
    const serverType = isHttps ? 'HTTPS' : 'HTTP';

    // 美化的服务器启动日志
    console.log(chalk.cyan('\n╔════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.green.bold(`  ${cfg.server?.name || 'Yunzai'} ${serverType} Server Started Successfully!  `) + chalk.cyan('║'));
    console.log(chalk.cyan('╚════════════════════════════════════════════════════════════╝\n'));

    BotUtil.makeLog("info",
      chalk.green(`✓ ${serverType}监听地址: ${host}:${serverInfo.port}`), 'Server');

    // 显示访问地址
    if (!isHttps) {
      await this._displayAccessUrls(protocol, serverInfo.port);
    } else {
      await this._displayHttpsGuide();
    }
  }

  /**
   * 显示HTTPS配置指南
   * @private
   * @async
   */
  async _displayHttpsGuide() {
    const domain = cfg.server?.url || 'your-domain.com';
    
    // 如果启用了反向代理，显示配置的域名
    if (this.proxyEnabled && this.proxyDomains.size > 0) {
      console.log(chalk.yellow('\n╔════════════════════════════════════════════════════════════╗'));
      console.log(chalk.yellow('║') + chalk.white.bold('           HTTPS 反向代理已配置                            ') + chalk.yellow('║'));
      console.log(chalk.yellow('╚════════════════════════════════════════════════════════════╝\n'));

      console.log(chalk.cyan('▶ 已配置的域名:'));
      console.log(chalk.gray('─'.repeat(60)));
      
      for (const [domain, config] of this.proxyDomains) {
        const ssl = config.ssl?.enabled ? chalk.green(' [SSL]') : '';
        const proxy = config.target ? chalk.yellow(` → ${config.target}`) : '';
        const staticRoot = config.staticRoot ? chalk.gray(` (${config.staticRoot})`) : '';
        
        console.log(`  ${chalk.cyan('•')} ${chalk.white(domain)}${ssl}${proxy}${staticRoot}`);
      }
      
      console.log(chalk.gray('─'.repeat(60)) + '\n');
      return;
    }
    
    console.log(chalk.yellow('\n╔════════════════════════════════════════════════════════════╗'));
    console.log(chalk.yellow('║') + chalk.white.bold('           HTTPS 反向代理配置指南                          ') + chalk.yellow('║'));
    console.log(chalk.yellow('╚════════════════════════════════════════════════════════════╝\n'));

    // Nginx配置示例
    console.log(chalk.cyan('▶ Nginx 配置示例:'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(chalk.green(`
server {
    listen 443 ssl http2;
    server_name ${domain};
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    # 静态文件直接访问
    location / {
        root ${process.cwd()}/www;
        index index.html index.htm;
        try_files $uri $uri/ @backend;
    }
    
    # API和动态内容代理到Node.js
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
    
    # WebSocket支持
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

  /**
   * 显示访问地址
   * @private
   * @async
   */
  async _displayAccessUrls(protocol, port) {
    const addresses = [`${protocol}://localhost:${port}`];

    // 获取IP地址信息
    const ipInfo = await this.getLocalIpAddress();

    console.log(chalk.cyan('\n▶ 访问地址:'));
    console.log(chalk.gray('─'.repeat(50)));

    // 显示内网地址
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

    // 显示公网地址
    if (ipInfo.public) {
      console.log(chalk.yellow('\n  公网访问:'));
      const publicUrl = `${protocol}://${ipInfo.public}:${port}`;
      console.log(`    ${chalk.cyan('•')} ${chalk.white(publicUrl)}`);
    }

    // 显示配置的URL
    if (cfg.server?.url) {
      console.log(chalk.yellow('\n  配置域名:'));
      const configUrl = `${protocol}://${cfg.server.url}${port !== 80 && port !== 443 ? ':' + port : ''}`;
      console.log(`    ${chalk.cyan('•')} ${chalk.white(configUrl)}`);
    }

    // 显示配置的代理域名
    if (this.proxyEnabled && this.proxyDomains.size > 0) {
      console.log(chalk.yellow('\n  代理域名:'));
      for (const domain of this.proxyDomains.keys()) {
        console.log(`    ${chalk.cyan('•')} ${chalk.white(protocol + '://' + domain)}`);
      }
    }

    // 显示API密钥
    if (cfg.server?.auth?.apiKey?.enabled !== false) {
      console.log(chalk.yellow('\n  API密钥:'));
      console.log(`    ${chalk.cyan('•')} ${chalk.white(this.apiKey)}`);
      console.log(chalk.gray(`    提示: 使用 X-API-Key 请求头传递密钥`));
    }

    console.log(chalk.gray('─'.repeat(50)) + '\n');
  }

  /**
   * 加载HTTPS服务器
   * @async
   */
  async httpsLoad() {
    const httpsConfig = cfg.server?.https;
    const proxyConfig = cfg.proxy;

    // 检查是否需要启动HTTPS
    const needHttps = httpsConfig?.enabled || (proxyConfig?.enabled && proxyConfig?.httpsPort);

    if (!needHttps) return;

    try {
      let httpsOptions = {};

      // 如果启用了代理模式
      if (this.proxyEnabled) {
        // 加载所有域名证书
        const certificates = await this._loadDomainCertificates();

        if (Object.keys(certificates).length > 0) {
          // 使用第一个证书作为默认证书
          const defaultCert = Object.values(certificates)[0];
          httpsOptions = {
            key: defaultCert.key,
            cert: defaultCert.cert,
            ca: defaultCert.ca
          };

          // 创建SNI回调以支持多域名证书
          httpsOptions.SNICallback = this._createSNICallback(certificates);
        } else if (httpsConfig?.enabled) {
          // 如果没有域名证书，使用默认证书
          const cert = httpsConfig.certificate;
          if (cert?.key && cert?.cert) {
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
        }
      } else {
        // 非代理模式，使用默认证书
        const cert = httpsConfig.certificate;
        if (!cert?.key || !cert?.cert) {
          BotUtil.makeLog("error", chalk.red("✗ HTTPS已启用但未配置证书"), 'Server');
          return;
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

      // TLS配置
      if (httpsConfig?.tls?.minVersion) {
        httpsOptions.minVersion = httpsConfig.tls.minVersion;
      }

      // 创建HTTPS服务器
      this.httpsServer = https.createServer(httpsOptions, this.express)
        .on("error", err => this._handleServerError(err, true))
        .on("upgrade", this.wsConnect.bind(this));

      // 启动服务器
      await this.serverLoad(true);

      BotUtil.makeLog("info", chalk.green("✓ HTTPS服务器已启动"), 'Server');

    } catch (err) {
      BotUtil.makeLog("error", chalk.red(`✗ HTTPS服务器创建失败: ${err.message}`), 'Server');
    }
  }

  /**
   * 设置404和错误处理（最后注册）
   * @private
   */
  _setupFinalHandlers() {
    // 404处理
    this.express.use((req, res) => {
      if (req.accepts('html')) {
        // 根据域名配置查找404页面
        let custom404Path = path.join(process.cwd(), 'www', '404.html');
        
        if (req.domainConfig?.staticRoot) {
          const domainCustom404 = path.join(
            path.resolve(process.cwd(), req.domainConfig.staticRoot), 
            '404.html'
          );
          if (fsSync.existsSync(domainCustom404)) {
            custom404Path = domainCustom404;
          }
        }
        
        if (fsSync.existsSync(custom404Path)) {
          res.status(404).sendFile(custom404Path);
        } else {
          res.redirect('/');
        }
      } else {
        // 对API请求，返回JSON错误
        res.status(404).json({
          error: 'Not Found',
          path: req.path,
          timestamp: Date.now()
        });
      }
    });

    // 错误处理
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

  /**
   * 关闭服务器
   * @async
   */
  async closeServer() {
    BotUtil.makeLog('info', chalk.yellow('⏳ 正在关闭服务器...'), 'Server');

    // 关闭服务器
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

  /**
   * 获取服务器URL
   * @returns {string} 服务器URL
   */
  getServerUrl() {
    const protocol = cfg.server?.https?.enabled ? 'https' : 'http';
    const port = protocol === 'https' ? this.httpsPort : this.httpPort;
    const host = cfg.server?.url || 'localhost';

    // 标准端口不显示
    const needPort = (protocol === 'http' && port !== 80) || 
                     (protocol === 'https' && port !== 443);
    
    return `${protocol}://${host}${needPort ? ':' + port : ''}`;
  }

  /**
   * 获取本地IP地址
   * @async
   * @returns {Promise<Object>} IP地址信息
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

      // 收集本地IP
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

      // 获取主要IP
      try {
        result.primary = await this._getIpByUdp();
        const existingItem = result.local.find(item => item.ip === result.primary);
        if (existingItem) {
          existingItem.primary = true;
        }
      } catch { }

      // 获取公网IP
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

  /**
   * 检查是否为虚拟网络接口
   * @private
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
   * 通过UDP获取本机IP
   * @private
   * @async
   */
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

  /**
   * 获取公网IP
   * @private
   * @async
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
   * 验证IP地址格式
   * @private
   */
  _isValidIP(ip) {
    if (!ip) return false;

    const ipv4Regex = /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
    return ipv4Regex.test(ip);
  }

  /**
   * 运行服务器
   * @async
   * @param {Object} options - 选项
   * @returns {Promise<void>}
   */
  async run(options = {}) {
    const { port } = options;

    // 检查是否启用代理模式
    if (this.proxyEnabled && cfg.proxy?.httpPort) {
      // 代理模式使用配置的端口
      this.httpPort = cfg.proxy.httpPort || 80;
      this.httpsPort = cfg.proxy.httpsPort || 443;
      
      BotUtil.makeLog('info', 
        chalk.yellow(`⚡ 代理模式: HTTP=${this.httpPort}, HTTPS=${this.httpsPort}`), 
        'Server');
    } else {
      // 普通模式使用传入的端口
      this.httpPort = port;
      this.httpsPort = port + 1;
    }

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

    // 初始化所有中间件和基础路由
    this._initializeMiddlewareAndRoutes();

    // 注册API路由
    await ApiLoader.register(this.express, this);

    // 设置404和错误处理
    this._setupFinalHandlers();

    // 启动服务器
    await this.serverLoad(false);

    // 启动HTTPS
    if (cfg.server?.https?.enabled || (this.proxyEnabled && cfg.proxy?.httpsPort)) {
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
      apis: ApiLoader.getApiList(),
      proxy: this.proxyEnabled ? {
        domains: Array.from(this.proxyDomains.keys())
      } : null
    });
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