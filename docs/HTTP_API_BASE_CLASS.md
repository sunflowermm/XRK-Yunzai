# HTTP API基类开发文档

## 概述

`HttpApi` 是所有HTTP API模块的基类，提供路由注册、WebSocket处理、中间件等功能。所有API模块应继承此类或使用对象导出。

**文件路径**: `lib/http/http.js`

## 使用方式

### 方式1: 对象导出（推荐）

```javascript
export default {
  name: 'my-api',
  dsc: '我的API',
  priority: 100,
  routes: [
    {
      method: 'GET',
      path: '/api/test',
      handler: async (req, res, Bot) => {
        res.json({ success: true });
      }
    }
  ],
  init: async (app, Bot) => {
    // 初始化逻辑
  }
};
```

### 方式2: 继承HttpApi类

```javascript
// 假设已导入: import HttpApi from '../../lib/http/http.js';

export default class MyApi extends HttpApi {
  constructor() {
    super({ name: 'my-api', dsc: '我的API', priority: 100, routes: [/* ... */] });
  }
}
```

## 构造函数参数

```javascript
constructor(data = {})
```

### 参数说明

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | string | `"unnamed-api"` | API名称（必填，用于标识） |
| `dsc` | string | `"暂无描述"` | API描述（用于文档和日志） |
| `routes` | array | `[]` | 路由配置数组 |
| `priority` | number | `100` | 优先级（数字越大优先级越高） |
| `enable` | boolean | `true` | 是否启用 |
| `init` | function | `null` | 初始化钩子函数 |
| `ws` | object | `{}` | WebSocket处理器对象 |
| `middleware` | array | `[]` | 全局中间件数组 |

## 路由配置

### 路由对象结构

```javascript
{
  method: 'GET',           // HTTP方法（GET/POST/PUT/DELETE等）
  path: '/api/test',       // 路由路径
  handler: async (req, res, Bot, next) => {
    // 处理函数
  },
  middleware: []          // 可选中间件数组
}
```

### 支持的HTTP方法

- `GET`
- `POST`
- `PUT`
- `DELETE`
- `PATCH`
- `HEAD`
- `OPTIONS`

### 路由处理函数

```javascript
async (req, res, Bot, next) => {
  // req: Express请求对象
  // res: Express响应对象
  // Bot: Bot实例
  // next: Express next函数
  
  // 处理逻辑
  res.json({ success: true });
}
```

**注意:** 
- 如果响应已发送（`res.headersSent === true`），不要再次发送响应
- 使用 `req.bot` 或 `req.api` 访问Bot实例和API实例
- 错误会自动捕获并返回500错误

## WebSocket支持

### WebSocket处理器配置

```javascript
export default {
  name: 'my-api',
  ws: {
    '/my-ws': (conn, req, bot, socket, head) => {
      // conn: WebSocket连接对象
      // req: HTTP请求对象
      // bot: Bot实例
      // socket: 原始socket
      // head: 升级头
      
      conn.on('message', (msg) => {
        conn.send('收到: ' + msg);
      });
    }
  }
};
```

### 多处理器支持

```javascript
ws: {
  '/my-ws': [
    handler1,
    handler2
  ]
}
```

## 中间件支持

### 全局中间件

```javascript
export default {
  name: 'my-api',
  middleware: [
    (req, res, next) => {
      // 全局中间件逻辑
      next();
    }
  ]
};
```

### 路由级中间件

```javascript
routes: [
  {
    method: 'GET',
    path: '/api/test',
    middleware: [
      (req, res, next) => {
        // 路由级中间件
        next();
      }
    ],
    handler: async (req, res, Bot) => {
      res.json({ success: true });
    }
  }
]
```

## 核心方法

| 方法 | 说明 |
|------|------|
| `init(app, bot)` | 初始化（自动调用）：注册中间件、路由、WS |
| `registerRoutes(app, bot)` | 注册 `routes` 中所有路由 |
| `registerWebSocketHandlers(bot)` | 将 `ws` 中路径挂到 `bot.wsf` |
| `getInfo()` | 返回 `{ name, dsc, priority, routes, enable, createTime }` |
| `start()` / `stop()` | 启用/停用 API |
| `reload(app, bot)` | 依次调用 stop → init → start |

