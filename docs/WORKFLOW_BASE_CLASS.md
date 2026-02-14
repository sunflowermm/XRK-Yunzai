# 工作流基类开发文档

## 概述

`AIStream` 是所有工作流的基类，提供了统一的AI调用、记忆系统、功能管理等能力。继承此基类可以快速创建自定义工作流。

**文件路径**: `lib/aistream/aistream.js`

**工作流存放路径**: 支持多个位置（按优先级从高到低）

### 1. 插件专用目录（推荐）

每个插件可以在自己的目录下创建 `stream/` 子目录来存放专属的工作流：

```
plugins/
├── myplugin/
│   └── stream/
│       ├── workflow1.js      # 插件专属工作流
│       └── workflow2.js
└── anotherplugin/
    └── stream/
        └── workflow.js
```

**优点：**
- 插件代码集中管理，便于维护
- 插件可以独立分发，不依赖 `plugins/stream/` 目录
- 支持插件级别的热重载

### 2. 工作流加载规则

当前版本仅从插件内部加载工作流：

```
plugins/<插件根>/stream/
├── chat.js          # 聊天工作流
├── device.js        # 设备工作流
└── [自定义].js     # 自定义工作流
```

`StreamLoader` 不再扫描 `plugins/stream/` 或 `core/*/stream/`，统一约定**每个插件自带自己的 `stream/` 业务层目录**。

**注意:** 
- 工作流必须继承 `AIStream` 基类
- 工作流的 `name` 属性用于标识，如果同名，优先级更高的会覆盖优先级较低的
- 工作流的 `priority` 属性影响加载顺序，数字越小优先级越高

## 类结构

```javascript
import AIStream from '../../lib/aistream/aistream.js';
import cfg from '../../lib/config/config.js';

export default class MyWorkflow extends AIStream {
  constructor() {
    super({
      name: 'myworkflow',              // 工作流名称（必填）
      description: '我的工作流',        // 工作流描述
      version: '1.0.0',                // 版本号
      author: 'YourName',              // 作者
      priority: 100,                   // 优先级（数字越小优先级越高）
      config: {                        // AI配置（可选，会与aistream配置和LLM提供商配置合并）
        enabled: true,                 // 是否启用
        baseUrl: '',                   // API基础URL
        apiKey: '',                    // API密钥
        chatModel: 'deepseek-r1-0528', // 模型名称
        temperature: 0.7,              // 温度参数
        maxTokens: 2000,               // 最大token数
        topP: 0.9,                     // top_p采样
        presencePenalty: 0.6,          // 存在惩罚
        frequencyPenalty: 0.6,         // 频率惩罚
        timeout: 30000                 // 超时时间（毫秒）
      },
      functionToggles: {},              // 功能开关（可选）
      embedding: {                     // 轻量语义检索配置（可选，基于 BM25）
        enabled: false,                // 是否启用语义检索
        maxContexts: 5,                // 最大上下文数量
        similarityThreshold: 0.6,      // 相似度阈值
        cacheExpiry: 86400             // 缓存过期时间（秒）
      }
    });
  }
}
```

**构造函数参数说明：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `name` | `string` | 是 | `'base-stream'` | 工作流名称，用于标识 |
| `description` | `string` | 否 | `'基础工作流'` | 工作流描述 |
| `version` | `string` | 否 | `'1.0.0'` | 版本号 |
| `author` | `string` | 否 | `'unknown'` | 作者名称 |
| `priority` | `number` | 否 | `100` | 优先级，数字越小优先级越高 |
| `config` | `object` | 否 | 见下方 | AI配置对象 |
| `functionToggles` | `object` | 否 | `{}` | 功能开关，用于控制注册的功能是否启用 |
| `embedding` | `object` | 否 | 见下方 | 语义检索（BM25）配置对象 |

**config 对象字段：**

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | `boolean` | `true` | 是否启用工作流 |
| `baseUrl` | `string` | `''` | API基础URL |
| `apiKey` | `string` | `''` | API密钥 |
| `chatModel` | `string` | `'deepseek-r1-0528'` | 聊天模型名称 |
| `temperature` | `number` | `0.8` | 温度参数（0-2） |
| `maxTokens` | `number` | `6000` | 最大token数 |
| `topP` | `number` | `0.9` | top_p采样（0-1） |
| `presencePenalty` | `number` | `0.6` | 存在惩罚（-2到2） |
| `frequencyPenalty` | `number` | `0.6` | 频率惩罚（-2到2） |
| `timeout` | `number` | `30000` | 超时时间（毫秒） |

