# 工厂模式文档（LLM）

> XRK-Yunzai 中 LLM 客户端统一创建与扩展入口。**文件**: `lib/factory/llm/LLMFactory.js`

---

## 概述

- **统一接口**：所有 LLM 提供商通过同一套 API 创建与使用。
- **易扩展**：新提供商只需 `registerProvider(name, factoryFn)`。
- **配置**：从 `cfg.getLLMConfig(provider)` 读取，支持 CommonConfig/YAML。
- **动态选择**：运行时通过 `createClient({ provider })` 指定提供商；未传 `provider` 时使用**第一个启用的**提供商（无「默认运营商」配置项）。

---

## 架构与提供商

```
LLMFactory (静态类)
├── providers (Map): gptgod / volcengine / openai / gemini / anthropic / azure_openai / openai_compat / xiaomimimo
└── registerProvider / listProviders / hasProvider / getProviderConfig / getDefaultProvider / createClient
```

| 提供商 | 说明 |
|--------|------|
| `gptgod` | GPTGod，支持识图 |
| `volcengine` | 火山引擎豆包 |
| `xiaomimimo` | 小米 MiMo（仅文本） |
| `openai` | OpenAI Chat Completions |
| `gemini` | Google Generative Language |
| `openai_compat` | OpenAI 兼容，可自定义 baseUrl/认证 |
| `anthropic` | Claude Messages API |
| `azure_openai` | Azure OpenAI（deployment + api-version） |

---

## 核心 API

| 方法 | 说明 |
|------|------|
| `registerProvider(name, factoryFn)` | 注册提供商；factoryFn(config) 返回客户端实例 |
| `listProviders()` | 返回已注册名称数组 |
| `hasProvider(name)` | 是否存在该提供商 |
| `getProviderConfig(provider)` | 从 cfg.getLLMConfig(provider) 取配置，失败返回 {} |
| `getDefaultProvider()` | 第一个 enabled 的提供商，否则 `'gptgod'` |
| `createClient(config?)` | 创建客户端。config 可含 provider/baseUrl/apiKey/model/temperature/maxTokens/timeout 等；合并优先级：**传入 config > 配置文件 > 默认值**。提供商不存在时抛错。 |

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

- **选择**：开发可用 gptgod/openai_compat；生产按需选稳定提供商。
- **配置**：集中用配置文件，敏感信息勿提交版本控制。
- **错误**：捕获「不支持的LLM提供商」时可回退 `createClient()` 使用默认。
- **扩展**：客户端需实现 `chat`/`chatStream`，配置字段兼容 baseUrl/apiKey/model 等。

**Q: 如何切换？** → `createClient({ provider: 'gemini' })`  
**Q: 如何添加？** → 实现客户端类 + `registerProvider`  
**Q: 配置从哪读？** → `cfg.getLLMConfig(provider)`，见上配置来源  
**Q: 默认提供商？** → 无配置项；未传 model/provider 时用第一个启用的，否则兜底 gptgod  

---

## 相关文档

- [WORKFLOW_BASE_CLASS.md](./WORKFLOW_BASE_CLASS.md) - 工作流内使用工厂
- [COMMONCONFIG_BASE.md](./COMMONCONFIG_BASE.md) - 配置管理
- [CORE_OBJECTS.md](./CORE_OBJECTS.md) - cfg 与配置读取
- [ARCHITECTURE.md](./ARCHITECTURE.md) - 工厂在架构中的位置
