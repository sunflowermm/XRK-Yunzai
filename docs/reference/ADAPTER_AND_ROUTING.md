# 适配器与路由系统关系文档

> 本文档详细说明适配器（Adapter）和路由系统（Routing）如何与 Bot 主对象交互，以及它们之间的关系。

---

## 1. 适配器（Adapter）系统

### 1.1 适配器概述

适配器是连接外部协议（如 OneBot、QQ、微信等）与 Bot 核心系统的桥梁。所有适配器都通过 `Bot.adapter` 数组注册。

**适配器存放路径**: `plugins/system-plugin/adapter/` 或各插件下 `plugins/<插件名>/adapter/`。

### 1.2 适配器注册

在适配器文件中通过 `Bot.adapter.push(adapterInstance)` 注册。适配器需有 `id`、`name`、`path`（WebSocket 路径）、`echo`（请求-响应 Map）、`timeout` 及发送/拉取等实现方法。

### 1.3 适配器与 Bot 的交互

- **事件触发**：`Bot.em(\`connect.${self_id}\`, { self_id, bot, adapter })`、`Bot.em('message.private.friend', { self_id, user_id, message, bot })`、`Bot.em('notice.group.increase', { ... })`。命名格式：`<post_type>.<type>.<sub_type>`（如 message.private.friend、notice.group.increase）。
- **账号管理**：`Bot.uin.push(self_id)`、`Bot.uin.includes(self_id)`；uin 为代理数组，支持 toJSON/toString/includes。
- **子 Bot**：`Bot.bots[self_id] = { uin, fl, gl, gml, adapter, sendApi, ... }` 存储每账号上下文。
- **WebSocket**：将 handler 推入 `Bot.wsf[path]`，wsConnect 匹配完整路径或首段（如 `/OneBotv11`、`OneBotv11`）并调用 adapter.connect(conn, req)。
- **工具**：`Bot.makeLog`、`Bot.String`/`Bot.Buffer`/`Bot.fileType`、`Bot.makeError`、`Bot.sendMasterMsg`/`Bot.sendForwardMsg`、`Bot.getServerUrl`、`Bot.httpPort`/`Bot.httpsPort` 等。

### 1.4 适配器必须实现的方法

| 方法 | 说明 | 参数 | 返回值 |
|------|------|------|--------|
| `sendFriendMsg(data, msg)` | 发送好友消息 | `data`: 事件数据, `msg`: 消息 | `Promise<any>` |
| `sendGroupMsg(data, msg)` | 发送群消息 | `data`: 事件数据, `msg`: 消息 | `Promise<any>` |
| `recallMsg(data, message_id)` | 撤回消息 | `data`: 事件数据, `message_id`: 消息ID | `Promise<any>` |
| `getFriendArray(data)` | 获取好友列表 | `data`: 事件数据 | `Promise<Array>` |
| `getGroupArray(data)` | 获取群列表 | `data`: 事件数据 | `Promise<Array>` |
| `getFriendInfo(data)` | 获取好友信息 | `data`: 事件数据 | `Promise<Object>` |
| `getGroupInfo(data)` | 获取群信息 | `data`: 事件数据 | `Promise<Object>` |
| `getGroupMemberList(data)` | 获取群成员列表 | `data`: 事件数据 | `Promise<Array>` |
| `getGroupMemberInfo(data)` | 获取群成员信息 | `data`: 事件数据 | `Promise<Object>` |

### 1.5 事件链与事件对象规范

**事件链**（消息类事件）：

1. 适配器构造事件对象 `data`，调用 `Bot.em(eventName, data)`（Bot 内部会先执行 `prepareEvent(data)`）。
2. `Bot.em` 按事件名逐级 `emit`（如 `message.group.normal` → `message.group` → `message`）。
3. `plugins/system-plugin/events/message.js` 等监听器订阅 `message`，执行 `EventListener.execute(e)` → `PluginsLoader.deal(e)`。
4. **device/stdin** 不经过 `Bot.em` 的 message 分支，直接调用 `PluginsLoader.deal(event)`。
5. `deal(e)` 内：`initEvent(e)`（补全 self_id、bot、event_id）→ 若为 stdin/device 则 `normalizeSpecialEvent(e)`（补全 post_type、message、raw_message 等）→ `dealMsg(e)`（解析 message、设置 e.msg、e.group 占位等）→ `runPluginsAndHandle(e)`。

