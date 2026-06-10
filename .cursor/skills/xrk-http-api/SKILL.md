---
name: xrk-http-api
description: 在 XRK-Yunzai 中开发或修改 HTTP API 时使用；涉及 plugins/*/http/ 路由、Express 注册、WebSocket 或 HttpApi 子类时使用。
---

# XRK-Yunzai HTTP API 开发

## 文档与代码

- 短契约：`docs/base-classes.md`；详述：`docs/HTTP_API_BASE_CLASS.md`
- 基类：`lib/http/http.js`；加载：`lib/http/loader.js`

## 推荐：对象导出

```javascript
export default {
  name: 'my-api',
  dsc: '描述',
  priority: 100,
  routes: [{
    method: 'GET',
    path: '/api/example',
    handler: async (req, res, Bot) => {
      res.json({ success: true });
    }
  }],
  ws: { '/ws/example': (conn, req) => {} },
  init: async (app, Bot) => {}
};
```

`ApiLoader` 会包装为 `HttpApi` 实例。亦可 `class extends HttpApi`。

## 约定

- 路径：`plugins/<插件名>/http/*.js`。
- handler 使用注入的 `Bot`（多实例、配置、`getServerUrl` 等）。
- `priority` 数字越大越优先注册。
- 文件/日志：`FileUtils`、`BotUtil.makeLog`；配置：`getServerConfigPath`。

## 参考

- skill `xrk-base-layer`；规则 `xrk-dev-requirements.mdc`
