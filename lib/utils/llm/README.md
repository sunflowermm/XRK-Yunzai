# LLM 工具层（lib/utils/llm）

OpenAI 系请求构建、SSE 解析、代理与 MCP 工具注入。

## 模块说明

| 文件 | 职责 |
|------|------|
| **openai-chat-utils.js** | `buildOpenAIChatCompletionsBody`、`applyOpenAITools`、`extractOpenAIAssistantText`；规范字段 `maxTokens`、`topP` 等 |
| **sse-utils.js** | `iterateSSE`、`consumeOpenAIChatStream`、`parseOpenAIChatContent` |
| **mcp-tool-adapter.js** | MCP ↔ OpenAI：`convertMCPToolsToOpenAI`、`handleToolCalls`；`getMCPServer()` → **`StreamLoader.mcpServer`** |
| **proxy-utils.js** | `config.proxy` → fetch agent |
| **message-transform.js** | 多模态 `transformMessagesWithVision` |
| **llm-nonstream-reply.js** | 非流式返回值解包（`usedReplyTool` 等） |

## Chat Completions 工具轮退出约定

非流式 `chat()` 多轮 tool 循环：**当轮响应无 `tool_calls` 即结束**，用 `extractOpenAIAssistantText(message)` 取正文（允许为空）。勿因 `content` 为 `null`/`""` 继续请求下一轮。`OpenAIPathCompatLLMClient._runWithToolRounds` 与 `OpenAIResponsesCompatibleLLMClient` 的 Responses function_call 路径同理。

## MCP 访问

```javascript
import StreamLoader from '../../aistream/loader.js';

// MCPToolAdapter.getMCPServer() 等价于：
StreamLoader.mcpServer;
```

勿使用已移除的全局 MCP 挂载。

## 配置约定

- overrides 使用规范键名：`model`、`maxTokens`、`topP`、`presencePenalty`、`frequencyPenalty`
- 发往下游 API 时由本层映射为 `max_tokens`、`top_p` 等

## 依赖关系

- `openai-chat-utils` ← 各 LLM Client 的 `buildBody`
- `sse-utils` ← 流式 `chatStream`
- `mcp-tool-adapter` ← `applyOpenAITools`、v3 接口工具卡片
