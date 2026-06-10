---
name: xrk-base-layer
description: 开发或审计 XRK-Yunzai 底层基类、加载器、工厂与工具时使用；涉及 lib/ 基础设施、基类扩展、FileUtils/ObjectUtils、constructor/类字段约定时使用。
---

# XRK-Yunzai 底层基类规范

> 短契约：`docs/base-classes.md`（对齐 XRK-AGT 契约风格，路径改为 Yunzai 的 `lib/` + `plugins/`）。

## 分层

| 层级 | 路径 | 职责 |
|------|------|------|
| 入口 | `app.js` → `lib/bot.js` | 启动、HTTP/WS、调度 Loader |
| 加载器 | `lib/*/loader.js` | 扫描 `plugins/<插件根>/` 子目录 |
| 基类 | `lib/plugins/plugin.js` 等 | 业务扩展点 |
| 工厂 | `lib/factory/BaseFactory.js` | LLM/ASR/TTS |
| 工具 | `lib/utils/` | FileUtils、ObjectUtils、HotReloadBase |

**业务只改 `plugins/`；改 `lib/` 仅限基类、加载器、工具。**

## 基类与加载器

| 扩展点 | 基类 | 加载器 | 扫描目录 |
|--------|------|--------|----------|
| 插件 | `lib/plugins/plugin.js` | `lib/plugins/loader.js` | `plugins/**`（约定入口） |
| HTTP | `lib/http/http.js` | `lib/http/loader.js` | `plugins/<名>/http/*.js` |
| 工作流 | `lib/aistream/aistream.js` | `lib/aistream/loader.js` | `plugins/<名>/stream/` 或 `streams/` |
| 事件 | `lib/listener/listener.js` | `lib/listener/loader.js` | `plugins/<名>/events/` |
| 配置 | `lib/commonconfig/commonconfig.js` | `lib/commonconfig/loader.js` | `plugins/system-plugin/commonconfig/` |
| 渲染器 | `lib/renderer/Renderer.js` | `lib/renderer/loader.js` | `renderers/`、`plugins/*/renderer/` |

## 多元统一契约

各基类职责不同，统一遵守：

1. `constructor(options = {})` + `super({ name, ... })`
2. 必填 `name`；可选 `priority`（插件/工作流越小越优先，HTTP 越大越优先）
3. **类字段**存 `Map`/`Set`/缓存；**constructor 不 new 可变容器**
4. JSDoc 标明基类路径与业务放码目录
5. 资源释放：`destroy()`（插件）/ `cleanup()`（工作流）

### plugin

```javascript
import plugin from '../../lib/plugins/plugin.js';
export default class X extends plugin {
  watchers = new Map();  // 类字段，非 constructor
  constructor() {
    super({ name: 'x', event: 'message', rule: [{ reg: '^#', fnc: 'run' }] });
  }
  async destroy() { /* 关闭 watcher */ }
}
```

- 全局 `Bot`、`segment`；工作流：`callWorkflow` > `getStream().execute`
- 米游：`e.runtime.getMysApi`（`lib/plugins/runtime.js`）

### HttpApi

对象导出优先；`routes[].handler(req, res, Bot)`。

### AIStream

- `init()` 中 `registerMCPTool` / `registerFunction`，不在 constructor
- `callAI` → `{ text, usedReplyTool } | null`
- LLM 配置字段合并：`docs/CONFIG_PRIORITY.md`

### ConfigBase

`filePath` 用 `getServerConfigPath(port, name)`；schema 构造期严格校验。

### EventListener

Yunzai 保留 `EventListener`（`event`/`prefix`/`once` → `PluginsLoader.deal`），**非** AGT 的 `EventListenerBase + init()` 模式。

## 工具入口

```javascript
import { FileUtils, ObjectUtils, FileLoader, PluginDirScanner, HotReloadBase, tryParseJson } from '../../lib/utils/index.js';
import { getServerConfigPath } from '../../lib/config/config-constants.js';
import BotUtil from '../../lib/util.js';
```

| 工具 | 用途 |
|------|------|
| `PluginDirScanner` | 统一扫描 `plugins/<名>/<subdir>/`、`listJsFiles`、`listStreamDirs`、`listRendererEntries`、`getSharedSubdir('adapter')` |
| `FileUtils.toImportUrl` | 跨平台 dynamic import（**绝对路径** + 可选 cacheBust） |
| `FileUtils.statSync` / `readFileBuffer` / `chmod` / `createWriteStream` | stat、证书/二进制读、权限、下载流 |
| `tryParseJson` | SSE/NDJSON/MCP stdout 安全解析，失败返回 `null` |
| `ObjectUtils.shallowMergePlain` | 浅合并 headers/extraBody/proxy 等 |
| `ObjectUtils.deepMergeImmutable` | 不可变深度合并（ConfigBase 等） |
| `FileLoader.readFiles` | 目录 .js 过滤（支持 `exclude`） |

`lib/` 基础设施经 `FileUtils` 访问 fs；**plugins 禁止直连 fs**。

## Loader 模式

1. 类字段存放 watcher / Map（基类与 loader 实例均同）
2. 插件子目录扫描：**统一** `PluginDirScanner.listSubdirPaths('http'|'stream'|...)`
3. 动态导入：`FileUtils.toImportUrl(absPath)`
4. 热重载：`HotReloadBase.createWatcher(...)` 或 `HotReloadBase.watchModuleDirs(...)`（Api/Stream/Config）；debounce、hashStore 去重

## 审计清单

1. plugins 是否直连 `fs.*Sync` 或重复实现工具
2. constructor 是否误建 `Map`/缓存
3. 新基类 JSDoc、扫描路径是否与 loader 一致
4. 工厂是否继承 `BaseFactory`
5. 空 catch 是否 `BotUtil.makeLog`
6. 文档/skills 与代码一致（**以代码为准**）

## 参考

- 短契约：`docs/base-classes.md`
- 详述：`docs/BASE_CLASSES.md`、`docs/PLUGIN_BASE_CLASS.md` 等
- 规则：`.cursor/rules/xrk-dev-requirements.mdc`、`xrk-yunzai-core.mdc`
