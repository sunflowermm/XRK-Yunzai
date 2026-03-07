# XRK-Yunzai AI 开发指引

## 项目概览

XRK-Yunzai 是基于 Node.js 24+ 的机器人框架，采用事件驱动、模块化架构。核心：Bot、插件系统、AIStream 工作流、HTTP/WebSocket API。

## 开发规范

- **工具**：`FileUtils`、`ObjectUtils`、`config-constants`，禁止重复实现
- **路径**：`getServerConfigPath(port, name)`、`cfg.PATHS`、`BASE_DIRS`
- **配置**：`config/default_config/` 默认，`data/server_bots/<port>/` 端口级

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - 架构
- [docs/CORE_OBJECTS.md](docs/CORE_OBJECTS.md) - 核心对象
- [docs/PLUGIN_BASE_CLASS.md](docs/PLUGIN_BASE_CLASS.md) - 插件基类
- [docs/WORKFLOW_BASE_CLASS.md](docs/WORKFLOW_BASE_CLASS.md) - 工作流

## Cursor 配置

- `.cursor/rules/` - 编码规则（核心、JS、插件、CommonConfig）
- `.cursor/skills/` - 技能（插件、HTTP API、工作流、配置）
