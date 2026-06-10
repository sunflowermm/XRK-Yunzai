# 项目基类文档

本文档介绍 XRK-Yunzai 项目中的所有基类及其使用方法。

> **开发首选短契约**：[base-classes.md](./base-classes.md)（对齐 XRK-AGT 契约风格，含 constructor/类字段约定）。本文档为详述与关系图。

## 目录

- [工作流基类 (AIStream)](#工作流基类-aistream)
- [插件基类 (Plugin)](#插件基类-plugin)
- [HTTP API基类 (HttpApi)](#http-api基类-httpapi)
- [事件监听基类 (EventListener)](#事件监听基类-eventlistener)
- [渲染器基类 (Renderer)](#渲染器基类-renderer)
- [Bot主类](#bot主类)

## 详细文档

每个基类都有独立的详细开发文档：

- [工作流基类开发文档](./WORKFLOW_BASE_CLASS.md) - 如何创建自定义工作流
- [插件基类开发文档](./PLUGIN_BASE_CLASS.md) - 如何创建插件
- [HTTP API基类开发文档](./HTTP_API_BASE_CLASS.md) - 如何创建API路由

---

## 工作流基类 (AIStream)

**路径**: `lib/aistream/aistream.js`

所有AI工作流的基类，提供统一的AI调用、记忆系统、功能管理等能力。

### 核心特性

- **记忆系统**: 自动场景隔离的记忆管理
- **功能注册**: AI可以在回复中使用注册的功能
- **推理调优**: 支持多轮推理和响应润色
- **参数优先级**: execute传入 > 构造函数 > aistream配置/LLM提供商配置 > 默认值

**使用**：继承 `AIStream`，在构造函数中 `super({ name, description, version?, ... })`，实现 `buildSystemPrompt(context)` 与 `buildChatContext(e, question)`。工作流放 `plugins/<插件根>/stream/*.js`。

### 详细文档

- [工作流基类开发文档](./WORKFLOW_BASE_CLASS.md)

---

## 插件基类 (Plugin)

**路径**: `lib/plugins/plugin.js`

所有插件的基类，提供工作流集成、上下文管理、消息回复等功能。

### 核心特性

- **工作流集成**: 可以直接调用工作流
- **上下文管理**: 支持状态管理和超时控制
- **消息回复**: 简化的消息回复接口

**工作流方法**：`getStream(name)`、`callWorkflow(name, params, context)`、`callWorkflows(workflows, sharedParams, context)`（并行）、`callWorkflowsSequential(...)`（串行）、`executeWorkflow(streamName, question, config)`。完整示例见 [PLUGINS.md](./reference/PLUGINS.md)、[PLUGIN_BASE_CLASS.md](./PLUGIN_BASE_CLASS.md)。

---

## HTTP API基类 (HttpApi)

**路径**: `lib/http/http.js`

所有HTTP API模块的基类，提供路由注册、WebSocket处理等功能。

### 核心特性

- **路由注册**: 支持多种HTTP方法
- **WebSocket支持**: 可以注册WebSocket处理器
- **中间件支持**: 支持自定义中间件

**使用**: 对象导出 `{ name, dsc, routes, ws?, middleware? }` 或继承 `HttpApi`，文件放 `plugins/<插件根>/http/`。详见 [HTTP_API_BASE_CLASS.md](./HTTP_API_BASE_CLASS.md)。

---

## 事件监听基类 (EventListener)

**路径**: `lib/listener/listener.js`

事件监听器的基类，统一经 `Bot.PluginsLoader` 走事件链。

### 核心特性

- **事件监听**: 监听指定的事件（`event`、`prefix`、`once`）
- **插件集成**: `execute(e)` 委托 `PluginsLoader.deal(e)`

**使用**: 继承 `EventListener`，文件放 `plugins/<插件根>/events/`。

---

## 工厂基类 (BaseFactory)

**路径**: `lib/factory/BaseFactory.js`

LLM / ASR / TTS 等工厂的提供商注册与创建基类。

### 核心特性

- **registerProvider**: 注册提供商工厂函数
- **createClient**: 子类实现，按 provider 创建客户端
- **createDeviceClient**: 设备级 ASR/TTS 等统一入口

**使用**: `LLMFactory`、`ASRFactory`、`TTSFactory` 均继承此类。

---

## 配置基类 (ConfigBase)

**路径**: `lib/commonconfig/commonconfig.js`

CommonConfig 配置文件读写与 schema 校验基类。

### 核心特性

- **read / write**: YAML/JSON 配置读写与缓存
- **schema**: 构造阶段严格校验默认值与类型

**使用**: CommonConfig 注册项继承或在 `plugins/system-plugin/commonconfig/` 定义 schema。

---

## 渲染器基类 (Renderer)

**路径**: `lib/renderer/Renderer.js`

图片渲染器的基类，用于将HTML模板渲染为图片。

### 核心特性

- **模板渲染**: 支持art-template模板
- **文件监听**: 自动监听模板文件变化
- **多渲染器支持**: 支持puppeteer和playwright

**使用**: 继承 `Renderer`，实现 `render(tpl, data)`，渲染器放 `renderers/`。

---

## Bot主类

**路径**: `lib/bot.js`

系统的核心类，负责HTTP服务器、WebSocket、插件管理、配置管理等。

### 核心特性

- **HTTP服务器**: Express应用和HTTP/HTTPS服务器
- **WebSocket支持**: WebSocket服务器和连接管理
- **插件管理**: 插件加载和执行
- **配置管理**: 配置加载和热重载
- **反向代理**: 支持多域名反向代理

**常用**：`Bot.run({ port })`、`Bot.sendFriendMsg`/`sendGroupMsg`/`sendMasterMsg`。完整 API 见 [BOT.md](./reference/BOT.md)。

### 路径

- **主类文件**: `lib/bot.js`
- **启动文件**: `app.js` -> `start.js`

---

## 基类关系图

```mermaid
graph TB
    subgraph Bot["🤖 Bot (主类)"]
        BotCore[核心控制器]
    end
    
    subgraph Loaders["📦 加载器层"]
        PluginLoader[PluginsLoader<br/>插件加载器]
        StreamLoader[StreamLoader<br/>工作流加载器]
        ApiLoader[ApiLoader<br/>API加载器]
        ListenerLoader[ListenerLoader<br/>监听器加载器]
        RendererLoader[RendererLoader<br/>渲染器加载器]
    end
    
    subgraph BaseClasses["🏗️ 基类层"]
        Plugin[Plugin<br/>插件基类]
        AIStream[AIStream<br/>工作流基类]
        HttpApi[HttpApi<br/>HTTP API基类]
        EventListener[EventListener<br/>事件监听基类]
        Renderer[Renderer<br/>渲染器基类]
    end
    
    subgraph Systems["⚙️ 子系统"]
        Memory[MemorySystem<br/>记忆系统]
        WorkflowMgr[WorkflowManager<br/>工作流管理器]
    end
    
    BotCore --> Loaders
    PluginLoader --> Plugin
    StreamLoader --> AIStream
    ApiLoader --> HttpApi
    ListenerLoader --> EventListener
    RendererLoader --> Renderer
    
    AIStream --> Memory
    AIStream --> WorkflowMgr
    Plugin --> AIStream
    
    style Bot fill:#4a90e2,stroke:#2c5aa0,color:#fff
    style Loaders fill:#50c878,stroke:#2d8659,color:#fff
    style BaseClasses fill:#feca57,stroke:#d68910,color:#000
    style Systems fill:#ff6b9d,stroke:#c44569,color:#fff
```

---

## 快速参考

| 基类 | 路径 | 用途 |
|------|------|------|
| AIStream | `lib/aistream/aistream.js` | AI工作流基类 |
| Plugin | `lib/plugins/plugin.js` | 插件基类 |
| HttpApi | `lib/http/http.js` | HTTP API基类 |
| EventListener | `lib/listener/listener.js` | 事件监听基类 |
| Renderer | `lib/renderer/Renderer.js` | 渲染器基类 |
| ConfigBase | `lib/commonconfig/commonconfig.js` | CommonConfig 配置基类 |
| BaseFactory | `lib/factory/BaseFactory.js` | 工厂基类（LLM/ASR/TTS） |
| HotReloadBase | `lib/utils/hot-reload-base.js` | 热重载监视基类 |
| Bot | `lib/bot.js` | Bot主类 |

---

## 相关文档

- [工作流基类开发文档](./WORKFLOW_BASE_CLASS.md)
- [工厂模式文档](./FACTORY.md) - LLM提供商管理
- [配置优先级文档](./CONFIG_PRIORITY.md) - 配置优先级说明
- [项目README](../README.md)

