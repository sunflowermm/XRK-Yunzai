# XRK-Yunzai Skills 索引

**唯一维护目录**：`.cursor/skills/`（勿复制到 `.claude/`、`.trae/`）。

每个 skill：`SKILL.md` 含 YAML `name`（与目录名一致）、`description`（触发场景）。

校验：`node scripts/validate-skills.mjs`

---

## 框架技能

| Skill | 何时使用 |
|-------|----------|
| [xrk-project-overview](xrk-project-overview/SKILL.md) | 架构、目录、与 XRK-AGT 差异 |
| [xrk-coding-style](xrk-coding-style/SKILL.md) | 写法规范、Code review |
| [xrk-base-layer](xrk-base-layer/SKILL.md) | lib/ 基类、Loader、工厂、审计 |
| [xrk-plugin-development](xrk-plugin-development/SKILL.md) | plugins/ 消息插件 |
| [xrk-workflow-stream](xrk-workflow-stream/SKILL.md) | stream/ 工作流、MCP、LLM |
| [xrk-http-api](xrk-http-api/SKILL.md) | http/ API、WebSocket |
| [xrk-config-commonconfig](xrk-config-commonconfig/SKILL.md) | CommonConfig schema |
| [xrk-framework-tests](xrk-framework-tests/SKILL.md) | 框架基准测试、配置三件套 |
| [xrk-docs-audit](xrk-docs-audit/SKILL.md) | 文档与代码一致性审计 |

## 权威文档（skills 指向）

| 文档 | 用途 |
|------|------|
| `docs/coding-style.md` | 写法速查 |
| `docs/runtime-surface.md` | Bot/segment/cfg 挂载 |
| `docs/base-classes.md` | 基类短契约 |
| `docs/框架测试指南.md` | 测试命令与基准 |
| `docs/文档审查清单.md` | 发布前文档检查 |

## 规则（非 skill）

- `.cursor/rules/xrk-yunzai-core.mdc`
- `.cursor/rules/xrk-dev-requirements.mdc`
- `.cursor/rules/karpathy-guidelines.mdc`

冲突时**以代码与 `pnpm test` 为准**。
