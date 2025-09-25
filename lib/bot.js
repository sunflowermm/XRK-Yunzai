import path from 'path';
import fs from 'node:fs/promises';
import PluginsLoader from "./plugins/loader.js";
import ListenerLoader from "./listener/loader.js";
import ApiLoader from "./http/loader.js";
import { EventEmitter } from "events";
import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import * as fsSync from 'fs';
import BotUtil from './common/util.js';
import init from "./config/init.js";
import cfg from './config/config.js';
import os from 'node:os';
import dgram from 'node:dgram';
import crypto from 'crypto';

export default class Yunzai extends EventEmitter {
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

  constructor() {
    super();
    
    this.ApiLoader = ApiLoader;
    this._cache = BotUtil.getMap('yunzai_cache', { ttl: 60000, autoClean: true });

    this.express.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Key');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });

    this.setupWWW();

    this.express.use(this.serverAuth.bind(this))
      .use("/status", this.serverStatus.bind(this))
      .use(express.urlencoded({ extended: false }))
      .use(express.json({ limit: '10mb' }))
      .use(express.raw({ limit: '10mb' }))
      .use(express.text({ limit: '10mb' }))
      .use(this.serverHandle.bind(this))
      .use("/File", this.fileSend.bind(this));

    process.on('SIGINT', async () => await this.closeServer());
    process.on('SIGTERM', async () => await this.closeServer());

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

  async generateApiKey() {
    const apiKeyPath = path.join(process.cwd(), 'config/server_config/api_key.json');

    try {
      if (fsSync.existsSync(apiKeyPath)) {
        const keyData = JSON.parse(await fs.readFile(apiKeyPath, 'utf8'));
        this.apiKey = keyData.key;
        if (BotUtil) {
          BotUtil.apiKey = this.apiKey;
        }
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

        if (BotUtil) {
          BotUtil.apiKey = this.apiKey;
        }

        BotUtil.makeLog('success', `生成新的API密钥: ${this.apiKey}`, `${cfg.server.name}`);
        return this.apiKey;
      }
    } catch (error) {
      BotUtil.makeLog('error', `API密钥处理失败: ${error.message}`, `${cfg.server.name}`);
      this.apiKey = BotUtil.randomString(64);
      if (BotUtil) {
        BotUtil.apiKey = this.apiKey;
      }
      return this.apiKey;
    }
  }

  checkApiAuthorization(req) {
    if (!req) return false;

    const remoteAddress = req.socket?.remoteAddress ?? req.ip ?? "";

    if (this.isLocalConnection(remoteAddress)) return true;

    const authKey = req.headers?.["x-api-key"] ?? req.query?.api_key ?? req.body?.api_key;

    if (!this.apiKey || !authKey) {
      BotUtil.makeLog("debug", `API鉴权失败: 缺少密钥`, `${cfg.server.name}`);
      return false;
    }

    try {
      const authKeyBuffer = Buffer.from(String(authKey));
      const apiKeyBuffer = Buffer.from(String(this.apiKey));

      if (authKeyBuffer.length !== apiKeyBuffer.length) {
        BotUtil.makeLog("warn", `来自 ${remoteAddress} 的未授权API访问尝试`, `${cfg.server.name}`);
        return false;
      }

      const isValid = crypto.timingSafeEqual(authKeyBuffer, apiKeyBuffer);

      if (!isValid) {
        BotUtil.makeLog("warn", `来自 ${remoteAddress} 的未授权API访问尝试`, `${cfg.server.name}`);
      }

      return isValid;
    } catch (error) {
      BotUtil.makeLog("error", `API鉴权错误: ${error.message}`, `${cfg.server.name}`);
      return false;
    }
  }

  // 优化：简化本地连接检测
  isLocalConnection(address) {
    if (!address || typeof address !== 'string') return false;

    // 标准化地址
    const ip = address.toLowerCase().trim()
      .replace(/^::ffff:/, '')  // 移除IPv6映射前缀
      .replace(/%.+$/, '');      // 移除IPv6作用域标识符

    // 检查是否为本地地址
    return ip === 'localhost' ||
      ip === '127.0.0.1' ||
      ip === '::1' ||
      this.isPrivateIP(ip);
  }

  // 优化：增强私有IP检测，支持虚拟环境
  isPrivateIP(ip) {
    if (!ip) return false;

    // IPv4私有地址范围
    const ipv4Private = [
      /^10\./,                    // 10.0.0.0/8
      /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
      /^192\.168\./,              // 192.168.0.0/16
      /^127\./,                   // 127.0.0.0/8 (回环)
      /^169\.254\./,              // 169.254.0.0/16 (链路本地)
      /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./ // 100.64.0.0/10 (CGN)
    ];

    // IPv6私有地址范围
    const ipv6Private = [
      /^fe80:/i,  // 链路本地
      /^fc00:/i,  // 唯一本地
      /^fd00:/i,  // 唯一本地
      /^fec0:/i,  // 站点本地(已弃用)
      /^ff0[0-9a-f]:/i // 组播
    ];

    // 检查IPv4
    if (ip.includes('.')) {
      return ipv4Private.some(range => range.test(ip));
    }

    // 检查IPv6
    if (ip.includes(':')) {
      return ipv6Private.some(range => range.test(ip));
    }

    return false;
  }

  // 优化：获取外网IP（使用境内可访问的免费API）
  async getPublicIP() {
    const apis = [
      { url: 'https://api.ipify.org?format=json', field: 'ip' },
      { url: 'https://api.myip.la/json', field: 'ip' },
      { url: 'https://api.ip.sb/geoip', field: 'ip' },
      { url: 'https://myip.ipip.net/json', field: 'data.ip' }
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
        // 静默失败，尝试下一个API
      }
    }

    return null;
  }

