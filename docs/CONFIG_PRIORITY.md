# 配置优先级（工作流 / LLM）

## 总览

与 **单次 LLM 请求**相关的字段，在 `AIStream.resolveLLMConfig(apiConfig)` 中按 **字段** 选择来源（不是整对象一层层覆盖）。同一字段的常见优先级为：

**`apiConfig`（含 `execute` 第三参数）> `this.config` > `LLMFactory.getProviderConfig(provider)` > `getAistreamConfigOptional().llm`**（`aistream.yaml`：`Provider`、`timeout`、`temperature`、`maxTokens`、`retry` 等）；超时兜底 **`global.maxTimeout`**

其中 `provider` 本身由 `apiConfig.provider` → `this.config.provider` → `aistream.llm.Provider` → `LLMFactory.resolveProvider({})` 解析。

基类 **`execute`**（`lib/aistream/aistream.js`）对 LLM 的调用为 **`callAI(messages, userConfig)`**：只把传入的第三参数当作 **`apiConfig`**；**不会**把 `cfg.aistream` 整对象与 `cfg.getLLMConfig` 在 `execute` 里再拼进一个「大 finalConfig」后交给 `callAI`。全局与提供商配置是在 **`resolveLLMConfig`** 内部按字段读入的。

## 构造函数 `config`

`super({ config: { ... } })` 会与基类默认值合并为 **`this.config`**，仅影响未在 `apiConfig` / 提供商 / `aistream.llm` 中出现的字段。

## 字段别名（`resolveLLMConfig` 支持）

| 常用写法 | 说明 |
|---------|------|
| `model`（`chatModel` 仅读别名，合并为 `model`） | 模型名 |
| `maxTokens` / `max_tokens` / `max_completion_tokens` | 最大输出 |
| `topP` / `top_p` | top_p |
| `presencePenalty` / `presence_penalty` | presence_penalty |
| `frequencyPenalty` / `frequency_penalty` | frequency_penalty |
| `apiKey` / `api_key` | 密钥 |
| `enableTools` / `enable_tools` | 是否启用工具链 |
| `enableStream` / `enable_stream` | 是否流式（`false` 时 `callAIStream` 退化为 `callAI`） |
| `tool_choice` / `toolChoice`、`parallel_tool_calls` / `parallelToolCalls` | OpenAI 协议透传 |
| `headers`、`extraBody`、`proxy` | 浅合并（与 `openai_compat_llm` providers schema 一致） |

## 示例

```javascript
const chatStream = Bot.StreamLoader.getStream('chat');
await chatStream.execute(e, e.msg, {
  provider: 'openai',
  model: 'gpt-4o-mini',
  temperature: 0.7
});
```

## 相关

- 实现：`lib/aistream/aistream.js` 中 `resolveLLMConfig`、`callAI`。
- 配置读取：`getAistreamConfigOptional()`（`lib/utils/aistream-config.js`）。
- 工厂：`docs/FACTORY.md`；`cfg.getLLMConfig(provider)` 封装自 `LLMFactory.getProviderConfig`。
- MCP / aistream 全量说明：`docs/reference/AISTREAM_AND_MCP.md`。
