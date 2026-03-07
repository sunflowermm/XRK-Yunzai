---
name: xrk-workflow-stream
description: 在 XRK-Yunzai 中开发或修改 AI 工作流时使用；涉及 plugins/*/stream/ 或 streams/、LLM 调用、记忆与 function calling 时使用。
---

# XRK-Yunzai 工作流开发

## 目录与基类

- 工作流定义：`plugins/<插件名>/stream/*.js` 或 `plugins/<插件名>/streams/*.js`。
- 基类：`lib/aistream/aistream.js` 的 AIStream。

## 注册与加载

- StreamLoader（`lib/aistream/loader.js`）自动扫描 `plugins/*/stream/` 和 `plugins/*/streams/`。
- 导出格式：`{ name, description, execute, config?, priority? }`。

## 执行

- `stream.execute(e, question, config)`：`e` 为消息事件，`question` 为用户输入。
- 上下文与记忆：使用 `buildChatContext`、`buildEnhancedContext` 及 Memory 相关能力。

## 参考

- 项目内文档：`docs/WORKFLOW_BASE_CLASS.md`（若存在）、`lib/aistream/README.md`（若存在）；以代码 `lib/aistream/aistream.js`、`lib/aistream/loader.js` 为准。
