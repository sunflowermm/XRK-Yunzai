<div align="center">

# Bot 对象函数手册

> 基于 `lib/bot.js`（2025-11-21）。所有方法默认已绑定到 `Bot` 实例/Proxy，可直接在插件、适配器、API 中调用。

</div>

---

<div align="center">

## 📖 阅读指引

</div>

<div align="center">

- **签名** 字段采用 JSDoc 风格，列出参数类型与返回值。
- **参数** 块列出关键字段；若为可选项会以 "(可选)" 标注。
- **用法** 仅提供调用场景提示，具体示例可在插件/适配器中套用。
- 以 `_` 开头的方法虽然是内部实现，但对调试/扩展常有帮助，故一并列出。

</div>

---

<div align="center">

## 1. 生命周期 & 代理

</div>

### constructor()
- **签名**: `new Bot()`
- **作用**: 初始化 Express、HTTP/HTTPS server、WebSocketServer、缓存、反向代理状态并注册信号处理。

### makeError(message, type = 'Error', details = {})
- **签名**: `(message: string | Error, type?: string, details?: Record<string, any>) => Error`
- **作用**: 统一异常包装（附加类型、时间戳、源头），并经 `BotUtil.makeLog` 打印。
- **用法**: `throw Bot.makeError('配置缺失', 'ConfigError', { file: 'server.yaml' })`

### _createUinManager()
- **签名**: `() => Proxy & { toJSON(): string, toString(raw?: boolean): string, includes(uin: number|string): boolean }`
- **作用**: 创建账号数组代理，提供随机当前账号、JSON 序列化与包含判断。

### _createProxy()
- **签名**: `() => BotProxy`
- **作用**: 返回一个 Proxy，使外部访问 `Bot.xxx` 时按顺序查找当前实例、子 Bot、`BotUtil`。

### run(options = {})
- **签名**: `async run(options?: { port?: number }): Promise<void>`
- **参数**: `options.port` 指定 HTTP 监听端口，未设置默认 2537。
- **作用**: 整体启动流程（生成 API key、加载配置/插件/工作流、注册路由、启动 HTTP/HTTPS/代理、监听 WebSocket、触发 `online` 事件）。

### closeServer()
- **签名**: `async closeServer(): Promise<void>`
- **作用**: 依次关闭 HTTP、HTTPS、代理 server，并调用 `redisExit()`，用于优雅退出。

---

<div align="center">

## 2. HTTP / 中间件 / 静态资源

</div>

### _initHttpServer()
- **签名**: `void`
- **作用**: 创建 `http.createServer` 并绑定 `error`（委托 `_handleServerError`）与 `upgrade`（委托 `wsConnect`）。

### _handleServerError(err, isHttps)
- **签名**: `(err: NodeJS.ErrnoException, isHttps: boolean) => void`
- **作用**: 将错误转交给 `server${err.code}` 处理函数（如 `serverEADDRINUSE`），否则记录日志。

### _initializeMiddlewareAndRoutes()
- **作用**: 按 Nginx 风格顺序注册所有中间件/系统路由：追踪 → 压缩 → 安全头 → CORS → 请求日志 → 限流 → body parser → `/status` `/health` `/robots.txt` `/favicon.ico` → `/File` 静态 → 认证 → `/xrk` cookie → 静态文件托管。

### _setupCors()
- **签名**: `void`
- **作用**: 处理 `Access-Control-*` 头、预检请求、允许列表匹配。

### _setupRequestLogging()
- **作用**: 打印请求方法/状态/耗时，注入 `X-Request-Id`、`X-Response-Time`。

### _setupRateLimiting()
- **签名**: `void`
- **作用**: 依据 `cfg.server.rateLimit` 创建多套限流器，默认跳过本地 IP。

### _setupBodyParsers()
- **作用**: 注册 JSON、urlencoded、文本解析并限制体积。

### _setupSignalHandlers()
- **作用**: 捕获 `SIGINT/SIGTERM`，触发 `closeServer()` 与进程退出。

### _setupStaticServing()
- **作用**: 挂载目录索引、中间安全过滤与 `express.static`，默认服务 `www/`。

### _directoryIndexMiddleware(req, res, next)
- **作用**: 对无扩展名路径检测是否存在 `index.html` 并发起 301 重定向。

### _setStaticHeaders(res, filePath)
- **作用**: 根据扩展名设置 `Content-Type` / 缓存 Header。

### _staticSecurityMiddleware(req, res, next)
- **作用**: 拦截非法扩展、目录穿越、`.env` 等敏感文件请求。

