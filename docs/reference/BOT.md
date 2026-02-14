# Bot 对象函数手册

> 基于 `lib/bot.js`。所有方法默认已绑定到 Bot 实例/Proxy，可在插件、适配器、API 中直接调用。以 `_` 开头为内部方法，调试/扩展时可参考。

---

## 1. 生命周期 & 代理

| 方法 | 签名/要点 | 说明 |
|------|-----------|------|
| `constructor()` | `new Bot()` | 初始化 Express、HTTP/HTTPS、WebSocket、缓存、反向代理与信号处理 |
| `makeError(message, type?, details?)` | 返回 `Error` | 统一异常包装并经 BotUtil.makeLog 打印 |
| `_createUinManager()` | 返回 Proxy | 账号数组代理：toJSON、toString、includes |
| `_createProxy()` | 返回 BotProxy | 查找顺序：当前实例 → 子 Bot → BotUtil |
| `run(options?)` | `async` | 启动：生成 API key、加载配置/插件/工作流、注册路由、启动服务、WebSocket、触发 online |
| `closeServer()` | `async` | 关闭 HTTP/HTTPS/代理、redisExit，优雅退出 |

## 2. HTTP / 中间件 / 静态资源

| 方法 | 说明 |
|------|------|
| `_initHttpServer()` | 创建 http server，绑定 error / upgrade（wsConnect） |
| `_handleServerError(err, isHttps)` | 转交 serverEADDRINUSE 等处理 |
| `_initializeMiddlewareAndRoutes()` | 顺序：追踪→压缩→安全头→CORS→请求日志→限流→body→/status /health /robots /favicon→/File→认证→/xrk→静态 |
| `_setupCors` / `_setupRequestLogging` / `_setupRateLimiting` / `_setupBodyParsers` / `_setupSignalHandlers` | CORS、X-Request-Id/耗时、限流、JSON/urlencoded、SIGINT/SIGTERM |
| `_setupStaticServing` / `_directoryIndexMiddleware` / `_setStaticHeaders` / `_staticSecurityMiddleware` | 静态目录、index 重定向、Content-Type、非法路径拦截 |
| `_setupFinalHandlers()` | API 404、静态 404、全局错误兜底 |
| `_handleFavicon` / `_handleRobotsTxt` | favicon.ico 或 204；robots.txt |
| `_statusHandler` / `_healthHandler` / `_fileHandler` | 状态（版本/uptime/IP/ws/API）、健康检查（Redis/HTTP）、/File 下载与安全 |

## 3. 身份验证 & API Key

