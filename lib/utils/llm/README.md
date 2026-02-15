# LLM 工具层（lib/utils/llm）

与 XRK-AGT 对齐的 LLM 请求构建、SSE 解析、代理与 MCP 工具注入。

## 模块说明

| 文件 | 职责 |
|------|------|
| **openai-chat-utils.js** | OpenAI 系请求体构建：`buildOpenAIChatCompletionsBody`、`applyOpenAITools`。配置仅使用规范字段：`model`、`maxTokens`、`topP`、`presencePenalty`、`frequencyPenalty`。 |
| **sse-utils.js** | 通用 SSE 解析：`iterateSSE`、`consumeOpenAIChatStream`、`parseOpenAIChatContent`。支持 `application/json` 整段与 `data:` 行，上游错误 JSON 会抛错便于 HTTP 层返回。 |
| **mcp-tool-adapter.js** | MCP 工具与 OpenAI tools 互转：`getMCPServer`、`convertMCPToolsToOpenAI`，供 `applyOpenAITools` 注入工具列表。 |
| **proxy-utils.js** | 代理：读取 `config.proxy.enabled`、`config.proxy.url`，构建 fetch 的 agent。 |
| **message-transform.js** | 多模态消息转换：`transformMessagesWithVision`，统一为 OpenAI 风格 text + image_url（含 base64 data URL）。 |

## 配置约定

- 配置与请求 overrides 使用**规范键名**：`model`、`maxTokens`、`topP`、`presencePenalty`、`frequencyPenalty`。
- 请求体发往下游时由本层映射为 API 键名（如 `max_tokens`、`top_p`）。

## 依赖关系

- `openai-chat-utils` 被各 LLM 工厂（OpenAI、OpenAICompatible、Volcengine、GPTGod 等）用于 `buildBody`。
- `sse-utils` 被上述工厂的流式分支统一使用 `consumeOpenAIChatStream`。
- `mcp-tool-adapter` 被 `openai-chat-utils.applyOpenAITools` 调用。
