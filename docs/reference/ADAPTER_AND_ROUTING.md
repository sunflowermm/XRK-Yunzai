<div align="center">

# 适配器与路由系统关系文档

> 本文档详细说明适配器（Adapter）和路由系统（Routing）如何与 Bot 主对象交互，以及它们之间的关系。

</div>

---

<div align="center">

## 1. 适配器（Adapter）系统

</div>

### 1.1 适配器概述

适配器是连接外部协议（如 OneBot、QQ、微信等）与 Bot 核心系统的桥梁。所有适配器都通过 `Bot.adapter` 数组注册。

**适配器存放路径**: `plugins/adapter/`

### 1.2 适配器注册

适配器通过以下方式注册到 Bot：

```javascript
// plugins/adapter/MyAdapter.js
Bot.adapter.push(
  new class MyAdapter {
    id = "MY_PROTOCOL"      // 适配器ID（唯一标识）
    name = "MyProtocol"     // 适配器名称
    path = this.name         // WebSocket路径
    echo = new Map()         // 请求-响应映射
    timeout = 60000          // API请求超时时间
    
    // ... 适配器方法
  }
);
```

### 1.3 适配器与 Bot 的交互

#### 1.3.1 事件触发

适配器通过 `Bot.em()` 方法触发事件：

```javascript
// 触发连接事件
Bot.em(`connect.${self_id}`, {
  self_id: self_id,
  bot: botInstance,
  adapter: this
});

// 触发消息事件
Bot.em(`message.private.friend`, {
  self_id: self_id,
  user_id: user_id,
  message: message,
  // ... 其他字段
});

// 触发通知事件
Bot.em(`notice.group.increase`, {
  self_id: self_id,
  group_id: group_id,
  user_id: user_id,
  // ... 其他字段
});
```

**事件命名规则**:
- 格式: `<post_type>.<message_type|notice_type|request_type>.<sub_type>`
- 示例: `message.private.friend`, `notice.group.increase`, `request.friend.add`

#### 1.3.2 账号管理

适配器通过 `Bot.uin` 管理账号列表：

```javascript
// 添加账号到列表
if (!Bot.uin.includes(self_id)) {
  Bot.uin.push(self_id);
}

// Bot.uin 是一个特殊的代理数组，支持：
// - toJSON(): 返回随机当前账号
// - toString(): 返回当前账号字符串
// - includes(uin): 检查账号是否存在
```

#### 1.3.3 子 Bot 实例管理

适配器通过 `Bot.bots` 管理子 Bot 实例：

```javascript
// 存储子Bot实例
Bot.bots[self_id] = {
  uin: self_id,
  fl: new Map(),        // 好友列表
  gl: new Map(),        // 群列表
  gml: new Map(),       // 群成员列表
  adapter: this,        // 适配器引用
  sendApi: (action, params) => { /* ... */ },
  // ... 其他方法
};
```

#### 1.3.4 WebSocket 注册

适配器通过 `Bot.wsf` 注册 WebSocket 处理器：

```javascript
// 注册WebSocket路径
if (!Array.isArray(Bot.wsf[this.path])) {
  Bot.wsf[this.path] = [];
}

Bot.wsf[this.path].push((conn, req, bot, socket, head) => {
  // WebSocket连接处理逻辑
  conn.on('message', (msg) => {
    // 处理消息
  });
});
```

**WebSocket 路径匹配**:
- 完整路径匹配: `/OneBotv11`
- 路径段匹配: `OneBotv11`（自动匹配 `/OneBotv11`）

#### 1.3.5 Bot 工具方法调用

适配器可以使用 Bot 的所有工具方法：

```javascript
// 日志方法
Bot.makeLog('info', '消息', scope);
Bot.makeLog('error', '错误', scope, error);

// 字符串工具
Bot.String(data);              // 转换为字符串
Bot.Buffer(file, opts);        // 转换为Buffer
Bot.fileType(file, opts);       // 获取文件类型

// 错误处理
Bot.makeError(message, type, details);

// 消息发送
Bot.sendMasterMsg(msg, sleep);  // 发送给主人
Bot.sendForwardMsg(send, msg);  // 发送转发消息

// 服务器信息
Bot.getServerUrl();             // 获取服务器URL
Bot.httpPort;                   // HTTP端口
Bot.httpsPort;                  // HTTPS端口
```

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

### 1.5 适配器事件处理流程

