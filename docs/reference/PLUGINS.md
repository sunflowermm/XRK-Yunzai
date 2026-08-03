# 插件运行时手册 (`lib/plugins/plugin.js`)

> 布局与 Yunzai 对照（`index.js` / system-plugin 无 index、`app.js`）：见 [VS_YUNZAI.md](../VS_YUNZAI.md)。  
> 兼容标记：见 [lib/plugins/README.md](../../lib/plugins/README.md)。

插件为 `plugins/<名>/` 目录；通常入口 `index.js`，类 `extends plugin`。

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
| `handler` / `namespace` | [compat] Handler 注册 |
| `bypassThrottle` | [ext] true 时跳过消息节流 |

## 2. 工作流调用（[ext]）

| 方法 | 说明 |
|------|------|
| `getWorkflow(name)` | 从 AiWorkflowLoader 取工作流实例 |
| `getAllWorkflows()` | 返回所有工作流 Map |
| `getWorkflowManager()` | 全局 WorkflowManager 单例 |
| `callWorkflow(name, params?, context?)` | 调单个工作流，context 默认带 `this.e` |
| `callWorkflows(workflows, sharedParams?, context?)` | 并行 |
| `callWorkflowsSequential(...)` | 顺序执行 |
| `executeWorkflow(streamName, question, config?)` | 直接执行工作流 |

## 3. 消息与回复

| 方法 | 说明 |
|------|------|
| `reply(msg?, quote?, data?)` | 调用 `this.e.reply` |
| `markNeedReparse()` | 设 `this.e._needReparse = true` |

## 4. 上下文管理

按 `name + self_id + target_id` 区分 stateArr：

| 方法 | 说明 |
|------|------|
| `conKey(isGroup?)` | 生成 key |
| `setContext` / `getContext` / `finish` | 读写与清理 |
| `awaitContext` / `resolveContext` | Promise 式上下文 |

## 5. 渲染

| 方法 | 说明 |
|------|------|
| `renderImg(pluginName, tpl, data, cfg?)` | 调用 #miao 模板渲染（若存在） |

## 6. 约定字段

- `this.e`：当前事件，由 PluginsLoader 注入
- `this.rule`：规则数组，fnc 对应类方法名
- `this.priority`：数值越低越先执行
- `this.bypassThrottle`：[ext] 跳过节流

相关：[HTTP.md](./HTTP.md)、[WORKFLOWS.md](./WORKFLOWS.md)、[VS_YUNZAI.md](../VS_YUNZAI.md)。
