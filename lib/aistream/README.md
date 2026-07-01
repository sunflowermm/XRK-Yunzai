# lib/aistream（工作流与 LLM 解析）

## 模块

| 文件 | 职责 |
|------|------|
| **loader.js** | `StreamLoader`：加载 `plugins/<插件>/stream/`；MCP（`mcpServer`、内置 `mcpServers`、远程 `aistream.mcp.remote.mcpServers` JSON 块） |
| **aistream.js** | `AIStream`：工作流基类；`resolveLLMConfig` 合并单次调用、工作流 `this.config`、`LLMFactory.getProviderConfig`、`getAistreamConfigOptional().llm` |
| **chat-pipeline.js** | Chat LLM 消息组装（history/memory/静态 system 分层） |
| **stream-cache.js** | 工作流结果 LRU（opt-in；键含 session revision） |
| **agent-session.js** | 会话 revision / 有副作用流判定 |
| **memory.js** / **workflow-manager.js** | 记忆与调度，见 [docs/reference/WORKFLOWS.md](../../docs/reference/WORKFLOWS.md) |

## 配置读取

底层统一使用 **`getAistreamConfigOptional()`**（`lib/utils/aistream-config.js`），勿在 `lib/` 内散落 `cfg?.aistream`。

## `resolveLLMConfig` 参与合并的字段（节选）

按字段 **pick** 顺序：**单次 apiConfig → 工作流 `this.config` → `LLMFactory.getProviderConfig(provider)` → `getAistreamConfigOptional().llm`**；超时兜底 **`global.maxTimeout`**。

- **连接**：`apiKey`、`baseUrl`、`timeout`、`proxy`
- **生成**：`model`、`maxTokens`、`topP`、`presencePenalty`、`frequencyPenalty`、`temperature`（旧 YAML 的 `chatModel` 仍可读，合并进 `model`）
- **工具与流**：`enableTools`、`enableStream`、`tool_choice`、`parallel_tool_calls`、`maxToolRounds`、`mcpToolMode`
- **扩展**：`headers`、`extraBody`

返回前去掉 `_clientClass`、`factoryType`（工厂内部用）。详见 [docs/CONFIG_PRIORITY.md](../../docs/CONFIG_PRIORITY.md)。

## MCP

- 实例：`StreamLoader.mcpServer`（`MCPToolAdapter.getMCPServer()`）
- 远程配置：`aistream.mcp.remote.mcpServers` JSON 块数组
- 详见 [docs/reference/AISTREAM_AND_MCP.md](../../docs/reference/AISTREAM_AND_MCP.md)

## 默认 Provider

未配置 `aistream.llm.Provider` 时，由 `LLMFactory.resolveProvider({})` 解析；业务可用 `LLMFactory.listProviders()` 列举可用 key。

## HTTP

- `/api/v3/chat/completions`：`plugins/system-plugin/http/ai.js`
