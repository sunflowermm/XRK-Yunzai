import path from 'path';
import fs from 'node:fs/promises';
import PluginsLoader from "./plugins/loader.js";
import ListenerLoader from "./listener/loader.js";
import ApiLoader from "./http/loader.js";
import init from "./config/loader.js";
import { EventEmitter } from "events";
import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import * as fsSync from 'fs';
import BotUtil from './common/util.js';
import cfg from './config/config.js';
import os from 'node:os';
import dgram from 'node:dgram';
import crypto from 'crypto';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

export default class Bot extends EventEmitter {
  stat = { start_time: Date.now() / 1000 };
  bot = this;
  bots = {};
  uin = Object.assign([], {
    toJSON() {
      if (!this.now) {
        switch (this.length) {
          case 0: return "";
          case 1:
          case 2: return this[this.length - 1];
        }
        const array = this.slice(1);
        this.now = array[Math.floor(Math.random() * array.length)];
        setTimeout(() => delete this.now, 60000);
      }
      return this.now;
    },
    toString(raw, ...args) {
      return raw === true ? this.__proto__.toString.apply(this, args) : this.toJSON().toString(raw, ...args);
    },
    includes(value) {
      return this.some(i => i == value);
    }
  });
  adapter = [];
  express = Object.assign(express(), { skip_auth: [], quiet: [] });
  server = http.createServer(this.express)
    .on("error", err => {
      if (typeof this[`server${err.code}`] === "function") return this[`server${err.code}`](err);
      BotUtil.makeLog("error", err, "Server");
    })
    .on("upgrade", this.wsConnect.bind(this));

  wss = new WebSocketServer({ noServer: true });
  wsf = Object.create(null);
  fs = Object.create(null);
  apiKey = '';
  _cache = null;
  _rateLimiters = new Map();

  constructor() {
    super();

    this.ApiLoader = ApiLoader;
    this._cache = BotUtil.getMap('yunzai_cache', { ttl: 60000, autoClean: true });

    // 基础中间件配置
    this.setupMiddleware();
    
    // 设置静态文件服务
    this.setupStaticServing();
    
    // API路由配置
    this.setupAPIRoutes();

    // 进程信号处理
    process.on('SIGINT', async () => await this.closeServer());
    process.on('SIGTERM', async () => await this.closeServer());

    // 生成API密钥
    this.generateApiKey();

    return new Proxy(this.bots, {
      get: (target, prop) => {
        const value = target[prop];
        if (value !== undefined) return value;

        const thisValue = this[prop];
        if (thisValue !== undefined) return thisValue;

        const utilValue = BotUtil[prop];
        if (utilValue !== undefined) {
          if (typeof utilValue === 'function') {
            return utilValue.bind(BotUtil);
          }
          return utilValue;
        }

        for (const i of [this.uin.toString(), ...this.uin]) {
          const bot = target[i];
          if (bot && bot[prop] !== undefined) {
            BotUtil.makeLog("trace", `因不存在 Bot.${prop} 而重定向到 Bot.${i}.${prop}`);
            if (typeof bot[prop] === "function" && typeof bot[prop].bind === "function") {
              return bot[prop].bind(bot);
            }
            return bot[prop];
          }
        }
        BotUtil.makeLog("trace", `不存在 Bot.${prop}`);
        return undefined;
      }
    });
  }

  setupMiddleware() {
    // 使用压缩
    if (cfg.server?.compression !== false) {
      this.express.use(compression({
        filter: (req, res) => {
          if (req.headers['x-no-compression']) return false;
          return compression.filter(req, res);
        },
        level: 6
      }));
    }

    // 安全头部 - 根据配置调整
    if (cfg.server?.security?.helmet !== false) {
      this.express.use(helmet({
        contentSecurityPolicy: cfg.server?.security?.csp || false,
        crossOriginEmbedderPolicy: false
      }));
    }

    // CORS配置
    this.express.use((req, res, next) => {
      const allowedOrigins = cfg.server?.cors?.origins || ['*'];
      const origin = req.headers.origin;
      
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin || '*');
      }
      
      res.header('Access-Control-Allow-Methods', cfg.server?.cors?.methods || 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', cfg.server?.cors?.headers || 'Origin, X-Requested-With, Content-Type, Accept, X-API-Key, Authorization');
      res.header('Access-Control-Allow-Credentials', cfg.server?.cors?.credentials ? 'true' : 'false');
      
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });

