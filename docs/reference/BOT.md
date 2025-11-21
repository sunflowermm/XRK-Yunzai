# Bot 对象函数手册

> 基于 `lib/bot.js`（2025-11-21）。所有方法默认已绑定到 `Bot` 实例/Proxy，可直接在插件、适配器、API 中调用。

## 阅读指引

- **签名** 字段采用 JSDoc 风格，列出参数类型与返回值。
- **参数** 块列出关键字段；若为可选项会以 “(可选)” 标注。
- **用法** 仅提供调用场景提示，具体示例可在插件/适配器中套用。
- 以 `_` 开头的方法虽然是内部实现，但对调试/扩展常有帮助，故一并列出。

---

## 1. 生命周期 & 代理

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

## 2. HTTP / 中间件 / 静态资源

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

## 3. 身份验证 & API Key

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

## 4. 代理 / HTTPS / 网络

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

## 5. WebSocket

### wsConnect(req, socket, head)
- **签名**: `(req: IncomingMessage, socket: Duplex, head: Buffer) => void`
- **作用**: 检查白名单/API-Key 后匹配 `bot.wsf` 中的路径（完整路径或首段），并在成功升级后注入日志与 `sendMsg`。

---

## 6. 事件增强 & 触发

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

## 7. 联系人 & 群组工具

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

## 8. 消息发送 / 转发

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

## 9. Redis / 文件工具

### redisExit()
- **签名**: `async redisExit(): Promise<boolean>`
- **作用**: 若 `global.redis.process` 存在（本地启动的 redis-server），则等待保存并杀死进程。

### fileToUrl(file, opts = {})
- **签名**: `async fileToUrl(file: string|Buffer|Readable, opts?: Record<string, any>): Promise<string>`
- **作用**: 包装 `BotUtil.fileToUrl`，将本地/Buffer/stream 转换成可被消息使用的 URL。

---

## 10. 服务器信息 & 实用函数

### _statusHandler / _healthHandler / _fileHandler
- 详见 2. 静态与系统路由。

### getLocalIpAddress / _getIpByUdp / _getPublicIP / _isValidIP / _isVirtualInterface
- 详见 4. 代理/网络。

### _setupFinalHandlers
- 详见 2. 静态章节。

---

所有函数的源代码与逻辑细节可直接参阅 `lib/bot.js`。如需扩展/重写，可在自定义模块中继承 `Bot` 或通过 Proxy 拓展。***

