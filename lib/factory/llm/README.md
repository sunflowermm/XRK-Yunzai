# LLM 工厂层（lib/factory/llm）

多提供商 LLM 客户端工厂：单一 `createClient` 路径。

## 架构

- **LLMFactory**：按 `provider`（`providers[].key`）选择实现，合并 `getProviderConfig` 与调用方 `config`
- **factory-registry.js**：16 个工厂元数据（`configKey`、`protocol`、`displayName`）
- **客户端**：`chat` / `chatStream`；流式 tool_calls 经 `MCPToolAdapter.emitMcpToolsToStream` 推送 `mcp_tools`

## 提供商与实现类

| protocol | 实现类 | 说明 |
|----------|--------|------|
| gptgod | GPTGodLLMClient | GPTGod |
| volcengine | VolcengineLLMClient | 火山引擎 |
| deepseek | DeepSeekLLMClient | DeepSeek |
| xiaomimimo | XiaomiMiMoLLMClient | 小米 MiMo |
| openai | OpenAILLMClient | OpenAI |
| gemini | GeminiLLMClient | Gemini |
| anthropic | AnthropicLLMClient | Claude |
| azure_openai | AzureOpenAILLMClient | Azure OpenAI |
| （compat） | `*CompatibleLLMClient` | `*_compat_llm.providers[]` 自定义 key |

## 配置来源

- YAML：`data/server_bots/*_llm.yaml`，统一 **`providers: []`**；每条 `key` 供 `aistream.llm.Provider` 引用
- 默认模板：`config/default_config/*_llm.yaml`
- 默认 Provider：`getAistreamConfigOptional().llm` 的 `Provider` / `provider` 字段
- 对外封装：`cfg.getLLMConfig(name)`（去掉内部 `_clientClass`）

## 常用 API

| 方法 | 说明 |
|------|------|
| `listProviders()` | 所有已配置 provider key（控制台下拉 enum 来源） |
| `listFactories()` | 工厂元数据列表 |
| `resolveProvider(input?)` | 解析最终 provider key |
| `getProviderConfig(key)` | 合并后的提供商配置 |
| `createClient(config?)` | 创建客户端实例 |
| `registerProvider(name, fn)` | 运行时注册扩展 |

## 扩展新客户端

实现 `constructor(config)`、`chat(messages, overrides)`；流式需 `chatStream` 并在 tool 执行后调用 `MCPToolAdapter.emitMcpToolsToStream`。

详见 [docs/FACTORY.md](../../docs/FACTORY.md)。
