---
name: xrk-base-layer
description: 开发或审计 XRK-Yunzai 底层基类、加载器、工厂与工具时使用；涉及 lib/ 基础设施、基类扩展、FileUtils/ObjectUtils、constructor/类字段约定时使用。
---

# XRK-Yunzai 底层基类规范

## 权威入口

- **写法**：`docs/coding-style.md` · **挂载**：`docs/runtime-surface.md`
- **短契约**：`docs/base-classes.md` · **详述**：`docs/BASE_CLASSES.md`
- **测试**：`docs/框架测试指南.md` · skill `xrk-framework-tests`

## 适用场景

- 修改 `lib/` 加载器、基类、工厂、工具
- 审计 plugins 是否违反 FileUtils / 类字段约定

## 非适用场景

- 纯业务插件功能 → `xrk-plugin-development`
- AGT 的 `core/`、`#infrastructure` 路径 — **勿照搬**

## 分层

| 层级 | 路径 | 职责 |
|------|------|------|
| 入口 | `app.js` → `lib/bot.js` | 启动、HTTP/WS、调度 Loader |
| 加载器 | `lib/*/loader.js` | 扫描 `plugins/<插件根>/` 子目录 |
| 基类 | `lib/plugins/plugin.js` 等 | 业务扩展点 |
| 工厂 | `lib/factory/llm/LLMFactory.js` + `factory-registry.js` | LLM `providers[]` |
| aistream 读 | `getAistreamConfigOptional()`（`lib/utils/aistream-config.js`） | `lib/` 内 `cfg?.aistream` |
| 工具 | `lib/utils/` | FileUtils、ObjectUtils、HotReloadBase、**BaseTools**、path-guards、input-validator |

**业务只改 `plugins/`；改 `lib/` 仅限基类、加载器、工具。**

## 基类与加载器

| 扩展点 | 基类 | 加载器 | 扫描目录 |
|--------|------|--------|----------|
| 插件 | `lib/plugins/plugin.js` | `lib/plugins/loader.js` | `plugins/**` |
| HTTP | `lib/http/http.js` | `lib/http/loader.js` | `plugins/<名>/http/*.js` |
| 工作流 | `lib/aistream/aistream.js` | `lib/aistream/loader.js` | `plugins/<名>/stream/` |
| 事件 | `lib/listener/listener.js` | `lib/listener/loader.js` | `plugins/<名>/events/` |
| 配置 | `lib/commonconfig/commonconfig.js` | `lib/commonconfig/loader.js` | `plugins/system-plugin/commonconfig/` |
| 渲染器 | `lib/renderer/Renderer.js` | `lib/renderer/loader.js` | `renderers/`、`plugins/*/renderer/` |

## 统一契约

1. `constructor` + `super({ name, ... })`；**类字段**存 Map/缓存
2. `priority`：插件/工作流越小越先；HTTP 越大越先
3. 资源释放：`destroy()`（插件）/ `cleanup()`（工作流）
4. 全局裸名 `Bot`、`segment`；日志 `Bot.makeLog`；HTTP handler `(req, res, Bot)`
5. 业务禁止直连 `fs.*Sync`；用 `FileUtils`

## 工具入口

```javascript
import { FileUtils, ObjectUtils, FileLoader, PluginDirScanner, HotReloadBase, tryParseJson } from '../../lib/utils/index.js';
import { getServerConfigPath } from '../../lib/config/config-constants.js';
import BotUtil from '../../lib/util.js';
```

## 审计清单

1. plugins 是否直连 `fs.*Sync`
2. constructor 是否误建 `Map`/缓存
3. 工作流是否仅放在 `stream/`
4. 工厂是否仅 LLM（无 ASR/TTS）
5. 文档与 `pnpm test` 基准一致
6. Loader `watch(false)` 是否经 `HotReloadBase.closeWatcher(s)`；debounce 是否用 `WATCH_DEBOUNCE_MS`

## Loader 统一契约

| Loader | 单例导出 | 停止监视 | 资源释放 |
|--------|----------|----------|----------|
| ApiLoader | `http/loader.js` | `watch(false)` | — |
| StreamLoader | `aistream/loader.js` | `watch(false)` | `cleanupAll()` |
| ConfigLoader | `commonconfig/loader.js` | `watch(false)` | — |
| ListenerLoader | `listener/loader.js` | `watch(false)` | — |
| PluginsLoader | `plugins/loader.js` | `destroy()` | `destroy()` |

`Bot._shutdownLoaders()` 顺序：StreamLoader → PluginsLoader → Api/Config/Listener `watch(false)` → `cfg.destroy()`。

## 常见陷阱

- `PluginDirScanner.listStreamDirs()` **不**扫描 `streams/`
- `EventListener` 模式，非 AGT `EventListenerBase + init()`
- 增删 system-plugin 内置模块未更新 `tests/helpers/system-plugin-baseline.mjs`
- `Bot.closeServer()` 须经 `_shutdownLoaders()` 释放 Loader 与 `cfg`

## 参考

- skill `xrk-coding-style`、`xrk-docs-audit`
- 规则 `xrk-yunzai-core.mdc`、`xrk-dev-requirements.mdc`