```
外部协议消息
    ↓
适配器接收
    ↓
解析消息格式
    ↓
构造事件对象 data
    ↓
Bot.prepareEvent(data)  ← 补全 bot/friend/group/member
    ↓
Bot.em(eventName, data)  ← 触发事件
    ↓
PluginsLoader.deal(e)   ← 插件处理
    ↓
插件执行
```

### 1.6 适配器示例

```javascript
// plugins/adapter/MyAdapter.js
Bot.adapter.push(
  new class MyAdapter {
    id = "MY_PROTOCOL"
    name = "MyProtocol"
    path = this.name
    echo = new Map()
    timeout = 60000

    // 发送好友消息
    sendFriendMsg(data, msg) {
      // 实现发送逻辑
      return this.sendApi(data, ws, "send_private_msg", {
        user_id: data.user_id,
        message: msg
      });
    }

    // 发送群消息
    sendGroupMsg(data, msg) {
      return this.sendApi(data, ws, "send_group_msg", {
        group_id: data.group_id,
        message: msg
      });
    }

    // API请求
    sendApi(data, ws, action, params = {}) {
      const echo = ulid();
      const request = { action, params, echo };
      ws.sendMsg(request);
      
      const cache = Promise.withResolvers();
      this.echo.set(echo, cache);
      
      const timeout = setTimeout(() => {
        cache.reject(Bot.makeError("请求超时", request));
        this.echo.delete(echo);
      }, this.timeout);
      
      return cache.promise
        .then(response => {
          clearTimeout(timeout);
          this.echo.delete(echo);
          return response.data;
        })
        .catch(err => {
          clearTimeout(timeout);
          this.echo.delete(echo);
          throw err;
        });
    }

    // WebSocket连接处理
    connect(ws, req) {
      const self_id = 'my_bot_id';
      
      // 注册到Bot
      if (!Bot.uin.includes(self_id)) {
        Bot.uin.push(self_id);
      }
      
      Bot.bots[self_id] = {
        uin: self_id,
        fl: new Map(),
        gl: new Map(),
        adapter: this,
        sendApi: (action, params) => this.sendApi({ self_id }, ws, action, params)
      };
      
      // 触发连接事件
      Bot.em(`connect.${self_id}`, {
        self_id: self_id,
        bot: Bot.bots[self_id]
      });
      
      // 处理消息
      ws.on('message', (raw) => {
        const data = JSON.parse(raw);
        
        // 触发消息事件
        Bot.em(`message.private.friend`, {
          self_id: self_id,
          user_id: data.user_id,
          message: data.message,
          bot: Bot.bots[self_id]
        });
      });
    }
  }
);

// 注册WebSocket处理器
if (!Array.isArray(Bot.wsf['MyProtocol'])) {
  Bot.wsf['MyProtocol'] = [];
}

Bot.wsf['MyProtocol'].push((conn, req, bot, socket, head) => {
  const adapter = Bot.adapter.find(a => a.path === 'MyProtocol');
  if (adapter) {
    adapter.connect(conn, req);
  }
});
```

---

<div align="center">

## 2. 路由（Routing）系统

</div>

### 2.1 路由系统概述

路由系统通过 `ApiLoader` 管理所有 HTTP API 路由。路由可以注册 REST API、WebSocket 处理器和中间件。

**路由存放路径**: `plugins/api/`

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

#### 2.3.1 路由处理器中的 Bot 访问

在路由处理器中，可以通过以下方式访问 Bot：

```javascript
// 方式1: 通过 req.bot（推荐）
export default {
  routes: [{
    method: 'GET',
    path: '/api/test',
    handler: async (req, res, Bot) => {
      // Bot 是全局 Bot 实例
      const url = Bot.getServerUrl();
      
      // req.bot 也是 Bot 实例（与上面的 Bot 相同）
      const friends = req.bot.getFriendList();
      
      res.json({ url, friends });
    }
  }]
};

// 方式2: 通过 req.apiLoader
handler: async (req, res, Bot) => {
  const apiList = req.apiLoader.getApiList();
  res.json({ apis: apiList });
}
```

#### 2.3.2 路由中触发事件

路由可以通过 `Bot.em()` 触发事件：

```javascript
export default {
  routes: [{
    method: 'POST',
    path: '/api/trigger',
    handler: async (req, res, Bot) => {
      const { event_type, event_data } = req.body;
      
      // 触发自定义事件
      Bot.em(event_type, {
        ...event_data,
        source: 'api',
        timestamp: Date.now()
      });
      
      res.json({ success: true });
    }
  }]
};
```

#### 2.3.3 路由中发送消息

路由可以通过 Bot 方法发送消息：

