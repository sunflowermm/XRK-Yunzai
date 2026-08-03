# 配置优先级（工作流 / LLM）与端口

## 多端口配置落盘（框架核心）

| 类型 | 位置 |
|------|------|
| 端口级 | `data/server_bots/<port>/{bot,other,server,group,renderer,ai-workflow}.yaml` |
| 全局 | `data/server_bots/{device,monitor,notice,redis,db}.yaml` |
| 工厂 LLM | `data/server_bots/*_llm.yaml`（根级） |
| 模板 | `config/default_config/` |

启动时选端口 → `cfg.ensurePortConfigs(port)` → `Bot.run({ port })`。对照：[VS_YUNZAI.md](./VS_YUNZAI.md)。

---

## LLM 字段优先级

与单次 LLM 请求相关的字段，在 `AiWorkflow.resolveLLMConfig(apiConfig)` 中按**字段**选择：

**`apiConfig`（`execute` 第三参数）> `this.config` > `LLMFactory.getProviderConfig(provider)` > `getAiWorkflowConfigOptional().llm`**；超时还可兜底 `global.maxTimeout`。

`provider`：`apiConfig.provider` → `this.config.provider` → `ai-workflow.yaml` 的 `llm.Provider` → `LLMFactory.resolveProvider({})`。

`execute` 只把第三参数当作 `apiConfig`，不会在 `execute` 里先拼「大 finalConfig」。

## 构造函数 `config`

`super({ config: { … } })` 合并为 `this.config`，只补全未在 apiConfig / 提供商 / 全局 llm 中出现的字段。

## 字段别名

| 常用 | 说明 |
|------|------|
| `model`（`chatModel` 别名） | 模型名 |
| `maxTokens` / `max_tokens` | 最大输出 |
| `topP` / `top_p` | top_p |
| `apiKey` / `api_key` | 密钥 |
| `enableTools` / `enableStream` | 工具链 / 流式 |
| `headers`、`extraBody`、`proxy` | 浅合并 |

## 示例

```javascript
const chat = Bot.AiWorkflowLoader.getWorkflow('chat');
await chat.execute(e, e.msg, {
  provider: 'openai',
  model: 'gpt-4o-mini',
  temperature: 0.7,
});
```

## 相关

- 实现：`lib/ai-workflow/ai-workflow.js`（`resolveLLMConfig`、`callAI`）
- 配置读取：`getAiWorkflowConfigOptional()`
- 工厂：[FACTORY.md](./FACTORY.md)
- MCP / 工作流：[reference/AISTREAM_AND_MCP.md](./reference/AISTREAM_AND_MCP.md)
