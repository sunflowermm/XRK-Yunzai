# lib/aistream（工作流与 LLM 解析）

## 模块

| 文件 | 职责 |
|------|------|
| **loader.js** | `StreamLoader`：加载 `plugins/<插件>/stream/`；MCP（本体、内置 `mcpServers`、远程 `aistream.mcp.remote.mcpServers` JSON 块）。 |
| **aistream.js** | `AIStream`：构造期默认配置与 **XRK-AGT** 对齐（仅 `enabled/temperature/maxTokens/topP/presencePenalty/frequencyPenalty`，不含 `model`/`baseUrl`/`apiKey`/`timeout`）；`resolveLLMConfig` 合并单次调用、工作流 `this.config`、`LLMFactory.getProviderConfig(provider)`、`cfg.aistream.llm`；`callAI` 返回 `{ text, usedReplyTool }` 或 `null`（见 `lib/utils/llm/llm-nonstream-reply.js`），`callAIStream` 使用 `LLMFactory.createClient` 与 `{ ...config, stream, streams }`。 |
| **memory.js** / **workflow-manager.js** | 记忆与调度，见 [docs/reference/WORKFLOWS.md](../../docs/reference/WORKFLOWS.md)。 |

## `resolveLLMConfig` 参与合并的字段（节选）

按字段 **pick** 顺序：**单次 apiConfig → 工作流 `this.config` → `LLMFactory.getProviderConfig(provider)` → `cfg.aistream.llm`**；超时额外兜底 **`cfg.aistream.global.maxTimeout`**。与 `config/default_config/aistream.yaml` 中 `llm` 段（含 `temperature`、`maxTokens`、`retry` 等）对齐。

- **连接**：`apiKey`、`baseUrl`、`timeout`、`proxy`（`proxy` 为 provider / stream / api 浅合并）
- **生成**：`model`、`chatModel`、`maxTokens`、`topP`、`presencePenalty`、`frequencyPenalty`、`temperature`
- **工具与流**：`enableTools`、`enableStream`、`tool_choice` / `toolChoice`、`parallel_tool_calls` / `parallelToolCalls`、`maxToolRounds`、`mcpToolMode`
- **扩展**：`headers`、`extraBody`（浅合并，api 层最后覆盖）

返回前去掉 `_clientClass`、`factoryType`（工厂内部用）。

## 默认 Provider

未配置 `aistream.llm.Provider` 时，由 **`LLMFactory` 内部逻辑**（`resolveProvider` 候选链依赖的默认项）取 **`builtinProviders` 插入顺序的第一个 key**（`LLMFactory.firstBuiltinProviderKey()`）；业务层 `registerProvider` 追加不改变首项时，与默认 yaml 行为一致。

## HTTP

- `/api/v3/chat/completions`：`plugins/system-plugin/http/ai.js`。