```javascript
export default {
  routes: [{
    method: 'POST',
    path: '/api/send',
    handler: async (req, res, Bot) => {
      const { user_id, message } = req.body;
      
      // 发送好友消息
      const result = await Bot.sendFriendMsg(null, user_id, message);
      
      res.json({ success: true, result });
    }
  }]
};
```

#### 2.3.4 路由中访问配置

路由可以通过 `cfg` 访问配置：

```javascript
import cfg from '../../lib/config/config.js';

export default {
  routes: [{
    method: 'GET',
    path: '/api/config',
    handler: async (req, res, Bot) => {
      res.json({
        server: cfg.server,
        bot: cfg.bot,
        masterQQ: cfg.masterQQ
      });
    }
  }]
};
```

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

路由可以注册全局中间件和路由级中间件：

```javascript
export default {
  // 全局中间件（所有路由）
  middleware: [
    (req, res, next) => {
      // 可以访问 req.bot
      req.bot.makeLog('debug', `请求: ${req.path}`, 'API');
      next();
    }
  ],
  
  routes: [{
    method: 'GET',
    path: '/api/test',
    // 路由级中间件（仅此路由）
    middleware: [
      (req, res, next) => {
        // 可以访问 req.bot
        if (!req.bot.apiKey) {
          return res.status(401).json({ error: '未授权' });
        }
        next();
      }
    ],
    handler: async (req, res, Bot) => {
      res.json({ success: true });
    }
  }]
};
```

---

<div align="center">

## 3. Bot 对象完整方法列表

</div>

### 3.1 生命周期方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `constructor()` | `new Bot()` | 初始化Bot实例 |
| `run(options)` | `async run({ port? })` | 启动Bot服务器 |
| `closeServer()` | `async closeServer()` | 关闭服务器 |

### 3.2 事件方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `prepareEvent(data)` | `(data: Object) => void` | 补全事件对象属性 |
| `em(name, data)` | `(name: string, data?: Object) => void` | 触发层级事件 |
| `_extendEventMethods(data)` | `(data: Object) => void` | 扩展事件方法 |

### 3.3 联系人方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `getFriendArray()` | `() => Array` | 获取所有好友数组 |
| `getFriendList()` | `() => Array` | 获取所有好友ID数组 |
| `getFriendMap()` | `() => Map` | 获取所有好友Map |
| `get fl()` | `getter => Map` | `getFriendMap()` 的别名 |
| `getGroupArray()` | `() => Array` | 获取所有群数组 |
| `getGroupList()` | `() => Array` | 获取所有群ID数组 |
| `getGroupMap()` | `() => Map` | 获取所有群Map |
| `get gl()` | `getter => Map` | `getGroupMap()` 的别名 |
| `get gml()` | `getter => Map` | 获取所有群成员Map |
| `pickFriend(user_id, strict?)` | `(user_id, strict?) => Friend` | 选择好友对象 |
| `get pickUser()` | `getter => Function` | `pickFriend` 的别名 |
| `pickGroup(group_id, strict?)` | `(group_id, strict?) => Group` | 选择群对象 |
| `pickMember(group_id, user_id)` | `(group_id, user_id) => Member` | 选择群成员对象 |

### 3.4 消息发送方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `sendFriendMsg(bot_id, user_id, ...args)` | `async (bot_id?, user_id, ...args) => any` | 发送好友消息 |
| `sendGroupMsg(bot_id, group_id, ...args)` | `async (bot_id?, group_id, ...args) => any` | 发送群消息 |
| `sendMasterMsg(msg, sleep?)` | `async (msg, sleep?) => Object` | 发送主人消息 |
| `makeForwardMsg(msg)` | `(msg: any) => Object` | 构造转发消息节点 |
| `makeForwardArray(msg, node?)` | `(msg: Array, node?) => Object` | 构造转发消息数组 |
| `sendForwardMsg(send, msg)` | `async (send: Function, msg: Array) => Array` | 发送转发消息 |

### 3.5 HTTP/HTTPS/代理方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `_initHttpServer()` | `() => void` | 初始化HTTP服务器 |
| `_initProxyApp()` | `async () => void` | 初始化代理应用 |
| `_loadDomainCertificates()` | `async () => void` | 加载域名SSL证书 |
| `_createHttpsProxyServer()` | `async () => void` | 创建HTTPS代理服务器 |
| `_createProxyMiddleware(domainConfig)` | `(domainConfig) => Middleware` | 创建代理中间件 |
| `_findDomainConfig(hostname)` | `(hostname: string) => Object\|null` | 查找域名配置 |
| `_findWildcardContext(servername)` | `(servername: string) => Context\|null` | 查找通配符SSL证书 |
| `startProxyServers()` | `async () => void` | 启动代理服务器 |
| `httpsLoad()` | `async () => void` | 加载HTTPS服务器 |
| `serverLoad(isHttps)` | `async (isHttps: boolean) => void` | 加载服务器 |
| `serverEADDRINUSE(err, isHttps)` | `async (err, isHttps) => void` | 处理端口占用错误 |

