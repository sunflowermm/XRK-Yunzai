# 业务扩展基类契约

业务代码放在 `plugins/<插件名>/` 对应子目录；**必须**继承或符合下列基类/导出约定。

> **写法**：`docs/coding-style.md` · **挂载**：`docs/runtime-surface.md`  
> 详述见 `PLUGIN_BASE_CLASS.md` 等；本文档为**短契约**，与 skill `xrk-base-layer` 对齐。冲突时**以代码与 `pnpm test` 为准**。

## 通用编码约定

- **状态容器**（`Map`/`Set`/数组缓存）用**类字段**声明，禁止在 `constructor` 内 `this.cache = new Map()`（热重载会重复执行 constructor）。
- **constructor** 内只做 `super({...})` 与固定配置赋值。
- **全局对象**：使用全局 `Bot`、`segment`（`PluginsLoader` 已挂载）；业务勿 `new Bot()`。新插件应 `import plugin from '../../lib/plugins/plugin.js'`。
- **文件/对象**：业务用 `FileUtils`、`ObjectUtils`；配置路径用 `getServerConfigPath(port, name)`。
- **日志**：`Bot.makeLog`；禁止空 catch。

## plugin（`lib/plugins/plugin.js`）

```javascript
import plugin from '../../lib/plugins/plugin.js';

export default class MyPlugin extends plugin {
  constructor() {
    super({
      name: 'my-plugin',
      dsc: '说明',
      event: 'message',
      priority: 5000,
      rule: [{ reg: '^#命令$', fnc: 'run' }],
      task: { name: '', fnc: '', cron: '' }  // 或扩展为数组（见 loader 实现）
    });
  }
  async run(e) {
    await this.reply('ok');
  }
}
```

- 工作流优先：`this.callWorkflow(name, params, { e })`；低层：`this.getStream(name)?.execute(e, question, config)`。
- 持有 chokidar / 定时器等资源的插件，实现 `async destroy()`；热重载时由加载器清理（见 `PluginsLoader`）。

## HttpApi（`lib/http/http.js`）

推荐**对象导出**，由 `ApiLoader` 包装为 `HttpApi`：

```javascript
export default {
  name: 'my-api',
  dsc: '说明',
  priority: 100,
  routes: [{ method: 'GET', path: '/api/foo', handler: async (req, res, Bot) => { res.json({ success: true }); } }],
  ws: { '/ws/foo': (conn, req) => {} },
  init: async (app, Bot) => {}
};
```

亦可 `export default class extends HttpApi`。

## AIStream（`lib/aistream/aistream.js`）

```javascript
import AIStream from '../../lib/aistream/aistream.js';

export default class MyStream extends AIStream {
  constructor() {
    super({
      name: 'my-stream',
      description: '说明',
      priority: 100,
      config: { enabled: true, temperature: 0.8 }
    });
  }
  async init() {
    await super.init();
    this.registerMCPTool('tool_name', { description, inputSchema, handler });
    this.registerFunction('fn', { description, prompt, parser, handler, enabled: true });
  }
  buildSystemPrompt(context) { return '...'; }
  async buildChatContext(e, question) { return [...]; }
}
```

- 扫描路径：`plugins/<插件根>/stream/*.js`（`PluginDirScanner.listStreamDirs()`，**仅** `stream/`，不扫 `streams/`）。
- `callAI` 返回 `{ text, usedReplyTool } | null`；配置合并见 `CONFIG_PRIORITY.md`。
- 可选 `async cleanup()` 释放资源。

## ConfigBase（`lib/commonconfig/commonconfig.js`）

```javascript
import ConfigBase from '../../lib/commonconfig/commonconfig.js';
import { getServerConfigPath } from '../../lib/config/config-constants.js';

export default class MyConfig extends ConfigBase {
  constructor() {
    super({
      name: 'myconfig',
      displayName: '显示名',
      filePath: (cfg) => getServerConfigPath(cfg?._port ?? 2536, 'myconfig'),
      schema: { /* fields */ }
    });
  }
}
```

注册入口：`plugins/system-plugin/commonconfig/`。

## EventListener（`lib/listener/listener.js`）

```javascript
import EventListener from '../../lib/listener/listener.js';

export default class MyListener extends EventListener {
  constructor() {
    super({ prefix: '', event: 'message', once: false });
  }
}
```

`execute(e)` 委托 `Bot.PluginsLoader.deal(e)`。路径：`plugins/<插件根>/events/`。

## Renderer（`lib/renderer/Renderer.js`）

路径 `renderers/`；`super({ id, type, render })`；模板 I/O 经 `FileUtils`。

## LLMFactory（`lib/factory/llm/LLMFactory.js`）

LLM 端点从各 `*_llm.yaml` 的 `providers[]` 解析；注册表见 `lib/factory/llm/factory-registry.js`。

## 热重载与基础设施工具

- Loader 扫描：`PluginDirScanner`（`lib/utils/plugin-dir-scanner.js`）统一 `plugins/<名>/<subdir>/`；插件列表存**绝对路径**。
- 动态导入：**必须** `FileUtils.toImportUrl(absPath)`（Windows 热更、适配器、渲染器、事件监听均同）。
- 文件 I/O：`FileUtils`（含 `statSync`、`readFileBuffer`、`chmod`、`createWriteStream`）；`lib/` 禁止直连 `fs`/`chokidar`（仅 `file-utils.js`、`hot-reload-base.js` 内部）。
- 流式 JSON/SSE/NDJSON：`tryParseJson`（`lib/utils/json-utils.js`），解析失败返回 `null`，禁止空 `catch {}`。
- 对象合并：`ObjectUtils.shallowMergePlain` / `deepMergeImmutable`。
- 热重载：`HotReloadBase.createWatcher` / `watchModuleDirs`；`WATCH_DEBOUNCE_MS`（300ms）与 `closeWatcher` / `closeWatchers` 为 Loader 统一契约；配置/插件/API/工作流/CommonConfig/渲染器均已接入。
- HttpApi 热更：每个 API 使用独立 `express.Router`，`stop(app)` 时从 Express 栈移除，避免路由重复注册。
- Loader 状态：`Map`/`Set` 用**类字段**，禁止 constructor 内 `new Map()`。
- 资源释放：工作流 `cleanup()`、插件 `destroy()`。
