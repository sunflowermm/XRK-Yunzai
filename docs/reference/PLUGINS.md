# 插件运行时手册 (`lib/plugins/plugin.js`)

> 插件为目录，入口如 `plugins/<插件名>/index.js`，类 `extends plugin` 即可获得以下方法。

---

## 1. 构造函数

| 参数 | 说明 |
|------|------|
| `constructor({ name?, dsc?, event?, priority?, task?, rule?, bypassThrottle?, handler?, namespace? })` | 保存配置并暴露给 PluginsLoader |
| `name` | 插件名，默认 `"your-plugin"` |
| `event` | 监听类型：message/notice 等 |
| `priority` | 规则优先级，数值越低越高 |
| `rule` | `{ reg, fnc, log?, permission?, describe? }[]` |
| `task` | `{ name, fnc, cron }` 定时任务 |
| `handler` | 若提供则作为自定义入口（适配器式） |

## 2. 工作流调用

| 方法 | 说明 |
|------|------|
| `getStream(name)` | 从 StreamLoader 取工作流实例 |
| `getAllStreams()` | 返回所有工作流 Map |
| `getWorkflowManager()` | 全局 WorkflowManager 单例，首次调用时注册所有工作流 |
| `callWorkflow(name, params?, context?)` | 调单个工作流，context 默认带 this.e |
| `callWorkflows(workflows, sharedParams?, context?)` | 并行（WorkflowManager.runMultiple） |
| `callWorkflowsSequential(...)` | 顺序执行 |
| `executeWorkflow(streamName, question, config?)` | 直接调 AIStream，绕过 WorkflowManager |

## 3. 消息与回复

| 方法 | 说明 |
|------|------|
| `reply(msg?, quote?, data?)` | 调用 this.e.reply（群→好友），msg 空则返回 false |
| `markNeedReparse()` | 设 this.e._needReparse = true |

## 4. 上下文管理

按 `name + self_id + target_id` 区分 stateArr，用于多轮对话：

| 方法 | 说明 |
|------|------|
| `conKey(isGroup?)` | 生成 key：`<plugin>.<bot_id>.<group_id|user_id>` |
| `setContext(type, isGroup?, time?, timeoutMsg?)` | 存入 stateArr，设超时清理与提醒 |
| `getContext(type?, isGroup?)` | 读取；type 为空返回整 key 数据 |
| `finish(type?, isGroup?)` | 清理上下文，resolve 等待者 |
| `awaitContext(...args)` | 返回 Promise，直到 resolveContext 或超时 |
| `resolveContext(context)` | 恢复 awaitContext 等待者并传入 this.e |

## 5. 渲染

| 方法 | 说明 |
|------|------|
| `renderImg(pluginName, tpl, data, cfg?)` | 调用 #miao 模板渲染（若存在），自动传 this.e |

## 6. 约定字段

- `this.e`：当前事件，由 PluginsLoader 注入。
- `this.rule`：规则数组，fnc 对应类方法名。
- `this.priority`：数值越低越先执行；系统插件通常 <1000。
- `this.bypassThrottle`：true 时跳过消息节流。

相关：[HTTP.md](./HTTP.md)、[WORKFLOWS.md](./WORKFLOWS.md)。
