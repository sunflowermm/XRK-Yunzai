---
name: xrk-workflow-stream
description: 在 XRK-Yunzai 中开发或修改 AI 工作流时使用；涉及 plugins/*/stream/、LLM 调用、MCP 工具、记忆与 function calling 时使用。
---

# XRK-Yunzai 工作流开发

## 文档与代码

- 短契约：`docs/base-classes.md`；详述：`docs/WORKFLOW_BASE_CLASS.md`
- 基类：`lib/aistream/aistream.js`；加载：`lib/aistream/loader.js`

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
}
```

## 约定

- 路径：**仅** `plugins/<插件名>/stream/*.js`（`StreamLoader` 扫描，不用 `streams/`）。
- 配置：`data/server_bots/<port>/aistream.yaml`；字段合并见 `CONFIG_PRIORITY.md`。
- **类字段**存工具 Map；`init()` 注册 MCP/功能，不在 constructor。
- `callAI` → `{ text, usedReplyTool } | null`；`usedReplyTool` 时避免重复 `sendMessages`。
- 可选 `async cleanup()` 释放资源。
- LLM：`LLMFactory.createClient().chat/chatStream`；非流式见 `lib/utils/llm/llm-nonstream-reply.js`。

## 插件调用

`plugin.callWorkflow('chat', { question }, { e })` 或 `getStream('chat').execute(e, question, config)`。

## 参考

- skill `xrk-base-layer`；规则 `xrk-dev-requirements.mdc`
