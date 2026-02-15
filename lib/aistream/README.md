# AI 工作流与调用（lib/aistream）

工作流加载、MCP 注册与统一 LLM 调用入口，与 XRK-AGT 一致的单一路径与配置约定。

## 模块

| 文件 | 职责 |
|------|------|
| **loader.js** | StreamLoader：加载 `plugins/*/stream` 工作流、初始化 MCP（本体 + 远程 stdio/HTTP），注册工具到 MCPToolAdapter。远程 MCP 配置优先读 `aistream.mcp.remote`，selected 为空则加载全部。 |
| **aistream.js** | AIStream 类：`resolveLLMConfig(apiConfig)` 标准化合并 apiConfig/this.config/提供商配置（仅规范键：model、maxTokens、topP 等）；`_buildOverridesFromConfig(config, base)` 统一构建 overrides；`callAI` / `callAIStream` 使用 LLMFactory 创建客户端并重试。 |

## 配置约定

- 使用规范键：`model`、`maxTokens`、`topP`、`presencePenalty`、`frequencyPenalty`。
- overrides 由 `_buildOverridesFromConfig` 单一路径生成，避免重复分支。

## 与 HTTP 层

- `/api/v3/chat/completions` 等由 `plugins/system-plugin/http/ai.js` 处理，仅用提供商配置创建客户端（不拿请求 apiKey 覆盖，与 AGT 一致）。
- 工作流内调用 AI 时通过 AIStream 的 `callAI` / `callAIStream`，传入的 apiConfig 与 resolveLLMConfig 合并后得到最终 config。