### _setupFinalHandlers()
- **作用**: 注册 API 404、静态 404 以及全局错误兜底响应。

### _handleFavicon(req, res)
- **签名**: `async (req, res) => void`
- **作用**: 优先读取 `www/favicon.ico`，否则返回 204。

### _handleRobotsTxt(req, res)
- **签名**: `async (req, res) => void`
- **作用**: 从 `www/robots.txt` 或默认模板返回爬虫策略。

### _statusHandler(req, res)
- **作用**: 返回运行状态（版本、uptime、IP、WebSocket 路径、API 列表）。

### _healthHandler(req, res)
- **作用**: 返回健康检查（Redis/HTTP 状态），供探活使用。

### _fileHandler(req, res)
- **作用**: 处理 `/File/*` 下载、目录浏览与安全校验。

---

<div align="center">

## 3. 身份验证 & API Key

</div>

### generateApiKey()
- **签名**: `async generateApiKey(): Promise<string|null>`
- **作用**: 依据 `cfg.server.auth.apiKey` 加载/生成密钥并存入 `config/server_config/api_key.json`。

### _authMiddleware(req, res, next)
- **作用**: 白名单匹配 → 本地 IP → `xrk_ui` Cookie 同源校验 → API-Key 校验；主要保护 `/api/**`。

### _checkApiAuthorization(req)
- **签名**: `(req: Request) => boolean`
- **作用**: 从 Header/Query/Body 读取 `X-API-Key`/`Authorization`/`api_key` 并与 `this.apiKey` 做常量时间比较。

### checkApiAuthorization(req)
- **作用**: 对外公开包装，内部直接调用 `_checkApiAuthorization`。

### _isLocalConnection(address)
- **签名**: `(address?: string) => boolean`
- **作用**: 判断 IP 是否来自 `127.0.0.1/::1` 或内网。

### _isPrivateIP(ip)
- **签名**: `(ip?: string) => boolean`
- **作用**: 判断 `10.* / 172.16-31.* / 192.168.*` 等私网地址。

---

<div align="center">

## 4. 代理 / HTTPS / 网络

</div>

### _initProxyApp()
- **签名**: `async _initProxyApp(): Promise<void>`
- **作用**: 当启用反代时创建独立 Express，加载证书并为不同域名注册 `http-proxy-middleware`。

### _loadDomainCertificates()
- **作用**: 遍历 `cfg.server.proxy.domains`，读取证书/链并缓存到 `sslContexts`。

### _createHttpsProxyServer()
- **作用**: 使用 `https.createServer` 或 `http2.createSecureServer` 创建多域名代理，支持 SNI。

### _findDomainConfig(hostname)
- **作用**: 精确/通配符匹配域名配置，返回重写后的配置对象。

### _findWildcardContext(servername)
- **作用**: 针对 `*.example.com` 返回已加载的 TLS Context。

### _createProxyMiddleware(domainConfig)
- **作用**: 构造 `http-proxy-middleware` 实例，处理自定义 header、路径重写、错误上报。

### startProxyServers()
- **签名**: `async startProxyServers(): Promise<void>`
- **作用**: 分别监听 HTTP/HTTPS 代理端口并打印可访问地址。

### _displayProxyInfo()
- **作用**: 启动时在控制台展示域名、目标、静态目录、重写规则、API Key。

### _displayAccessUrls(protocol, port)
- **作用**: 列出本地/公网/配置域名访问地址及 API Key。

### httpsLoad()
- **签名**: `async httpsLoad(): Promise<void>`
- **作用**: 基于 `cfg.server.https` 创建 HTTPS/HTTP2 server 并调用 `serverLoad(true)`。

### serverLoad(isHttps)
- **签名**: `async serverLoad(isHttps: boolean): Promise<void>`
- **作用**: 监听 HTTP/HTTPS 端口，等待 `listening` 事件并打印监听地址。

### serverEADDRINUSE(err, isHttps)
- **作用**: 当端口占用时指数退避重试。

### getServerUrl()
- **签名**: `(): string`
- **作用**: 返回当前可对外访问的 URL（优先代理域名，否则 host + 端口）。

### getLocalIpAddress()
- **签名**: `async getLocalIpAddress(): Promise<{ local: Array<{ ip:string, interface:string, mac:string, virtual:boolean, primary?:boolean }>, public: string|null, primary: string|null }>`
- **作用**: 枚举网卡 IPv4、标记虚拟接口，并可选检测公网 IP。

### _isVirtualInterface(name, mac)
- **作用**: 根据名称匹配常见虚拟网卡（docker/veth/vmnet 等）。

