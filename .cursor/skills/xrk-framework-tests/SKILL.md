---
name: xrk-framework-tests
description: 运行或维护 XRK-Yunzai 框架基准测试、配置三件套、system-plugin 模块数量断言。增删内置 HTTP/stream/plugin 时使用。
---

# 框架参数测试

## 权威入口

- `docs/框架测试指南.md`
- `tests/helpers/system-plugin-baseline.mjs` — **标准值唯一维护处**
- `lib/config/config-constants.js` — 全局/端口配置列表

## 适用场景

- 增删 `plugins/system-plugin/http|stream|plugin|events|adapter` 下模块
- 修改 `GLOBAL_CONFIG_NAMES` / `PORT_CONFIG_NAMES`
- 发布前验证配置 yaml 与 `system.js` schema 对齐

## 执行步骤

1. 若改模块数量 → 更新 `SYSTEM_PLUGIN_BASELINE`
2. 若改配置分类 → 同步 `config-constants.js`、`system.js`、默认 yaml
3. 运行：
   ```bash
   pnpm test
   pnpm lint
   node scripts/validate-skills.mjs
   ```

## 测试文件

| 文件 | 断言 |
|------|------|
| `config-alignment.test.mjs` | 默认 yaml + system schema + 无 asr/tts yaml |
| `config-constants.test.mjs` | 工厂后缀、路径解析 |
| `module-inventory.test.mjs` | system-plugin 五类目录数量、无 stream/device |
| `plugin-dir-scanner.test.mjs` | 仅扫 `stream/` |
| `lib-conventions.test.mjs` | `lib/` 无 fs 直连、无 ASR/TTS、关闭链与类字段约定 |
| `doc-consistency.test.mjs` | 关键文档无 streams/ASR/TTS 残留 |

## 常见陷阱

- 全仓库插件/工作流总数**不是**基准线；仅 **system-plugin 内置**计入
- LLM `*_llm.yaml` 不列入 GLOBAL/PORT 三件套
- 改基准后须同步 `SYSTEM-PLUGIN.md`、`docs/文档审查清单.md`