    // 请求日志中间件
    if (cfg.server?.logging?.requests !== false) {
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
  }

  setupStaticServing() {
    // 获取配置的静态文件目录
    const staticDirs = cfg.server?.static || [
      { 
        route: '/www', 
        path: 'www',
        options: {
          index: true,
          dotfiles: 'deny',
          extensions: ['html', 'htm'],
          fallthrough: true,
          maxAge: '1d'
        }
      }
    ];

    // 设置每个静态目录
    staticDirs.forEach(dir => {
      const dirPath = path.isAbsolute(dir.path) 
        ? dir.path 
        : path.join(process.cwd(), dir.path);

      // 确保目录存在
      if (!fsSync.existsSync(dirPath)) {
        fsSync.mkdirSync(dirPath, { recursive: true });
      }

      // 配置静态文件中间件
      const staticOptions = {
        index: dir.options?.index !== false ? ['index.html', 'index.htm'] : false,
        dotfiles: dir.options?.dotfiles || 'deny',
        extensions: dir.options?.extensions || false,
        fallthrough: dir.options?.fallthrough !== false,
        maxAge: dir.options?.maxAge || '1d',
        etag: dir.options?.etag !== false,
        lastModified: dir.options?.lastModified !== false,
        setHeaders: (res, filePath, stat) => {
          // 设置正确的MIME类型
          const ext = path.extname(filePath).toLowerCase();
          const mimeTypes = {
            '.html': 'text/html; charset=utf-8',
            '.htm': 'text/html; charset=utf-8',
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
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
            '.otf': 'font/otf',
            '.mp3': 'audio/mpeg',
            '.mp4': 'video/mp4',
            '.webm': 'video/webm',
            '.pdf': 'application/pdf',
            '.zip': 'application/zip',
            '.xml': 'application/xml',
            '.txt': 'text/plain; charset=utf-8',
            '.md': 'text/markdown; charset=utf-8',
            '.yaml': 'text/yaml; charset=utf-8',
            '.yml': 'text/yaml; charset=utf-8'
          };

          if (mimeTypes[ext]) {
            res.setHeader('Content-Type', mimeTypes[ext]);
          }

          // 安全头部
          res.setHeader('X-Content-Type-Options', 'nosniff');
          
          // 缓存控制
          if (ext === '.html' || ext === '.htm') {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
          } else if (ext === '.css' || ext === '.js') {
            res.setHeader('Cache-Control', `public, max-age=${dir.options?.maxAge || 86400}`);
          } else if (ext === '.json') {
            res.setHeader('Cache-Control', 'no-cache');
          }

          // 自定义头部
          if (dir.options?.headers) {
            Object.entries(dir.options.headers).forEach(([key, value]) => {
              res.setHeader(key, value);
            });
          }
        }
      };

      // 安全中间件 - 防止路径遍历
      this.express.use(dir.route, (req, res, next) => {
        const normalizedPath = path.normalize(req.path);
        
        // 检查路径遍历攻击
        if (normalizedPath.includes('..')) {
          return res.status(403).json({ error: 'Forbidden' });
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
          pattern instanceof RegExp ? pattern.test(normalizedPath) : normalizedPath.includes(pattern)
        )) {
          return res.status(404).json({ error: 'Not Found' });
        }

        next();
      });

      // 应用静态文件服务
      this.express.use(dir.route, express.static(dirPath, staticOptions));

      // 目录浏览（可选）
      if (dir.options?.browse) {
        this.express.use(dir.route, this.createDirectoryListing(dirPath));
      }

      BotUtil.makeLog('info', `静态文件服务: ${dir.route} -> ${dirPath}`, 'Server');
    });

