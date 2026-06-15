---
name: xrk-coding-style
description: 编写或审查 lib/plugins 代码时的写法规范（全局裸名、FileUtils、类字段、stream/ 目录、HTTP handler）。改业务或底层前必读。
---

# XRK-Yunzai 编码风格

## 权威入口

- **主文档**：`docs/coding-style.md`（速查表 + 分节）
- **挂载面**：`docs/runtime-surface.md`
- **短契约**：`docs/base-classes.md`
- **规则**：`.cursor/rules/xrk-dev-requirements.mdc`、`xrk-yunzai-core.mdc`

## 适用场景

- 新增/修改 `plugins/` 或 `lib/` 代码
- Code review 对照项目约定
- 与 XRK-AGT 对照时**只借鉴方法论**，路径用 Yunzai 的 `plugins/` + `lib/`

## 非适用场景

- Node 26 专项 API（AGT 的 `Error.isError` 等）— Yunzai 为 Node 24+
- `core/`、`#infrastructure` 别名 — AGT 专用

## 30 秒记忆

1. 业务 **`plugins/<名>/`**，基础设施 **`lib/`**
2. 裸名 **`Bot`** / **`segment`**；HTTP 用注入的 **`Bot`**
3. **类字段**存 Map/缓存；constructor 只 `super()` + 固定配置
4. 文件 **`FileUtils`**；配置 **`getServerConfigPath`**
5. 工作流**仅** `stream/`，不扫 `streams/`

## 审查

改代码前：`pnpm test` + 对照 `docs/coding-style.md` 文末清单。
