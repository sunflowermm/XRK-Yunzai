# HTTP / WebSocket API 手册 (`lib/http/http.js`)

> 适用于 `plugins/<插件根>/http/*.js`，无论是对象式导出还是继承类方式，本文件涵盖所有方法。

---

## 1. 构造函数

### constructor(data = {})
- **签名**: `new HttpApi({ name, dsc, routes, priority, enable, init, ws, middleware })`
- **关键字段**:
  - `routes`: `[{ method, path, handler, middleware? }]`
  - `ws`: `{ '/ws/path': handler | handler[] }`
  - `middleware`: 需在挂载路由前执行的 Express 中间件。
- **默认值**: `name='unnamed-api'`, `priority=100`, `enable=true`。

---

## 2. 生命周期

### init(app, bot)
- **签名**: `async init(app: Express, bot: Bot): Promise<boolean>`
- **流程**: 先注册 `middleware` → `registerRoutes` → `registerWebSocketHandlers` → `initHook`。

### registerRoutes(app, bot)
- **作用**: 遍历 `routes`，根据 `method` 选择 `app[method]` 并注入包装后的 handler。
- **注意**: 自动记录成功注册的数量，并输出日志。

### wrapHandler(handler, bot)
- **签名**: `(req, res, next) => Promise<void>`
- **作用**:
  - 注入 `req.bot` 与 `req.api`。
  - 捕获异常并返回 500 JSON。
  - 若 handler 返回值但未发送响应，不会自动发送（由 handler 自行处理）。

### registerWebSocketHandlers(bot)
- **作用**: 将 `ws` 字段中的路径与处理器挂到 `bot.wsf[path]`，供 `Bot.wsConnect` 使用。

### start()
- **作用**: 将 `enable` 设为 `true` 并打印日志，通常用于热重载后重新启用。

### stop()
- **作用**: 将 `enable` 设为 `false` 并打印日志。

### reload(app, bot)
- **签名**: `async reload(app, bot): Promise<void>`
- **作用**: 顺序调用 `stop()` → `init()` → `start()`，用于开发态刷新。

---

## 3. 元数据

### getInfo()
- **返回**: `{ name, dsc, priority, routes: number, enable, createTime }`
- **用途**: 对外展示 API 状态，常被管理面板调用。

---

## 4. 定义示例

```js
// plugins/my-plugin/http/example.js
import HttpApi from '../../lib/http/http.js';

export default class ExampleApi extends HttpApi {
  constructor() {
    super({
      name: 'example-api',
      dsc: '示例 REST API',
      routes: [{
        method: 'GET',
        path: '/api/example',
        handler: async (req, res) => res.json({ ok: true })
      }],
      ws: {
        '/ws/example': (conn, req, bot) => conn.send(JSON.stringify({ hello: 'world' }))
      }
    });
  }
}
```

> **提示**：对象式导出与继承方式仅在语法上不同，`loader` 会自动兼容。

