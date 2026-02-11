<h1 align="center">核心对象与全局依赖</h1>

<div align="center">

![Core Objects](https://img.shields.io/badge/Core%20Objects-7-blue?style=flat-square)
![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Version](https://img.shields.io/badge/Version-3.1.3-informational?style=flat-square)

</div>

> 📚 本文档详细介绍 XRK-Yunzai 的核心对象，包括它们在技术栈中的作用、特性、API 和使用示例。

> 💡 **架构概览**: 如需了解系统整体架构和各对象的关系，请参阅 [技术架构文档](./ARCHITECTURE.md)

---

<h2 align="center">📑 文档导航</h2>

| # | 📦 对象 | 📝 说明 |
|:---:|---|:---:|
| 1️⃣ | [Bot 对象](#1-bot-对象-libbotjs) | 🤖 系统核心控制器 |
| 2️⃣ | [事件对象 e](#2-事件对象-e) | 📨 统一的事件数据结构 |
| 3️⃣ | [logger 对象](#3-logger-对象-libconfiglogjs) | 📊 日志系统 |
| 4️⃣ | [cfg 对象](#4-cfg-对象-libconfigconfigjs) | ⚙️ 配置管理系统 |
| 5️⃣ | [segment 对象](#5-segment-对象) | 📝 消息段构造器 |
| 6️⃣ | [redis 客户端](#6-redis-客户端-libconfigredisjs) | 🔴 Redis 缓存服务 |
| 7️⃣ | [BotUtil 工具集](#7-botutil-工具集-libcommonutiljs) | 🛠️ 工具函数集合 |

---

<h2 align="center">1. Bot 对象 (`lib/bot.js`)</h2>

### 1.1 在技术栈中的作用

`Bot` 是系统的核心控制器，在整个技术栈中扮演以下角色：

1. **服务生命周期管理**: 负责启动和关闭 HTTP、HTTPS、反向代理服务器
2. **事件分发中心**: 通过 `em()` 方法将事件分发到插件系统
3. **适配器集成点**: 适配器通过 `Bot.adapter.push()` 注册，通过 `Bot.em()` 触发事件
4. **路由注册点**: API 路由通过 `ApiLoader.register(app, bot)` 注册到 Bot 的 Express 应用
5. **工具函数提供者**: 通过 Proxy 机制将 `BotUtil` 的所有工具函数代理到 `Bot` 实例

### 1.2 技术特性

- **继承 EventEmitter**: 支持事件驱动架构，可以监听和触发自定义事件
- **Proxy 机制**: 将 `BotUtil` 的方法代理到 `Bot` 实例，实现统一 API
- **多服务器支持**: 同时支持 HTTP、HTTPS、反向代理服务器运行
- **WebSocket 支持**: 统一的 WebSocket 升级处理，支持多路径分发
- **中间件系统**: 集成 Express 中间件（压缩、安全头、限流、认证、静态资源）
- **健康检查**: 提供 `/status` 和 `/health` 端点用于监控

### 1.3 核心能力

| 能力分类 | 核心方法 | 说明 |
|---------|---------|------|
| **服务生命周期** | `run(options)`, `closeServer()`, `serverLoad()`, `httpsLoad()` | 启动/关闭 HTTP、HTTPS、代理服务器；打印访问地址 |
| **HTTP 中间件** | `_initializeMiddlewareAndRoutes()`, `_setupCors()`, `_authMiddleware()` | 自动注册压缩、安全头、限流、静态资源、认证中间件 |
| **代理/网络** | `_initProxyApp()`, `_createProxyMiddleware()`, `_displayProxyInfo()`, `getServerUrl()` | 多域名反向代理、SNI 证书加载、本地/公网 IP 探测 |
| **WebSocket** | `wsConnect()` | 统一 WebSocket upgrade 处理，按路径分发到 `bot.wsf` |
| **事件增强** | `prepareEvent()`, `_extendEventMethods()`, `em()` | 补全 `e.friend/group/member` 并注入 `sendFile`、`makeForwardMsg` 等方法 |
| **联系人工具** | `pickFriend()`, `pickGroup()`, `pickMember()`, `sendFriendMsg()`, `sendGroupMsg()`, `makeForwardMsg()` | 跨账号分发消息、构造合并转发、批量通知主人 |
| **诊断工具** | `makeError()`, `_setupRequestLogging()`, `_statusHandler()`, `_healthHandler()` | 统一格式错误处理、请求日志、健康检查 |

### 1.4 关键方法说明

#### prepareEvent(data)
- **作用**: 准备事件对象，注入 Bot 实例和联系人对象
- **流程**:
  1. 检查 `data.self_id` 对应的 Bot 实例是否存在
  2. 注入 `data.bot` 属性（Bot 子实例）
  3. 如果存在 `user_id`，注入 `data.friend`（好友对象）
  4. 如果存在 `group_id`，注入 `data.group`（群对象）
  5. 如果同时存在 `group_id` 和 `user_id`，注入 `data.member`（群成员对象）
  6. 注入适配器信息（`adapter_id`、`adapter_name`）
  7. 调用 `_extendEventMethods()` 扩展方法

#### _extendEventMethods(data)
- **作用**: 为事件对象的联系人对象注入通用方法
- **注入的方法**:
  - `sendFile(file, name)`: 发送文件
  - `makeForwardMsg(nodes)`: 构造转发消息
  - `sendForwardMsg(nodes)`: 发送转发消息
  - `getInfo()`: 获取联系人信息
- **回复方法**: 如果不存在 `data.reply`，自动设置 `data.reply` 为群或好友的 `sendMsg` 方法

#### em(name, data)
- **作用**: 触发事件，支持事件名层级传播
- **流程**:
  1. 调用 `prepareEvent(data)` 准备事件对象
  2. 触发完整事件名（如 `message.group.normal`）
  3. 逐级触发父级事件（如 `message.group`、`message`）
  4. 插件系统监听这些事件并处理

> **详细 API**: 完整的 Bot 对象方法说明请查阅 [`docs/reference/BOT.md`](./reference/BOT.md)

---

<h2 align="center">2. 事件对象 `e`</h2>

### 2.1 在技术栈中的作用

事件对象 `e` 是系统的核心数据结构，在整个技术栈中扮演以下角色：

1. **统一事件接口**: 无论事件来源（OneBot、设备、STDIN、API），都使用相同的对象结构
2. **插件输入**: 所有插件方法都接收事件对象 `e` 作为唯一参数
3. **上下文传递**: 携带完整的消息、发送者、群组、Bot 实例等信息
4. **统一回复接口**: 通过 `e.reply()` 统一处理消息回复，自动选择群聊或私聊渠道
5. **权限判断**: 通过 `e.isMaster`、`e.isGroup` 等属性进行权限和类型判断
6. **日志标识**: 通过 `e.logText` 和 `e.logFnc` 统一日志格式

### 2.2 创建流程

事件对象的创建经过以下步骤：

```
适配器/API 接收原始数据
  ↓
Bot.em('message', rawData)  // 触发事件
  ↓
Bot.prepareEvent(data)  // 注入 bot、friend、group、member
  ↓
PluginsLoader.deal(e)  // 插件加载器处理
  ↓
PluginsLoader.dealMsg(e)  // 解析消息、设置属性
  ├── initMsgProps(e)  // 初始化消息属性
  ├── parseMessage(e)  // 解析消息内容
  ├── setupEventProps(e)  // 设置事件属性
  ├── checkPermissions(e)  // 检查权限
  └── processAlias(e)  // 处理群聊别名
  ↓
PluginsLoader.setupReply(e)  // 设置回复方法
  ↓
完整的事件对象 e（包含所有属性和方法）
```

### 2.3 技术特性

- **自动增强**: 通过 `Bot.prepareEvent()` 和 `PluginsLoader.dealMsg()` 自动注入属性和方法
- **类型标识**: 自动设置 `isGroup`、`isPrivate`、`isDevice`、`isStdin`、`isMaster` 等标识
- **联系人对象**: 自动注入 `friend`、`group`、`member` 对象（如果存在）
- **方法注入**: 自动注入 `sendFile`、`makeForwardMsg`、`getInfo`、`reply` 等方法
- **不可变 Bot**: `e.bot` 属性使用 `Object.defineProperty` 设置为不可修改

事件统一由 `Bot.prepareEvent` + `plugins/loader` 注入属性，无论来源是 OneBot、设备还是 STDIN，写法一致。

### 2.1 核心属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `e.bot` | `BotInstance` | 当前消息所属的 Bot 子实例，可直接调用 `pickFriend`、`sendMsg` 等 |
| `e.self_id` | `string\|number` | 当前Bot的账号ID |
| `e.user_id` | `string\|number` | 发送者用户ID |
| `e.group_id` | `string\|number` | 群ID（群消息时存在） |
| `e.message_id` | `string\|number` | 消息ID |
| `e.time` | `number` | 时间戳（Unix时间，秒） |
| `e.post_type` | `string` | 事件类型：`message` / `notice` / `request` / `meta_event` |
| `e.message_type` | `string` | 消息类型：`private` / `group` / `guild` |
| `e.notice_type` | `string` | 通知类型：`friend` / `group` / `guild` 等 |
| `e.request_type` | `string` | 请求类型：`friend` / `group` |
| `e.sub_type` | `string` | 子类型：`friend` / `group` / `normal` / `anonymous` 等 |

### 2.2 类型标识属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `e.isGroup` | `boolean` | 是否为群消息 |
| `e.isPrivate` | `boolean` | 是否为私聊消息 |
| `e.isGuild` | `boolean` | 是否为频道消息 |
| `e.isDevice` | `boolean` | 是否为设备事件 |
| `e.isStdin` | `boolean` | 是否为STDIN/API事件 |
| `e.isMaster` | `boolean` | 是否为主人（根据 `cfg.masterQQ` 判断） |

### 2.3 消息相关属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `e.message` | `Array` | 消息数组，格式：`[{ type, data }]` |
| `e.msg` | `string` | 消息文本内容（从message中提取） |
| `e.raw_message` | `string` | 原始消息文本 |
| `e.img` | `Array<string>` | 图片URL/路径数组 |
| `e.video` | `Array<string>` | 视频URL/路径数组 |
| `e.audio` | `Array<string>` | 音频URL/路径数组 |
| `e.file` | `Object` | 文件对象 `{ name, fid, size, url }` |
| `e.fileList` | `Array<Object>` | 文件列表 |
| `e.face` | `Array<number>` | 表情ID数组 |
| `e.at` | `string\|number` | @的用户ID（第一个） |
| `e.atList` | `Array<string\|number>` | @的用户ID数组 |
| `e.atBot` | `boolean` | 是否@了Bot |
| `e.source` | `Object` | 引用消息信息 `{ message_id, seq, time, user_id, raw_message }` |
| `e.reply_id` | `string\|number` | 回复的消息ID |

### 2.4 联系人对象

| 属性 | 类型 | 说明 |
|------|------|------|
| `e.friend` | `Friend\|null` | 好友对象（私聊时存在），已注入方法 |
| `e.group` | `Group\|null` | 群对象（群消息时存在），已注入方法 |
| `e.member` | `Member\|null` | 群成员对象（群消息时存在），已注入方法 |
| `e.sender` | `Object` | 发送者信息 `{ user_id, nickname, card }` |
| `e.group_name` | `string` | 群名称 |
| `e.device_name` | `string` | 设备名称（设备事件时存在） |
| `e.device_id` | `string` | 设备ID（设备事件时存在） |

### 2.5 适配器相关属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `e.adapter` | `string` | 适配器名称（如 `'stdin'`, `'api'`） |
| `e.adapter_id` | `string` | 适配器ID |
| `e.adapter_name` | `string` | 适配器名称 |

### 2.6 方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `e.reply(msg, quote?, opts?)` | `(msg, quote?, opts?) => Promise<any>` | 智能选择群聊或私聊渠道回复 |
| `e.replyNew(msg, quote?, opts?)` | `(msg, quote?, opts?) => Promise<any>` | 新的回复方法（内部使用） |
| `e.getReply()` | `async () => Object\|null` | 拉取引用消息 |
| `e.recall()` | `() => Promise<any>` | 撤回当前消息 |
| `e.logText` | `string` | 日志统一格式 `[群名][成员]` / `[设备]` / `[STDIN]` |
| `e.logFnc` | `string` | 日志函数名 `[插件名][函数名]` |

### 2.7 friend/group/member 注入的方法

通过 `Bot._extendEventMethods` 注入：

| 方法 | 签名 | 说明 |
|------|------|------|
| `e.friend.sendFile(file, name?)` | `async (file, name?) => any` | 发送文件 |
| `e.friend.makeForwardMsg(nodes)` | `(nodes) => Object` | 构造转发消息 |
| `e.friend.sendForwardMsg(nodes)` | `async (nodes) => any` | 发送转发消息 |
| `e.friend.getInfo()` | `() => Object` | 获取好友信息 |
| `e.group.sendFile(file, name?)` | `async (file, name?) => any` | 发送文件 |
| `e.group.makeForwardMsg(nodes)` | `(nodes) => Object` | 构造转发消息 |
| `e.group.sendForwardMsg(nodes)` | `async (nodes) => any` | 发送转发消息 |
| `e.group.getInfo()` | `() => Object` | 获取群信息 |
| `e.member.sendFile(file, name?)` | `async (file, name?) => any` | 发送文件（通过群） |
| `e.member.getInfo()` | `() => Object` | 获取成员信息 |

### 2.8 其他属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `e.hasAlias` | `boolean` | 是否使用了群别名 |
| `e._needReparse` | `boolean` | 是否需要重新解析消息 |
| `e.raw` | `string\|Object` | 原始事件数据 |

### 2.9 事件对象示例

```javascript
// 群消息事件
{
  self_id: '123456',
  user_id: '789012',
  group_id: '345678',
  message_id: '987654321',
  time: 1698765432,
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  message: [
    { type: 'text', data: { text: '你好' } },
    { type: 'at', data: { qq: '123456' } }
  ],
  msg: '你好',
  atBot: true,
  atList: ['123456'],
  isGroup: true,
  isPrivate: false,
  isMaster: false,
  bot: BotInstance,
  group: GroupInstance,
  member: MemberInstance,
  sender: { user_id: '789012', nickname: '用户', card: '用户' },
  group_name: '测试群',
  logText: '[测试群(345678)][用户(789012)]',
  reply: Function,
  getReply: Function,
  recall: Function
}
```


---

<h2 align="center">3. logger 对象 (`lib/config/log.js`)</h2>

### 3.1 在技术栈中的作用

`logger` 是全局日志系统，在整个技术栈中扮演以下角色：

1. **统一日志接口**: 所有模块使用相同的日志接口，保证日志格式一致
2. **性能监控**: 通过 `time()` 和 `timeEnd()` 方法监控代码执行时间
3. **调试支持**: trace 级别日志记录详细的执行流程，便于调试
4. **错误追踪**: error 级别日志记录异常堆栈，便于问题定位
5. **日志管理**: 自动轮转、压缩、清理过期日志文件

### 3.2 技术特性

- **基于 Pino**: 使用高性能的 Pino 日志库
- **多级别日志**: 支持 trace/debug/info/warn/error/fatal 六个级别
- **文件轮转**: 按天轮转日志文件，自动压缩旧文件
- **自动清理**: 定时清理过期日志（默认主日志保留3天，trace日志保留1天）
- **颜色支持**: 丰富的颜色和格式化工具，提升可读性
- **性能优化**: 异步写入日志，不阻塞主线程

全局注入的日志系统，基于 Pino 高性能日志库，提供丰富的日志方法和格式化工具。

### 基础日志方法

| 方法 | 用法 | 说明 |
|------|------|------|
| `logger.trace/debug/info/warn/error/fatal/mark(...args)` | 输出不同级别的日志 | 支持多参数，自动格式化对象 |
| `logger.success/tip/done(...args)` | 输出特殊类型日志 | 成功、提示、完成日志 |
| `logger.warning(...args)` | `warn` 的别名 | 兼容性方法 |

### 颜色工具

| 方法 | 用法 | 说明 |
|------|------|------|
| `logger.red/green/yellow/blue/magenta/cyan/gray/white(text)` | 返回带颜色的字符串 | 仅返回字符串，不输出 |
| `logger.chalk` | 直接访问 chalk 库 | 可使用所有 chalk 方法 |
| `logger.xrkyzGradient(text)` | XRK-Yunzai 主题渐变色 | 项目主题色 |
| `logger.rainbow(text)` | 彩虹渐变色 | 七色渐变 |
| `logger.gradient(text, colors?)` | 自定义渐变色 | 可指定颜色数组 |

### 计时器方法

| 方法 | 用法 | 说明 |
|------|------|------|
| `logger.time(label?)` | 开始计时器 | 默认标签 'default' |
| `logger.timeEnd(label?)` | 结束计时器并输出耗时 | 自动格式化时间 |

### 格式化方法

| 方法 | 用法 | 说明 |
|------|------|------|
| `logger.title(text, color?)` | 输出标题（带边框） | 默认黄色 |
| `logger.subtitle(text, color?)` | 输出子标题 | 默认青色 |
| `logger.line(char?, length?, color?)` | 输出分隔线 | 默认灰色，长度35 |
| `logger.gradientLine(char?, length?)` | 输出渐变色分隔线 | 默认长度50 |
| `logger.box(text, color?)` | 输出方框文本 | 默认蓝色 |

### 数据展示方法

| 方法 | 用法 | 说明 |
|------|------|------|
| `logger.json(obj, title?)` | 格式化输出 JSON | 自动缩进 |
| `logger.table(data, title?)` | 以表格形式输出 | 使用 console.table |
| `logger.list(items, title?)` | 输出列表 | 自动编号 |
| `logger.progress(current, total, length?)` | 输出进度条 | 默认长度30 |

### 状态方法

| 方法 | 用法 | 说明 |
|------|------|------|
| `logger.status(message, status, statusColor?)` | 输出状态日志 | 支持多种状态图标 |
| `logger.important(text)` | 输出重要日志 | 黄色加粗 |
| `logger.highlight(text)` | 输出高亮日志 | 黄色背景 |
| `logger.fail(text)` | 输出失败日志 | 红色 |
| `logger.system(text)` | 输出系统日志 | 灰色 |
| `logger.tag(text, tag, tagColor?)` | 输出带标签的日志 | 默认蓝色标签 |

### 系统方法

| 方法 | 用法 | 说明 |
|------|------|------|
| `logger.platform()` | 获取平台信息 | 返回系统信息对象 |
| `logger.cleanLogs(days?, includeTrace?)` | 手动清理过期日志 | 返回删除的文件数 |
| `logger.getTraceLogs(lines?)` | 获取 trace 日志内容 | 返回日志行数组 |
| `logger.shutdown()` | 关闭日志系统 | 清理资源 |

### 配置

通过 `config/default_config/bot.yaml` 配置：

```yaml
bot:
  log_level: 'info'        # trace/debug/info/warn/error/fatal
  log_align: 'XRKYZ'        # 日志头部对齐文本
  log_color: 'default'       # 颜色方案: default/scheme1-7
  log_max_days: 3           # 主日志保留天数
  log_trace_days: 1          # Trace 日志保留天数
```

### 日志文件

- **主日志**: `logs/app.yyyy-MM-dd.log` - debug 及以上级别
- **Trace 日志**: `logs/trace.yyyy-MM-dd.log` - 所有级别

日志文件自动按天轮转，过期文件每天凌晨 3 点自动清理。

> **详细文档**: 完整的 logger API 说明请查阅 [`docs/reference/LOGGER.md`](./reference/LOGGER.md)

`BotUtil.makeLog(level, text, scope)` 会调用 `logger`，并附带时间戳、scope 名称。

---

<h2 align="center">4. cfg 对象 (`lib/config/config.js`)</h2>

### 4.1 在技术栈中的作用

`cfg` 是配置管理系统的单例，在整个技术栈中扮演以下角色：

1. **配置提供者**: 所有模块通过 `cfg` 获取配置，统一配置管理
2. **动态配置**: 支持运行时修改配置（通过 `setConfig()`），配置变更自动生效
3. **配置隔离**: 多实例部署时，通过端口号隔离配置，互不干扰
4. **配置验证**: 通过默认配置确保必要字段存在，避免配置缺失
5. **热更新**: 配置文件修改后自动清除缓存，无需重启应用

### 4.2 技术特性

- **单例模式**: 全局唯一的配置实例，所有模块共享
- **多端口隔离**: 通过端口号隔离不同服务器的配置（`data/server_bots/<port>/`）
- **热更新**: 使用 `chokidar` 监听文件变更，自动清除缓存
- **配置合并**: 默认配置 + 服务器配置，服务器配置优先
- **懒加载**: 配置按需加载，首次访问时读取文件并缓存
- **类型转换**: 自动处理 YAML 到 JavaScript 对象的转换

### 4.3 常用属性/方法

| 属性/方法 | 类型 | 说明 |
|-----------|------|------|
| `cfg.bot` | `Object` | 机器人配置（默认 + 服务器配置合并） |
| `cfg.server` | `Object` | 服务器配置（HTTP/HTTPS/代理/安全） |
| `cfg.redis` | `Object` | Redis 连接配置 |
| `cfg.llm` | `Object` | 所有LLM提供商配置对象 |
| `cfg.aistream` | `Object` | AI工作流配置对象 |
| `cfg.getLLMConfig(provider)` | `Function` | 获取指定LLM提供商配置 |
| `cfg.masterQQ` | `Array` | 主人QQ号数组，插件常用于权限判断 |
| `cfg.getGroup(groupId)` | `Function` | 返回群配置（默认 + 群自定义） |
| `cfg.setConfig(name, data)` | `Function` | 保存配置并触发文件监听器 |
| `cfg.renderer` | `Object` | 渲染器配置（playwright/puppeteer） |

> **详细 API**: 完整的 cfg 对象方法说明请查阅 [`docs/reference/CONFIG_AND_REDIS.md`](./reference/CONFIG_AND_REDIS.md#1-cfg-单例-libconfigconfigjs)

---

<h2 align="center">5. segment 对象</h2>

### 5.1 在技术栈中的作用

`segment` 是消息段构造器，用于构造富文本消息：

1. **消息构造**: 将文本、图片、文件等组合成消息数组
2. **协议适配**: 适配 OneBot 协议的消息段格式
3. **方法注入**: `Bot._extendEventMethods()` 会优先使用 `segment` 的方法

### 5.2 技术特性

- **来源**: 来源于 OneBot/`icqq` 库
- **全局注入**: 通过 `global.segment` 全局访问
- **协议依赖**: 在非 QQ 场景（设备、HTTP）可能不存在，使用前需判空

### 5.3 常用方法

| 方法 | 参数 | 说明 |
|------|------|------|
| `segment.at(qq)` | `qq: string\|number` | @ 指定用户 |
| `segment.reply(messageId)` | `messageId: string\|number` | 回复引用消息 |
| `segment.image(url/path)` | `url: string` | 发送图片 |
| `segment.file(file, name)` | `file: string, name?: string` | 发送文件 |

### 5.4 使用示例

```javascript
// 构造包含文本、@、图片的消息
const msg = [
  segment.at(123456789),
  ' 你好！',
  segment.image('https://example.com/image.jpg')
];

await e.reply(msg);
```

> **注意**: 在非 QQ 场景（设备、HTTP）可能不存在 `segment`，使用前需判空或使用 `BotUtil` 的降级逻辑。

---

<h2 align="center">6. redis 客户端 (`lib/config/redis.js`)</h2>

### 6.1 在技术栈中的作用

Redis 客户端提供高性能的缓存和存储服务，在整个技术栈中扮演以下角色：

1. **AI 记忆系统**: 存储长短期记忆（使用 ZSet + JSON）
2. **Embedding 缓存**: 缓存文本向量，加速语义检索
3. **速率限制**: 存储 API 调用频率限制数据
4. **会话锁**: 防止并发执行同一会话
5. **消息缓存**: 缓存历史消息，支持消息检索

### 6.2 技术特性

- **连接池**: 根据系统资源（CPU、内存）自动调整连接池大小（3-50）
- **自动重连**: 指数退避重连策略，连接断开后自动重连
- **健康检查**: 每 30 秒自动 PING 检查连接状态
- **开发友好**: 开发环境自动尝试启动 Redis 服务
- **全局访问**: 初始化后挂载到 `global.redis`，所有模块可直接使用

### 6.3 初始化

`redisInit()` 会在应用启动时调用，连接 Redis 并将客户端挂载到 `global.redis`：

```javascript
// 假设已导入: import redisInit from './lib/config/redis.js';

// 在 app.js 或 start.js 中
await redisInit();
// 现在可以使用 global.redis
```

### 6.4 常用操作

| 操作类型 | 方法示例 | 用途 |
|---------|---------|------|
| **字符串** | `redis.set()`, `redis.get()`, `redis.setEx()` | 速率限制、API Key 缓存 |
| **列表** | `redis.lPush()`, `redis.lRange()`, `redis.lTrim()` | 工作流 embedding、消息缓存 |
| **有序集合** | `redis.zAdd()`, `redis.zRange()`, `redis.zRemRangeByScore()` | Memory System 长短期记忆 |
| **哈希** | `redis.hSet()`, `redis.hGet()`, `redis.hGetAll()` | 存储结构化数据 |
| **过期** | `redis.expire()`, `redis.ttl()` | 设置过期时间 |

### 6.5 配置

Redis 连接参数来自 `cfg.redis`，包括：
- `host`: Redis 主机地址
- `port`: Redis 端口
- `db`: 数据库编号
- `username`: 用户名（可选）
- `password`: 密码（可选）

### 6.6 工具函数

| 函数 | 说明 |
|------|------|
| `redisInit()` | 初始化并返回客户端 |
| `closeRedis()` | 优雅关闭连接（`Bot.closeServer()` 会调用） |
| `getRedisClient()` | 获取当前实例（主要用于测试或扩展） |

> **详细 API**: 完整的 Redis 客户端说明请查阅 [`docs/reference/CONFIG_AND_REDIS.md`](./reference/CONFIG_AND_REDIS.md#2-redis-客户端-libconfigredisjs)

> **注意**: 当 Redis 不可用时，Memory System、Embedding 会自动降级，但建议保持在线以启用全部能力。

---

<h2 align="center">7. BotUtil 工具集 (`lib/common/util.js`)</h2>

### 7.1 在技术栈中的作用

`BotUtil` 是工具函数集合，通过 Proxy 机制代理到 `Bot` 实例，在整个技术栈中扮演以下角色：

1. **工具函数提供者**: 提供常用的工具函数，避免重复实现
2. **统一 API**: 通过 `Bot` 实例统一访问，无需单独导入
3. **性能优化**: 提供缓存、批量处理等性能优化工具

### 7.2 技术特性

- **Proxy 代理**: `Bot` 实例通过 Proxy 将 `BotUtil` 的方法代理到自身
- **全局访问**: 插件或适配器可直接调用 `Bot.makeLog()` 等方法
- **类型丰富**: 涵盖日志、时间、缓存、文本、文件、网络等多个领域

### 7.3 工具函数分类

| 分类 | 代表方法 | 说明 |
|------|---------|------|
| **日志** | `makeLog(level, text, scope)`, `colorLog()` | 统一日志格式，支持颜色输出 |
| **时间/控制** | `sleep(ms)`, `promiseEvent(emitter, event, errorEvent?)` | 延迟执行、事件等待 |
| **缓存** | `getMap(name, { ttl, autoClean })` | 带 TTL 和自动清理的 Map |
| **文本处理** | `String(any)`, `escapeHTML(str)`, `slugify(str)` | 字符串转换、HTML转义、URL友好化 |
| **文件/网络** | `fileToUrl(file, opts)`, `request(opts)`, `fetchRetry(url, options)` | 文件转URL、HTTP请求、重试请求 |

### 7.4 使用方式

由于 `Bot` 通过 Proxy 代理了 `BotUtil` 的方法，可以直接通过 `Bot` 实例调用：

```javascript
// 在插件中
Bot.makeLog('info', '这是一条日志', 'MyPlugin');
await Bot.sleep(1000);  // 延迟1秒
const map = Bot.getMap('my-cache', { ttl: 60000 });
```

> **注意**: 插件或适配器可直接调用 `Bot.makeLog()` 等方法，而不必单独导入 `BotUtil`。

---

---

<h2 align="center">8. 对象关系图</h2>

```mermaid
flowchart TD
    subgraph Bot["🤖 Bot (核心)"]
        PrepareEvent[prepareEvent<br/>准备事件]
        Em[em<br/>触发事件]
        CloseServer[closeServer<br/>关闭服务器]
    end
    
    subgraph Event["📨 事件对象 e"]
        EventData[事件数据]
    end
    
    subgraph PluginSys["🔌 插件系统"]
        PluginsLoader[PluginsLoader]
        Deal[deal<br/>处理事件]
        DealMsg[dealMsg<br/>解析消息]
        SetupReply[setupReply<br/>设置回复]
        RunPlugins[runPlugins<br/>执行插件]
    end
    
    subgraph Plugin["⚙️ 插件"]
        PluginFnc[plugin[fnc]<br/>插件函数]
        Reply[reply<br/>回复消息]
    end
    
    Bot --> PrepareEvent
    Bot --> Em
    Bot --> CloseServer
    
    Em --> EventData
    PrepareEvent --> EventData
    
    EventData --> PluginsLoader
    PluginsLoader --> Deal
    Deal --> DealMsg
    DealMsg --> SetupReply
    SetupReply --> RunPlugins
    RunPlugins --> PluginFnc
    PluginFnc --> Reply
    
    style Bot fill:#4a90e2,stroke:#2c5aa0,color:#fff
    style Event fill:#50c878,stroke:#2d8659,color:#fff
    style PluginSys fill:#feca57,stroke:#d68910,color:#000
    style Plugin fill:#ff6b9d,stroke:#c44569,color:#fff
```

---

<h2 align="center">9. 参考文档</h2>

### 9.1 详细 API 文档

- [Bot 对象完整 API](./reference/BOT.md) - Bot 对象的所有方法和属性
- [插件基类文档](./PLUGIN_BASE_CLASS.md) - 插件开发完整指南
- [工作流基类文档](./WORKFLOW_BASE_CLASS.md) - 工作流开发指南
- [配置与 Redis 手册](./reference/CONFIG_AND_REDIS.md) - cfg 和 redis 的完整 API
- [Logger 完整手册](./reference/LOGGER.md) - logger 的所有方法和配置

### 9.2 系统架构文档

- [技术架构文档](./ARCHITECTURE.md) - 系统整体架构和各对象的关系
- [适配器与路由系统](./reference/ADAPTER_AND_ROUTING.md) - 适配器和路由如何与 Bot 交互

### 9.3 代码示例

- 协议适配器示例：`plugins/adapter/OneBotv11.js`
- 事件增强实现：`lib/plugins/loader.js`, `lib/bot.js`
- 插件示例：`plugins/` 目录下的各种插件
- 工厂模式示例：`lib/factory/llm/LLMFactory.js`

---

<h2 align="center">10. 快速参考</h2>

### 10.1 在插件中访问核心对象

```javascript
// 假设已导入: import plugin from '../../lib/plugins/plugin.js';
//            import cfg from '../../lib/config/config.js';

export default class MyPlugin extends plugin {
  async test(e) {
    const msg = e.msg;
    const isMaster = e.isMaster;
    const bot = e.bot;
    const masterQQ = cfg.masterQQ;
    
    if (global.redis) {
      await global.redis.set('key', 'value');
    }
    
    logger.info('这是一条日志');
    return this.reply('回复内容');
  }
}
```

### 10.2 在适配器中触发事件

```javascript
// 在适配器中
const e = {
  self_id: '123456',
  user_id: '789012',
  message: [{ type: 'text', text: '你好' }]
};

Bot.em('message', e);  // 触发事件
```

### 10.3 在路由中访问 Bot

```javascript
// 在 API 路由中
export default {
  name: 'my-api',
  routes: [{
    method: 'GET',
    path: '/api/test',
    handler: async (req, res, Bot) => {
      res.json({ success: true });
    }
  }]
};
```