---
name: xrk-project-overview
description: 需要从整体理解 XRK-Yunzai 的架构、目录、运行流程和技术栈时使用。
---

# XRK-Yunzai 项目概览

## 权威文档

- 文档索引：`docs/README.md`
- 架构：`docs/ARCHITECTURE.md`
- 技术栈：`docs/TECH_STACK.md`
- 开发者导航：`docs/overview/DEVELOPER_HUB.md`（若存在）

## 项目细节

- **定位**：基于 QQ/OneBot 的 Bot 框架，事件驱动、模块化；业务在 `plugins/<插件名>/`，基础设施在 `lib/`。
- **核心层**：Bot 核心（HTTP/WS、插件系统 PluginsLoader、工作流 StreamLoader、路由 ApiLoader、配置 Cfg、Redis、日志）。
- **适配器层**：OneBotv11、Stdin、Device 等，实现位于 `plugins/system-plugin/adapter/` 或各插件 `adapter/`。
- **入口**：`app.js` → `start.js` / `debug.js` → `lib/bot.js`。

## 开发细节与放码位置

- **插件**：`plugins/<插件名>/`，继承 `lib/plugins/plugin.js`，由 PluginsLoader 扫描。
- **HTTP API**：`plugins/<插件名>/http/*.js`，导出 `routes` 或继承 `lib/http/http.js`，由 ApiLoader 加载。
- **工作流**：`plugins/<插件名>/stream/*.js` 或 `streams/*.js`，继承 `lib/aistream/aistream.js`，由 StreamLoader 加载。
- **CommonConfig**：`plugins/system-plugin/commonconfig/` 注册 configFiles 与 schema；路径与工具见 skill `xrk-config-commonconfig`。
- **工具与路径**：文件用 `FileUtils`，对象用 `ObjectUtils`，配置路径用 `getServerConfigPath`（`lib/config/config-constants.js`）。

## 回答方式

- 问「某功能在哪」：先按架构分层（入口 → 核心 → 适配器）和放码位置给出具体路径。
- 问「代码该放哪」：按插件/HTTP/工作流/CommonConfig 对应目录说明，并提醒使用 `lib/` 下基类与工具。