**事件对象最低要求**（供 loader 与插件兼容）：

| 来源 | 必设字段 | 说明 |
|------|----------|------|
| OneBot 消息 | post_type, message_type, sub_type, self_id, user_id, message, raw_message, sender | message 为段数组；loader 据此设 e.isGroup、e.msg、e.group（getter 或占位） |
| device 消息 | post_type: 'device', event_type: 'message', self_id, user_id, message, raw_message, sender, reply | 可选 group_id、message_type、group_name 以兼容群上下文 |
| stdin/api | post_type, message_type, sub_type, self_id, user_id, message 或 raw_message, sender, reply | normalizeSpecialEvent 会补全 message/raw_message |

**说明**：`e.isGroup`、`e.isPrivate` 由 loader 在 `setupEventProps` 中根据 `message_type` 设置，适配器无需重复设置。群消息若缺少 `e.group`（如 getter 抛错或 device 无 bot），loader 会挂占位对象 `{ group_id, group_name }`，避免插件报「未获取到群对象」。

### 1.6 适配器事件处理流程（概览）

```
外部协议消息 → 适配器解析 → 构造 data（见上表）
    → Bot.em(name, data) 或 PluginsLoader.deal(data)（device/stdin）
    → initEvent → normalizeSpecialEvent（若适用）→ dealMsg → runPluginsAndHandle
    → 插件执行
```

### 1.7 适配器示例

```javascript
// plugins/system-plugin/adapter/MyAdapter.js（与 OneBotv11、stdin 同目录）
Bot.adapter.push(new class MyAdapter {
  id = "MY_PROTOCOL"; name = "MyProtocol"; path = this.name; echo = new Map(); timeout = 60000;
  sendFriendMsg(data, msg) { return this.sendApi(data, ws, "send_private_msg", { user_id: data.user_id, message: msg }); }
  sendGroupMsg(data, msg) { return this.sendApi(data, ws, "send_group_msg", { group_id: data.group_id, message: msg }); }
  sendApi(data, ws, action, params = {}) { /* echo + Promise.withResolvers + 超时 */ }
  connect(ws, req) {
    const self_id = 'my_bot_id';
    if (!Bot.uin.includes(self_id)) Bot.uin.push(self_id);
    Bot.bots[self_id] = { uin: self_id, fl: new Map(), gl: new Map(), adapter: this, sendApi: (a, p) => this.sendApi({ self_id }, ws, a, p) };
    Bot.em(`connect.${self_id}`, { self_id, bot: Bot.bots[self_id] });
    ws.on('message', (raw) => { const d = JSON.parse(raw); Bot.em('message.private.friend', { self_id, user_id: d.user_id, message: d.message, bot: Bot.bots[self_id] }); });
  }
});
Bot.wsf['MyProtocol'] = Bot.wsf['MyProtocol'] || []; Bot.wsf['MyProtocol'].push((conn, req) => Bot.adapter.find(a => a.path === 'MyProtocol')?.connect(conn, req));
```

---

## 2. 路由（Routing）系统

### 2.1 路由系统概述

路由系统通过 `ApiLoader` 管理所有 HTTP API 路由。路由可以注册 REST API、WebSocket 处理器和中间件。

**路由存放路径**: `plugins/<插件根>/http/`

### 2.2 路由注册流程

```
Bot.run()
    ↓
ApiLoader.load()          ← 加载所有API文件
    ↓
ApiLoader.register(app, bot)  ← 注册路由到Express
    ↓
HttpApi.init(app, bot)   ← 初始化API
    ↓
HttpApi.registerRoutes(app, bot)  ← 注册路由
    ↓
HttpApi.registerWebSocketHandlers(bot)  ← 注册WebSocket
```

### 2.3 路由与 Bot 的交互

| 能力 | 用法 |
|------|------|
| Bot 访问 | handler 中使用 `req.bot` 或参数 `Bot`（二者同源）；`req.apiLoader.getApiList()` 取 API 列表 |
| 触发事件 | `Bot.em(event_type, { ...event_data })` |
| 发送消息 | `Bot.sendFriendMsg(null, user_id, message)`、`Bot.sendGroupMsg(...)` |
| 配置访问 | `import cfg from '../../lib/config/config.js'`，使用 `cfg.server`、`cfg.bot`、`cfg.masterQQ` 等 |

