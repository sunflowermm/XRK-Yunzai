# 配置优先级说明

## 配置优先级规则

**execute传入参数 > 构造函数config > aistream配置/LLM提供商配置 > 默认值**

## 详细说明

### 1. execute方法传入的config（最高优先级）

```javascript
const API_CONFIG = {
  baseUrl: 'https://api.gptgod.online/v1',
  apiKey: 'your-key',
  chatModel: 'gemini-3-pro-preview',  // 这个会覆盖所有其他配置
  temperature: 0.8,
  max_tokens: 6000
};

const chatStream = StreamLoader.getStream('chat');
const result = await chatStream.execute(e, question, API_CONFIG);
```
传入 `execute` 的 config 覆盖其余所有来源。

### 2. 构造函数中的 config（次高）

```javascript
export default class MyWorkflow extends AIStream {
  constructor() {
    super({
      name: 'my-workflow',
      config: {
        chatModel: 'gpt-4',  // 这个会覆盖kuizai.yaml和默认值
        temperature: 0.7
      }
    });
  }
}
```

### 3. aistream / LLM 提供商配置（中）

配置来源包括：
- `cfg.aistream`：AI工作流通用配置（`config/default_config/aistream.yaml`）
- `cfg.getLLMConfig(provider)`：特定LLM提供商配置（如 `config/commonconfig/openai_llm.js`）

```yaml
# config/default_config/aistream.yaml
aistream:
  enabled: true
  temperature: 0.8
  max_tokens: 2000
```

或通过 CommonConfig 系统：

```javascript
// config/commonconfig/openai_llm.js
export default class OpenAILLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'openai_llm',
      schema: {
        fields: {
          enabled: { type: 'boolean', default: false },
          baseUrl: { type: 'string', default: 'https://api.openai.com/v1' },
          apiKey: { type: 'string', default: '' },
          model: { type: 'string', default: 'gpt-3.5-turbo' },
          temperature: { type: 'number', default: 0.7 }
        }
      }
    });
  }
}
```

**说明：**
- 如果上面没有指定，使用这些配置
- 会被构造函数和 `execute` 传入的参数覆盖

### 4. 默认值（最低优先级）

```javascript
// lib/aistream/aistream.js
this.config = {
  chatModel: 'deepseek-r1-0528',
  temperature: 0.8,
  max_tokens: 6000,
  // ...
};
```

**说明：**
- 如果上面都没有指定，使用基类的默认值

## 实际合并过程

### execute方法中的合并

```javascript
async execute(e, question, config) {
  // 1. 先合并基础配置
  const baseConfig = { ...this.config };  // 构造函数config（已包含默认值）
  
  // 2. 合并aistream配置和LLM提供商配置
  const aistreamConfig = { ...cfg.aistream };
  const llmConfig = cfg.getLLMConfig(provider || 'gptgod');
  
  // 3. 合并用户传入的config（最高优先级）
  const userConfig = config || {};
  
  // 4. 最终配置（用户配置覆盖所有）
  const finalConfig = { 
    ...baseConfig, 
    ...aistreamConfig,
    ...llmConfig,
    ...userConfig 
  };
  
  // 5. 调用callAI时，传入原始userConfig（确保优先级）
  const response = await this.callAI(messages, userConfig);
}
```

### callAI方法中的合并

```javascript
async callAI(messages, apiConfig = {}) {
  // 1. 用户传入的配置（最高优先级）
  const userConfig = apiConfig || {};
  
  // 2. 基础配置（构造函数 + aistream配置 + LLM提供商配置）
  const provider = apiConfig.provider || this.config.provider || 'gptgod';
  const baseConfig = { 
    ...this.config, 
    ...cfg.aistream,
    ...cfg.getLLMConfig(provider)
  };
  
  // 3. 最终配置（用户配置覆盖基础配置）
  const config = { ...baseConfig, ...userConfig };
  
  // 4. 模型选择（优先使用userConfig中的模型）
  const model = userConfig?.model || userConfig?.chatModel || config.model || config.chatModel;
  
  // 5. 其他参数（优先使用userConfig中的参数）
  body: JSON.stringify({
    model: model,
    temperature: userConfig.temperature ?? config.temperature,
    max_tokens: userConfig.maxTokens ?? userConfig.max_tokens ?? config.maxTokens,
    // ...
  })
}
```

