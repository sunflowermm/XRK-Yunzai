---
name: xrk-project-overview
description: 需要从整体理解 XRK-Yunzai 的架构、目录、运行流程和技术栈时使用。
---

# XRK-Yunzai 项目概览

## 权威入口

- **写法**：`docs/coding-style.md` · **挂载**：`docs/runtime-surface.md`
- **架构**：`docs/ARCHITECTURE.md` · **技术栈**：`docs/TECH_STACK.md`
- **基类短契约**：`docs/base-classes.md`
- **内置插件**：`plugins/system-plugin/SYSTEM-PLUGIN.md`
- **技能索引**：`.cursor/skills/SKILL_INDEX.md`

## 适用场景

- 定位功能在哪个 Loader / 基类 / 目录
- 与 XRK-AGT 对照时确认路径差异

## 分层

- **业务**：`plugins/<插件名>/`（`plugin/`、`http/`、`stream/`、`events/`、`commonconfig/`、`adapter/`、`www/`）
- **基础设施**：`lib/`（基类、Loader、工具、LLM 工厂）
- **入口**：`app.js` → `lib/bot.js`

## 扩展点速查

| 类型 | 基类 | 业务目录 |
|------|------|----------|
| 插件 | `lib/plugins/plugin.js` | `plugins/<名>/plugin/` 或插件根入口 |
| 工作流 | `lib/aistream/aistream.js` | `plugins/<名>/stream/` |
| HTTP | `lib/http/http.js` | `plugins/<名>/http/` |
| 配置 | `lib/commonconfig/commonconfig.js` | `plugins/system-plugin/commonconfig/` |

## 验证

```bash
pnpm lint && pnpm test && node scripts/validate-skills.mjs
```

## 与 XRK-AGT 差异（勿照搬路径）

| 项 | XRK-AGT | XRK-Yunzai |
|----|---------|------------|
| 基础设施 | `src/infrastructure/` | `lib/` |
| 业务 | `core/<Core>/` | `plugins/<名>/` |
| 文件工具 | BotUtil + FileLoader | **FileUtils**（业务必用） |
| 事件监听 | EventListenerBase + init() | EventListener + deal() |
| 工厂 | LLM + 历史 ASR/TTS | **仅 LLM** |
| Node | ≥26 专项 API | ≥24 |
| 长期 Roadmap | [XRK-AGT](https://github.com/sunflowermm/XRK-AGT) | 稳定 Bot / 工作流运行时 |
| 测试 | `pnpm test` 框架基准 | 同方法论，`tests/framework/` |

## 回答方式

- 「功能在哪」：入口 → Loader → 基类 → plugins 路径
- 「代码放哪」：按扩展点目录 + 继承对应基类 + `docs/coding-style.md`
