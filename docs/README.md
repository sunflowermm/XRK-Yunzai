# XRK-Yunzai 底层文档索引

本目录为框架底层与开发参考文档，与主 [README](../README.md)、[USER_GUIDE](../USER_GUIDE.md) 配合使用。

**文档结构约定**：根目录为概览与基类指南，`reference/` 为 API 与规范手册，`overview/` 为可视化导航。配置与工厂等专题独立成篇，与代码结构（如 `lib/commonconfig` 仅从插件加载、工作流仅从 `plugins/<名>/stream` 加载）保持一致。

---

## 文档一览

| 分类 | 文档 | 说明 |
|------|------|------|
| **概览** | [TECH_STACK.md](./TECH_STACK.md) | 技术栈、运行时、Web/Redis/工作流/插件、DevOps |
| **概览** | [ARCHITECTURE.md](./ARCHITECTURE.md) | 系统架构、核心对象、数据流与事件流、扩展点 |
| **概览** | [overview/DEVELOPER_HUB.md](./overview/DEVELOPER_HUB.md) | 开发者导航：对象关系图、文档地图、开发流程与扩展入口 |
| **核心对象** | [CORE_OBJECTS.md](./CORE_OBJECTS.md) | Bot / 事件 `e` / logger / cfg / segment / redis / BotUtil |
| **基类** | [BASE_CLASSES.md](./BASE_CLASSES.md) | 各基类索引与简要说明 |
| **基类** | [PLUGIN_BASE_CLASS.md](./PLUGIN_BASE_CLASS.md) | 插件基类开发（构造、rule、工作流、上下文） |
| **基类** | [WORKFLOW_BASE_CLASS.md](./WORKFLOW_BASE_CLASS.md) | 工作流基类 AIStream 开发 |
| **基类** | [HTTP_API_BASE_CLASS.md](./HTTP_API_BASE_CLASS.md) | HTTP/WS API 基类 |
| **基类** | [COMMONCONFIG_BASE.md](./COMMONCONFIG_BASE.md) | CommonConfig 配置基类与 schema |
| **配置** | [CONFIG_PRIORITY.md](./CONFIG_PRIORITY.md) | 配置优先级说明 |
| **工厂** | [FACTORY.md](./FACTORY.md) | LLM 工厂模式与提供商管理 |

### reference/（API 与规范）

| 文档 | 说明 |
|------|------|
| [reference/BOT.md](./reference/BOT.md) | Bot 生命周期、HTTP/代理、好友/群/消息、WS |
| [reference/PLUGINS.md](./reference/PLUGINS.md) | 插件运行时手册（工作流调用、上下文、渲染） |
| [reference/WORKFLOWS.md](./reference/WORKFLOWS.md) | AIStream、MemorySystem、WorkflowManager |
| [reference/HTTP.md](./reference/HTTP.md) | HttpApi、路由与 WS 注册 |
| [reference/CONFIG_AND_REDIS.md](./reference/CONFIG_AND_REDIS.md) | cfg API、Redis 初始化与事件 |
| [reference/LOGGER.md](./reference/LOGGER.md) | logger 方法与格式化 |
| [reference/ADAPTER_AND_ROUTING.md](./reference/ADAPTER_AND_ROUTING.md) | 适配器与路由、事件流、规范 |
| [reference/DEVICE.md](./reference/DEVICE.md) | 设备相关 API |

---

## 推荐阅读顺序

1. **快速了解**：主 [README](../README.md) → [TECH_STACK.md](./TECH_STACK.md) → [DEVELOPER_HUB.md](./overview/DEVELOPER_HUB.md)
2. **写插件**：[CORE_OBJECTS.md](./CORE_OBJECTS.md)（事件 `e`）→ [PLUGIN_BASE_CLASS.md](./PLUGIN_BASE_CLASS.md) 或 [reference/PLUGINS.md](./reference/PLUGINS.md)
3. **写工作流**：[WORKFLOW_BASE_CLASS.md](./WORKFLOW_BASE_CLASS.md) → [reference/WORKFLOWS.md](./reference/WORKFLOWS.md)
4. **扩展适配器**：[reference/ADAPTER_AND_ROUTING.md](./reference/ADAPTER_AND_ROUTING.md)，实现置于 `plugins/system-plugin/adapter/` 或任意插件 `adapter/`

---

## 插件文档

- **system-plugin**（内置系统插件）：[plugins/system-plugin/SYSTEM-PLUGIN.md](../plugins/system-plugin/SYSTEM-PLUGIN.md)
