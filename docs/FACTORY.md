# 工厂：LLM（`lib/factory/llm/LLMFactory.js`）

## 作用

- 按 **provider**（内置或 compat 注册的 `providers[].key`）创建统一接口的客户端（`chat` / `chatStream`）。
- 扩展：`LLMFactory.registerProvider(name, (config) => new MyClient(config))`。

## 结构

```
LLMFactory
├── factoryRegistry：gptgod / volcengine / deepseek / xiaomimimo / openai / gemini / anthropic / azure_openai + 各 *_compat_llm
├── 所有工厂 YAML 统一 providers[] 数组（每条 key 即 provider 名）
├── builtinClientFactories：按 protocol 实例化官方 Client
└── listFactories / listProviders / listModelProfiles / resolveProvider / getProviderConfig / createClient
```

| API | 说明 |
|-----|------|
| `resolveProvider(input?, options?)` | 从 `input.provider/model/llm/profile` 或 `aistream.llm.Provider` 解析 **providers[].key**。 |
| `getProviderConfig(name)` | 从各工厂 `providers[]` 合并条目；含 `protocol`、`factoryType`、`_clientClass`（compat）。对外用 **`cfg.getLLMConfig(name)`**（去掉 `_clientClass`）。 |
| `createClient(config?)` | `resolveProvider` → builtin 按 `protocol` 或 compat 按 `clientClass` 创建客户端。 |

## 配置

- 各工厂 YAML：`data/server_bots/*_llm.yaml`，结构为 `providers: [{ key, baseUrl, apiKey, model, ... }]`。
- `aistream.llm.Provider` 填写 **providers[].key**（非工厂名）。
- 旧版扁平 yaml（无 providers）会在读取时自动合成单条端点（key 为工厂 id，如 `gptgod`）。
- CommonConfig 表单：`plugins/system-plugin/commonconfig/shared/llm-provider-fields.js` 预设字段。

## 相关

- [WORKFLOW_BASE_CLASS.md](./WORKFLOW_BASE_CLASS.md)、[reference/WORKFLOWS.md](./reference/WORKFLOWS.md)（工作流内如何传 `apiConfig`）
