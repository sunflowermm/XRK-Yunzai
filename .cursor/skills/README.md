# XRK-Yunzai Skills 说明

本目录存放 Cursor 使用的技能文档（Skills），用于在开发与排障时快速定位约定与入口。

## 结构

- 每个技能一个文件夹：`.cursor/skills/<skill-name>/SKILL.md`。
- `SKILL.md` 需包含 YAML Frontmatter：`name`、`description`，其后为 Markdown 内容。

## 技能列表

| 技能名 | 说明 |
|--------|------|
| xrk-project-overview | 项目架构、目录、运行流程、技术栈与放码位置 |
| xrk-plugin-development | 插件开发：基类、规则、工作流调用、文件与配置 |
| xrk-workflow-stream | 工作流开发：stream/streams 目录、AIStream、注册与执行 |
| xrk-http-api | HTTP API 开发：routes、WebSocket、HttpApi、工具与路径 |
| xrk-config-commonconfig | CommonConfig schema 与配置路径、工具 |

## 约定

- 内容与规则统一使用**简体中文**。
- 涉及「在哪改/在哪配」须给出**具体文件路径与函数/字段**；文档与代码冲突时以**代码为准**。
