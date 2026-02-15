# HTTP / WebSocket API 手册

> **加载**：由 `lib/http/loader.js` 从 `plugins/<插件根>/http/*.js` 加载。**基类**：`lib/http/http.js` 的 `HttpApi`。  
> **导出约定**：default 为**类或构造函数**时 `new default()` 得到实例；default 为**普通对象**（含 name/routes 等）时 `new HttpApi(default)` 包装；无 default 或类型不符则加载失败。

---

## 1. 构造函数

| 字段 | 说明 |
|------|------|
| `constructor({ name, dsc, routes, priority, enable, init, ws, middleware })` | 默认 `name='unnamed-api'`、`priority=100`、`enable=true` |
| `routes` | `[{ method, path, handler, middleware? }]` |
| `ws` | `{ '/ws/path': handler \| handler[] }` |
| `middleware` | 挂载路由前执行的 Express 中间件 |

## 2. 生命周期

| 方法 | 说明 |
|------|------|
| `init(app, bot)` | middleware → registerRoutes → registerWebSocketHandlers → initHook |
| `registerRoutes(app, bot)` | 按 method 挂到 app，注入包装后 handler，记录数量并打日志 |
| `wrapHandler(handler, bot)` | 注入 req.bot、req.api；捕获异常返回 500 JSON；不自动发送 handler 返回值 |
| `registerWebSocketHandlers(bot)` | 将 ws 路径与处理器挂到 bot.wsf[path]，供 Bot.wsConnect 使用 |
| `start()` / `stop()` | 设 enable 并打日志（热重载用） |
| `reload(app, bot)` | stop → init → start |

## 3. 元数据

| 方法 | 返回 |
|------|------|
| `getInfo()` | `{ name, dsc, priority, routes: number, enable, createTime }`，供管理面板用 |

## 4. 示例

```js
// plugins/my-plugin/http/example.js
import HttpApi from '../../lib/http/http.js';
export default class ExampleApi extends HttpApi {
  constructor() {
    super({
      name: 'example-api', dsc: '示例 REST API',
      routes: [{ method: 'GET', path: '/api/example', handler: async (req, res) => res.json({ ok: true }) }],
      ws: { '/ws/example': (conn, req, bot) => conn.send(JSON.stringify({ hello: 'world' })) }
    });
  }
}
```

对象式导出与继承方式 loader 均兼容。详见 [HTTP_API_BASE_CLASS.md](../HTTP_API_BASE_CLASS.md)。
