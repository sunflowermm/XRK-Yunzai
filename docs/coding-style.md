# 底层与插件写法规范

> **读者**：在 `lib/`、`plugins/` 写代码的开发者与 AI  
> **关联**：[runtime-surface.md](runtime-surface.md) · [base-classes.md](base-classes.md)  
> **规则副本**：`.cursor/rules/xrk-dev-requirements.mdc` · skill **`xrk-coding-style`**

**原则**：业务放 `plugins/`（**含内置 `system-plugin/`**）；基础设施放 `lib/`；能复用 `FileUtils` / `ObjectUtils` 就不在业务里再写一遍。

---

## 速查表

| 主题 | ✅ 要 | ❌ 不要 |
|------|--------|---------|
| 放码 | 业务 `plugins/<名>/`；内置底层 `plugins/system-plugin/`；基类/Loader `lib/` | 业务写进 `lib/` 应付需求 |
| 全局 | 裸名 `Bot`、`segment`、`cfg`（启动挂载）；`lib/` 可读 `import cfg` | `import Bot`；`global.Bot` / `global.cfg` |
| 基类 | `import plugin from '../../lib/plugins/plugin.js'` | 新代码依赖 `global.plugin` |
| 配置路径 | `getServerConfigPath(port, name)`（`config-constants.js`） | 手写 `data/server_bots/...` 字符串 |
| aistream（`lib/`） | `getAistreamConfigOptional()` | 散落 `cfg?.aistream` |
| MCP | `StreamLoader.mcpServer` | 已移除的全局 MCP 挂载 |
| 文件 I/O | `FileUtils`（含 `createReadStream` / `createWriteStream`） | 业务中 `fs.existsSync` / `import fs` |
| 对象工具 | `ObjectUtils` 类型判断、合并、克隆 | 重复实现 `isPlainObject` 等 |
| 状态 | **类字段** `cache = new Map()` 或 `init()` | constructor 里 `this.cache = new Map()` |
| 日志 | `Bot.makeLog(level, msg, tag[, trace])` | `BotUtil.makeLog`；业务中 `logger.*`；空 `catch {}` |
| 文件工具 | `BaseTools` + `path-guards` / `InputValidator`（对齐 AGT system-Core） | 业务直连 `fs`；无校验的 `run` |
| HTTP handler | `(req, res, Bot)`，对象导出 `{ name, routes }` | 在 handler 内 `import Bot` |
| 工作流目录 | **仅** `plugins/<名>/stream/` | `streams/`（Loader 不扫描） |
| 热重载 | `HotReloadBase` | 业务层直接 `chokidar` |
| 资源释放 | 插件 `destroy()`；工作流 `cleanup()` | watcher/定时器泄漏 |
| Loader 热重载 | `HotReloadBase.WATCH_DEBOUNCE_MS`；`watch(false)` 用 `closeWatcher`/`closeWatchers` | 各 Loader 手写 `debounceMs: 300` 或重复 close 逻辑 |

Node ≥ 24；与 XRK-AGT 的 Node 26 专项 API（`Error.isError`、`Map.getOrInsert` 等）**勿照搬**，以本仓库 ESLint 与运行环境为准。

---

## 1. 分层

| 层 | 路径 | 写什么 |
|----|------|--------|
| 业务 | `plugins/<插件名>/plugin|http|stream|events|commonconfig|adapter|www/` | 插件、API、工作流、配置 schema |
| 基础设施 | `lib/` | Bot、Loader、基类、工厂、工具 |
| 入口 | `app.js`、`lib/bot.js` | 启动、中间件、挂载 |
| 默认配置 | `config/default_config/*.yaml` | 模板；运行时在 `data/server_bots/` |

---

## 2. 全局与 import

```javascript
// 插件 / 事件 / 工作流
Bot.em('message', data);
segment.image(url);

// HTTP
export default {
  name: 'my-api',
  routes: [{ method: 'get', path: '/api/foo', handler: async (req, res, Bot) => { /* ... */ } }]
};

// 配置路径
import { getServerConfigPath } from '../../lib/config/config-constants.js';
const path = getServerConfigPath(port, 'bot');
```

| 对象 | 来源 |
|------|------|
| `Bot` | 启动与 `PluginsLoader` 挂载全局 |
| `segment` | 全局，勿从 oicq import |
| `cfg` | `lib/config/config.js` 单例；启动后裸名 `cfg` 或 `import cfg` |

---

## 3. 类、状态、热重载

```javascript
export default class Demo extends plugin {
  cooldown = new Map();

  constructor() {
    super({ name: 'demo', event: 'message', rule: [{ reg: /^#x$/, fnc: 'run' }] });
  }

  async init() {
    // 一次性初始化
  }

  async destroy() {
    // 关闭 watcher / 定时器
  }
}
```

插件 `priority`：**数字越小越先**；`rule[]` 内无独立 priority 字段。

---

## 4. 工作流（AIStream）

- 文件：`plugins/<名>/stream/*.js`
- `init()` 中 `registerMCPTool` / `registerFunction`，不在 constructor
- `callAI` 返回 `{ text, usedReplyTool } | null`
- LLM 配置合并见 [CONFIG_PRIORITY.md](CONFIG_PRIORITY.md)

---

## 5. 审查清单（改代码前）

- [ ] 业务是否误用 `fs.*Sync`
- [ ] constructor 是否 new 了 Map/缓存
- [ ] 工作流是否放在 `stream/` 而非 `streams/`
- [ ] HTTP 是否使用注入的 `Bot`
- [ ] 插件/工作流是否实现 `destroy()` / `cleanup()`
- [ ] 配置路径是否经 `getServerConfigPath` / `config-constants`

框架参数与文档一致性见 [框架测试指南.md](框架测试指南.md)、`pnpm test`。