  // 新增：IP格式验证
  isValidIP(ip) {
    if (!ip) return false;

    // IPv4验证
    const ipv4Regex = /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
    if (ipv4Regex.test(ip)) return true;

    // IPv6验证(简化版)
    const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
    return ipv6Regex.test(ip);
  }

  // 优化：获取所有IP地址（包括虚拟环境）
  async getLocalIpAddress() {
    const cacheKey = 'local_ip_addresses';
    const cached = this._cache.get(cacheKey);
    if (cached) return cached;

    const result = {
      local: [],   // 内网IP
      public: null, // 外网IP
      primary: null // 主要使用的IP
    };

    try {
      // 获取所有网络接口
      const interfaces = os.networkInterfaces();
      const skipPatterns = ['lo', 'localhost']; // 跳过的接口名称模式

      for (const [name, ifaces] of Object.entries(interfaces)) {
        // 跳过回环接口
        if (skipPatterns.some(p => name.toLowerCase().includes(p))) continue;

        for (const iface of ifaces) {
          // 只处理IPv4和启用的接口
          if (iface.family !== 'IPv4' || iface.internal) continue;

          const info = {
            ip: iface.address,
            interface: name,
            mac: iface.mac,
            // 检测虚拟网卡特征
            virtual: this.isVirtualInterface(name, iface.mac)
          };

          // 私有IP添加到内网列表
          if (this.isPrivateIP(iface.address)) {
            result.local.push(info);
          }
        }
      }

      // 通过UDP获取主要使用的网卡IP
      try {
        const primaryIp = await this.getIpByUdp();
        if (primaryIp) {
          result.primary = primaryIp;
          // 如果主IP不在列表中，添加它
          if (!result.local.some(item => item.ip === primaryIp)) {
            result.local.unshift({
              ip: primaryIp,
              interface: 'auto-detected',
              primary: true
            });
          } else {
            // 标记主IP
            result.local.find(item => item.ip === primaryIp).primary = true;
          }
        }
      } catch { }

      // 获取外网IP（可选）
      if (cfg.server?.detectPublicIP !== false) {
        result.public = await this.getPublicIP();
      }

      // 缓存结果
      this._cache.set(cacheKey, result);
      return result;

    } catch (err) {
      BotUtil.makeLog("debug", `获取IP地址失败: ${err.message}`, `${cfg.server.name}`);
      return result;
    }
  }

