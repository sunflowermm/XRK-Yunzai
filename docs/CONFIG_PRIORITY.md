# 配置优先级说明

## 配置优先级规则

**execute传入参数 > 构造函数config > kuizai.yaml配置 > 默认值**

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

**说明：**
- 传入的 `API_CONFIG` 会覆盖所有其他配置
- 包括 `chatModel`、`temperature`、`max_tokens` 等所有参数
- 这是**最高优先级**的配置方式

### 2. 构造函数中的config（次高优先级）

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

**说明：**
- 构造函数中的 `config` 会覆盖 `kuizai.yaml` 和默认值
- 但会被 `execute` 传入的参数覆盖

### 3. kuizai.yaml配置（中等优先级）

```yaml
# config/default_config/kuizai.yaml
kuizai:
  ai:
    chatModel: 'deepseek-r1-0528'
    temperature: 0.8
    max_tokens: 2000
```

**说明：**
- 如果上面没有指定，使用这个配置
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
  
  // 2. 合并kuizai.yaml配置
  const kuizaiConfig = { ...cfg.kuizai?.ai };
  
  // 3. 合并用户传入的config（最高优先级）
  const userConfig = config || {};
  
  // 4. 最终配置（用户配置覆盖所有）
  const finalConfig = { 
    ...baseConfig, 
    ...kuizaiConfig, 
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
  
  // 2. 基础配置（构造函数 + kuizai.yaml）
  const baseConfig = { ...this.config, ...cfg.kuizai?.ai };
  
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

**结果：** 会使用 `gemini-3-pro-preview` 模型，而不是 `kuizai.yaml` 中配置的模型。

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
2. `cfg.kuizai?.ai`（kuizai.yaml配置）
3. `userConfig`（execute传入的config，最高优先级）

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

