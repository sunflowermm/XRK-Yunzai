# LLM 工厂层（lib/factory/llm）

多提供商 LLM 客户端工厂，与 XRK-AGT 一致的单一创建与调用路径。

## 架构

- **LLMFactory**：根据 `config.provider` 选择实现类，合并 `getProviderConfig(provider)` 与传入的 `config` 后创建客户端。
- **客户端约定**：各客户端实现 `chat(messages, overrides)`、可选 `chatStream(messages, onDelta, overrides)`。overrides 使用规范键（如 `maxTokens`、`topP`），由 `buildOpenAIChatCompletionsBody` 统一映射为 API 体。
- **流式回调**：`onDelta(delta, metadata)`。`delta` 为文本增量；执行 tool_calls 后各客户端通过 `MCPToolAdapter.emitMcpToolsToStream(tool_calls, toolResults, onDelta)` 发送 `metadata.mcp_tools`，供 v3 接口转发给前端展示工具卡片。

## 提供商与实现类

| protocol | 实现类 | 说明 |
|----------|--------|------|
| gptgod | GPTGodLLMClient | GPTGod，OpenAI 兼容 |
| volcengine | VolcengineLLMClient | 火山引擎豆包 |
| deepseek | DeepSeekLLMClient | DeepSeek 官方（thinking / reasoning_effort） |
| xiaomimimo | XiaomiMiMoLLMClient | 小米 MiMo |
| openai | OpenAILLMClient | OpenAI 官方 |
| gemini | GeminiLLMClient | Google Gemini |
| anthropic | AnthropicLLMClient | Anthropic Claude |
| azure_openai | AzureOpenAILLMClient | Azure OpenAI |
| （compat） | 各 Compatible Client | 由 `*_compat_llm.providers[]` 注册，key 自定义 |

## 配置来源

- 工厂 YAML：`data/server_bots/*_llm.yaml`，统一 **`providers: []` 数组**；每条 `key` 供 `aistream.llm.Provider` 引用。
- 默认模板：`config/default_config/*_llm.yaml`。
- `LLMFactory.getProviderConfig(key)` 读取对应 providers 条目，**不**使用请求体 apiKey 覆盖。

## 扩展

- 注册新提供商：`LLMFactory.registerProvider(name, (config) => new YourClient(config))`。
- 新客户端需实现：`constructor(config)`、`chat(messages, overrides)`；流式需实现 `chatStream(messages, onDelta, overrides)`，若支持 tool_calls 则在执行后调用 `MCPToolAdapter.emitMcpToolsToStream(tool_calls, toolResults, onDelta)` 以统一输出 mcp_tools。
