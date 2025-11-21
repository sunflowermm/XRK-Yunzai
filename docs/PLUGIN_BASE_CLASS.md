# 插件基类开发文档

## 概述

`Plugin` 是所有插件的基类，提供工作流集成、上下文管理、消息回复等功能。所有插件都应继承此类。

**文件路径**: `lib/plugins/plugin.js`

## 类结构

```javascript
import plugin from '../../lib/plugins/plugin.js';

export default class MyPlugin extends plugin {
  constructor() {
    super({
      name: 'my-plugin',
      dsc: '我的插件',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#测试$',
          fnc: 'test'
        }
      ]
    });
  }

  async test(e) {
    return this.reply('测试成功');
  }
}
```

## 构造函数参数

```javascript
constructor(options = {})
```

### 参数说明

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | string | `"your-plugin"` | 插件名称（必填，用于标识） |
| `dsc` | string | `"无"` | 插件描述（用于日志和文档） |
| `event` | string | `"message"` | 监听的事件类型 |
| `priority` | number | `5000` | 优先级（数字越大优先级越高） |
| `task` | object | `{ name: "", fnc: "", cron: "" }` | 定时任务配置 |
| `rule` | array | `[]` | 规则数组（匹配规则和处理函数） |
| `bypassThrottle` | boolean | `false` | 是否绕过节流限制 |
| `handler` | function | - | 自定义处理器（可选） |
| `namespace` | string | `""` | 命名空间（可选） |

### Rule 规则配置

```javascript
rule: [
  {
    reg: '^#测试$',           // 正则表达式匹配
    fnc: 'test',              // 处理函数名
    permission: 'master',     // 权限要求（可选）
    log: false                // 是否记录日志（可选）
  }
]
```

## 核心方法

### 工作流相关方法

#### getStream(name)

获取工作流实例。

```javascript
const chatStream = this.getStream('chat');
```

**参数:**
- `name` (string): 工作流名称

**返回:** `AIStream|null` 工作流实例

#### getAllStreams()

获取所有已加载的工作流。

```javascript
const streams = this.getAllStreams();
// 返回 Map<string, AIStream>
```

**返回:** `Map` 所有工作流实例

#### getWorkflowManager()

获取全局工作流管理器（单例模式）。

```javascript
const manager = this.getWorkflowManager();
```

**返回:** `WorkflowManager` 工作流管理器实例

#### callWorkflow(name, params, context)

调用单个工作流。

```javascript
const result = await this.callWorkflow('chat', {
  question: '你好'
}, { e: this.e });
```

**参数:**
- `name` (string): 工作流名称
- `params` (object): 参数对象
- `context` (object): 上下文（可选，会自动使用this.e）

**返回:** `Promise<Object>` 结果对象

#### callWorkflows(workflows, sharedParams, context)

同时调用多个工作流（并行执行）。

```javascript
const results = await this.callWorkflows([
  'chat',
  { name: 'file', params: { question: '创建test.txt' } }
], {}, { e: this.e });
```

**参数:**
- `workflows` (Array): 工作流列表，可以是字符串或配置对象
- `sharedParams` (object): 共享参数
- `context` (object): 上下文（可选，会自动使用this.e）

**返回:** `Promise<Array>` 结果数组

#### callWorkflowsSequential(workflows, sharedParams, context)

顺序调用多个工作流（串行执行）。

```javascript
const results = await this.callWorkflowsSequential(['file', 'chat'], {}, { e: this.e });
```

**参数:** 同 `callWorkflows`

**返回:** `Promise<Array>` 结果数组

#### executeWorkflow(streamName, question, config)

直接执行工作流（简化调用）。

```javascript
const result = await this.executeWorkflow('chat', '你好', { temperature: 0.7 });
```

**参数:**
- `streamName` (string): 工作流名称
- `question` (string|object): 问题
- `config` (object): 配置（可选）

**返回:** `Promise<string>` 结果文本

### 消息回复方法

#### reply(msg, quote, data)

回复消息。

```javascript
this.reply('回复内容', true, { at: true });
```

**参数:**
- `msg` (string): 消息内容
- `quote` (boolean): 是否引用原消息（默认false）
- `data` (object): 额外数据（如at、recall等）

**返回:** `boolean` 是否成功

### 上下文管理方法

#### setContext(type, isGroup, time, timeout)

设置上下文（用于多轮对话）。

```javascript
this.setContext('waiting_input', false, 120, '操作超时已取消');
```

**参数:**
- `type` (string): 上下文类型
- `isGroup` (boolean): 是否群聊（默认false）
- `time` (number): 超时时间（秒，默认120）
- `timeout` (string): 超时提示（默认"操作超时已取消"）

**返回:** `Object` 上下文对象

#### getContext(type, isGroup)

获取上下文。

```javascript
const context = this.getContext('waiting_input', false);
```

**参数:**
- `type` (string): 上下文类型（可选，不传则返回所有）
- `isGroup` (boolean): 是否群聊（默认false）

**返回:** `Object|null` 上下文对象

#### finish(type, isGroup)

结束上下文。

```javascript
this.finish('waiting_input', false);
```

**参数:**
- `type` (string): 上下文类型
- `isGroup` (boolean): 是否群聊（默认false）