## 完整示例

### 示例1: 基础API

```javascript
export default {
  name: 'test-api',
  dsc: '测试API',
  priority: 100,
  routes: [
    {
      method: 'GET',
      path: '/api/test',
      handler: async (req, res, Bot) => {
        res.json({ 
          success: true, 
          message: '测试成功',
          timestamp: Date.now()
        });
      }
    },
    {
      method: 'POST',
      path: '/api/test',
      handler: async (req, res, Bot) => {
        const { data } = req.body;
        res.json({ 
          success: true, 
          received: data 
        });
      }
    }
  ]
};
```

### 示例2: 带中间件

```javascript
export default {
  name: 'auth-api',
  middleware: [(req, res, next) => next()],
  routes: [{
    method: 'GET',
    path: '/api/user',
    middleware: [(req, res, next) => {
      if (!req.headers.authorization) return res.status(401).json({ error: '未授权' });
      next();
    }],
    handler: async (req, res, Bot) => res.json({ user: 'test', role: 'admin' })
  }]
};
```

### 示例3: WebSocket

```javascript
export default {
  name: 'ws-api',
  ws: {
    'my-ws': (conn, req, bot) => {
      conn.on('message', (msg) => conn.send(JSON.stringify({ echo: msg })));
    }
  }
};
```

### 示例4: 继承类

```javascript
// 假设已导入: import HttpApi from '../../lib/http/http.js';

export default class MyApi extends HttpApi {
  constructor() {
    super({
      name: 'my-api',
      dsc: '我的API',
      priority: 100,
      routes: [{ method: 'GET', path: '/api/info', handler: this.getInfo.bind(this) }]
    });
  }

  async getInfo(req, res, Bot) {
    res.json({ name: this.name, description: this.dsc, version: '1.0.0' });
  }
}
```

### 示例5: 调用工作流

在 handler 中：`const stream = Bot.StreamLoader.getStream('chat'); const result = await stream.execute(null, req.body?.question);` 详见 [工作流基类](./WORKFLOW_BASE_CLASS.md)。

> API 文件放在 `plugins/<插件名>/http/*.js`，由 ApiLoader 自动加载。

## 错误处理

路由 handler 内未捕获的异常会由基类统一捕获并返回 500 JSON（含 `success: false`、`message`，开发环境下含 `error` 详情）。

## 请求对象扩展

在路由处理函数中，`req` 对象会被扩展：

- `req.bot`: Bot实例
- `req.api`: 当前API实例
- `req.requestId`: 请求ID（用于追踪）

## 最佳实践

1. **命名规范**: 使用小写字母和连字符，如 `my-api.js`
2. **错误处理**: 使用try-catch处理异步错误
3. **响应格式**: 统一使用JSON格式，包含success字段
4. **状态码**: 正确使用HTTP状态码（200/400/401/500等）
5. **参数验证**: 验证请求参数，返回明确的错误信息
6. **日志记录**: 使用 `BotUtil.makeLog` 记录重要操作
7. **WebSocket**: 及时处理连接关闭和错误

## 常见问题

**Q: 如何访问Bot实例？**
A: 在handler中使用 `Bot` 参数或 `req.bot`。

**Q: 如何访问配置？**
A: 使用 `import cfg from '../../lib/config/config.js'` 导入配置。

**Q: 如何返回文件？**
A: 使用 `res.sendFile()` 或 `res.download()`。

**Q: 如何设置响应头？**
A: 使用 `res.setHeader()` 或 `res.header()`。

**Q: WebSocket连接失败怎么办？**
A: 检查路径是否正确，确保在 `bot.wsf` 中注册，查看日志获取详细错误信息。

## 相关文档

- [工作流基类文档](./WORKFLOW_BASE_CLASS.md)
- [插件基类文档](./PLUGIN_BASE_CLASS.md)
- [项目基类总览](./BASE_CLASSES.md)
- [工厂模式文档](./FACTORY.md) - LLM提供商管理

