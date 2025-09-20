import path from 'path';
import fs from 'node:fs/promises';
import PluginsLoader from "./plugins/loader.js";
import ListenerLoader from "./listener/loader.js";
import ApiLoader from "./api/loader.js";
import { EventEmitter } from "events";
import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import * as fsSync from 'fs';
import BotUtil from './util.js';
import init from "./config/init.js";
import cfg from './config/config.js';
import os from 'node:os';
import crypto from 'crypto';

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
  _ipCache = null;

  constructor() {
    super();

    this._cache = BotUtil.getMap('yunzai_cache', { ttl: 60000, autoClean: true });
    this._ipCache = BotUtil.getMap('ip_cache', { ttl: 300000, autoClean: true });

    this.express.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Key');
      res.header('X-Content-Type-Options', 'nosniff');
      res.header('X-Frame-Options', 'DENY');
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
        this.apiKey = BotUtil.randomString(64, 'ABCDEFGHIJKLMNOPQRSTUVWXSYAUabcdefghijklmnopqrstuvwxSYAU0123456789');
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

  isLocalConnection(address) {
    if (!address || typeof address !== 'string') return false;

    address = address.toLowerCase().trim().replace(/^::ffff:/, '');

    return address === "127.0.0.1" ||
      address === "::1" ||
      address === "localhost" ||
      /^10\./.test(address) ||
      /^192\.168\./.test(address) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(address) ||
      address.startsWith("fd00:") ||
      address.startsWith("fc00:");
  }

  isPrivateIP(ip) {
    if (!ip) return false;

    const cached = this._ipCache.get(`private_${ip}`);
    if (cached !== undefined) return cached;

    const privateRanges = [
      /^10\./,
      /^192\.168\./,
      /^172\.(1[6-9]|2\d|3[0-1])\./,
      /^127\./,
      /^169\.254\./,
      /^::1$/,
      /^fe80:/,
      /^fc00:/,
      /^fd00:/
    ];

    const result = privateRanges.some(range => range.test(ip));
    this._ipCache.set(`private_${ip}`, result);
    return result;
  }

  async getLocalIPs() {
    const cacheKey = 'local_ips';
    const cached = this._cache.get(cacheKey);
    if (cached) return cached;

    const ips = [];
    
    try {
      const interfaces = os.networkInterfaces();
      
      for (const [name, ifaces] of Object.entries(interfaces)) {
        if (/^(docker|br-|veth|vmnet|vbox|tun|tap|lo)/i.test(name)) continue;
        
        for (const iface of ifaces) {
          if (iface.family === 'IPv4' && !iface.internal) {
            const ip = iface.address;
            if (this.isPrivateIP(ip)) {
              ips.push(ip);
            }
          }
        }
      }
      
      // 去重
      const uniqueIPs = [...new Set(ips)];
      this._cache.set(cacheKey, uniqueIPs);
      return uniqueIPs;
    } catch (err) {
      BotUtil.makeLog("debug", `获取本地IP失败: ${err.message}`, `${cfg.server.name}`);
      return [];
    }
  }

  setupWWW() {
    const wwwPath = path.join(process.cwd(), 'www');
    if (!fsSync.existsSync(wwwPath)) fsSync.mkdirSync(wwwPath, { recursive: true });

    const mediaPath = path.join(wwwPath, 'media');
    if (!fsSync.existsSync(mediaPath)) fsSync.mkdirSync(mediaPath, { recursive: true });

    const webAddress = cfg.server?.address || 'www';

    this.express.use(`/${webAddress}`, (req, res, next) => {
      const normalizedPath = path.normalize(req.path).replace(/^(\.\.[\/\\])+/, '');
      if (normalizedPath !== req.path) {
        return res.status(403).send('Forbidden');
      }
      
      if (/(^|\/)\./.test(req.path)) {
        return res.status(403).send('Forbidden');
      }
      
      next();
    }, express.static(wwwPath, {
      dotfiles: 'deny',
      index: false
    }));

    this.express.use('/media', express.static(mediaPath, {
      dotfiles: 'deny',
      index: false
    }));

    this.express.get('/favicon.ico', (req, res) => {
      const faviconPath = path.join(wwwPath, 'favicon.ico');
      if (fsSync.existsSync(faviconPath)) {
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

    if (req.originalUrl.startsWith(`/${webAddress}`) || 
        req.originalUrl === '/favicon.ico' ||
        req.originalUrl.startsWith('/media')) {
      return next();
    }

    if (req.ip === '::1' || req.ip === '::ffff:127.0.0.1') {
      BotUtil.makeLog("debug", ["本地连接，跳过鉴权"], `${cfg.server.name}`);
      return next();
    }

    const clientIp = req.ip.replace(/^::ffff:/, '');
    
    if (this.isPrivateIP(clientIp)) {
      BotUtil.makeLog("debug", ["内网IP连接", clientIp], `${cfg.server.name}`);
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
    const report = JSON.stringify(process.report?.getReport() || {})
      .replace(/(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)/g, "[IPv4]");
    res.send(report);
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
  }

  wsConnect(req, socket, head) {
    req.rid = `${req.socket.remoteAddress}:${req.socket.remotePort}-${req.headers["sec-websocket-key"]}`;
    req.sid = `ws://${req.headers["x-forwarded-host"] ?? req.headers.host ?? `${req.socket.localAddress}:${req.socket.localPort}`}${req.url}`;
    req.query = Object.fromEntries(new URL(req.sid).searchParams.entries());
    const remoteAddress = req.socket.remoteAddress;

    if (this.isLocalConnection(remoteAddress) || this.isPrivateIP(remoteAddress.replace(/^::ffff:/, ''))) {
      BotUtil.makeLog("debug", ["内网WebSocket连接", req.url], `${cfg.server.name}`);
    } else if (!this.checkApiAuthorization(req)) {
      BotUtil.makeLog("error", ["WebSocket鉴权失败", req.url], `${cfg.server.name}`);
      return socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"), socket.destroy();
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
          ? `[Binary message, length: ${msg.length}]`
          : BotUtil.String(msg);
        BotUtil.makeLog("trace", ["WS消息", logMsg], `${cfg.server.name}`);
      });
      conn.sendMsg = msg => {
        if (!Buffer.isBuffer(msg)) msg = BotUtil.String(msg);
        const logMsg = Buffer.isBuffer(msg) && msg.length > 1024
          ? `[Binary send, length: ${msg.length}]`
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

  async serverLoad(https) {
    const server = https ? "httpsServer" : "server";
    const port = this.port;
    this[server].listen(port, '0.0.0.0');
    await BotUtil.promiseEvent(this[server], "listening", https && "error").catch(() => { });
    const { address, port: listenedPort } = this[server].address();

    const localIPs = await this.getLocalIPs();
    const protocol = https ? 'https' : 'http';
    const webAddress = cfg.server?.address || 'www';

    this.url = cfg.server.url ? `${cfg.server.url}:${listenedPort}` : `${protocol}://${address}:${listenedPort}`;
    BotUtil.makeLog("info", `${cfg.server.name} 启动成功`, `${cfg.server.name}`);
    BotUtil.makeLog("info", `端口: ${listenedPort}`, `${cfg.server.name}`);
    BotUtil.makeLog("info", `API密钥: ${this.apiKey}`, `${cfg.server.name}`);
    BotUtil.makeLog("info", `文件目录: /${webAddress}`, `${cfg.server.name}`);
    BotUtil.makeLog("info", `本地: ${protocol}://127.0.0.1:${listenedPort}`, `${cfg.server.name}`);
    
    if (localIPs.length > 0) {
      BotUtil.makeLog("info", `内网: ${protocol}://${localIPs[0]}:${listenedPort}`, `${cfg.server.name}`);
      if (localIPs.length > 1) {
        for (let i = 1; i < localIPs.length; i++) {
          BotUtil.makeLog("info", `        ${protocol}://${localIPs[i]}:${listenedPort}`, `${cfg.server.name}`);
        }
      }
    }
    if (cfg.server.url) {
      BotUtil.makeLog("info", `配置文件地址: ${cfg.server.url}:${listenedPort}`, `${cfg.server.name}`);
    }
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

  prepareEvent(data) {
    if (!this.bots[data.self_id]) return;

    if (!data.bot) {
      Object.defineProperty(data, "bot", { value: this.bots[data.self_id] });
    }
    if (data.bot.adapter?.id) data.adapter_id = data.bot.adapter.id;
    if (data.bot.adapter?.name) data.adapter_name = data.bot.adapter.name;
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

  async run(options = {}) {
    const { port } = options;
    this.port = port;
    await init();

    await this.generateApiKey();

    await PluginsLoader.load();

    await ApiLoader.load();
    ApiLoader.register(this.express, this);

    await this.serverLoad(false);
    if (cfg.server.https?.enabled) await this.httpsLoad();

    const webAddress = cfg.server?.address || 'www';
    this.express.use((req, res) => res.redirect(`/${webAddress}`));

    await Promise.all([ListenerLoader.load()]);

    if (Object.keys(this.wsf).length > 0) {
      BotUtil.makeLog("info", `WebSocket服务: ${this.url.replace(/^http/, "ws")}/ [${Object.keys(this.wsf).join(', ')}]`, `${cfg.server.name}`);
    }

    this.emit("online", { bot: this, timestamp: Date.now(), url: this.url, uptime: process.uptime() });
  }
}