  // 新增：检测虚拟网卡
  isVirtualInterface(name, mac) {
    const virtualPatterns = [
      // 虚拟化平台
      /^(docker|br-|veth|virbr|vnet)/i,
      /^(vmnet|vmware)/i,
      /^(vboxnet|virtualbox)/i,
      /^(utun|tap|tun)/i,
      // WSL
      /^eth\d+$/i
    ];

    // 检查接口名称
    if (virtualPatterns.some(p => p.test(name))) return true;

    // 检查MAC地址前缀（虚拟化常见前缀）
    const virtualMacPrefixes = [
      '00:50:56', // VMware
      '00:0c:29', // VMware
      '00:05:69', // VMware
      '00:1c:42', // Parallels
      '08:00:27', // VirtualBox
      '00:15:5d', // Hyper-V
      '02:42:',   // Docker
      '00:16:3e', // Xen
      '52:54:00', // QEMU/KVM
    ];

    if (mac && virtualMacPrefixes.some(prefix =>
      mac.toLowerCase().startsWith(prefix.toLowerCase())
    )) {
      return true;
    }

    return false;
  }

  // 保持原有UDP检测方法不变
  async getIpByUdp() {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('UDP获取IP超时'));
      }, 3000);

      try {
        socket.connect(80, '223.5.5.5', () => { // 使用国内DNS服务器
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

  setupWWW() {
    const wwwPath = path.join(process.cwd(), 'www');
    if (!fsSync.existsSync(wwwPath)) fsSync.mkdirSync(wwwPath, { recursive: true });

    const mediaPath = path.join(wwwPath, 'media');
    if (!fsSync.existsSync(mediaPath)) fsSync.mkdirSync(mediaPath, { recursive: true });

    const webAddress = cfg.server?.address || 'www';

    // 安全性增强：限制访问路径
    this.express.use(`/${webAddress}`, (req, res, next) => {
      // 防止路径遍历攻击
      const normalizedPath = path.normalize(req.path);
      if (normalizedPath.includes('..')) {
        return res.status(403).send('Forbidden');
      }

      // 隐藏敏感文件
      const hiddenFiles = ['.git', '.env', 'config', 'node_modules', '.DS_Store'];
      if (hiddenFiles.some(hidden => normalizedPath.includes(hidden))) {
        return res.status(404).send('Not Found');
      }

      next();
    }, express.static(wwwPath, {
      dotfiles: 'deny',
      index: ['index.html', 'index.htm'],
      maxAge: '1d',
      setHeaders: (res, filePath) => {
        // 设置安全头部
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('X-Frame-Options', 'SAMEORIGIN');
      }
    }));

    this.express.use('/media', express.static(mediaPath, {
      dotfiles: 'deny',
      maxAge: '7d'
    }));

    this.express.get('/favicon.ico', (req, res) => {
      const faviconPath = path.join(wwwPath, 'favicon.ico');
      if (fsSync.existsSync(faviconPath)) {
        res.set('Cache-Control', 'public, max-age=86400');
        res.sendFile(faviconPath);
      } else {
        res.status(204).end();
      }
    });
  }

  serverAuth(req, res, next) {
    req.rid = `${req.ip}:${req.socket.remotePort}`;
    req.sid = `${req.protocol}://${req.hostname}:${req.socket.localPort}${req.originalUrl}`;

    const webAddress = cfg.server?.address || 'www';

    if (req.originalUrl.startsWith(`/${webAddress}`) || req.originalUrl === '/favicon.ico' ||
      req.originalUrl.startsWith('/media') || req.originalUrl.startsWith('/api/files/')) {
      return next();
    }

    const clientIp = req.ip.replace(/^::ffff:/, '');

    if (this.isLocalConnection(clientIp)) {
      BotUtil.makeLog("debug", ["本地连接，跳过鉴权", clientIp], `${cfg.server.name}`);
      return next();
    }

    if (!this.checkApiAuthorization(req)) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or missing API key',
        hint: 'Please provide X-API-Key header or api_key parameter'
      });
      BotUtil.makeLog("error", ["HTTP鉴权失败", req.method, req.originalUrl, "来自", req.ip], `${cfg.server.name}`);
      return;
    }

    next();
  }

  serverStatus(req, res) {
    res.type("json");
    res.send(JSON.stringify(process.report.getReport()).replace(/(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)/g, "[IPv4]"));
  }

  serverHandle(req, res, next) {
    const quiet = req.app.quiet.some(i => req.originalUrl.startsWith(i));
    if (!quiet) {
      BotUtil.makeLog("debug", ["HTTP", req.method, req.originalUrl], `${cfg.server.name}`);
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
        BotUtil.makeLog("error", ["WebSocket鉴权失败", req.url], `${cfg.server.name}`);
        return socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"), socket.destroy();
      }
    }

    const path = req.url.split("/")[1];
    if (!(path in this.wsf)) {
      BotUtil.makeLog("error", ["WebSocket处理器不存在", path], `${cfg.server.name}`);
      return socket.write("HTTP/1.1 404 Not Found\r\n\r\n"), socket.destroy();
    }

    this.wss.handleUpgrade(req, socket, head, conn => {
      BotUtil.makeLog("debug", ["WebSocket连接建立", req.url], `${cfg.server.name}`);
      conn.on("error", err => BotUtil.makeLog("error", err, `${cfg.server.name}`));
      conn.on("close", () => BotUtil.makeLog("debug", ["WebSocket断开", req.url], `${cfg.server.name}`));
      conn.on("message", msg => {
        const logMsg = Buffer.isBuffer(msg) && msg.length > 1024
          ? `[Binary message, length: ${msg.length}, MD5: ${BotUtil.hash(msg, 'md5')}]`
          : BotUtil.String(msg);
        BotUtil.makeLog("trace", ["WS消息", logMsg], `${cfg.server.name}`);
      });
      conn.sendMsg = msg => {
        if (!Buffer.isBuffer(msg)) msg = BotUtil.String(msg);
        const logMsg = Buffer.isBuffer(msg) && msg.length > 1024
          ? `[Binary send, length: ${msg.length}, MD5: ${BotUtil.hash(msg, 'md5')}]`
          : msg;
        BotUtil.makeLog("trace", ["WS发送", logMsg], `${cfg.server.name}`);
        return conn.send(msg);
      };
      for (const i of this.wsf[path]) i(conn, req, socket, head);
    });
  }

  async serverEADDRINUSE(err, https) {
    BotUtil.makeLog("error", ["端口", this.port, "已被占用"], `${cfg.server.name}`);
    if (!https) {
      this.server_listen_time = this.server_listen_time ? this.server_listen_time + 1 : 1;
      await BotUtil.sleep(this.server_listen_time * 1000);
      this.server.listen(this.port);
    }
  }

  // 优化：改进服务器加载显示
  async serverLoad(https) {
    const server = https ? "httpsServer" : "server";
    const port = this.port;
    this[server].listen(port, '0.0.0.0');
    await BotUtil.promiseEvent(this[server], "listening", https && "error").catch(() => { });
    const { address, port: listenedPort } = this[server].address();

    const ipInfo = await this.getLocalIpAddress();
    const protocol = https ? 'https' : 'http';

    this.url = cfg.server.url ? `${cfg.server.url}:${listenedPort}` : `${protocol}://${address}:${listenedPort}`;

    BotUtil.makeLog("info", `${cfg.server.name} 启动成功`, `${cfg.server.name}`);
    BotUtil.makeLog("info", `API密钥: ${this.apiKey}`, `${cfg.server.name}`);

    // 显示访问地址
    const addresses = [];

    // 本地地址
    addresses.push(`${protocol}://localhost:${listenedPort}`);

    // 内网地址
    if (ipInfo.local.length > 0) {
      BotUtil.makeLog("info", "内网访问地址:", `${cfg.server.name}`);
      ipInfo.local.forEach(info => {
        const url = `${protocol}://${info.ip}:${listenedPort}`;
        const label = info.primary ? ' (主要)' : info.virtual ? ' (虚拟)' : '';
        BotUtil.makeLog("info", `  ${url} [${info.interface}]${label}`, `${cfg.server.name}`);
        addresses.push(url);
      });
    }

    // 外网地址
    if (ipInfo.public) {
      const publicUrl = `${protocol}://${ipInfo.public}:${listenedPort}`;
      BotUtil.makeLog("info", `外网访问地址: ${publicUrl}`, `${cfg.server.name}`);
      addresses.push(publicUrl);
    }

    // 配置地址
    if (cfg.server.url) {
      BotUtil.makeLog("info", `配置地址: ${cfg.server.url}:${listenedPort}`, `${cfg.server.name}`);
    }

    // 文件目录地址
    const webAddress = cfg.server?.address || 'www';
    BotUtil.makeLog("info", `文件目录: ${addresses[0]}/${webAddress}`, `${cfg.server.name}`);
  }

  async httpsLoad() {
    if (!cfg.server.https.enabled || !cfg.server.https.key || !cfg.server.https.cert) return;
    try {
      this.httpsServer = (await import("node:https")).createServer({
        key: await fs.readFile(cfg.server.https.key),
        cert: await fs.readFile(cfg.server.https.cert),
      }, this.express)
        .on("error", err => {
          if (typeof this[`server${err.code}`] === "function") return this[`server${err.code}`](err, true);
          BotUtil.makeLog("error", err, `${cfg.server.name}`);
        })
        .on("upgrade", this.wsConnect.bind(this));
      await this.serverLoad(true);
    } catch (err) {
      BotUtil.makeLog("error", ["HTTPS服务器创建失败", err.message], `${cfg.server.name}`);
    }
  }

  async run(options = {}) {
    const { port } = options;
    this.port = port;

    // 初始化配置
    await init();

    // 生成API密钥
    await this.generateApiKey();

    // 加载插件
    await PluginsLoader.load();

    // 加载API模块 - 修改这部分
    await ApiLoader.load();
    await ApiLoader.register(this.express, this);

    // 启动服务器
    await this.serverLoad(false);
    if (cfg.server.https?.enabled) await this.httpsLoad();

    // 设置默认路由
    const webAddress = cfg.server?.address || 'www';
    this.express.use((req, res) => res.redirect(`/${webAddress}`));

    // 加载监听器
    await Promise.all([ListenerLoader.load()]);

    await ApiLoader.watch(true);

    // 显示WebSocket服务信息
    if (Object.keys(this.wsf).length > 0) {
      BotUtil.makeLog("info", `WebSocket服务: ${this.url.replace(/^http/, "ws")}/ [${Object.keys(this.wsf).join(', ')}]`, `${cfg.server.name}`);
    }

    // 触发上线事件
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
    BotUtil.makeLog("debug", `文件发送: ${file.name} (${BotUtil.formatFileSize(file.buffer.length)})`, `${cfg.server.name}`);
    res.send(file.buffer);
  }

  prepareEvent(data) {
    if (!this.bots[data.self_id]) return;

    if (!data.bot) {
      Object.defineProperty(data, "bot", { value: this.bots[data.self_id] });
    }

    // 设备事件增强
    if (data.post_type === 'device' || data.device_id) {
      const deviceBot = this.bots[data.device_id];
      if (deviceBot) {
        data.device = deviceBot;

        // 添加设备方法到事件对象
        data.sendCommand = (cmd, params) => deviceBot.sendCommand(cmd, params);
        data.display = (text, x, y, clear) => deviceBot.display(text, x, y, clear);
        data.getDeviceLogs = (filter) => deviceBot.getLogs(filter);
        data.hasCapability = (cap) => deviceBot.hasCapability(cap);
        data.rebootDevice = () => deviceBot.reboot();

        // 设备回复方法
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

    BotUtil.makeLog("trace", ["因不存在用户", user_id, "而随机选择Bot", this.uin.toJSON()], `${cfg.server.name}`);
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

    BotUtil.makeLog("trace", ["因不存在群", group_id, "而随机选择Bot", this.uin.toJSON()], `${cfg.server.name}`);
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
          BotUtil.makeLog("debug", `成功发送消息给主人 ${user_id}`, `${cfg.server.name}`);
        } else {
          results[user_id] = { error: "无法找到可用的Bot发送消息" };
          BotUtil.makeLog("warn", `无法向主人 ${user_id} 发送消息`, `${cfg.server.name}`);
        }

        if (sleep && masterQQs.indexOf(user_id) < masterQQs.length - 1) {
          await BotUtil.sleep(sleep);
        }
      } catch (err) {
        results[user_id] = { error: err.message };
        BotUtil.makeLog("error", `向主人 ${user_id} 发送消息失败: ${err.message}`, `${cfg.server.name}`);
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