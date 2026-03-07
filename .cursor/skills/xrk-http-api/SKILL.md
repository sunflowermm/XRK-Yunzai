---
name: xrk-http-api
description: Develop HTTP API modules for XRK-Yunzai. Use when creating or modifying API routes in plugins/*/http/, registering Express routes, WebSocket handlers, or HttpApi subclasses.
---

# XRK-Yunzai HTTP API 开发

## 结构

- 路径：`plugins/<plugin>/http/*.js`
- 导出：`export default { name, dsc, routes, ws?, init? }` 或继承 `HttpApi`

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

- `ws: { '/path': (conn, req) => {} }`
- 注册到 `Bot.wsf`，由 ApiLoader 统一处理

## 工具

- `FileUtils`、`BotUtil`、`getServerConfigPath`（config-constants）