**embedding 对象字段（BM25）**

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | `boolean` | `false` | 是否启用语义检索 |
| `maxContexts` | `number` | `5` | 最大返回的历史上下文数量 |
| `similarityThreshold` | `number` | `0.6` | 相似度阈值（0-1），低于此值将被丢弃 |
| `cacheExpiry` | `number` | `86400` | Redis 中历史对话缓存过期时间（秒） |

## 参数优先级

**execute 传入 > 构造函数 config > aistream/LLM 提供商配置 > 默认值**

合并顺序：`finalConfig = { ...this.config, ...cfg.aistream, ...cfg.getLLMConfig(provider), ...config }`。详见 [CONFIG_PRIORITY.md](./CONFIG_PRIORITY.md)。

## 核心方法

- **buildSystemPrompt(context)**：子类实现，返回系统提示字符串。
- **buildChatContext(e, question)**：子类实现，返回 `[{ role, content }]` 消息数组。
- **execute(e, question, config)**：合并 config → 构建上下文 → `callAI`；参数 `e` 事件对象、`question` 字符串或对象、`config` 可选；返回字符串或 null。详见 [reference/WORKFLOWS.md](./reference/WORKFLOWS.md)。

## 记忆系统

`this.getMemorySystem()` 获取记忆系统；`this.buildMemorySummary(e)` 构建摘要（场景隔离）；`memorySystem.remember({ ownerId, scene, layer, content, ... })` / `forget(...)`。详见 [WORKFLOWS.md](./reference/WORKFLOWS.md)。

## AI 调用

- **callAI(messages, apiConfig)**：内部合并 `this.config` 与 apiConfig，调用 LLM 返回回复文本。
- **callAIStream(messages, apiConfig, onDelta)**：流式输出，每段增量回调 `onDelta(delta)`。

## 功能管理

**registerFunction(name, options)**：注册后 AI 可在回复中使用约定格式；`options` 含 `description`、`prompt`、`parser(text, context)`（返回 `{ functions, cleanText }`）、`handler(params, context)`、`enabled`。解析出的 functions 由 `runActionTimeline` 执行。

## 工作流调用效果

**单个工作流**：`const stream = StreamLoader.getStream('chat'); await stream.execute(e, question, config);` — AI 仅能看到该工作流注册的功能与记忆。

**并行多工作流**：`await workflowManager.runMultiple(['chat', { name: 'file', params: { question: '...' } }], {}, { e, question, config });` — 各工作流独立执行，返回结果数组。

**场景示例**：需“创建文件并回复”时，只调 file 无法回复、只调 chat 无法创建文件；应使用 `runMultiple([{ name: 'file', params: {...} }, { name: 'chat', params: {...} }], ...)` 并行调用。

## 完整示例

> **注意**: 以下示例中，假设已导入必要的模块：
> - `import AIStream from '../../lib/aistream/aistream.js'`
> - `import cfg from '../../lib/config/config.js'`
> - `import fs from 'fs/promises'`

```javascript
export default class FileWorkflow extends AIStream {
  constructor() {
    super({
      name: 'file',
      description: '文件操作工作流',
      version: '1.0.0',
      author: 'YourName',
      priority: 50,
      config: {
        enabled: true,
        temperature: 0.7
      }
    });
  }

  async init() {
    await super.init();
    this.registerFunction('createFile', {
      description: '创建文件',
      prompt: '[创建文件:文件名:内容] - 创建文件',
      parser: (text, context) => {
        const functions = [];
        const regex = /\[创建文件:([^:]+):([^\]]+)\]/g;
        let match;
        while ((match = regex.exec(text))) {
          functions.push({
            type: 'createFile',
            params: { fileName: match[1], content: match[2] },
            raw: match[0]
          });
        }
        return { 
          functions, 
          cleanText: text.replace(regex, '').trim() 
        };
      },
      handler: async (params, context) => {
        try {
          await fs.writeFile(params.fileName, params.content, 'utf8');
          return { type: 'text', content: `文件 ${params.fileName} 已创建` };
        } catch (error) {
          return { type: 'text', content: `创建失败: ${error.message}` };
        }
      },
      enabled: true
    });
  }

  buildSystemPrompt(context) {
    return `你是文件操作助手，可以创建、读取、删除文件。
