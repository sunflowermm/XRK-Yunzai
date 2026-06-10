# XRK-Yunzai Skills 说明

Cursor 技能文档，与 `.cursor/rules/` 配合使用。**唯一维护目录**；勿复制到 `.claude/`、`.trae/`。

## 结构

`.cursor/skills/<skill-name>/SKILL.md`，含 YAML frontmatter：`name`、`description`。

## 技能列表

| 技能名 | 说明 |
|--------|------|
| xrk-project-overview | 架构、目录、与 XRK-AGT 差异对照 |
| xrk-base-layer | 底层基类契约、Loader、工具、审计清单 |
| xrk-plugin-development | 插件：类字段、destroy、工作流调用 |
| xrk-workflow-stream | 工作流：stream/、MCP、LLM |
| xrk-http-api | HTTP API：对象导出、routes、ws |
| xrk-config-commonconfig | CommonConfig schema 与路径 |

编码行为准则见 `.cursor/rules/karpathy-guidelines.mdc`（无独立 skill）。

## 文档分层

| 层级 | 文件 | 用途 |
|------|------|------|
| 短契约 | `docs/base-classes.md` | 开发时首选，对齐 AGT 风格 |
| 详述 | `docs/*_BASE_CLASS.md` | 示例、FAQ、长表格 |
| 规则 | `.cursor/rules/xrk-dev-requirements.mdc` | constructor/全局/工具 |

冲突时**以代码为准**；内容使用**简体中文**。