    // 处理favicon
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

  setupAPIRoutes() {
    // 速率限制配置
    if (cfg.server?.rateLimit?.enabled !== false) {
      const createLimiter = (options) => rateLimit({
        windowMs: options.windowMs || 15 * 60 * 1000,
        max: options.max || 100,
        message: options.message || 'Too many requests',
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) => this.isLocalConnection(req.ip)
      });

      // API速率限制
      this.express.use('/api', createLimiter(cfg.server?.rateLimit?.api || {
        windowMs: 15 * 60 * 1000,
        max: 100
      }));
    }

    // 认证中间件
    this.express.use(this.serverAuth.bind(this));

    // 状态端点
    this.express.use('/status', this.serverStatus.bind(this));

    // 健康检查
    this.express.get('/health', (req, res) => {
      res.json({ 
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: Date.now()
      });
    });

    // 请求体解析
    this.express.use(express.urlencoded({ 
      extended: false, 
      limit: cfg.server?.limits?.urlencoded || '10mb' 
    }));
    this.express.use(express.json({ 
      limit: cfg.server?.limits?.json || '10mb' 
    }));
    this.express.use(express.raw({ 
      limit: cfg.server?.limits?.raw || '10mb' 
    }));
    this.express.use(express.text({ 
      limit: cfg.server?.limits?.text || '10mb' 
    }));

    // 请求处理
    this.express.use(this.serverHandle.bind(this));