### _getIpByUdp()
- **作用**: 通过 UDP 连接公共 DNS（223.5.5.5）以获取首选出口 IP。

### _getPublicIP()
- **作用**: 调用 `api.ipify.org` / `api.myip.la` 获取公网 IP，带超时。

### _isValidIP(ip)
- **作用**: 使用正则校验 IPv4 格式。

---

<div align="center">

## 5. WebSocket

</div>

### wsConnect(req, socket, head)
- **签名**: `(req: IncomingMessage, socket: Duplex, head: Buffer) => void`
- **作用**: 检查白名单/API-Key 后匹配 `bot.wsf` 中的路径（完整路径或首段），并在成功升级后注入日志与 `sendMsg`。

---

<div align="center">

## 6. 事件增强 & 触发

</div>

### prepareEvent(data)
- **签名**: `(data: Record<string, any>) => void`
- **作用**: 补全 `data.bot/friend/group/member`，同步 `sender`、群名称、适配器字段，并调用 `_extendEventMethods`。

### _extendEventMethods(data)
- **作用**: 为 `friend/group/member` 注入：
  - `sendFile(file, name?)`
  - `makeForwardMsg(nodes)`
  - `sendForwardMsg(nodes)`
  - `getInfo()`
  同时确保 `data.reply` 始终存在。

### em(name = "", data = {})
- **签名**: `(name: string, data?: Record<string, any>) => void`
- **作用**: 触发层级事件（`foo.bar.baz` → `foo.bar` → `foo`）并自动调用 `prepareEvent`。

---

<div align="center">

## 7. 联系人 & 群组工具

</div>

### getFriendArray()
- **签名**: `(): Array<{ user_id: number, nickname: string, bot_id: number }>`
- **作用**: 聚合所有 Bot 的好友详细信息。

### getFriendList()
- **作用**: 返回所有好友 ID 数组。

### getFriendMap()
- **作用**: 返回 `Map<user_id, FriendInfo>`，包含所属 Bot。

### get fl()
- **作用**: `getFriendMap()` 的别名。

### getGroupArray()
- **作用**: 聚合所有 Bot 的群列表。

### getGroupList()
- **作用**: 返回所有群 ID 数组。

### getGroupMap()
- **作用**: `Map<group_id, GroupInfo>`。

### get gl()
- **作用**: `getGroupMap()` 的别名。

### get gml()
- **作用**: 返回 `Map<group_id, Map<member_id, MemberInfo>>`，并注入 `bot_id`。

### pickFriend(user_id, strict)
- **签名**: `(user_id: number|string, strict?: boolean) => Friend`
- **作用**: 自动从拥有该好友的 Bot 里取出对象；若不存在且非 strict，则随机挑选可发送的 Bot。

### get pickUser
- **作用**: `pickFriend` 的 getter 别名。

### pickGroup(group_id, strict)
- **签名**: `(group_id: number|string, strict?: boolean) => Group`
- **作用**: 同 `pickFriend`，但面向群。

### pickMember(group_id, user_id)
- **作用**: 先通过 `pickGroup` 再调用 `.pickMember(user_id)`。

---

<div align="center">

## 8. 消息发送 / 转发

</div>

### sendFriendMsg(bot_id, user_id, ...args)
- **签名**: `async sendFriendMsg(bot_id: number|string|null, user_id: number|string, ...payload): Promise<any>`
- **作用**: 若 `bot_id` 为空自动选择；若 Bot 未上线则等待 `connect.${bot_id}` 事件。

### sendGroupMsg(bot_id, group_id, ...args)
- **作用**: 同上，面向群。

### sendMasterMsg(msg, sleep = 5000)
- **签名**: `async sendMasterMsg(msg: any, sleep?: number): Promise<Record<string, any>>`
- **作用**: 依次给 `cfg.masterQQ` 中的账号发消息，可配置每次间隔。

### makeForwardMsg(msg)
- **签名**: `(msg: any) => { type: 'node', data: any }`
- **作用**: 构造 OneBot 转发节点。

### makeForwardArray(msg = [], node = {})
- **作用**: 将数组/单条消息转换成 forward 节点数组。

### sendForwardMsg(send, msg)
- **签名**: `async sendForwardMsg(send: (seg) => Promise<any>, msg: Array<{ message: any }>|{ message: any }): Promise<any[]>`
- **作用**: 逐条发送 `makeForwardMsg` 生成的节点。

---

<div align="center">

## 9. Redis / 文件工具

</div>

### redisExit()
- **签名**: `async redisExit(): Promise<boolean>`
- **作用**: 若 `global.redis.process` 存在（本地启动的 redis-server），则等待保存并杀死进程。

