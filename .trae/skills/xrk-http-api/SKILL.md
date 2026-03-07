---
name: xrk-http-api
description: 在 XRK-Yunzai 中开发或修改 HTTP API 时使用；涉及 plugins/*/http/ 路由、Express 注册、WebSocket 或 HttpApi 子类时使用。
---

# XRK-Yunzai HTTP API 开发

## 位置与导出

- 路径：`plugins/<插件名>/http/*.js`。
- 导出：`export default { name, dsc, routes, ws?, init? }` 或继承 `lib/http/http.js` 的 HttpApi 类。

## 路由格式

```javascript
routes: [
  {
    method: 'GET',
    path: '/api/example',
    handler: async (req, res, Bot) => {
      res.json({ success: true });
    }
  }
]
```

## WebSocket

- `ws: { '/path': (conn, req) => {} }` 注册到 Bot 的 WebSocket 层，由 ApiLoader（`lib/http/loader.js`）统一处理。

## 工具与路径

- 文件与工具：`FileUtils`、`BotUtil`（`lib/util.js`）；配置路径：`getServerConfigPath`（`lib/config/config-constants.js`）。