    // 文件服务
    this.express.use('/File', this.fileSend.bind(this));
  }

  async generateApiKey() {
    const apiKeyPath = path.join(process.cwd(), 'config/server_config/api_key.json');

    try {
      if (fsSync.existsSync(apiKeyPath)) {
        const keyData = JSON.parse(await fs.readFile(apiKeyPath, 'utf8'));
        this.apiKey = keyData.key;
        if (BotUtil) BotUtil.apiKey = this.apiKey;
        return this.apiKey;
      } else {
        this.apiKey = BotUtil.randomString(64, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
        const apiKeyDir = path.dirname(apiKeyPath);
        await BotUtil.mkdir(apiKeyDir);
        const apiKeyData = {
          key: this.apiKey,
          generated: new Date().toISOString(),
          note: '此密钥用于远程API访问，请妥善保管'
        };

        await fs.writeFile(apiKeyPath, JSON.stringify(apiKeyData, null, 2), 'utf8');

        if (process.platform !== 'win32') {
          try {
            await fs.chmod(apiKeyPath, 0o600);
          } catch { }
        }

        if (BotUtil) BotUtil.apiKey = this.apiKey;

        BotUtil.makeLog('success', `生成新的API密钥: ${this.apiKey}`, 'Server');
        return this.apiKey;
      }
    } catch (error) {
      BotUtil.makeLog('error', `API密钥处理失败: ${error.message}`, 'Server');
      this.apiKey = BotUtil.randomString(64);
      if (BotUtil) BotUtil.apiKey = this.apiKey;
      return this.apiKey;
    }
  }

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

    const authKey = req.headers?.["x-api-key"] ?? 
                   req.headers?.["authorization"]?.replace('Bearer ', '') ??
                   req.query?.api_key ?? 
                   req.body?.api_key;

    if (!this.apiKey || !authKey) {
      BotUtil.makeLog("debug", `API鉴权失败: 缺少密钥`, 'Server');
      return false;
    }

    try {
      const authKeyBuffer = Buffer.from(String(authKey));
      const apiKeyBuffer = Buffer.from(String(this.apiKey));

      if (authKeyBuffer.length !== apiKeyBuffer.length) {
        BotUtil.makeLog("warn", `来自 ${remoteAddress} 的未授权API访问尝试`, 'Server');
        return false;
      }

      const isValid = crypto.timingSafeEqual(authKeyBuffer, apiKeyBuffer);

      if (!isValid) {
        BotUtil.makeLog("warn", `来自 ${remoteAddress} 的未授权API访问尝试`, 'Server');
      }

      return isValid;
    } catch (error) {
      BotUtil.makeLog("error", `API鉴权错误: ${error.message}`, 'Server');
      return false;
    }
  }

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

  isPrivateIP(ip) {
    if (!ip) return false;

    const ipv4Private = [
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^127\./,
      /^169\.254\./,
      /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./
    ];

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

  async getPublicIP() {
    const apis = [
      { url: 'https://api.ipify.org?format=json', field: 'ip' },
      { url: 'https://api.myip.la/json', field: 'ip' },
      { url: 'https://api.ip.sb/geoip', field: 'ip' }
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
          const ip = api.field.split('.').reduce((obj, key) => obj?.[key], data);
          if (ip && this.isValidIP(ip)) return ip;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  isValidIP(ip) {
    if (!ip) return false;

    const ipv4Regex = /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
    if (ipv4Regex.test(ip)) return true;

    const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
    return ipv6Regex.test(ip);
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

      try {
        const primaryIp = await this.getIpByUdp();
        if (primaryIp) {
          result.primary = primaryIp;
          if (!result.local.some(item => item.ip === primaryIp)) {
            result.local.unshift({
              ip: primaryIp,
              interface: 'auto-detected',
              primary: true
            });
          } else {
            result.local.find(item => item.ip === primaryIp).primary = true;
          }
        }
      } catch { }

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

  isVirtualInterface(name, mac) {
    const virtualPatterns = [
      /^(docker|br-|veth|virbr|vnet)/i,
      /^(vmnet|vmware)/i,
      /^(vboxnet|virtualbox)/i,
      /^(utun|tap|tun)/i,
      /^eth\d+$/i
    ];

    if (virtualPatterns.some(p => p.test(name))) return true;

    const virtualMacPrefixes = [
      '00:50:56', '00:0c:29', '00:05:69', '00:1c:42',
      '08:00:27', '00:15:5d', '02:42:', '00:16:3e', '52:54:00'
    ];

    if (mac && virtualMacPrefixes.some(prefix =>
      mac.toLowerCase().startsWith(prefix.toLowerCase())
    )) {
      return true;
    }

    return false;
  }

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

  getServerUrl() {
    const host = cfg.server.url ? cfg.server.url : `http://localhost`;
    return `${host}:${this.port}`;
  }

  serverAuth(req, res, next) {
    req.rid = `${req.ip}:${req.socket.remotePort}`;
    req.sid = `${req.protocol}://${req.hostname}:${req.socket.localPort}${req.originalUrl}`;

    // 跳过静态资源认证
    const skipAuthPaths = cfg.server?.auth?.skip || [
      '/www',
      '/public',
      '/static', 
      '/media',
      '/favicon.ico',
      '/health',
      '/api/files'
    ];

    if (skipAuthPaths.some(path => req.path.startsWith(path))) {
      return next();
    }

    const clientIp = req.ip.replace(/^::ffff:/, '');

    if (this.isLocalConnection(clientIp)) {
      BotUtil.makeLog("debug", ["本地连接，跳过鉴权", clientIp], 'Server');
      return next();
    }

    if (!this.checkApiAuthorization(req)) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or missing API key',
        hint: 'Please provide X-API-Key header or api_key parameter'
      });
      BotUtil.makeLog("error", ["HTTP鉴权失败", req.method, req.originalUrl, "来自", req.ip], 'Server');
      return;
    }

    next();
  }

  serverStatus(req, res) {
    res.type("json");
    res.send(JSON.stringify(process.report.getReport()).replace(/(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)/g, "[IPv4]"));
  }

  serverHandle(req, res, next) {
    const quiet = this.express.quiet.some(i => req.originalUrl.startsWith(i));
    if (!quiet) {
      BotUtil.makeLog("debug", ["HTTP", req.method, req.originalUrl], 'Server');
    }
    next();
  }

  async closeServer() {
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    if (this.httpsServer) await new Promise(resolve => this.httpsServer.close(resolve));
    await BotUtil.sleep(2000);
    await this.redisExit();
  }

  wsConnect(req, socket, head) {
    req.rid = `${req.socket.remoteAddress}:${req.socket.remotePort}-${req.headers["sec-websocket-key"]}`;
    req.sid = `ws://${req.headers["x-forwarded-host"] ?? req.headers.host ?? `${req.socket.localAddress}:${req.socket.localPort}`}${req.url}`;
    req.query = Object.fromEntries(new URL(req.sid).searchParams.entries());
    const remoteAddress = req.socket.remoteAddress;

    if (!this.isLocalConnection(remoteAddress)) {
      if (!this.checkApiAuthorization(req)) {
        BotUtil.makeLog("error", ["WebSocket鉴权失败", req.url], 'Server');
        return socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"), socket.destroy();
      }
    }

    const path = req.url.split("/")[1];
    if (!(path in this.wsf)) {
      return socket.write("HTTP/1.1 404 Not Found\r\n\r\n"), socket.destroy();
    }

    this.wss.handleUpgrade(req, socket, head, conn => {
      BotUtil.makeLog("debug", ["WebSocket连接建立", req.url], 'Server');
      conn.on("error", err => BotUtil.makeLog("error", err, 'Server'));
      conn.on("close", () => BotUtil.makeLog("debug", ["WebSocket断开", req.url], 'Server'));
      conn.on("message", msg => {
        const logMsg = Buffer.isBuffer(msg) && msg.length > 1024
          ? `[Binary message, length: ${msg.length}]`
          : BotUtil.String(msg);
        BotUtil.makeLog("trace", ["WS消息", logMsg], 'Server');
      });
      conn.sendMsg = msg => {
        if (!Buffer.isBuffer(msg)) msg = BotUtil.String(msg);
        const logMsg = Buffer.isBuffer(msg) && msg.length > 1024
          ? `[Binary send, length: ${msg.length}]`
          : msg;
        BotUtil.makeLog("trace", ["WS发送", logMsg], 'Server');
        return conn.send(msg);
      };
      for (const i of this.wsf[path]) i(conn, req, socket, head);
    });
  }

  async serverEADDRINUSE(err, https) {
    BotUtil.makeLog("error", ["端口", this.port, "已被占用"], 'Server');
    if (!https) {
      this.server_listen_time = this.server_listen_time ? this.server_listen_time + 1 : 1;
      await BotUtil.sleep(this.server_listen_time * 1000);
      this.server.listen(this.port);
    }
  }

  async serverLoad(https) {
    const server = https ? "httpsServer" : "server";
    const port = this.port;
    this[server].listen(port, cfg.server?.host || '0.0.0.0');
    await BotUtil.promiseEvent(this[server], "listening", https && "error").catch(() => { });
    const { address, port: listenedPort } = this[server].address();

    const ipInfo = await this.getLocalIpAddress();
    const protocol = https ? 'https' : 'http';

    this.url = cfg.server.url ? `${cfg.server.url}:${listenedPort}` : `${protocol}://${address}:${listenedPort}`;

    BotUtil.makeLog("info", `${cfg.server.name} 启动成功`, 'Server');
    BotUtil.makeLog("info", `API密钥: ${this.apiKey}`, 'Server');

    const addresses = [];
    addresses.push(`${protocol}://localhost:${listenedPort}`);

    if (ipInfo.local.length > 0) {
      BotUtil.makeLog("info", "内网访问地址:", 'Server');
      ipInfo.local.forEach(info => {
        const url = `${protocol}://${info.ip}:${listenedPort}`;
        const label = info.primary ? ' (主要)' : info.virtual ? ' (虚拟)' : '';
        BotUtil.makeLog("info", `  ${url} [${info.interface}]${label}`, 'Server');
        addresses.push(url);
      });
    }

    if (ipInfo.public) {
      const publicUrl = `${protocol}://${ipInfo.public}:${listenedPort}`;
      BotUtil.makeLog("info", `外网访问地址: ${publicUrl}`, 'Server');
      addresses.push(publicUrl);
    }

    if (cfg.server.url) {
      BotUtil.makeLog("info", `配置地址: ${cfg.server.url}:${listenedPort}`, 'Server');
    }

    // 显示静态文件目录
    const staticDirs = cfg.server?.static || [{ route: '/www', path: 'www' }];
    staticDirs.forEach(dir => {
      BotUtil.makeLog("info", `静态目录: ${addresses[0]}${dir.route}`, 'Server');
    });
  }

  async httpsLoad() {
    if (!cfg.server.https?.enabled || !cfg.server.https?.key || !cfg.server.https?.cert) return;
    try {
      this.httpsServer = (await import("node:https")).createServer({
        key: await fs.readFile(cfg.server.https.key),
        cert: await fs.readFile(cfg.server.https.cert),
      }, this.express)
        .on("error", err => {
          if (typeof this[`server${err.code}`] === "function") return this[`server${err.code}`](err, true);
          BotUtil.makeLog("error", err, 'Server');
        })
        .on("upgrade", this.wsConnect.bind(this));
      await this.serverLoad(true);
    } catch (err) {
      BotUtil.makeLog("error", ["HTTPS服务器创建失败", err.message], 'Server');
    }
  }

  async run(options = {}) {
    const { port } = options;
    this.port = port;

    await init();
    await this.generateApiKey();
    await PluginsLoader.load();
    await ApiLoader.load();
    await ApiLoader.register(this.express, this);
    await this.serverLoad(false);
    if (cfg.server.https?.enabled) await this.httpsLoad();

    // 设置404处理
    this.express.use((req, res) => {
      const defaultRoute = cfg.server?.defaultRoute || '/www';
      if (req.accepts('html')) {
        res.redirect(defaultRoute);
      } else {
        res.status(404).json({ error: 'Not Found' });
      }
    });

    await Promise.all([ListenerLoader.load()]);
    await ApiLoader.watch(true);

    if (Object.keys(this.wsf).length > 0) {
      BotUtil.makeLog("info", `WebSocket服务: ${this.url.replace(/^http/, "ws")}/ [${Object.keys(this.wsf).join(', ')}]`, 'Server');
    }

    this.emit("online", {
      bot: this,
      timestamp: Date.now(),
      url: this.url,
      uptime: process.uptime(),
      apis: ApiLoader.getApiList()
    });
  }

  async fileToUrl(file, opts = {}) {
    return await BotUtil.fileToUrl(file, opts);
  }

  fileSend(req, res) {
    const url = req.url.replace(/^\//, "");
    let file = this.fs[url];
    if (!file) {
      file = this.fs[404];
      if (!file) {
        return res.status(404).send('Not Found');
      }
    }

    if (typeof file.times === "number") {
      if (file.times > 0) {
        file.times--;
      } else {
        file = this.fs.timeout;
        if (!file) {
          return res.status(410).send('Gone');
        }
      }
    }

    if (file.type?.mime) res.setHeader("Content-Type", file.type.mime);
    BotUtil.makeLog("debug", `文件发送: ${file.name} (${BotUtil.formatFileSize(file.buffer.length)})`, 'Server');
    res.send(file.buffer);
  }

  prepareEvent(data) {
    if (!this.bots[data.self_id]) return;

    if (!data.bot) {
      Object.defineProperty(data, "bot", { value: this.bots[data.self_id] });
    }

    if (data.post_type === 'device' || data.device_id) {
      const deviceBot = this.bots[data.device_id];
      if (deviceBot) {
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
    }

    if (data.user_id) {
      if (!data.friend) {
        Object.defineProperty(data, "friend", {
          value: data.bot.pickFriend(data.user_id)
        });
      }
      data.sender ||= { user_id: data.user_id };
      data.sender.nickname ||= data.friend?.name || data.friend?.nickname;
    }

    if (data.group_id) {
      if (!data.group) {
        Object.defineProperty(data, "group", {
          value: data.bot.pickGroup(data.group_id)
        });
      }
      data.group_name ||= data.group?.name || data.group?.group_name;
    }

    if (data.group && data.user_id) {
      if (!data.member) {
        Object.defineProperty(data, "member", {
          value: data.group.pickMember(data.user_id)
        });
      }
      data.sender.nickname ||= data.member?.name || data.member?.nickname;
      data.sender.card ||= data.member?.card;
    }

    if (data.bot.adapter?.id) data.adapter_id = data.bot.adapter.id;
    if (data.bot.adapter?.name) data.adapter_name = data.bot.adapter.name;

    for (const i of [data.friend, data.group, data.member]) {
      if (typeof i !== "object" || !i) continue;

      i.sendFile ??= (file, name) => i.sendMsg(segment.file(file, name));
      i.makeForwardMsg ??= this.makeForwardMsg;
      i.sendForwardMsg ??= msg => this.sendForwardMsg(msg => i.sendMsg(msg), msg);
      i.getInfo ??= () => i.info || i;
    }

    if (!data.reply) {
      if (data.group?.sendMsg) {
        data.reply = data.group.sendMsg.bind(data.group);
      } else if (data.friend?.sendMsg) {
        data.reply = data.friend.sendMsg.bind(data.friend);
      }
    }
  }

  em(name = "", data = {}) {
    this.prepareEvent(data);
    while (true) {
      this.emit(name, data);
      const i = name.lastIndexOf(".");
      if (i === -1) break;
      name = name.slice(0, i);
    }
  }

  // Bot管理方法保持不变...
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

  getFriendList() {
    const array = [];
    for (const bot_id of this.uin) {
      const bot = this.bots[bot_id];
      if (!bot?.fl) continue;
      array.push(...bot.fl.keys());
    }
    return array;
  }

  getFriendMap() {
    const map = new Map;
    for (const bot_id of this.uin) {
      const bot = this.bots[bot_id];
      if (!bot?.fl) continue;
      for (const [id, i] of bot.fl) {
        map.set(id, { ...i, bot_id });
      }
    }
    return map;
  }
  get fl() { return this.getFriendMap(); }

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

  getGroupList() {
    const array = [];
    for (const bot_id of this.uin) {
      const bot = this.bots[bot_id];
      if (!bot?.gl) continue;
      array.push(...bot.gl.keys());
    }
    return array;
  }

  getGroupMap() {
    const map = new Map;
    for (const bot_id of this.uin) {
      const bot = this.bots[bot_id];
      if (!bot?.gl) continue;
      for (const [id, i] of bot.gl) {
        map.set(id, { ...i, bot_id });
      }
    }
    return map;
  }
  get gl() { return this.getGroupMap(); }

  get gml() {
    const map = new Map;
    for (const bot_id of this.uin) {
      const bot = this.bots[bot_id];
      if (!bot?.gml) continue;
      for (const [id, i] of bot.gml) {
        map.set(id, Object.assign(new Map(i), { bot_id }));
      }
    }
    return map;
  }

  pickFriend(user_id, strict) {
    user_id = Number(user_id) === user_id ? Number(user_id) : user_id;
    const mainBot = this.bots[this.uin];
    if (mainBot?.fl?.has(user_id)) return mainBot.pickFriend(user_id);

    let user = this.fl.get(user_id);
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

    if (user) return this.bots[user.bot_id].pickFriend(user_id);
    if (strict) return false;

    BotUtil.makeLog("trace", ["因不存在用户", user_id, "而随机选择Bot", this.uin.toJSON()], 'Server');
    return this.bots[this.uin].pickFriend(user_id);
  }
  get pickUser() { return this.pickFriend; }

  pickGroup(group_id, strict) {
    group_id = Number(group_id) === group_id ? Number(group_id) : group_id;
    const mainBot = this.bots[this.uin];
    if (mainBot?.gl?.has(group_id)) return mainBot.pickGroup(group_id);

    const group = this.gl.get(group_id);
    if (group) return this.bots[group.bot_id].pickGroup(group_id);
    if (strict) return false;

    BotUtil.makeLog("trace", ["因不存在群", group_id, "而随机选择Bot", this.uin.toJSON()], 'Server');
    return this.bots[this.uin].pickGroup(group_id);
  }

  pickMember(group_id, user_id) {
    return this.pickGroup(group_id).pickMember(user_id);
  }

  sendFriendMsg(bot_id, user_id, ...args) {
    if (!bot_id) return this.pickFriend(user_id).sendMsg(...args);
    if (this.uin.includes(bot_id) && this.bots[bot_id]) return this.bots[bot_id].pickFriend(user_id).sendMsg(...args);
    if (this.pickFriend(bot_id, true)) return this.pickFriend(bot_id).sendMsg(user_id, ...args);

    return new Promise((resolve, reject) => {
      const listener = data => { resolve(data.bot.pickFriend(user_id).sendMsg(...args)); clearTimeout(timeout); };
      const timeout = setTimeout(() => { reject(Object.assign(Error("等待 Bot 上线超时"), { bot_id, user_id, args })); this.off(`connect.${bot_id}`, listener); }, 300000);
      this.once(`connect.${bot_id}`, listener);
    });
  }

  sendGroupMsg(bot_id, group_id, ...args) {
    if (!bot_id) return this.pickGroup(group_id).sendMsg(...args);
    if (this.uin.includes(bot_id) && this.bots[bot_id]) return this.bots[bot_id].pickGroup(group_id).sendMsg(...args);
    if (this.pickGroup(bot_id, true)) return this.pickGroup(bot_id).sendMsg(group_id, ...args);

    return new Promise((resolve, reject) => {
      const listener = data => { resolve(data.bot.pickGroup(group_id).sendMsg(...args)); clearTimeout(timeout); };
      const timeout = setTimeout(() => { reject(Object.assign(Error("等待 Bot 上线超时"), { bot_id, group_id, args })); this.off(`connect.${bot_id}`, listener); }, 300000);
      this.once(`connect.${bot_id}`, listener);
    });
  }

  getTextMsg(fnc = () => true) {
    if (typeof fnc !== "function") fnc = data => data.self_id == fnc.self_id && data.user_id == fnc.user_id;
    return new Promise(resolve => {
      const listener = data => {
        if (!fnc(data)) return;
        let msg = "";
        for (const i of data.message) if (i.type === "text" && i.text) msg += i.text.trim();
        if (msg) { resolve(msg); this.off("message", listener); }
      };
      this.on("message", listener);
    });
  }

  getMasterMsg() {
    return this.getTextMsg(data => {
      if (!cfg.masterQQ) return false;
      return cfg.masterQQ.includes(String(data.user_id));
    });
  }

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
          results[user_id] = { error: "无法找到可用的Bot发送消息" };
          BotUtil.makeLog("warn", `无法向主人 ${user_id} 发送消息`, 'Server');
        }

        if (sleep && masterQQs.indexOf(user_id) < masterQQs.length - 1) {
          await BotUtil.sleep(sleep);
        }
      } catch (err) {
        results[user_id] = { error: err.message };
        BotUtil.makeLog("error", `向主人 ${user_id} 发送消息失败: ${err.message}`, 'Server');
      }
    }

    return results;
  }

  makeForwardMsg(msg) { return { type: "node", data: msg }; }

  makeForwardArray(msg = [], node = {}) {
    return this.makeForwardMsg((Array.isArray(msg) ? msg : [msg]).map(message => ({ ...node, message })));
  }

  async sendForwardMsg(send, msg) {
    return Promise.all((Array.isArray(msg) ? msg : [msg]).map(({ message }) => send(message)));
  }

  async redisExit() {
    if (!(typeof redis === 'object' && redis.process)) return false;
    const p = redis.process;
    delete redis.process;
    await BotUtil.sleep(5000, redis.save().catch(() => { }));
    return p.kill();
  }
}