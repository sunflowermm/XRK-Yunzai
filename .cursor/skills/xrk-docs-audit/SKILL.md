---
name: xrk-docs-audit
description: 审计 XRK-Yunzai 文档与代码一致性、清理 ASR/TTS/streams 等过时表述。大版本精简或改模块数量后使用。
---

# 文档审计

## 权威入口

- `docs/文档审查清单.md`
- `tests/framework/doc-consistency.test.mjs` — 可自动化部分

## 适用场景

- 底层精简、删除模块后的文档同步
- 新 AI/开发者 onboarding 前检查
- 与 XRK-AGT 文档对照（路径不同、方法论可对齐）

## 执行步骤

1. `pnpm test`（含 doc-consistency）
2. 全文 grep：`streams/`、`ASR`、`TTS`、`stream/device`、`volcengine_asr`、`asr_interim`
3. 核对 `SYSTEM_PLUGIN_BASELINE` 与 `SYSTEM-PLUGIN.md` 数字
4. 更新 `docs/README.md`、`.cursor/skills/SKILL_INDEX.md`
5. `node scripts/validate-skills.mjs`

## 文档层级

| 层级 | 文件 |
|------|------|
| 写法 | `docs/coding-style.md`、`docs/runtime-surface.md` |
| 契约 | `docs/base-classes.md` |
| 质量 | `docs/框架测试指南.md`、`docs/文档审查清单.md` |

## 已废弃（不得再写回文档）

- `streams/` 工作流目录
- `stream/device.js` 语音工作流
- ASR/TTS 工厂与 volcengine_asr/tts 配置
- 设备 WS 的 asr/play_tts 下行

## 常见陷阱

- `http/device.js` **保留**（Event 设备 API），与已删 `stream/device.js` 不同
- README 中「Device 工作流」若指场景而非文件，应明确为 `chat` + 设备 HTTP
- CHANGELOG 历史条目可保留，新文档勿复述已移除能力