### 3.6 中间件和路由方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `_initializeMiddlewareAndRoutes()` | `() => void` | 初始化中间件和路由 |
| `_setupCors()` | `() => void` | 配置CORS |
| `_setupRequestLogging()` | `() => void` | 配置请求日志 |
| `_setupRateLimiting()` | `() => void` | 配置速率限制 |
| `_setupBodyParsers()` | `() => void` | 配置请求体解析器 |
| `_setupStaticServing()` | `() => void` | 配置静态文件服务 |
| `_setupFinalHandlers()` | `() => void` | 配置最终处理器（404/错误） |
| `_authMiddleware(req, res, next)` | `(req, res, next) => void` | 认证中间件 |
| `_checkApiAuthorization(req)` | `(req) => boolean` | 检查API授权 |
| `checkApiAuthorization(req)` | `(req) => boolean` | 公开的API授权检查 |

### 3.7 WebSocket方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `wsConnect(req, socket, head)` | `(req, socket, head) => void` | WebSocket连接处理 |

### 3.8 网络和工具方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `getServerUrl()` | `() => string` | 获取服务器URL |
| `getLocalIpAddress()` | `async () => Object` | 获取本地IP地址 |
| `_isLocalConnection(address)` | `(address: string) => boolean` | 检查是否为本地连接 |
| `_isPrivateIP(ip)` | `(ip: string) => boolean` | 检查是否为私有IP |
| `_getIpByUdp()` | `async () => string` | 通过UDP获取IP |
| `_getPublicIP()` | `async () => string\|null` | 获取公网IP |
| `_isValidIP(ip)` | `(ip: string) => boolean` | 验证IP地址格式 |
| `_isVirtualInterface(name, mac)` | `(name: string, mac: string) => boolean` | 检查是否为虚拟网卡 |

### 3.9 文件和方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `_fileHandler(req, res)` | `(req, res) => void` | 文件处理器 |
| `fileToUrl(file, opts?)` | `async (file, opts?) => string` | 文件转URL |

### 3.10 系统方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `_statusHandler(req, res)` | `(req, res) => void` | 状态处理器 |
| `_healthHandler(req, res)` | `(req, res) => void` | 健康检查处理器 |
| `_handleFavicon(req, res)` | `async (req, res) => void` | Favicon处理器 |
| `_handleRobotsTxt(req, res)` | `async (req, res) => void` | Robots.txt处理器 |
| `generateApiKey()` | `async () => string\|null` | 生成API密钥 |
| `makeError(message, type?, details?)` | `(message, type?, details?) => Error` | 创建错误对象 |
| `redisExit()` | `async () => boolean` | 退出Redis |

### 3.11 内部方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `_createUinManager()` | `() => Proxy` | 创建账号管理器 |
| `_createProxy()` | `() => Proxy` | 创建Bot代理对象 |
| `_handleServerError(err, isHttps)` | `(err, isHttps) => void` | 处理服务器错误 |
| `_setupSignalHandlers()` | `() => void` | 设置信号处理器 |
| `_directoryIndexMiddleware(req, res, next)` | `(req, res, next) => void` | 目录索引中间件 |
| `_setStaticHeaders(res, filePath)` | `(res, filePath) => void` | 设置静态文件头 |
| `_staticSecurityMiddleware(req, res, next)` | `(req, res, next) => void` | 静态文件安全中间件 |
| `_displayProxyInfo()` | `async () => void` | 显示代理信息 |
| `_displayAccessUrls(protocol, port)` | `async (protocol, port) => void` | 显示访问地址 |

---

<div align="center">

## 4. 适配器与路由的协作

</div>

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

<div align="center">

## 5. 最佳实践

</div>

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

<div align="center">

## 6. 相关文档

</div>

- [Bot对象函数手册](./BOT.md) - Bot对象的完整API
- [HTTP API基类文档](../HTTP_API_BASE_CLASS.md) - 路由开发指南
- [核心对象文档](../CORE_OBJECTS.md) - 核心对象速查

