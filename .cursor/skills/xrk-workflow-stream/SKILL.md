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

## 非流式 LLM 与 MCP `*.reply`

- `AIStream.callAI` 返回 **`{ text, usedReplyTool } | null`**，不再依赖实例上的隐式标志；`usedReplyTool === true` 表示本轮已通过 MCP `*.reply` 发往会话。
- 各 LLM 工厂非流式 `chat()` 经 `lib/utils/llm/llm-nonstream-reply.js` 的 `createReplyTrack` / `noteReplyFromModelCalls` / `packNonStreamReturn` 与基类 `unpackFactoryChatRaw` 对齐。
- Chat 工作流里若已 `*.reply`，`execute` 应依据返回的 `usedReplyTool` 决定是否再 `sendMessages`（见 `plugins/system-plugin/stream/chat.js`）。

## 参考

- 项目内文档：`docs/WORKFLOW_BASE_CLASS.md`（若存在）、`lib/aistream/README.md`（若存在）；以代码 `lib/aistream/aistream.js`、`lib/aistream/loader.js` 为准。