#### awaitContext(...args)

等待上下文（Promise方式）。

```javascript
const context = await this.awaitContext('resolveContext', false, 120);
```

**参数:** 同 `setContext`

**返回:** `Promise<Object>` 上下文对象

#### resolveContext(context)

解析上下文（配合awaitContext使用）。

```javascript
this.resolveContext(this.e);
```

**参数:**
- `context` (object): 上下文对象

### 其他方法

#### markNeedReparse()

标记需要重新解析消息。

```javascript
this.markNeedReparse();
```

#### renderImg(plugin, tpl, data, cfg)

渲染图片（兼容性方法）。

```javascript
const img = await this.renderImg('my-plugin', './template.html', { data: 'value' });
```

## 完整示例

### 示例1: 基础插件

```javascript
import plugin from '../../lib/plugins/plugin.js';

export default class MyPlugin extends plugin {
  constructor() {
    super({
      name: 'my-plugin',
      dsc: '我的插件',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#测试$',
          fnc: 'test'
        }
      ]
    });
  }

  async test(e) {
    return this.reply('测试成功');
  }
}
```

### 示例2: 使用工作流

```javascript
import plugin from '../../lib/plugins/plugin.js';

export default class AIPlugin extends plugin {
  constructor() {
    super({
      name: 'ai-plugin',
      dsc: 'AI对话插件',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#AI (.+)$',
          fnc: 'aiChat'
        }
      ]
    });
  }

  async aiChat(e) {
    const question = e.msg.replace(/^#AI\s+/, '');
    
    // 方式1: 直接执行工作流
    const result = await this.executeWorkflow('chat', question);
    
    // 方式2: 调用工作流管理器
    const result2 = await this.callWorkflow('chat', {
      question: question
    }, { e });
    
    return this.reply(result || result2.content);
  }
}
```

### 示例3: 多工作流组合

```javascript
import plugin from '../../lib/plugins/plugin.js';

export default class MultiWorkflowPlugin extends plugin {
  constructor() {
    super({
      name: 'multi-workflow',
      dsc: '多工作流组合插件',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#组合 (.+)$',
          fnc: 'multiWorkflow'
        }
      ]
    });
  }

  async multiWorkflow(e) {
    const question = e.msg.replace(/^#组合\s+/, '');
    
    // 并行调用多个工作流
    const results = await this.callWorkflows([
      'chat',
      { name: 'file', params: { question: '创建test.txt' } }
    ], {}, { e, question });
    
    // 合并结果
    const combined = results.map(r => r.content || r).join('\n');
    return this.reply(combined);
  }
}
```

### 示例4: 上下文管理

```javascript
import plugin from '../../lib/plugins/plugin.js';

export default class ContextPlugin extends plugin {
  constructor() {
    super({
      name: 'context-plugin',
      dsc: '上下文管理插件',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#开始对话$',
          fnc: 'startDialog'
        },
        {
          reg: '^#结束对话$',
          fnc: 'endDialog'
        }
      ]
    });
  }

  async startDialog(e) {
    // 设置上下文，等待用户输入
    this.setContext('dialog', e.isGroup, 120, '对话超时已取消');
    return this.reply('对话已开始，请发送消息（输入#结束对话退出）');
  }

  async endDialog(e) {
    // 结束上下文
    this.finish('dialog', e.isGroup);
    return this.reply('对话已结束');
  }
}
```

## 插件存放路径

插件应存放在以下目录：

```
plugins/
├── example/          # 示例插件
├── system/          # 系统插件
├── other/           # 其他插件
└── [自定义目录]/    # 自定义插件目录
```

**注意:** 插件文件名即为插件标识，建议使用小写字母和连字符。

## 权限控制

在 `rule` 中可以设置权限要求：

```javascript
rule: [
  {
    reg: '^#管理员命令$',
    fnc: 'adminCommand',
    permission: 'admin'  // owner/admin/master
  }
]
```

**权限级别:**
- `master`: 主人（最高权限）
- `admin`: 管理员
- `owner`: 群主

## 最佳实践

1. **命名规范**: 使用小写字母和连字符，如 `my-plugin.js`
2. **错误处理**: 所有异步操作都要有错误处理
3. **日志记录**: 使用 `logger` 记录重要操作
4. **工作流调用**: 优先使用 `callWorkflow` 而不是直接获取stream
5. **上下文管理**: 及时清理上下文，避免内存泄漏
6. **权限检查**: 敏感操作要检查权限

## 常见问题

**Q: 如何获取Bot实例？**
A: 在插件方法中，`this.e.bot` 或全局 `Bot` 对象可用。

**Q: 如何访问配置？**
A: 使用 `import cfg from '../../lib/config/config.js'` 导入配置。

**Q: 如何调用其他插件？**
A: 使用 `Bot.em()` 触发事件，或直接调用插件方法。

**Q: 工作流调用失败怎么办？**
A: 检查工作流名称是否正确，确保工作流已加载，查看日志获取详细错误信息。

## 相关文档

- [工作流基类文档](./WORKFLOW_BASE_CLASS.md)
- [HTTP API基类文档](./HTTP_API_BASE_CLASS.md)
- [项目基类总览](./BASE_CLASSES.md)

