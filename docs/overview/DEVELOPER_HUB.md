# XRK-Yunzai 开发者导航

> 目标：一眼看清核心对象、基类与参考文档位置。此页作为 README 与子文档之间的“索引页”。

---

## 1. 对象关系可视化

```mermaid
flowchart LR
    subgraph Runtime
        Bot(Bot 主类<br/>lib/bot.js)
        Event[事件 e<br/>plugins/loader]
        Logger(logger)
        Cfg(cfg)
        Redis(global.redis)
    end

    subgraph Plugins & Workflows
        PluginBase(plugin 基类<br/>lib/plugins/plugin.js)
        WorkflowBase(AIStream 基类<br/>lib/aistream/aistream.js)
        WorkflowManager
        MemorySystem
    end

    subgraph HTTP & Adapter
        HttpApi(HttpApi 基类<br/>lib/http/http.js)
        Adapter[Adapter (OneBot/设备)]
    end

    Bot -->|prepareEvent| Event
    Bot -->|Proxy| PluginBase
    Bot -->|callStream| WorkflowBase
    PluginBase -->|callWorkflow/executeWorkflow| WorkflowManager
    WorkflowManager --> WorkflowBase
    WorkflowBase --> MemorySystem
    HttpApi --> Bot
    Adapter --> Bot
    Runtime --> PluginBase
```

---

## 2. 文档地图

| 分类 | 文档 | 内容摘要 |
|------|------|----------|
| 核心对象 | [`docs/CORE_OBJECTS.md`](../CORE_OBJECTS.md) | `Bot` / 事件 `e` / `logger` / `cfg` / `segment` / `redis`。 |
| 技术架构 | [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) | 系统架构、核心对象作用、数据流、技术栈依赖关系。 |
| Bot API | [`docs/reference/BOT.md`](../reference/BOT.md) | 生命周期、HTTP/HTTPS/代理、好友/群、消息工具、WS。 |
| 工作流 | [`docs/reference/WORKFLOWS.md`](../reference/WORKFLOWS.md) | `AIStream` 全部方法、Embedding、MemorySystem、WorkflowManager。 |
| 插件基类 | [`docs/reference/PLUGINS.md`](../reference/PLUGINS.md) | 构造、规则、上下文管理、工作流调用、渲染。 |
| HTTP 基类 | [`docs/reference/HTTP.md`](../reference/HTTP.md) | REST/WS 注册、middleware、热重载。 |
| 配置/Redis | [`docs/reference/CONFIG_AND_REDIS.md`](../reference/CONFIG_AND_REDIS.md) | `cfg` getters、watcher、Redis 初始化/事件。 |
| Logger 完整手册 | [`docs/reference/LOGGER.md`](../reference/LOGGER.md) | `logger` 全部方法、颜色工具、格式化、计时器等。 |
| 适配器 & 路由 | [`docs/reference/ADAPTER_AND_ROUTING.md`](../reference/ADAPTER_AND_ROUTING.md) | 适配器与路由系统如何与Bot交互、完整方法列表。 |
| 技术栈 | [`docs/TECH_STACK.md`](../TECH_STACK.md) | Node 运行时、Web 服务、缓存、DevOps。 |

---

## 3. 开发流程指北

1. **扩展 Bot 行为**：在 `lib/bot.js` 添加方法后，同步更新 `docs/reference/BOT.md`，并确保 README 导航能跳转到最新章节。
2. **编写插件**：
   - 继承 `plugin`，配置 `rule` 与 `event`。
   - 如需 AI 能力，调用 `callWorkflow` 或 `executeWorkflow`。
   - 多轮对话：使用 `setContext / awaitContext / finish`。
3. **创建工作流**：
   - 继承 `AIStream`，实现 `buildSystemPrompt` 与 `buildChatContext`。
   - 通过 `registerFunction` 暴露插件可调用的指令。
   - 若需记忆或语义检索，开启 `embeddingConfig` 并使用 `MemorySystem`。
4. **暴露 HTTP/WS**：
   - 在 `plugins/api/` 新增 `HttpApi` 子类或对象。
   - 使用 `routes` 声明 REST，`ws` 注册长链接。
5. **配置与部署**：
   - 所有 YAML 修改建议通过 `cfg.setConfig` 写入，保留热加载。
   - Redis 连接及健康检查逻辑在 `lib/config/redis.js`，可根据环境扩展。

---

## 4. 常见扩展入口

- **Adapter**：`plugins/adapter/*`，参考 `OneBotv11.js` 将第三方协议注入 `Bot`。
- **渲染器**：`renderers/puppeteer`、`renderers/playwright`，可新增自定义渲染流程。
- **设备工作流**：`plugins/stream/device.js`，结合 `plugins/api/device.js` 与事件 `e.isDevice`。

---

> 如需进一步细化某一类函数，可在 `docs/reference/` 目录补充新文件，并在本导航中添加条目。***

