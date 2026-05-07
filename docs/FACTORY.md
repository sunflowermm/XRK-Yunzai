# 工厂：LLM（`lib/factory/llm/LLMFactory.js`）

## 作用

- 按 **provider**（内置或 compat 注册的 `providers[].key`）创建统一接口的客户端（`chat` / `chatStream`）。
- 扩展：`LLMFactory.registerProvider(name, (config) => new MyClient(config))`。

## 结构

```
LLMFactory
├── builtinProviders: gptgod / volcengine / xiaomimimo / openai / gemini / anthropic / azure_openai
├── compatFactories: openai_compat_llm、openai_responses_compat_llm、newapi_compat_llm、cherryin_compat_llm（后二者共用 OpenAIPathCompatLLMClient）、ollama、gemini、anthropic、azure_openai 兼容等
└── registerProvider / listProviders / hasProvider / resolveProvider / getProviderConfig / createClient
```

| API | 说明 |
|-----|------|
| `resolveProvider(input?, options?)` | 从 `input.provider/model/llm/profile` 或 `aistream.llm.Provider` 等解析出 provider 名。 |
| `getProviderConfig(name)` | 内置：合并 `cfg` 中对应 `*_llm`；兼容：合并 yaml defaults + `providers[]` 条目，含 `protocol`、`factoryType`、`_clientClass`（仅供工厂内部）。对外读取可用 **`cfg.getLLMConfig(name)`**（会去掉 `_clientClass`）。 |
| `createClient(config?)` | `resolveProvider(config)` → 内置 `new X(config)` 或 compat `new ClientClass(merged)`；合并时丢弃传入字段值为 `undefined` 的项，避免覆盖默认。 |

## 使用

```javascript
import LLMFactory from '../../lib/factory/llm/LLMFactory.js';

// 依赖全局已加载 cfg（含 aistream.llm.Provider）
const client = LLMFactory.createClient({ provider: 'openai', model: 'gpt-4o' });
await client.chat(messages, { stream: false, temperature: 0.7 });
```

自定义提供商：实现 `chat` / `chatStream`（及项目约定的 overrides），再 `registerProvider`。

## 配置

- 默认 YAML：`config/default_config/*.yaml`；表单与 schema：`plugins/*/commonconfig/`。
- 详见 [CONFIG_PRIORITY.md](./CONFIG_PRIORITY.md)、[COMMONCONFIG_BASE.md](./COMMONCONFIG_BASE.md)。

## 相关

- [WORKFLOW_BASE_CLASS.md](./WORKFLOW_BASE_CLASS.md)、[reference/WORKFLOWS.md](./reference/WORKFLOWS.md)（工作流内如何传 `apiConfig`）
