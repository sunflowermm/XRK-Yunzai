# 工作流基类开发文档

## 概述

`AIStream` 是所有工作流的基类，提供了统一的AI调用、记忆系统、功能管理等能力。继承此基类可以快速创建自定义工作流。

**文件路径**: `lib/aistream/aistream.js`

**工作流存放路径**: `plugins/stream/`

## 类结构

```javascript
import AIStream from '../../lib/aistream/aistream.js';
import cfg from '../../lib/config/config.js';

export default class MyWorkflow extends AIStream {
  constructor() {
    super({
      name: 'myworkflow',
      description: '我的工作流',
      version: '1.0.0',
      author: 'YourName',
      priority: 100,
      config: {
        enabled: true,
        temperature: 0.7,
        maxTokens: 2000
      }
    });
  }
}
```

## 参数优先级

**execute传入参数 > 构造函数config > kuizai.yaml配置 > 默认值**

```javascript
// 1. execute方法传入的config（最高优先级）
await stream.execute(e, question, {
  temperature: 0.5  // 这个会覆盖所有其他配置
});

// 2. 构造函数中的config（次高优先级）
super({
  config: {
    temperature: 0.9  // 这个会覆盖kuizai.yaml和默认值
  }
});

// 3. kuizai.yaml配置（中等优先级）
// config/default_config/kuizai.yaml
kuizai:
  ai:
    temperature: 0.8  // 如果上面没有指定，使用这个

// 4. 默认值（最低优先级）
// 如果上面都没有，使用基类的默认值
```

**实际合并顺序（在execute方法中）：**
```javascript
const finalConfig = { 
  ...this.config,           // 构造函数config（已包含kuizai.yaml的默认值）
  ...cfg.kuizai?.ai,        // kuizai.yaml配置
  ...config                 // execute传入的参数（最高优先级）
};
```

## 核心方法

### 1. buildSystemPrompt(context)

构建系统提示词，必须由子类实现。

```javascript
buildSystemPrompt(context) {
  const { e, question } = context;
  return `你是AI助手，当前时间：${new Date().toLocaleString()}`;
}
```

### 2. buildChatContext(e, question)

构建消息上下文，必须由子类实现。

```javascript
async buildChatContext(e, question) {
  const text = typeof question === 'string' ? question : (question?.text || '');
  const messages = [
    { role: 'system', content: this.buildSystemPrompt({ e, question }) },
    { role: 'user', content: text }
  ];
  return messages;
}
```

### 3. execute(e, question, config)

执行工作流的主方法。

```javascript
async execute(e, question, config) {
  const finalConfig = { ...this.config, ...cfg.kuizai?.ai, ...config };
  const messages = await this.buildChatContext(e, question);
  const response = await this.callAI(messages, finalConfig);
  return response;
}
```

**参数说明：**
- `e`: 事件对象（QQ消息事件、设备事件等）
- `question`: 用户问题（字符串或对象）
- `config`: API配置（可选，会覆盖默认配置）

**返回值：**
- 字符串：AI回复文本
- null：执行失败

## 记忆系统

所有工作流自动获得记忆系统：

```javascript
// 获取记忆系统
const memorySystem = this.getMemorySystem();

// 构建记忆摘要（自动场景隔离）
const summary = await this.buildMemorySummary(e);

// 记住信息
await memorySystem.remember({
  ownerId: 'user123',
  scene: 'private',
  layer: 'long',
  content: '用户喜欢原神',
  metadata: {},
  authorId: 'bot'
});

// 删除记忆
await memorySystem.forget(ownerId, scene, memoryId, content);
```

## AI调用

### callAI(messages, apiConfig)

调用AI生成回复。

```javascript
const messages = [
  { role: 'system', content: '你是AI助手' },
  { role: 'user', content: '你好' }
];

const response = await this.callAI(messages, {
  temperature: 0.7,  // 会覆盖this.config中的temperature
  maxTokens: 1000
});

// 内部合并：{ ...this.config, ...apiConfig }
```

### callAIStream(messages, apiConfig, onDelta)

流式调用AI。

```javascript
await this.callAIStream(messages, this.config, (delta) => {
  console.log('收到:', delta);
});
```

## 功能管理

### registerFunction(name, options)

注册功能函数，AI可以在回复中使用。

```javascript
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
    return { functions, cleanText: text.replace(regex, '').trim() };
  },
  handler: async (params, context) => {
    await fs.writeFile(params.fileName, params.content);
    return { type: 'text', content: '文件已创建' };
  },
  enabled: true
});
```

## 工作流调用效果

### 单个工作流调用

```javascript
const chatStream = StreamLoader.getStream('chat');
const response = await chatStream.execute(e, question, config);
```

**效果：**
- AI只能看到chat工作流注册的功能（如表情包、@、禁言等）
- 使用chat工作流的系统提示
- 使用chat工作流的记忆系统（场景隔离）

### 同时调用多个工作流

```javascript
import { WorkflowManager } from '../../lib/aistream/workflow-manager.js';

const workflowManager = new WorkflowManager();

// 并行调用
const results = await workflowManager.runMultiple([
  'chat',
  'file'
], {}, { e, question, config });
```

