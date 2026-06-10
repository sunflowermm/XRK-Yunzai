# XRK-Yunzai AI 开发指引

## 项目概览

XRK-Yunzai 是基于 Node.js 24+ 的机器人框架，采用事件驱动、模块化架构。核心：Bot、插件系统、AIStream 工作流、HTTP/WebSocket API。

## 开发规范

- **工具**：`FileUtils`、`ObjectUtils`、`config-constants`，禁止重复实现
- **路径**：`getServerConfigPath(port, name)`、`cfg.PATHS`、`BASE_DIRS`
- **配置**：`config/default_config/` 默认，`data/server_bots/<port>/` 端口级

## 文档

- [docs/base-classes.md](docs/base-classes.md) - **基类短契约**（开发首选）
- [docs/BASE_CLASSES.md](docs/BASE_CLASSES.md) - 基类详述与关系图
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - 架构
- [docs/PLUGIN_BASE_CLASS.md](docs/PLUGIN_BASE_CLASS.md) - 插件基类详述
- [docs/WORKFLOW_BASE_CLASS.md](docs/WORKFLOW_BASE_CLASS.md) - 工作流详述

## Cursor 配置

- `.cursor/rules/` - 编码规则（`xrk-yunzai-core`、`xrk-dev-requirements`、插件、CommonConfig）
- `.cursor/skills/` - 技能（**唯一维护目录**；勿复制 `.claude`/`.trae`）