功能：
${this.buildFunctionsPrompt()}`;
  }

  async buildChatContext(e, question) {
    const text = typeof question === 'string' ? question : (question?.text || '');
    const messages = [
      { role: 'system', content: this.buildSystemPrompt({ e, question }) },
      { role: 'user', content: text }
    ];
    return messages;
  }

  async execute(e, question, config) {
    const provider = config.provider || this.config.provider || 'gptgod';
    const finalConfig = { 
      ...this.config, 
      ...cfg.aistream,
      ...cfg.getLLMConfig(provider),
      ...config 
    };
    const messages = await this.buildChatContext(e, question);
    const response = await this.callAI(messages, finalConfig);
    
    if (!response) return null;
    
    const { timeline, cleanText } = this.parseFunctions(response, { e, question, config: finalConfig });
    const actionTimeline = timeline?.length ? timeline : [{ type: 'text', content: cleanText || response }];
    const result = await this.runActionTimeline(actionTimeline, { e, question, config: finalConfig });
    
    return result;
  }
}
```

## 最佳实践

1. **参数合并**：在execute中使用 `{ ...this.config, ...cfg.aistream, ...cfg.getLLMConfig(provider), ...config }` 确保优先级
2. **记忆系统**：在 `buildChatContext` 中使用 `buildMemorySummary` 增强上下文
3. **功能注册**：在 `init` 方法中注册功能，而不是构造函数
4. **错误处理**：所有异步操作都要有错误处理
5. **场景隔离**：记忆系统自动场景隔离，无需手动处理
6. **模块化设计**：每个工作流专注特定功能，通过组合实现复杂需求

## 配置参考

### aistream配置

```yaml
# config/default_config/aistream.yaml
aistream:
  enabled: true
  temperature: 0.8
  max_tokens: 2000
  top_p: 0.9
  presence_penalty: 0.6
  frequency_penalty: 0.6
  timeout: 30000
```

### LLM提供商配置

通过 CommonConfig 系统管理，详见 [工厂模式文档](./FACTORY.md) 和 [CommonConfig基类文档](./COMMONCONFIG_BASE.md)。

## 常见问题

**Q: 如何让AI看到多个工作流的功能？**
A: 不能。每个工作流独立执行，AI只能看到当前工作流的功能。如果需要多个功能，使用 `WorkflowManager.runMultiple()` 并行调用多个工作流，每个工作流处理自己的部分。

**Q: 参数优先级如何确定？**
A: execute传入参数 > 构造函数config > aistream配置/LLM提供商配置 > 默认值。在execute中使用 `{ ...this.config, ...cfg.aistream, ...cfg.getLLMConfig(provider), ...config }` 合并。

**Q: 如何访问记忆系统？**
A: 使用 `this.getMemorySystem()` 或 `this.buildMemorySummary(e)`。所有工作流自动获得记忆系统。

**Q: 功能函数如何工作？**
A: AI在回复中使用特定格式（如`[创建文件:test.txt:内容]`），系统解析后执行对应handler，返回结果会合并到最终回复中。

**Q: 同时调用多个工作流时，AI能看到所有功能吗？**
A: 不能。每个工作流独立执行，AI只能看到当前工作流的功能。这是模块化设计的核心：每个工作流专注自己的功能，通过组合实现复杂需求。

**Q: 工作流如何被加载？**
A: 工作流由 `lib/aistream/loader.js` 自动扫描 `plugins/<插件根>/stream/` 目录并加载。确保文件导出默认类并继承 `AIStream`。

## 相关文档

- [插件基类文档](./PLUGIN_BASE_CLASS.md) - 如何在插件中使用工作流
- [HTTP API基类文档](./HTTP_API_BASE_CLASS.md) - 如何在API中使用工作流
- [项目基类总览](./BASE_CLASSES.md) - 所有基类的概览
- [工厂模式文档](./FACTORY.md) - LLM提供商管理和客户端创建
- [配置优先级文档](./CONFIG_PRIORITY.md) - 详细的配置优先级说明