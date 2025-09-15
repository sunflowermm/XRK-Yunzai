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
  _ipCache = null;

  constructor() {
    super();

    this._cache = BotUtil.getMap('yunzai_cache', { ttl: 60000, autoClean: true });
    this._ipCache = BotUtil.getMap('ip_cache', { ttl: 300000, autoClean: true });

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

  isHotspotIP(ip) {
    if (!ip) return false;

    const cached = this._ipCache.get(`hotspot_${ip}`);
    if (cached !== undefined) return cached;

    const result = /^(192\.168\.(43|137|0|1)\.|172\.(20|24)\.|10\.42\.)/.test(ip);
    this._ipCache.set(`hotspot_${ip}`, result);
    return result;
  }

  isVirtualInterface(interfaceName) {
    if (!interfaceName) return false;

    const virtualPatterns = [
      'VMware', 'VirtualBox', 'vEthernet', 'Bluetooth',
      'docker', 'veth', 'br-', 'lo', 'vmnet', 'vbox',
      'tun', 'tap', 'wg', 'ppp'
    ];

    return virtualPatterns.some(pattern =>
      interfaceName.toLowerCase().includes(pattern.toLowerCase())
    ) || /^(docker|br-|veth|vmnet|vbox|tun|tap)/i.test(interfaceName);
  }

  getHotspotInterfaces() {
    const hotspotInterfaces = [];
    try {
      const interfaces = os.networkInterfaces();

      for (const interfaceName in interfaces) {
        if (this.isVirtualInterface(interfaceName) &&
          !interfaceName.includes('ap') &&
          !interfaceName.includes('hotspot') &&
          !interfaceName.includes('wlan')) {
          continue;
        }

        const iface = interfaces[interfaceName];
        for (const alias of iface) {
          if (alias.family === 'IPv4' && !alias.internal) {
            const ip = alias.address;
            if (this.isHotspotIP(ip) ||
              ip.startsWith('192.168.43.') ||
              ip.startsWith('192.168.137.') ||
              ip.startsWith('172.20.10.') ||
              ip.startsWith('10.42.0.')) {
              hotspotInterfaces.push({
                name: interfaceName,
                address: ip,
                type: 'hotspot'
              });
            }
          }
        }
      }
    } catch (err) {
      BotUtil.makeLog("debug", `获取热点接口失败: ${err.message}`, `${cfg.server.name}`);
    }

    return hotspotInterfaces;
  }

  async getLocalIpAddress() {
    const cacheKey = 'local_ip_addresses';
    const cached = this._cache.get(cacheKey);
    if (cached) return cached;

    const localIps = [];
    const hotspotIps = [];

    try {
      const hotspotInterfaces = this.getHotspotInterfaces();
      hotspotInterfaces.forEach(iface => {
        hotspotIps.push({
          ip: iface.address,
          type: 'hotspot',
          interface: iface.name
        });
      });

      const interfaces = os.networkInterfaces();
      for (const interfaceName in interfaces) {
        if (this.isVirtualInterface(interfaceName)) continue;

        const iface = interfaces[interfaceName];
        for (const alias of iface) {
          if (alias.family === 'IPv4' && !alias.internal && !this.isHotspotIP(alias.address)) {
            localIps.push({
              ip: alias.address,
              type: 'local',
              interface: interfaceName
            });
          }
        }
      }

      try {
        const udpIp = await this.getIpByUdp();
        if (udpIp && !localIps.some(item => item.ip === udpIp) &&
          !hotspotIps.some(item => item.ip === udpIp)) {
          localIps.push({
            ip: udpIp,
            type: 'udp',
            interface: 'auto-detected'
          });
        }
      } catch (err) {
      }

      const result = [...hotspotIps, ...localIps];
      this._cache.set(cacheKey, result);
      return result;
    } catch (err) {
      BotUtil.makeLog("debug", `获取本地IP失败: ${err.message}`, `${cfg.server.name}`);
      return [];
    }
  }

  async getIpByUdp() {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('UDP获取IP超时'));
      }, 3000);

      try {
        socket.connect(80, '8.8.8.8', () => {
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

    this.express.use(`/${webAddress}`, express.static(wwwPath));
    this.express.use('/media', express.static(mediaPath));

    this.express.get('/favicon.ico', (req, res) => {
      const faviconPath = path.join(wwwPath, 'favicon.ico');
      if (fsSync.existsSync(faviconPath)) res.sendFile(faviconPath);
      else res.status(204).end();
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

    if (this.isLocalConnection(remoteAddress) || this.isPrivateIP(remoteAddress.replace(/^::ffff:/, ''))) {
      BotUtil.makeLog("debug", ["内网WebSocket连接", req.url], `${cfg.server.name}`);
    }
    else if (!this.checkApiAuthorization(req)) {
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

  async serverLoad(https) {
    const server = https ? "httpsServer" : "server";
    const port = this.port;
    this[server].listen(port, '0.0.0.0');
    await BotUtil.promiseEvent(this[server], "listening", https && "error").catch(() => { });
    const { address, port: listenedPort } = this[server].address();

    const localIpInfo = await this.getLocalIpAddress();

    this.url = cfg.server.url ? `${cfg.server.url}:${listenedPort}` : `${https ? 'https' : 'http'}://${address}:${listenedPort}`;

    BotUtil.makeLog("info", `${cfg.server.name} 启动成功`, `${cfg.server.name}`);
    BotUtil.makeLog("info", `本机地址: ${this.url}`, `${cfg.server.name}`);
    BotUtil.makeLog("info", `API密钥: ${this.apiKey}`, `${cfg.server.name}`);

    const hotspotIps = localIpInfo.filter(info => info.type === 'hotspot');
    const otherIps = localIpInfo.filter(info => info.type !== 'hotspot');

    if (hotspotIps.length > 0) {
      BotUtil.makeLog("info", "🔥 热点访问地址 (其他设备连接热点后使用):", `${cfg.server.name}`);
      hotspotIps.forEach(info => {
        const url = `${https ? 'https' : 'http'}://${info.ip}:${listenedPort}`;
        BotUtil.makeLog("info", `   📱 ${url} (${info.interface})`, `${cfg.server.name}`);
      });
    }

    if (otherIps.length > 0) {
      BotUtil.makeLog("info", "🌐 局域网访问地址:", `${cfg.server.name}`);
      otherIps.forEach(info => {
        const url = `${https ? 'https' : 'http'}://${info.ip}:${listenedPort}`;
        BotUtil.makeLog("info", `   🏠 ${url} (${info.interface})`, `${cfg.server.name}`);
      });
    }

    if (localIpInfo.length === 0) {
      BotUtil.makeLog("warn", "⚠️  未检测到可用的网络接口", `${cfg.server.name}`);
      BotUtil.makeLog("info", "💡 使用流量时，请开启热点后重启服务以获取访问地址", `${cfg.server.name}`);
    }

    // 使用配置的地址名称显示文件目录地址
    const webAddress = cfg.server?.address || 'www';
    BotUtil.makeLog("info", `📁 文件目录: ${this.url}/${webAddress}`, `${cfg.server.name}`);
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
    await init();

    await this.generateApiKey();

    await PluginsLoader.load();

    await ApiLoader.load();
    ApiLoader.register(this.express, this);

    await this.serverLoad(false);
    if (cfg.server.https?.enabled) await this.httpsLoad();

    // 使用配置的地址名称进行重定向
    const webAddress = cfg.server?.address || 'www';
    this.express.use((req, res) => res.redirect(`/${webAddress}`));

    await Promise.all([ListenerLoader.load()]);

    if (Object.keys(this.wsf).length > 0) {
      BotUtil.makeLog("info", `WebSocket服务: ${this.url.replace(/^http/, "ws")}/ [${Object.keys(this.wsf).join(', ')}]`, `${cfg.server.name}`);
    }

    this.emit("online", { bot: this, timestamp: Date.now(), url: this.url, uptime: process.uptime() });
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