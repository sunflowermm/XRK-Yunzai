# 工厂模式文档（LLM）

> XRK-Yunzai 中 LLM 客户端统一创建与扩展入口。**文件**: `lib/factory/llm/LLMFactory.js`

---

## 概述

- **统一接口**：所有 LLM 提供商通过同一套 API 创建与使用。
- **易扩展**：新提供商只需 `registerProvider(name, factoryFn)`。
- **配置**：内置提供商从 `cfg.getLLMConfig(provider)` 读取；兼容厂商由配置驱动（如 `openai_compat_llm.providers`）。
- **动态选择**：运行时通过 `createClient({ provider })` 或 `resolveProvider(input)` 指定；未传时默认来自 **aistream.llm.Provider**（与 XRK-AGT 一致）。

---

## 架构与提供商

```
LLMFactory (静态类)
├── builtinProviders (Map): gptgod / volcengine / xiaomimimo / openai / gemini / anthropic / azure_openai
├── compatFactories: openai_compat_llm / openai_responses_compat_llm / newapi_compat_llm / cherryin_compat_llm / ollama_compat_llm / gemini_compat_llm / anthropic_compat_llm / azure_openai_compat_llm（配置中 providers[] 注册为独立 key）
└── registerProvider / listProviders / hasProvider / resolveProvider / getProviderConfig / getDefaultProvider(deprecated) / createClient
```

| 提供商 | 说明 |
|--------|------|
| `gptgod` | GPTGod，支持识图（Yunzai 特有） |
| `volcengine` | 火山引擎豆包 |
| `xiaomimimo` | 小米 MiMo（仅文本） |
| `openai` | OpenAI Chat Completions |
| `gemini` | Google Generative Language |
| `anthropic` | Claude Messages API |
| `azure_openai` | Azure OpenAI（deployment + api-version） |
| 兼容厂商 | 由 `openai_compat_llm.providers` 等配置注册，每项 `key` 作为独立 provider |

---

## 核心 API

| 方法 | 说明 |
|------|------|
| `registerProvider(name, factoryFn)` | 注册内置提供商；factoryFn(config) 返回客户端实例 |
| `listProviders()` | 内置 + 兼容工厂配置中的 key（如 openai_compat_llm.providers[].key） |
| `hasProvider(name)` | 是否存在该提供商（内置或兼容） |
| `resolveProvider(input?, options?)` | 从 input.provider/model/llm/profile/defaultProvider 或 aistream.llm.Provider 解析出最终 provider |
| `getProviderConfig(provider)` | 内置用 cfg.getLLMConfig；兼容用对应 compat 工厂的 defaults + entry，含 protocol/factoryType/_clientClass |
| `getDefaultProvider()` | **已废弃**，请用 `resolveProvider({})`；仍保留兼容调用 |
| `createClient(config?)` | 先 resolveProvider(config)，再创建客户端。合并优先级：**传入 config > 提供商配置**；未指定 provider 时依赖 aistream.llm.Provider。 |

---

## 使用示例

```javascript
import LLMFactory from '../../lib/factory/llm/LLMFactory.js';

// 默认提供商
const client1 = LLMFactory.createClient();

// 指定提供商 / 覆盖配置
const client2 = LLMFactory.createClient({ provider: 'openai', model: 'gpt-4' });

// 工作流中
const client = LLMFactory.createClient({ provider: apiConfig.provider || 'openai', ...apiConfig });
return await client.chat(messages, apiConfig);
```

**自定义提供商**：实现 `chat(messages[, overrides])`、`chatStream(messages, onDelta[, overrides])`，再 `LLMFactory.registerProvider('my-llm', (config) => new MyLLMClient(config))`。

---

## 配置集成

配置来源：`plugins/*/commonconfig/*_llm.js`（CommonConfig 仅从插件目录加载）、`config/default_config/*.yaml`。详见 [CONFIG_PRIORITY.md](./CONFIG_PRIORITY.md)、[COMMONCONFIG_BASE.md](./COMMONCONFIG_BASE.md)。

---

## 最佳实践与常见问题

- **选择**：开发可用 gptgod 或配置 `openai_compat_llm.providers` 中的 key；生产按需选稳定提供商。
- **配置**：集中用配置文件，敏感信息勿提交版本控制。
- **错误**：捕获「不支持的LLM提供商」时可回退 `createClient()` 使用默认。
- **扩展**：客户端需实现 `chat`/`chatStream`，配置字段兼容 baseUrl/apiKey/model 等。

**Q: 如何切换？** → `createClient({ provider: 'gemini' })`  
**Q: 如何添加？** → 实现客户端类 + `registerProvider`  
**Q: 配置从哪读？** → `cfg.getLLMConfig(provider)`，见上配置来源  
**Q: 默认提供商？** → 由 `aistream.yaml` 中 `llm.Provider` 决定（默认 `gptgod`）；未配置时 createClient 会抛错提示配置 llm.Provider。  

---

## 相关文档

- [WORKFLOW_BASE_CLASS.md](./WORKFLOW_BASE_CLASS.md) - 工作流内使用工厂
- [COMMONCONFIG_BASE.md](./COMMONCONFIG_BASE.md) - 配置管理（含与 XRK-AGT 对齐说明）
- [CORE_OBJECTS.md](./CORE_OBJECTS.md) - cfg 与配置读取
- [ARCHITECTURE.md](./ARCHITECTURE.md) - 工厂在架构中的位置

### 与 XRK-AGT 工厂对齐说明

- **XRK-Yunzai** 已对齐 AGT：
  - **兼容性工厂**：通过 `compatFactories`（如 `openai_compat_llm`）从配置的 `providers[]` 注册厂商，`listProviders()` 合并内置与兼容 key。
  - **resolveProvider**：支持 `input.provider/model/llm/profile/defaultProvider` 及 `aistream.llm.Provider` 解析默认。
  - **getProviderConfig**：内置用 `cfg.getLLMConfig(provider)`，兼容用工厂 defaults + entry，返回含 `protocol`、`factoryType`、`_clientClass` 的配置。
  - **createClient**：先 resolveProvider，再按 builtin 或 compat 的 _clientClass 实例化；合并配置时过滤 `undefined`，避免覆盖 provider 默认。
- 当前已实现与 AGT 一致的 8 个兼容工厂：openai_compat_llm、openai_responses_compat_llm、newapi_compat_llm、cherryin_compat_llm、ollama_compat_llm、gemini_compat_llm、anthropic_compat_llm、azure_openai_compat_llm；配置方式为在对应 `*_compat_llm.yaml` 中配置 `providers` 数组，每项 `key` 作为独立 provider。
