<h1 align="center">插件基类开发文档</h1>

<div align="center">

![Plugin Base](https://img.shields.io/badge/Plugin%20Base-Class-blue?style=flat-square)
![Status](https://img.shields.io/badge/Status-Stable-success?style=flat-square)
![Version](https://img.shields.io/badge/Version-3.1.3-informational?style=flat-square)

</div>

## 📖 概述

> 🔌 `Plugin` 是所有插件的基类，提供工作流集成、上下文管理、消息回复等功能。所有插件都应继承此类。

**📁 文件路径**: `lib/plugins/plugin.js`

## 🏗️ 类结构

> 💡 **提示**: 所有插件都应继承 `plugin` 基类，并实现相应的处理函数。基础示例见下方"完整示例"部分。

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
    reg: '^#测试$',           // 正则表达式匹配（字符串或RegExp对象）
    fnc: 'test',              // 处理函数名（必填）
    permission: 'master',     // 权限要求（可选）：'master'/'admin'/'owner'
    log: false,               // 是否记录日志（可选，默认true）
    event: 'message',        // 事件类型（可选，默认使用插件的event）
    describe: '测试命令'      // 规则描述（可选，用于文档）
  }
]
```

**Rule 对象字段说明：**

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `reg` | `string\|RegExp` | 否 | - | 正则表达式，用于匹配消息内容。字符串会自动转换为RegExp。如果未提供，规则将匹配所有消息（需配合其他条件使用） |
| `fnc` | `string` | **是** | - | 处理函数名，对应插件类中的方法名。该函数必须存在于插件类中 |
| `permission` | `string` | 否 | - | 权限要求：`'master'`（主人）、`'admin'`（管理员）、`'owner'`（群主）。如果权限不足，规则不会执行 |
| `log` | `boolean` | 否 | `true` | 是否记录日志。设为 `false` 可禁用该规则的日志输出，适用于高频触发但不需要详细日志的场景 |
| `event` | `string` | 否 | 插件的 `event` | 事件类型，覆盖插件的默认事件类型。支持：`'message'`、`'notice'`、`'request'`、`'device'` 等 |
| `describe` | `string` | 否 | - | 规则描述，用于文档和调试。不会影响功能，仅用于说明规则用途 |

**匹配顺序**：事件类型（`event`）→ 正则（`reg`）→ 权限（`permission`）→ 执行 `fnc`。返回 `false` 继续下一条规则，其他值或异常则结束/记录错误。

## 插件特性

### 1. 工作流集成

插件基类提供了完整的工作流集成能力，支持：
- 获取单个工作流实例
- 获取所有工作流
- 调用单个工作流
- 并行调用多个工作流
- 串行调用多个工作流
- 直接执行工作流（简化调用）

### 2. 上下文管理

插件基类提供了强大的上下文管理功能，支持：
- 设置上下文（带超时）
- 获取上下文
- 结束上下文
- 等待上下文（Promise方式）
- 解析上下文

上下文系统使用插件名称、Bot ID 和目标ID（群ID或用户ID）作为键，支持多插件、多Bot、多群/用户的隔离。

### 3. 消息回复

插件基类提供了统一的消息回复接口：
- 自动选择群聊或私聊渠道
- 支持引用回复
- 支持@用户
- 支持自动撤回
- 错误处理和降级

### 4. 规则匹配系统

插件使用规则数组（`rule`）定义匹配条件：
- 支持正则表达式匹配
- 支持事件类型过滤
- 支持权限检查
- 支持日志控制
- 支持自定义描述

### 5. 扩展插件支持

插件可以注册为扩展插件（通过 `handler` 和 `namespace` 参数），扩展插件：
- 不进行常规的规则匹配
- 直接执行处理函数
- 适用于需要特殊处理逻辑的场景

### 6. 节流控制

插件可以设置 `bypassThrottle: true` 来绕过节流限制，适用于：
- 系统级插件
- 高优先级插件
- 需要实时响应的场景

## 核心方法

完整签名与用法见 [reference/PLUGINS.md](./reference/PLUGINS.md)。摘要如下：

| 分类 | 方法 | 说明 |
|------|------|------|
| 工作流 | `getStream(name)` | 获取工作流实例 |
| | `getAllStreams()` | 返回 `Map<name, AIStream>` |
| | `callWorkflow(name, params, context)` | 调用单个工作流 |
| | `callWorkflows(workflows, sharedParams, context)` | 并行多工作流 |
| | `callWorkflowsSequential(...)` | 串行多工作流 |
| | `executeWorkflow(streamName, question, config)` | 简化执行，返回文本 |
| 回复 | `reply(msg, quote?, data?)` | 回复消息，支持引用、at、recall |
| 上下文 | `setContext(type, isGroup?, time?, timeout?)` | 设置多轮上下文 |
| | `getContext(type?, isGroup?)` / `finish(type, isGroup?)` | 获取/结束上下文 |
| | `awaitContext(...)` / `resolveContext(context)` | Promise 等待与解析 |

其他：`markNeedReparse()` 标记重解析；`renderImg(plugin, tpl, data, cfg)` 渲染图片。详见 [PLUGINS.md](./reference/PLUGINS.md)。

## 完整示例

> **注意**: 以下示例中，假设已通过 `import plugin from '../../lib/plugins/plugin.js'` 导入插件基类。

### 示例1: 基础插件

```javascript
export default class MyPlugin extends plugin {
  constructor() {
    super({
      name: 'my-plugin',
      dsc: '我的插件',
      event: 'message',
      priority: 5000,
      rule: [{ reg: '^#测试$', fnc: 'test' }]
    });
  }

  async test(e) {
    return this.reply('测试成功');
  }
}
```

### 示例2: 工作流

`async aiChat(e) { const q = e.msg.replace(/^#AI\s+/, ''); const r = await this.callWorkflow('chat', { question: q }, { e }); return this.reply(r?.content || r); }`

### 示例3: 多工作流

并行：`await this.callWorkflows(['chat', { name: 'file', params: { question: '...' } }], {}, { e });`，将返回数组合并后 `reply` 即可。

### 示例4: 上下文管理

```javascript
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

> **注意**: 插件存放路径说明见 [工作流基类文档](./WORKFLOW_BASE_CLASS.md) 中的"工作流存放路径"部分（插件文件存放在 `plugins/` 目录下）。

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
- [工厂模式文档](./FACTORY.md) - LLM提供商管理
- [配置优先级文档](./CONFIG_PRIORITY.md) - 配置优先级说明

