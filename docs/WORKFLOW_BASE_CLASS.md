# 工作流基类开发文档

## 概述

`AIStream` 是所有工作流的基类，提供了统一的AI调用、记忆系统、功能管理等能力。继承此基类可以快速创建自定义工作流。

**文件路径**: `lib/aistream/aistream.js`

**工作流存放路径**：仅从插件目录加载，路径为 `plugins/<插件根>/stream/`。

```
plugins/<插件根>/stream/
├── chat.js          # 聊天工作流
├── device.js        # 设备工作流
└── [自定义].js      # 自定义工作流
```

`StreamLoader` 扫描各插件的 `stream/` 目录并加载，不扫描根级 `plugins/stream/` 或 `core/*/stream/`。

**注意:** 
- 工作流必须继承 `AIStream` 基类
- 工作流的 `name` 属性用于标识，如果同名，优先级更高的会覆盖优先级较低的
- 工作流的 `priority` 属性影响加载顺序，数字越小优先级越高

## 类结构

```javascript
import AIStream from '../../lib/aistream/aistream.js';

export default class MyWorkflow extends AIStream {
  constructor() {
    super({
      name: 'myworkflow',              // 工作流名称（必填）
      description: '我的工作流',        // 工作流描述
      version: '1.0.0',                // 版本号
      author: 'YourName',              // 作者
      priority: 100,                   // 优先级（数字越小优先级越高）
      config: {                        // 传入 callAI 的 apiConfig 会与全局/提供商配置按字段合并
        enabled: true,                 // 是否启用
        baseUrl: '',                   // API基础URL
        apiKey: '',                    // API密钥
        // model 不写则使用当前 LLM 提供商（如 openai_compat providers）里配置的模型
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
| `model` / `chatModel` | `string` | （无） | 不写则用提供商 yaml；与 XRK-AGT 一致，基类不设 `baseUrl`/`apiKey`/`timeout`（由 `openai_compat` 等 providers 与 `aistream.llm` 提供） |
| `temperature` | `number` | `0.8` | 可被提供商与 `aistream.llm.temperature` 覆盖（见 `resolveLLMConfig`） |
| `maxTokens` | `number` | `6000` | 同上 |
| `topP` | `number` | `0.9` | 同上 |
| `presencePenalty` | `number` | `0.6` | 同上 |
| `frequencyPenalty` | `number` | `0.6` | 同上 |
| `enableStream` / `toolChoice` / `parallelToolCalls` / `maxToolRounds` / `headers` / `extraBody` / `proxy` 等 | — | — | 可在工作流 `config` 中写；`resolveLLMConfig` 会与提供商条目合并（与 `openai_compat_llm` schema 对齐） |

**embedding 对象字段（BM25）**

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | `boolean` | `false` | 是否启用语义检索 |
| `maxContexts` | `number` | `5` | 最大返回的历史上下文数量 |
| `similarityThreshold` | `number` | `0.6` | 相似度阈值（0-1），低于此值将被丢弃 |
| `cacheExpiry` | `number` | `86400` | Redis 中历史对话缓存过期时间（秒） |

## 参数优先级（LLM 相关）

按 **字段** 合并，见 [CONFIG_PRIORITY.md](./CONFIG_PRIORITY.md)。要点：基类 **`execute`** 调用 **`callAI(messages, config)`**，第三参数 `config` 即 **`resolveLLMConfig` 的 `apiConfig`**；全局 `aistream.llm` 与 `LLMFactory.getProviderConfig` 在 **`resolveLLMConfig`** 内参与各字段的 `pick`，而非在 `execute` 里先拼成一个大对象。

## 核心方法

- **buildSystemPrompt(context)**：子类实现，返回系统提示字符串。
- **buildChatContext(e, question)**：子类实现，返回 `[{ role, content }]` 消息数组。
- **execute(e, question, config)**：构建上下文 → **`callAI(messages, config ?? {})`** → 解析功能时间线等；返回字符串或 `null`（`callAI` 自身返回 `{ text, usedReplyTool }`，基类 `execute` 取 `text` 参与解析）。详见 [reference/WORKFLOWS.md](./reference/WORKFLOWS.md)。

## 记忆系统

`this.getMemorySystem()`；`this.buildMemorySummary(e)`；`remember` / `forget`。详见 [reference/WORKFLOWS.md](./reference/WORKFLOWS.md)。

## AI 调用

- **callAI(messages, apiConfig)**：`resolveLLMConfig` → `LLMFactory.createClient` → `client.chat`；返回 **`{ text, usedReplyTool } | null`**（`usedReplyTool` 表示本轮已通过 MCP `*.reply` 发往会话，ChatStream 等据此避免重复 `sendMessages`）。工厂 `chat()` 的 pack/unpack 见 `lib/utils/llm/llm-nonstream-reply.js`。
- **callAIStream(messages, apiConfig, onDelta)**：同上，流式；`enableStream === false` 时走非流式再一次性回调。

## 功能管理

**registerFunction(name, options)**：注册后 AI 可在回复中使用约定格式；`options` 含 `description`、`prompt`、`parser(text, context)`（返回 `{ functions, cleanText }`）、`handler(params, context)`、`enabled`。解析出的 functions 由 `runActionTimeline` 执行。

## 工作流调用效果

**单个工作流**：`const stream = StreamLoader.getStream('chat'); await stream.execute(e, question, config);` — AI 仅能看到该工作流注册的功能与记忆。

**并行多工作流**：`await workflowManager.runMultiple(['chat', { name: 'file', params: { question: '...' } }], {}, { e, question, config });` — 各工作流独立执行，返回结果数组。

**场景示例**：需“创建文件并回复”时，只调 file 无法回复、只调 chat 无法创建文件；应使用 `runMultiple([{ name: 'file', params: {...} }, { name: 'chat', params: {...} }], ...)` 并行调用。

## 完整示例

> **注意**：业务中写文件请用 `FileUtils`（`lib/utils/file-utils.js`），勿在插件中直接使用 `fs`。

```javascript
import { FileUtils } from '../../lib/utils/file-utils.js';
import AIStream from '../../lib/aistream/aistream.js';

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
          await FileUtils.writeFile(params.fileName, params.content, 'utf8');
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
    const userConfig = config || {};
    const finalConfig = { ...this.config, ...userConfig };
    const context = { e, question, config: finalConfig };
    const baseMessages = await this.buildChatContext(e, question);
    const messages = await this.buildEnhancedContext(e, question, baseMessages);
    const r = await this.callAI(messages, userConfig);
    if (r == null) return null;
    const response = r.text;
    const { timeline, cleanText } = this.parseFunctions(response, context);
    const actionTimeline = timeline?.length ? timeline : [{ type: 'text', content: cleanText || response }];
    return await this.runActionTimeline(actionTimeline, context);
  }
}
```

## 最佳实践

1. **参数合并**：需要覆盖模型/密钥时在 `execute` 第三参数或 `callAI` 第二参数传入；详见 [CONFIG_PRIORITY.md](./CONFIG_PRIORITY.md)
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
A: 见 [CONFIG_PRIORITY.md](./CONFIG_PRIORITY.md)（按字段 `pick`，不是整对象覆盖）。

**Q: 如何访问记忆系统？**
A: 使用 `this.getMemorySystem()` 或 `this.buildMemorySummary(e)`。所有工作流自动获得记忆系统。

**Q: 功能函数如何工作？**
A: AI在回复中使用特定格式（如`[创建文件:test.txt:内容]`），系统解析后执行对应handler，返回结果会合并到最终回复中。

**Q: 工作流如何被加载？**
A: 工作流由 `lib/aistream/loader.js` 自动扫描 `plugins/<插件根>/stream/` 目录并加载。确保文件导出默认类并继承 `AIStream`。

## 相关文档

- [插件基类文档](./PLUGIN_BASE_CLASS.md) - 如何在插件中使用工作流
- [HTTP API基类文档](./HTTP_API_BASE_CLASS.md) - 如何在API中使用工作流
- [项目基类总览](./BASE_CLASSES.md) - 所有基类的概览
- [工厂模式文档](./FACTORY.md) - LLM提供商管理和客户端创建
- [配置优先级文档](./CONFIG_PRIORITY.md) - 详细的配置优先级说明