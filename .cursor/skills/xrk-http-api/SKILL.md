---
name: xrk-http-api
description: 在 XRK-Yunzai 中开发或修改 HTTP API 时使用；涉及 plugins/*/http/ 路由、Express 注册、WebSocket 或 HttpApi 子类时使用。
---

# XRK-Yunzai HTTP API 开发

## 权威入口

- **写法**：`docs/coding-style.md` · **挂载**：`docs/runtime-surface.md`（HTTP 用注入 `Bot`）
- **短契约**：`docs/base-classes.md`（HttpApi 段）· **详述**：`docs/HTTP_API_BASE_CLASS.md`
- **基类**：`lib/http/http.js` · **加载**：`lib/http/loader.js`

## 适用场景

- 新增 REST / WebSocket / SSE 路由
- 设备、MCP、配置、文件等 HTTP 模块维护

## 非适用场景

- 纯消息插件 → `xrk-plugin-development`
- 工作流 LLM 逻辑 → `xrk-workflow-stream`

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
      res.json({ success: true, url: Bot.getServerUrl?.() });
    }
  }],
  ws: { '/ws/example': (conn, req) => {} },
  init: async (app, Bot) => {}
};
```

`ApiLoader` 包装为 `HttpApi` 实例；亦可 `class extends HttpApi`。

## 约定

| 项 | 要求 |
|----|------|
| 路径 | `plugins/<插件名>/http/*.js` |
| Handler | `(req, res, Bot)`，使用注入的 `Bot` |
| priority | 数字**越大**越优先注册 |
| 文件/日志 | `FileUtils`、`Bot.makeLog` |
| 配置 | `getServerConfigPath(port, name)` |

## 常见陷阱

- handler 内 `import Bot` 或 `new Bot()`
- 业务层裸 `fs.*Sync`
- 与 `plugins/system-plugin/http/device.js` 混淆：其为 Event 设备 API，非 stream 工作流

## 参考

- skill `xrk-coding-style`、`xrk-base-layer`
- 规则 `xrk-dev-requirements.mdc`