## 使用示例

### 示例1: 插件中直接传入配置

```javascript
// plugins/my-plugin.js
export default class MyPlugin extends plugin {
  async test(e) {
    const API_CONFIG = {
      chatModel: 'gemini-3-pro-preview',  // 使用自定义模型
      temperature: 0.8,
      max_tokens: 6000
    };
    
    const chatStream = this.getStream('chat');
    const result = await chatStream.execute(e, e.msg, API_CONFIG);
    
    return this.reply(result);
  }
}
```

**结果：** 会使用 `gemini-3-pro-preview` 模型，而不是配置文件中配置的模型。

### 示例2: 使用callWorkflow方法

```javascript
// plugins/my-plugin.js
export default class MyPlugin extends plugin {
  async test(e) {
    const result = await this.callWorkflow('chat', {
      question: e.msg
    }, { 
      e,
      config: {
        chatModel: 'gemini-3-pro-preview',  // 自定义模型
        temperature: 0.8
      }
    });
    
    return this.reply(result.content);
  }
}
```

**结果：** 会使用 `gemini-3-pro-preview` 模型。

### 示例3: 使用executeWorkflow方法

```javascript
// plugins/my-plugin.js
export default class MyPlugin extends plugin {
  async test(e) {
    const result = await this.executeWorkflow('chat', e.msg, {
      chatModel: 'gemini-3-pro-preview',  // 自定义模型
      temperature: 0.8
    });
    
    return this.reply(result);
  }
}
```

**结果：** 会使用 `gemini-3-pro-preview` 模型。

## 配置字段映射

### 支持的字段名

为了兼容不同的配置格式，支持以下字段名：

| 用户配置字段 | 内部字段 | 说明 |
|------------|---------|------|
| `model` | `model` | 模型名称 |
| `chatModel` | `chatModel` | 聊天模型（同model） |
| `temperature` | `temperature` | 温度参数 |
| `max_tokens` | `maxTokens` | 最大token数 |
| `maxTokens` | `maxTokens` | 最大token数（同max_tokens） |
| `top_p` | `topP` | top_p采样 |
| `topP` | `topP` | top_p采样（同top_p） |
| `presence_penalty` | `presencePenalty` | 存在惩罚 |
| `presencePenalty` | `presencePenalty` | 存在惩罚（同presence_penalty） |
| `frequency_penalty` | `frequencyPenalty` | 频率惩罚 |
| `frequencyPenalty` | `frequencyPenalty` | 频率惩罚（同frequency_penalty） |

## 常见问题

**Q: 为什么我传入的模型没有被使用？**

A: 检查以下几点：
1. 确保传入的配置对象包含 `chatModel` 或 `model` 字段
2. 确保字段名正确（支持 `chatModel` 和 `model`）
3. 确保配置对象正确传递给 `execute` 方法

**Q: 如何确认使用的模型？**

A: 可以在 `callAI` 方法中添加日志：

```javascript
const model = userConfig?.model || userConfig?.chatModel || config.model || config.chatModel;
BotUtil.makeLog('debug', `[AI] 使用模型: ${model}`, 'AIStream');
```

**Q: 配置合并的顺序是什么？**

A: 合并顺序：
1. `this.config`（构造函数config，已包含默认值）
2. `cfg.aistream`（aistream配置）
3. `cfg.getLLMConfig(provider)`（LLM提供商配置）
4. `userConfig`（execute传入的config，最高优先级）

**Q: 如何确保使用我的配置？**

A: 直接在 `execute` 方法中传入完整的配置对象：

```javascript
const API_CONFIG = {
  baseUrl: 'https://api.gptgod.online/v1',
  apiKey: 'your-key',
  chatModel: 'gemini-3-pro-preview',  // 明确指定模型
  temperature: 0.8,
  max_tokens: 6000
};

await chatStream.execute(e, question, API_CONFIG);
```

## 相关文档

- [工作流基类开发文档](./WORKFLOW_BASE_CLASS.md)
- [插件基类开发文档](./PLUGIN_BASE_CLASS.md)
- [工厂模式文档](./FACTORY.md) - LLM提供商配置管理
- [CommonConfig基类文档](./COMMONCONFIG_BASE.md) - 配置系统使用

