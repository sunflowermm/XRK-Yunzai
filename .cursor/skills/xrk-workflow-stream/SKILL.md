---
name: xrk-workflow-stream
description: Develop AIStream workflows for XRK-Yunzai. Use when creating or modifying streams in plugins/*/stream/, configuring LLM calls, memory, or function calling.
---

# XRK-Yunzai 工作流开发

## 目录

- `plugins/<plugin>/stream/*.js`：工作流定义
- 基类：`lib/aistream/aistream.js` 的 AIStream

## 注册

- StreamLoader 自动扫描 `plugins/*/stream/` 和 `plugins/*/streams/`
- 导出 `{ name, description, execute, config?, priority? }`

## 执行

- `stream.execute(e, question, config)`：e 为事件，question 为用户输入
- 上下文：`buildChatContext`、`buildEnhancedContext`、Memory System

## 参考

- [docs/WORKFLOW_BASE_CLASS.md](../../docs/WORKFLOW_BASE_CLASS.md)
- [lib/aistream/README.md](../../lib/aistream/README.md)
