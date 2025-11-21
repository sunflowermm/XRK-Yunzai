# 插件运行时手册 (`lib/plugins/plugin.js`)

> 任何插件文件（如 `plugins/example/*.js`）只需 `extends plugin` 即可获得以下方法。

---

## 1. 构造函数

### constructor(options = {})
- **签名**: `new plugin({ name?, dsc?, event?, priority?, task?, rule?, bypassThrottle?, handler?, namespace? })`
- **参数要点**:
  - `name`: 插件名称（默认 `"your-plugin"`）。
  - `event`: 监听事件类型（`message`/`notice` 等）。
  - `priority`: 规则匹配优先级，数值越低优先级越高。
  - `rule`: `{ reg, fnc, log?, permission?, describe? }` 数组。
  - `task`: 定时任务描述 `{ name, fnc, cron }`。
  - `handler`: 若提供则作为自定义入口（适配器式插件）。
- **作用**: 保存配置并暴露给 `PluginsLoader`。

---

## 2. 工作流调用

### getStream(name)
- **签名**: `(name: string) => AIStream | undefined`
- **作用**: 直接从 `StreamLoader` 获取指定工作流实例。

### getAllStreams()
- **签名**: `() => Map<string, AIStream>`
- **作用**: 返回所有已加载的工作流 Map。

### getWorkflowManager()
- **签名**: `() => WorkflowManager`
- **作用**: 返回全局单例；首次调用时会遍历所有工作流并注册到 `WorkflowManager`。

### callWorkflow(name, params = {}, context = {})
- **签名**: `async callWorkflow(name: string, params?: any, context?: { e?, question?, config? }): Promise<any>`
- **作用**: 调用单个工作流，context 默认带 `this.e`。

### callWorkflows(workflows, sharedParams = {}, context = {})
- **签名**: `async callWorkflows(Array<string|{ name, params? }>, sharedParams?, context?): Promise<any[]>`
- **作用**: 并行运行多个工作流（通过 `WorkflowManager.runMultiple`）。

### callWorkflowsSequential(workflows, sharedParams = {}, context = {})
- **作用**: 顺序执行多个工作流，适合管线场景。

### executeWorkflow(streamName, question, config = {})
- **签名**: `async executeWorkflow(streamName: string, question: any, config?: Partial<AIConfig>): Promise<any>`
- **作用**: 直接操作单个 `AIStream` 实例（绕过 `WorkflowManager`），常用于简单调用。

---

## 3. 消息 & 回复

### reply(msg = "", quote = false, data = {})
- **作用**: 调用 `this.e.reply`（优先群→好友），若 `msg` 为空返回 `false`。

### markNeedReparse()
- **作用**: 设置 `this.e._needReparse = true`，通知上层重新解析消息。

---

## 4. 上下文管理

插件运行时维护一个 `stateArr` 对象（按 `name + self_id + target_id` 区分）。以下函数用于多轮对话：

### conKey(isGroup = false)
- **作用**: 生成上下文 key：`<plugin>.<bot_id>.<group_id|user_id>`。

### setContext(type, isGroup = false, time = 120, timeoutMsg = "操作超时已取消")
- **签名**: `setContext(type: string, isGroup?: boolean, time?: number, timeout?: string): EventContext`
- **作用**: 将 `this.e` 存入 `stateArr[key][type]`，并设置超时自动清理与提醒。

### getContext(type, isGroup = false)
- **作用**: 读取上下文；`type` 为空时返回整个 key 下的数据。

### finish(type, isGroup = false)
- **作用**: 主动清理上下文，清除定时器并 resolve 等待者。

### awaitContext(...args)
- **签名**: `async awaitContext(...args): Promise<Event | false>`
- **作用**: 返回一个 Promise，直到 `resolveContext` 被调用或超时。

### resolveContext(context)
- **作用**: 恢复 `awaitContext` 等待者，并将 `this.e` 传给它。

---

## 5. 渲染能力

### renderImg(pluginName, tpl, data, cfg)
- **签名**: `async renderImg(pluginName: string, tpl: string, data: object, cfg?: object): Promise<Buffer|null>`
- **作用**: 调用 `#miao` 模板渲染（若依赖存在），并自动传入 `this.e`。

---

## 6. 约定字段

- `this.e`: 当前事件对象，由 `PluginsLoader` 注入。
- `this.rule`: 匹配规则数组，`fnc` 对应类方法名称。
- `this.priority`: 数值越低越先执行；系统插件通常 <1000。
- `this.bypassThrottle`: 设为 `true` 可跳过消息节流（比如管理命令）。

---

通过以上 API，插件作者可以方便地串联多工作流、实现多轮会话或调用渲染模板。如需与 HTTP/API 交互，请配合 `docs/reference/HTTP.md` 使用。***