### fileToUrl(file, opts = {})
- **签名**: `async fileToUrl(file: string|Buffer|Readable, opts?: Record<string, any>): Promise<string>`
- **作用**: 包装 `BotUtil.fileToUrl`，将本地/Buffer/stream 转换成可被消息使用的 URL。

---

<div align="center">

## 10. 服务器信息 & 实用函数

</div>

### _statusHandler / _healthHandler / _fileHandler
- 详见 2. 静态与系统路由。

### getLocalIpAddress / _getIpByUdp / _getPublicIP / _isValidIP / _isVirtualInterface
- 详见 4. 代理/网络。

### _setupFinalHandlers
- 详见 2. 静态章节。

---

---

<div align="center">

## 11. Bot 对象属性

</div>

### 核心属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `stat` | `Object` | 统计信息，包含 `start_time` |
| `bot` | `Bot` | Bot自身引用 |
| `bots` | `Object` | 子Bot实例映射 `{ bot_id: BotInstance }` |
| `adapter` | `Array` | 适配器数组 |
| `uin` | `Proxy<Array>` | 账号列表代理，支持 `toJSON()`, `toString()`, `includes()` |
| `express` | `Express` | Express应用实例 |
| `server` | `http.Server` | HTTP服务器实例 |
| `httpsServer` | `https.Server\|http2.Http2SecureServer` | HTTPS服务器实例 |
| `wss` | `WebSocketServer` | WebSocket服务器实例 |
| `wsf` | `Object` | WebSocket处理器映射 `{ path: Array<Function> }` |
| `fs` | `Object` | 文件服务映射 |
| `apiKey` | `string` | API密钥 |
| `_cache` | `Map` | 内部缓存 |
| `_rateLimiters` | `Map` | 速率限制器映射 |
| `httpPort` | `number\|null` | HTTP端口 |
| `httpsPort` | `number\|null` | HTTPS端口 |
| `actualPort` | `number\|null` | 实际HTTP端口 |
| `actualHttpsPort` | `number\|null` | 实际HTTPS端口 |
| `url` | `string` | 服务器URL |
| `proxyEnabled` | `boolean` | 是否启用代理 |
| `proxyApp` | `Express\|null` | 代理Express应用 |
| `proxyServer` | `http.Server\|null` | HTTP代理服务器 |
| `proxyHttpsServer` | `https.Server\|http2.Http2SecureServer\|null` | HTTPS代理服务器 |
| `proxyMiddlewares` | `Map` | 代理中间件映射 |
| `domainConfigs` | `Map` | 域名配置映射 |
| `sslContexts` | `Map` | SSL证书上下文映射 |
| `ApiLoader` | `ApiLoader` | API加载器引用 |

### 属性访问说明

Bot 对象通过 Proxy 实现方法查找：

1. 首先查找 `Bot.bots[prop]`
2. 然后查找 `Bot[prop]`
3. 最后查找 `BotUtil[prop]`

这意味着可以直接调用 `Bot.makeLog()`、`Bot.String()` 等工具方法。

---

<div align="center">

## 12. 适配器与路由集成

</div>

### 适配器集成

适配器通过以下方式与 Bot 交互：

- **注册**: `Bot.adapter.push(adapterInstance)`
- **事件触发**: `Bot.em(eventName, data)`
- **账号管理**: `Bot.uin.push(self_id)`, `Bot.bots[self_id] = botInstance`
- **WebSocket注册**: `Bot.wsf[path] = [handler1, handler2, ...]`
- **工具方法**: `Bot.makeLog()`, `Bot.String()`, `Bot.Buffer()`, `Bot.makeError()`