| 方法 | 说明 |
|------|------|
| `generateApiKey()` | 加载/生成密钥，写入 config/server_config/api_key.json |
| `_authMiddleware` | 白名单→本地 IP→xrk_ui Cookie→API-Key，保护 /api/** |
| `_checkApiAuthorization(req)` | Header/Query/Body 取 X-API-Key/Authorization/api_key，常量时间比较 |
| `checkApiAuthorization(req)` | 对外包装 |
| `_isLocalConnection(address)` / `_isPrivateIP(ip)` | 是否本地/内网；是否私网 IP |

## 4. 代理 / HTTPS / 网络

| 方法 | 说明 |
|------|------|
| `_initProxyApp()` | 反代时创建独立 Express、加载证书、注册 http-proxy-middleware |
| `_loadDomainCertificates` / `_createHttpsProxyServer` | 域名证书缓存；多域名 HTTPS/HTTP2、SNI |
| `_findDomainConfig(hostname)` / `_findWildcardContext(servername)` | 精确/通配符匹配域名配置；*.example.com 的 TLS |
| `_createProxyMiddleware(domainConfig)` | 构造代理中间件，header/重写/错误 |
| `startProxyServers()` | 监听 HTTP/HTTPS 代理端口并打印地址 |
| `_displayProxyInfo` / `_displayAccessUrls` | 控制台展示域名/目标/静态/重写/API Key；列出访问 URL |
| `httpsLoad()` / `serverLoad(isHttps)` | 创建 HTTPS 并监听；监听端口、EADDRINUSE 时重试 |
| `serverEADDRINUSE(err, isHttps)` | 端口占用时指数退避重试 |
| `getServerUrl()` | 返回对外 URL（优先代理域名） |
| `getLocalIpAddress()` | 枚举网卡 IPv4、虚拟接口、公网 IP |
| `_isVirtualInterface` / `_getIpByUdp` / `_getPublicIP` / `_isValidIP` | 虚拟网卡判断；UDP 出口 IP；ipify/myip 公网 IP；IPv4 校验 |

## 5. WebSocket

| 方法 | 说明 |
|------|------|
| `wsConnect(req, socket, head)` | 白名单/API-Key 校验后匹配 bot.wsf 路径，升级后注入日志与 sendMsg |

## 6. 事件增强 & 触发

| 方法 | 说明 |
|------|------|
| `prepareEvent(data)` | 补全 data.bot/friend/group/member，同步 sender、群名、适配器，并调用 _extendEventMethods |
| `_extendEventMethods(data)` | 为 friend/group/member 注入 sendFile、makeForwardMsg、sendForwardMsg、getInfo；确保 data.reply |
| `em(name, data?)` | 触发层级事件（foo.bar.baz→foo.bar→foo），自动 prepareEvent |

## 7. 联系人 & 群组

| 方法 | 说明 |
|------|------|
| `getFriendArray()` | 所有 Bot 的好友详情数组 |
| `getFriendList()` / `getFriendMap()` / `fl` | 好友 ID 数组；Map<user_id, FriendInfo>；getter 别名 |
| `getGroupArray()` / `getGroupList()` / `getGroupMap()` / `gl` | 群列表；群 ID 数组；Map<group_id, GroupInfo>；别名 |
| `gml` | Map<group_id, Map<member_id, MemberInfo>>，带 bot_id |
| `pickFriend(user_id, strict?)` / `pickUser` | 取拥有该好友的 Bot 对应对象；getter 别名 |
| `pickGroup(group_id, strict?)` / `pickMember(group_id, user_id)` | 同上面向群；先 pickGroup 再 pickMember |

## 8. 消息发送 / 转发

| 方法 | 说明 |
|------|------|
| `sendFriendMsg(bot_id, user_id, ...payload)` | bot_id 为空则自动选 Bot；未上线则等 connect 事件 |
| `sendGroupMsg(bot_id, group_id, ...payload)` | 同上，群 |
| `sendMasterMsg(msg, sleep?)` | 向 cfg.masterQQ 依次发送，可设间隔 |
| `makeForwardMsg(msg)` / `makeForwardArray(msg?, node?)` | 构造转发节点；转成节点数组 |
| `sendForwardMsg(send, msg)` | 逐条发送转发节点 |

## 9. Redis / 文件

| 方法 | 说明 |
|------|------|
| `redisExit()` | 若 global.redis.process 存在则保存并结束进程 |
| `fileToUrl(file, opts?)` | 本地/Buffer/stream 转可发消息的 URL（包装 BotUtil.fileToUrl） |

## 10. 属性（核心）

| 属性 | 说明 |
|------|------|
| `stat` / `bot` / `bots` | 统计、自身引用、子 Bot 映射 |
| `adapter` / `uin` | 适配器数组；账号列表 Proxy（toJSON/toString/includes） |
| `express` / `server` / `httpsServer` / `wss` / `wsf` | Express、HTTP/HTTPS server、WebSocketServer、路径→处理器数组 |
| `apiKey` / `_cache` / `_rateLimiters` | API 密钥、内部缓存、限流器 |
| `httpPort` / `httpsPort` / `actualPort` / `actualHttpsPort` / `url` | 端口与 URL |
| `proxyEnabled` / `proxyApp` / `proxyServer` / `proxyHttpsServer` / `proxyMiddlewares` / `domainConfigs` / `sslContexts` | 代理相关 |
| `ApiLoader` / `fs` | API 加载器；文件服务映射 |

属性查找顺序（Proxy）：`Bot.bots[prop]` → `Bot[prop]` → `BotUtil[prop]`。

## 11. 适配器与路由、事件

- **适配器**：`Bot.adapter.push`、`Bot.em`、`Bot.uin`、`Bot.wsf`、BotUtil 工具。详见 [ADAPTER_AND_ROUTING.md](./ADAPTER_AND_ROUTING.md#1-适配器adapter系统)。
- **路由**：`req.bot`、`Bot.em`、发送接口、`import cfg from '../../lib/config/config.js'`。详见 [ADAPTER_AND_ROUTING.md](./ADAPTER_AND_ROUTING.md#2-路由routing系统)。
- **事件命名**：`<post_type>.<type>.<sub_type>`（如 message.private.friend、notice.group.increase）。触发：`em(name, data)` → prepareEvent → _extendEventMethods → emit → 层级触发。

### 常用事件

| 事件名 | 说明 | 数据要点 |
|--------|------|----------|
| `connect.${bot_id}` / `ready.${bot_id}` | 连接/就绪 | self_id, bot, adapter |
| `message.private.friend` / `message.group.normal` | 私聊/群聊 | self_id, user_id/group_id, message, bot, friend/group, member |
| `notice.group.increase` / `notice.group.decrease` | 群成员增减 | self_id, group_id, user_id, bot, group |
| `request.friend.add` / `request.group.add` | 好友/加群请求 | self_id, user_id/group_id, flag, bot |
| `online` | 服务上线 | bot, url, apis, proxyEnabled |

## 12. 示例与相关文档

适配器/路由/插件中调用示例见 [ADAPTER_AND_ROUTING.md](./ADAPTER_AND_ROUTING.md)、[PLUGINS.md](./PLUGINS.md)。实现细节见 `lib/bot.js`。

- [适配器与路由](./ADAPTER_AND_ROUTING.md) - 与 Bot 的交互
- [核心对象](../CORE_OBJECTS.md) - Bot 快速参考
- [插件运行时](./PLUGINS.md) - 插件内使用 Bot
- [HTTP API 基类](../HTTP_API_BASE_CLASS.md) - 路由开发