示例：`handler: async (req, res, Bot) => { const url = Bot.getServerUrl(); const friends = req.bot.getFriendList(); res.json({ url, friends }); }`

### 2.4 ApiLoader 与 Bot 的关系

#### 2.4.1 ApiLoader 方法

| 方法 | 说明 | 参数 | 返回值 |
|------|------|------|--------|
| `load()` | 加载所有API文件 | - | `Promise<Map>` |
| `register(app, bot)` | 注册所有API到Express | `app`: Express实例, `bot`: Bot实例 | `Promise<void>` |
| `getApiList()` | 获取API列表 | - | `Array<Object>` |
| `getApi(key)` | 获取指定API实例 | `key`: API键名 | `Object\|null` |
| `changeApi(key)` | 重载API | `key`: API键名 | `Promise<boolean>` |
| `unloadApi(key)` | 卸载API | `key`: API键名 | `Promise<void>` |
| `watch(enable)` | 启用/禁用文件监视 | `enable`: 布尔值 | `Promise<void>` |

#### 2.4.2 ApiLoader 在 Bot 中的使用

```javascript
// Bot.run() 中
await ApiLoader.load();                    // 加载API
await ApiLoader.register(this.express, this);  // 注册路由
await ApiLoader.watch(true);               // 启用文件监视
```

### 2.5 路由中间件与 Bot

支持 `middleware`（全局）与 `routes[].middleware`（路由级），中间件内可访问 `req.bot`。示例：`middleware: [(req, res, next) => { req.bot.makeLog('debug', req.path, 'API'); next(); }]`；路由级可做鉴权后 `next()`。

---

## 3. Bot 对象方法速查

Bot 的完整方法列表（生命周期、事件、联系人、消息、HTTP/代理、WebSocket、网络、文件、系统与内部方法）见 [BOT.md](./BOT.md)，此处不再重复。

---

## 4. 适配器与路由的协作

### 4.1 事件流

```
适配器接收消息
    ↓
Bot.em('message.private.friend', data)
    ↓
PluginsLoader.deal(e)
    ↓
插件处理
    ↓
插件调用工作流
    ↓
工作流可能需要调用API
    ↓
API路由处理
    ↓
返回结果
```

### 4.2 数据流

```
外部协议 → 适配器 → Bot.em() → 插件 → 工作流
                                    ↓
API路由 ← Bot.sendFriendMsg() ← 插件
```

### 4.3 共享资源

适配器和路由共享以下 Bot 资源：

- `Bot.bots`: 子Bot实例
- `Bot.uin`: 账号列表
- `Bot.wsf`: WebSocket处理器
- `Bot.express`: Express应用
- `Bot.apiKey`: API密钥
- `Bot.getServerUrl()`: 服务器URL

---

## 5. 最佳实践

### 5.1 适配器开发

1. **事件命名**: 遵循 `post_type.message_type.sub_type` 格式
2. **错误处理**: 使用 `Bot.makeError()` 创建标准化错误
3. **日志记录**: 使用 `Bot.makeLog()` 记录重要操作
4. **账号管理**: 及时更新 `Bot.uin` 和 `Bot.bots`
5. **WebSocket**: 正确注册到 `Bot.wsf`

### 5.2 路由开发

1. **Bot访问**: 优先使用 `req.bot` 而不是全局 `Bot`
2. **错误处理**: 使用 try-catch 捕获错误
3. **响应格式**: 统一使用 JSON 格式
4. **状态码**: 正确使用 HTTP 状态码
5. **认证**: 依赖 `_authMiddleware` 处理认证

### 5.3 性能优化

1. **缓存**: 使用 `Bot._cache` 缓存频繁访问的数据
2. **异步**: 所有I/O操作使用 async/await
3. **批量操作**: 批量处理消息和请求
4. **资源清理**: 及时清理定时器和监听器

---

## 6. 相关文档

- [Bot对象函数手册](./BOT.md) - Bot对象的完整API
- [HTTP API基类文档](../HTTP_API_BASE_CLASS.md) - 路由开发指南
- [核心对象文档](../CORE_OBJECTS.md) - 核心对象速查

