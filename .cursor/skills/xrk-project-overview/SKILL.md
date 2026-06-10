---
name: xrk-project-overview
description: 需要从整体理解 XRK-Yunzai 的架构、目录、运行流程和技术栈时使用。
---

# XRK-Yunzai 项目概览

## 权威文档

- 基类短契约：`docs/base-classes.md`（开发首选）
- 基类详述：`docs/BASE_CLASSES.md`
- 架构：`docs/ARCHITECTURE.md`；技术栈：`docs/TECH_STACK.md`

## 分层

- **业务**：`plugins/<插件名>/`（插件、`http/`、`stream/`、`events/`、`commonconfig/`、`www/`）
- **基础设施**：`lib/`（基类、Loader、工具、工厂）
- **入口**：`app.js` → `lib/bot.js`
- **适配器**：`plugins/system-plugin/adapter/` 等

## 扩展点速查

| 类型 | 基类 | 业务目录 |
|------|------|----------|
| 插件 | `lib/plugins/plugin.js` | `plugins/<名>/` |
| 工作流 | `lib/aistream/aistream.js` | `plugins/<名>/stream/` |
| HTTP | `lib/http/http.js` | `plugins/<名>/http/` |
| 配置 | `lib/commonconfig/commonconfig.js` | `plugins/system-plugin/commonconfig/` |

## 工具

- `FileUtils`、`ObjectUtils`、`getServerConfigPath`
- 编码约定：`.cursor/rules/xrk-dev-requirements.mdc`
- 底层规范：skill `xrk-base-layer`

## 与 XRK-AGT 差异（勿照搬路径）

| 项 | XRK-AGT | XRK-Yunzai |
|----|---------|------------|
| 基础设施 | `src/infrastructure/` | `lib/` |
| 业务 | `core/<Core>/` | `plugins/<名>/` |
| 文件工具 | BotUtil + FileLoader | **FileUtils**（业务必用） |
| 事件监听 | EventListenerBase + init() | EventListener + deal() |
| Node | ≥26 专项规则 | ≥24 |

## 回答方式

- 「功能在哪」：入口 → Loader → 基类 → plugins 路径
- 「代码放哪」：按扩展点目录 + 继承对应基类
