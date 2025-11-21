# 核心对象与全局依赖

此文档覆盖插件开发最常接触的对象：`Bot`、事件 `e`、`logger`、`cfg`、`segment` 以及全局 `redis` 客户端。每个对象均提供用途、示例与引用路径。

---

## 1. `Bot`（`lib/bot.js`）

`Bot` 继承自 `EventEmitter`，并通过 Proxy 将自身方法与 `BotUtil` 的工具函数统一暴露。任何模块在拿到 `Bot` 后都能直接调用下表所列 API；函数签名详见 `docs/reference/BOT.md`。

| 能力 | 快速说明 | 典型入口 |
|------|----------|----------|
| 服务生命周期 | `run()`, `closeServer()`, `serverLoad()`, `httpsLoad()` | 启动/关闭 HTTP、HTTPS、代理；打印访问地址。 |
| HTTP 中间件 | `_initializeMiddlewareAndRoutes()`, `_setupCors()`, `_authMiddleware()` | 自动注册压缩、安全头、限流、静态资源、认证。 |
| 代理/网络 | `_initProxyApp()`, `_createProxyMiddleware()`, `_displayProxyInfo()`, `getServerUrl()` | 多域名反代、SNI 证书加载、本地/公网 IP 探测。 |
| WebSocket | `wsConnect()` | 统一 upgrade，按路径分发到 `bot.wsf`。 |
| 事件增强 | `prepareEvent()`, `_extendEventMethods()`, `em()` | 补全 `e.friend/group/member` 并注入 `sendFile`、`reply`。 |
| 联系人工具 | `pickFriend/pickGroup/pickMember`, `sendFriendMsg/sendGroupMsg`, `makeForwardMsg()` | 跨账号分发消息、构造合并转发、批量通知主人。 |
| 诊断 | `makeError()`, `_setupRequestLogging()`, `_statusHandler()`, `_healthHandler()` | 统一格式日志、健康检查。 |

> `Bot` 作为 Proxy，找不到的方法会继续在 `BotUtil` 上查找，因此 `Bot.makeLog()`、`Bot.sleep()` 等同样可用。

---

## 2. 事件对象 `e`

事件统一由 `Bot.prepareEvent` + `plugins/loader` 注入属性，无论来源是 OneBot、设备还是 STDIN，写法一致。

| 属性/方法 | 说明 |
|-----------|------|
| `e.bot` | 当前消息所属的 Bot 子实例，可直接调用 `pickFriend`、`sendMsg` 等。 |
| `e.isGroup / e.isPrivate / e.isDevice / e.isMaster` | 已根据事件类型、`cfg.masterQQ` 打好标记。 |
| `e.friend / e.group / e.member` | 若存在，会被 `_extendEventMethods` 注入 `sendFile` / `makeForwardMsg` / `getInfo`。 |
| `e.reply(msg, quote?, opts?)` | 智能选择群聊或私聊渠道，插件默认调用即可。 |
| `e.getReply()` | 拉取引用消息（适配 OneBot 和设备事件）。 |
| `e.recall()` | 根据上下文自动调用撤回接口。 |
| `e.logText` | 日志统一格式 `[群名][成员]` / `[设备]` / `[STDIN]`。 |

设备事件（`plugins/api/device.js`）会构造简化版 `e` 并复用同样的增强逻辑，因此插件无需区分协议。

---

## 3. `logger`（`lib/config/log.js`）

全局注入，常用方法：

| 方法 | 用法 |
|------|------|
| `logger.info/warn/error/debug/mark(text)` | 插件、适配器、API 中打印彩色日志。 |
| `logger.blue/green/red(text)` | 仅返回带颜色的字符串，常与 `cfg` 信息拼接使用。 |

`BotUtil.makeLog(level, text, scope)` 会调用 `logger`，并附带时间戳、scope 名称。

---

## 4. `cfg`（`lib/config/config.js`）

用于读取/写入 YAML 配置，支持按端口隔离。

| 常用属性/方法 | 说明 |
|---------------|------|
| `cfg.bot / cfg.server / cfg.redis / cfg.kuizai` | 对应 `config/default_config/*.yaml` 的合并结果。 |
| `cfg.getGroup(groupId)` | 返回群配置（默认 + 群自定义）。 |
| `cfg.masterQQ` | 主账号数组，插件常用于权限判断。 |
| `cfg.setConfig(name, data)` | 保存并触发 `watcher`。 |
| `cfg.renderer` | 自动加载 `renderers/*/config_default.yaml` 与端口目录配置。 |

详细函数签名见 `docs/reference/CONFIG_AND_REDIS.md#cfg-api`。

---

## 5. `segment`

来源于 OneBot/`icqq`，用于构造富文本消息：

| 典型方法 | 作用 |
|----------|------|
| `segment.at(qq)` | @ 指定用户。 |
| `segment.reply(messageId)` | 回复引用。 |
| `segment.image(url/path)` / `segment.file(file, name)` | 发送图片/文件（`Bot._extendEventMethods` 会优先使用它）。 |

在非 QQ 场景（设备、HTTP）可能不存在 `segment`，使用前需判空或走 `BotUtil` 降级逻辑。

---

## 6. 全局 `redis` 客户端（`lib/config/redis.js`）

`redisInit()` 会在启动时连接/自动拉起 Redis，并将客户端挂载到 `global.redis`。常用成员：

| API | 说明 |
|-----|------|
| `await redisInit()` | 初始化并返回客户端；`app.js` / `start.js` 会调用一次。 |
| `redis.lPush/lRange/lTrim/expire` | 工作流 embedding、消息缓存。 |
| `redis.zAdd/zRange/zRemRangeByScore` | Memory System 长短期记忆。 |
| `redis.setEx/get/del` | 速率限制、API Key 缓存。 |
| `closeRedis()` | 关闭连接（`Bot.closeServer()` 会调用）。 |
| `getRedisClient()` | 获取当前实例（主要用于测试或扩展）。 |

Redis 连接参数来自 `cfg.redis`，包括 `host/port/db/username/password`。当 Redis 不可用时，Memory System、Embedding 会自动降级，但建议保持在线以启用全部能力。

---

## 7. `BotUtil` 快速索引

`Bot` 透出的工具函数集：

| 分类 | 代表方法 |
|------|----------|
| 日志 | `makeLog(level, text, scope)`、`colorLog()` |
| 时间/控制 | `sleep(ms)`、`promiseEvent(emitter, event, errorEvent?)` |
| 缓存 | `getMap(name, { ttl, autoClean })` |
| 文本 | `String(any)`、`escapeHTML(str)`、`slugify(str)` |
| 文件/网络 | `fileToUrl(file, opts)`、`request(opts)`、`fetchRetry(url, options)` |

插件或适配器可直接调用 `Bot.makeLog()` 等方法，而不必单独导入 `BotUtil`。

---

## 8. 参考路径

- 函数级别说明：`docs/reference/BOT.md`, `docs/reference/PLUGINS.md`, `docs/reference/WORKFLOWS.md`, `docs/reference/CONFIG_AND_REDIS.md`
- 协议示例：`plugins/adapter/OneBotv11.js`
- 事件增强：`lib/plugins/loader.js`, `lib/bot.js`

结合本文件与 reference 文档即可掌握对象 API 与 Redis 交互方式。***