# LLM 工厂层（lib/factory/llm）

多提供商 LLM 客户端工厂，与 XRK-AGT 一致的单一创建与调用路径。

## 架构

- **LLMFactory**：根据 `config.provider` 选择实现类，合并 `getProviderConfig(provider)` 与传入的 `config` 后创建客户端。
- **客户端约定**：各客户端实现 `chat(messages, overrides)`、可选 `chatStream(messages, onDelta, overrides)`，overrides 使用规范键（如 `maxTokens`、`topP`），由 `buildOpenAIChatCompletionsBody` 统一映射为 API 体。

## 提供商与实现类

| provider | 实现类 | 说明 |
|----------|--------|------|
| gptgod | GPTGodLLMClient | GPTGod，OpenAI 兼容 |
| volcengine | VolcengineLLMClient | 火山引擎豆包 |
| xiaomimimo | XiaomiMiMoLLMClient | 小米 MiMo |
| openai | OpenAILLMClient | OpenAI 官方 |
| gemini | GeminiLLMClient | Google Gemini |
| openai_compat | OpenAICompatibleLLMClient | 任意 OpenAI 兼容（自定义 baseUrl/path/认证） |
| anthropic | AnthropicLLMClient | Anthropic Claude |
| azure_openai | AzureOpenAILLMClient | Azure OpenAI |

## 配置来源

- 端口级配置：`data/server_bots/{port}/{provider}_llm.yaml`（如 `openai_llm.yaml`）。
- 全局默认：`config/default_config/{provider}_llm.yaml`。
- `LLMFactory.getProviderConfig(provider)` 通过 `global.cfg.getLLMConfig(provider)` 读取，**不**使用请求体中的 apiKey 覆盖（与 AGT 一致）。

## 扩展

- 注册新提供商：`LLMFactory.registerProvider(name, (config) => new YourClient(config))`。
- 新客户端需实现：`constructor(config)`、`chat(messages, overrides)`，流式需实现 `chatStream(messages, onDelta, overrides)`。
