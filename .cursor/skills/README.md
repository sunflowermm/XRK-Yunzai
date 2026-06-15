# XRK-Yunzai Skills 说明

Cursor 技能文档，与 `.cursor/rules/` 配合使用。**唯一维护目录**；勿复制到 `.claude/`、`.trae/`。

完整索引：[SKILL_INDEX.md](./SKILL_INDEX.md)

## 结构

`.cursor/skills/<skill-name>/SKILL.md`，含 YAML frontmatter：`name`、`description`。

校验：`node scripts/validate-skills.mjs`

## 技能列表

| 技能名 | 说明 |
|--------|------|
| xrk-project-overview | 架构、目录、与 XRK-AGT 差异对照 |
| xrk-coding-style | 写法规范（对齐 AGT 方法论，Yunzai 路径） |
| xrk-base-layer | 底层基类契约、Loader、工具、审计清单 |
| xrk-plugin-development | 插件：类字段、destroy、工作流调用 |
| xrk-workflow-stream | 工作流：stream/、MCP、LLM |
| xrk-http-api | HTTP API：对象导出、routes、ws |
| xrk-config-commonconfig | CommonConfig schema 与路径 |
| xrk-framework-tests | 框架基准测试、配置三件套 |
| xrk-docs-audit | 文档与代码一致性审计 |

编码行为准则见 `.cursor/rules/karpathy-guidelines.mdc`（无独立 skill）。

## 文档分层

| 层级 | 文件 | 用途 |
|------|------|------|
| 写法 | `docs/coding-style.md`、`docs/runtime-surface.md` | 唯一写法与挂载面 |
| 短契约 | `docs/base-classes.md` | 开发时首选 |
| 详述 | `docs/*_BASE_CLASS.md` | 示例、FAQ |
| 质量 | `docs/框架测试指南.md`、`docs/文档审查清单.md` | 测试与文档审查 |
| 规则 | `.cursor/rules/xrk-dev-requirements.mdc` | constructor/全局/工具 |

冲突时**以代码与 `pnpm test` 为准**；内容使用**简体中文**。