详细说明请参阅 [`docs/reference/ADAPTER_AND_ROUTING.md`](./ADAPTER_AND_ROUTING.md#适配器系统)

### 路由集成

路由通过以下方式与 Bot 交互：

- **Bot访问**: 路由处理器中通过 `req.bot` 或参数 `Bot` 访问
- **事件触发**: `Bot.em(eventName, data)`
- **消息发送**: `Bot.sendFriendMsg()`, `Bot.sendGroupMsg()`
- **配置访问**: `import cfg from '../../lib/config/config.js'`

详细说明请参阅 [`docs/reference/ADAPTER_AND_ROUTING.md`](./ADAPTER_AND_ROUTING.md#路由系统)

---

<div align="center">

## 13. 事件系统

</div>

### 事件命名规则

事件名称采用层级结构：`<post_type>.<type>.<sub_type>`

- **post_type**: `message` | `notice` | `request` | `meta_event`
- **type**: `private` | `group` | `guild` | `friend` | `group` | `friend` | `group` | `lifecycle` | `heartbeat`
- **sub_type**: `friend` | `group` | `normal` | `anonymous` | `increase` | `decrease` | `add` | `invite` 等

### 事件触发流程

```
适配器/插件调用 Bot.em(name, data)
    ↓
Bot.prepareEvent(data)  ← 补全 bot/friend/group/member
    ↓
Bot._extendEventMethods(data)  ← 注入方法
    ↓
Bot.emit(name, data)  ← 触发事件
    ↓
层级事件触发 (foo.bar.baz → foo.bar → foo)
    ↓
监听器处理
```

### 常用事件

| 事件名 | 说明 | 数据字段 |
|--------|------|----------|
| `connect.${bot_id}` | Bot连接事件 | `{ self_id, bot, adapter }` |
| `ready.${bot_id}` | Bot就绪事件 | `{ self_id, bot }` |
| `message.private.friend` | 私聊消息 | `{ self_id, user_id, message, bot, friend }` |
| `message.group.normal` | 群聊消息 | `{ self_id, group_id, user_id, message, bot, group, member }` |
| `notice.group.increase` | 群成员增加 | `{ self_id, group_id, user_id, bot, group }` |
| `notice.group.decrease` | 群成员减少 | `{ self_id, group_id, user_id, bot, group }` |
| `request.friend.add` | 好友请求 | `{ self_id, user_id, flag, bot }` |
| `request.group.add` | 加群请求 | `{ self_id, group_id, user_id, flag, bot }` |
| `online` | 服务器上线 | `{ bot, url, apis, proxyEnabled }` |

---

<div align="center">

## 14. 使用示例

</div>

### 示例1: 在适配器中使用 Bot

```javascript
// plugins/adapter/MyAdapter.js
Bot.adapter.push(
  new class MyAdapter {
    id = "MY_PROTOCOL"
    name = "MyProtocol"
    
    connect(ws, req) {
      const self_id = 'my_bot';
      
      // 注册账号
      if (!Bot.uin.includes(self_id)) {
        Bot.uin.push(self_id);
      }
      
      // 创建子Bot实例
      Bot.bots[self_id] = {
        uin: self_id,
        fl: new Map(),
        gl: new Map(),
        adapter: this
      };
      
      // 触发连接事件
      Bot.em(`connect.${self_id}`, {
        self_id: self_id,
        bot: Bot.bots[self_id]
      });
      
      // 处理消息
      ws.on('message', (raw) => {
        const data = JSON.parse(raw);
        Bot.em('message.private.friend', {
          self_id: self_id,
          user_id: data.user_id,
          message: data.message,
          bot: Bot.bots[self_id]
        });
      });
    }
  }
);
```

### 示例2: 在路由中使用 Bot

```javascript
// plugins/api/my-api.js
export default {
  routes: [{
    method: 'POST',
    path: '/api/send',
    handler: async (req, res, Bot) => {
      const { user_id, message } = req.body;
      
      // 发送消息
      const result = await Bot.sendFriendMsg(null, user_id, message);
      
      res.json({ success: true, result });
    }
  }, {
    method: 'GET',
    path: '/api/friends',
    handler: async (req, res, Bot) => {
      // 获取好友列表
      const friends = Bot.getFriendArray();
      
      res.json({ friends });
    }
  }]
};
```

### 示例3: 在插件中使用 Bot

```javascript
// plugins/example/my-plugin.js
import plugin from '../../lib/plugins/plugin.js';

export default class MyPlugin extends plugin {
  constructor() {
    super({
      name: 'my-plugin',
      event: 'message',
      rule: [{ reg: '^#测试$', fnc: 'test' }]
    });
  }
  
  async test(e) {
    // 访问Bot
    const url = Bot.getServerUrl();
    const friends = Bot.getFriendList();
    
    // 发送消息
    await Bot.sendMasterMsg('测试消息');
    
    return this.reply(`服务器: ${url}, 好友数: ${friends.length}`);
  }
}
```

---

<div align="center">

## 15. 相关文档

</div>

- [适配器与路由系统文档](./ADAPTER_AND_ROUTING.md) - 适配器和路由如何与Bot交互
- [核心对象文档](../CORE_OBJECTS.md) - Bot对象的快速参考
- [插件运行时文档](./PLUGINS.md) - 插件如何使用Bot
- [HTTP API基类文档](../HTTP_API_BASE_CLASS.md) - 路由开发指南

所有函数的源代码与逻辑细节可直接参阅 `lib/bot.js`。如需扩展/重写，可在自定义模块中继承 `Bot` 或通过 Proxy 拓展。***