**效果：**
- 每个工作流独立执行，互不干扰
- 每个工作流使用自己的功能和记忆系统
- 返回多个结果数组，可以合并使用

**详细说明：**

1. **单个工作流调用**：
```javascript
const chatStream = StreamLoader.getStream('chat');
const response = await chatStream.execute(e, question, config);
```
- AI只能看到chat工作流注册的功能（如表情包、@、禁言等）
- 使用chat工作流的系统提示
- 使用chat工作流的记忆系统（场景隔离）

2. **同时调用多个工作流（并行）**：
```javascript
const results = await workflowManager.runMultiple([
  'chat',
  { name: 'file', params: { question: '创建test.txt' } }
], {}, { e, question, config });
```
- chat工作流独立执行，AI只能看到chat的功能
- file工作流独立执行，AI只能看到file的功能
- 两个工作流并行执行，互不干扰
- 返回：`[{ type: 'text', content: 'chat的回复' }, { type: 'text', content: 'file的回复' }]`

3. **实际应用场景**：
```javascript
// 场景：用户说"帮我创建文件test.txt，然后回复'文件已创建'"

// 方案1：只调用file工作流
const fileResult = await workflowManager.run('file', 
  { question: '创建文件test.txt' }, 
  { e, config }
);
// 结果：file工作流创建文件，但AI看不到chat的功能，无法回复

// 方案2：只调用chat工作流  
const chatResult = await workflowManager.run('chat', 
  { question: '帮我创建文件test.txt，然后回复' }, 
  { e, config }
);
// 结果：chat工作流可以回复，但看不到file的功能，无法创建文件

// 方案3：同时调用两个工作流（推荐）
const results = await workflowManager.runMultiple([
  { name: 'file', params: { question: '创建文件test.txt' } },
  { name: 'chat', params: { question: '回复文件已创建' } }
], {}, { e, config });
// 结果：file工作流创建文件，chat工作流回复，各司其职，模块化清晰
```

## 完整示例

```javascript
import AIStream from '../../lib/aistream/aistream.js';
import cfg from '../../lib/config/config.js';
import fs from 'fs/promises';

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
    const finalConfig = { ...this.config, ...cfg.kuizai?.ai, ...config };
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

1. **参数合并**：在execute中使用 `{ ...this.config, ...cfg.kuizai?.ai, ...config }` 确保优先级
2. **记忆系统**：在 `buildChatContext` 中使用 `buildMemorySummary` 增强上下文
3. **功能注册**：在 `init` 方法中注册功能，而不是构造函数
4. **错误处理**：所有异步操作都要有错误处理
5. **场景隔离**：记忆系统自动场景隔离，无需手动处理
6. **模块化设计**：每个工作流专注特定功能，通过组合实现复杂需求

## 配置参考

```yaml
# config/default_config/kuizai.yaml
kuizai:
  ai:
    enabled: true
    baseUrl: 'https://api.example.com/v1'
    apiKey: 'your-key'
    chatModel: 'deepseek-r1-0528'
    temperature: 0.8
    max_tokens: 2000
    top_p: 0.9
    presence_penalty: 0.6
    frequency_penalty: 0.6
    timeout: 30000
```

## 工作流存放路径

工作流文件应存放在以下目录：

```
plugins/stream/
├── chat.js      # 聊天工作流
├── device.js    # 设备工作流
└── [自定义].js  # 自定义工作流
```

**注意:** 
- 工作流文件名即为工作流标识（name）
- 建议使用小写字母和连字符
- 工作流会自动被 `StreamLoader` 加载

## 常见问题

**Q: 如何让AI看到多个工作流的功能？**
A: 不能。每个工作流独立执行，AI只能看到当前工作流的功能。如果需要多个功能，使用 `WorkflowManager.runMultiple()` 并行调用多个工作流，每个工作流处理自己的部分。

**Q: 参数优先级如何确定？**
A: execute传入参数 > 构造函数config > kuizai.yaml > 默认值。在execute中使用 `{ ...this.config, ...cfg.kuizai?.ai, ...config }` 合并。

**Q: 如何访问记忆系统？**
A: 使用 `this.getMemorySystem()` 或 `this.buildMemorySummary(e)`。所有工作流自动获得记忆系统。

**Q: 功能函数如何工作？**
A: AI在回复中使用特定格式（如`[创建文件:test.txt:内容]`），系统解析后执行对应handler，返回结果会合并到最终回复中。

**Q: 同时调用多个工作流时，AI能看到所有功能吗？**
A: 不能。每个工作流独立执行，AI只能看到当前工作流的功能。这是模块化设计的核心：每个工作流专注自己的功能，通过组合实现复杂需求。

**Q: 工作流如何被加载？**
A: 工作流由 `lib/aistream/loader.js` 自动扫描 `plugins/stream/` 目录并加载。确保文件导出默认类并继承 `AIStream`。

## 相关文档

- [插件基类文档](./PLUGIN_BASE_CLASS.md) - 如何在插件中使用工作流
- [HTTP API基类文档](./HTTP_API_BASE_CLASS.md) - 如何在API中使用工作流
- [项目基类总览](./BASE_CLASSES.md) - 所有基类的概览
