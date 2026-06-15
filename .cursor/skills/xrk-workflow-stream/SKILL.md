---
name: xrk-workflow-stream
description: 在 XRK-Yunzai 中开发或修改 AI 工作流时使用；涉及 plugins/*/stream/、LLM 调用、MCP 工具、记忆与 function calling 时使用。
---

# XRK-Yunzai 工作流开发

## 权威入口

- **写法**：`docs/coding-style.md` · **挂载**：`docs/runtime-surface.md`
- **短契约**：`docs/base-classes.md`（AIStream 段）· **详述**：`docs/WORKFLOW_BASE_CLASS.md`
- **工厂**：`docs/FACTORY.md` · **引擎**：`docs/reference/WORKFLOWS.md`
- **基类**：`lib/aistream/aistream.js` · **加载**：`lib/aistream/loader.js`

## 适用场景

- 新增 MCP 工具、function calling、自定义 `buildChatContext`
- 调整 `chat` / `memory` / `tools` 等内置流

## 非适用场景

- 设备 Event WebSocket → `http/device.js`（非 stream 工作流）
- 已删除的设备语音专用 stream 工作流 — **勿恢复**

## 结构

```javascript
import AIStream from '../../lib/aistream/aistream.js';

export default class ChatStream extends AIStream {
  constructor() {
    super({ name: 'chat', description: '聊天', priority: 100, config: { temperature: 0.8 } });
  }

  async init() {
    await super.init();
    this.registerMCPTool('tool', { description, inputSchema, handler });
    this.registerFunction('fn', { description, prompt, parser, handler, enabled: true });
  }

  buildSystemPrompt(context) { return '...'; }
  async buildChatContext(e, question) { return [...]; }

  async cleanup() {}
}
```

## 约定

| 项 | 要求 |
|----|------|
| 路径 | **仅** `plugins/<插件名>/stream/*.js`（不扫 `streams/`） |
| 注册 | `init()` 中 `registerMCPTool` / `registerFunction` |
| 状态 | **类字段**；constructor 不建 Map 缓存 |
| callAI | 返回 `{ text, usedReplyTool } \| null` |
| LLM | `LLMFactory.createClient()`；合并见 `CONFIG_PRIORITY.md` |
| 配置 | `data/server_bots/<port>/aistream.yaml` 或全局 `aistream.yaml` |

## 插件调用

`plugin.callWorkflow('chat', { question }, { e })` 或 `getStream('chat').execute(e, question, config)`。

设备 AI 默认工作流为 **`chat`**（`POST /api/device/:id/ai`）。

## 常见陷阱

- 目录写成 `streams/` 导致 Loader 不加载
- `usedReplyTool` 为 true 时重复 `sendMessages`
- 在 constructor 注册 MCP 工具（应在 `init()`）

## 参考

- skill `xrk-coding-style`、`xrk-base-layer`
- 规则 `xrk-dev-requirements.mdc`、`plugin-development.mdc`
