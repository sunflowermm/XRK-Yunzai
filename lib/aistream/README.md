# lib/aistream（工作流加载与 AI 调用）

## 模块

| 文件 | 职责 |
|------|------|
| **loader.js** | `StreamLoader`：扫描 `plugins/<插件>/stream/` 加载工作流；MCP 含本体、内置（`export const mcpServers` / `getMcpServers`）、远程（`aistream.mcp.remote`）。 |
| **aistream.js** | `AIStream`：`resolveLLMConfig(apiConfig)` 按字段合并 `apiConfig`、`this.config`、`LLMFactory.getProviderConfig(provider)`、`cfg.aistream.llm`；`callAI` / `callAIStream` 使用 `LLMFactory.createClient` 与 `{ ...config, stream, streams }` 调用客户端。 |
| **memory.js** / **workflow-manager.js** | 记忆与跨工作流调度，见 [docs/reference/WORKFLOWS.md](../../docs/reference/WORKFLOWS.md)。 |

## LLM 配置从哪来

- 提供商与密钥等：`LLMFactory.getProviderConfig`（内置走 `global.cfg` 的 `*_llm`，兼容走各 `*_compat_llm` 的 `providers`）。
- 默认运营商：`cfg.aistream.llm.Provider`（或 `provider`）。
- 单次调用：`execute(e, q, config)` 里传入的 `config` 会作为 **`callAI` 的 `apiConfig`**，字段级覆盖 `this.config` 与提供商默认（见 `resolveLLMConfig` 内各 `pick` 顺序）。

## HTTP

- OpenAI 兼容 HTTP：`plugins/system-plugin/http/ai.js`（`/api/v3/chat/completions` 等）。
