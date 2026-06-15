# XRK-Yunzai AI 开发指引

## 项目概览

XRK-Yunzai 是基于 Node.js 24+ 的多平台 Agent 机器人框架：Bot、插件系统、AIStream 工作流、HTTP/WebSocket API。业务在 `plugins/`，基础设施在 `lib/`。

## 开发规范（首读）

| 文档 | 用途 |
|------|------|
| [docs/coding-style.md](docs/coding-style.md) | **写法速查**（对齐 XRK-AGT 方法论） |
| [docs/runtime-surface.md](docs/runtime-surface.md) | Bot / segment / cfg 挂载面 |
| [docs/base-classes.md](docs/base-classes.md) | 基类短契约 |

- **工具**：`FileUtils`、`ObjectUtils`、`getServerConfigPath`
- **路径**：`data/server_bots/<port>/`、`config/default_config/`
- **工作流**：仅 `plugins/<名>/stream/`（不扫 `streams/`）

## 验证

```bash
pnpm lint
pnpm test
node scripts/validate-skills.mjs
```

详见 [docs/框架测试指南.md](docs/框架测试指南.md)。

## 文档

- [docs/BASE_CLASSES.md](docs/BASE_CLASSES.md) — 基类详述
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构
- [docs/文档审查清单.md](docs/文档审查清单.md) — 发布前文档审计
- [plugins/system-plugin/SYSTEM-PLUGIN.md](plugins/system-plugin/SYSTEM-PLUGIN.md) — 内置插件

## Cursor 配置

- `.cursor/rules/` — `xrk-yunzai-core`、`xrk-dev-requirements` 等
- `.cursor/skills/` — 技能索引 [SKILL_INDEX.md](.cursor/skills/SKILL_INDEX.md)

## 与 XRK-AGT

借鉴：配置三件套测试、模块基准、`coding-style` 速查、skill 索引。  
勿照搬：`core/`、`src/infrastructure/`、Node 26 专项 API、Tasker 层路径。
