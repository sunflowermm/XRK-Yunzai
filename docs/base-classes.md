# 业务扩展基类契约

业务放 `plugins/<插件名>/`；**必须**符合下列基类/导出约定。

> **对照 Yunzai / 多端口**：[VS_YUNZAI.md](./VS_YUNZAI.md)  
> **写法**：[coding-style.md](./coding-style.md) · **挂载**：[runtime-surface.md](./runtime-surface.md)  
> 详述：[BASE_CLASSES.md](./BASE_CLASSES.md)；冲突时以代码与 `pnpm test` 为准。

## 通用约定

- 状态容器用**类字段**，禁止 constructor 内 `new Map()`。
- 全局：`Bot`、`segment`；新插件 `import plugin from '../../lib/plugins/plugin.js'`。
- 配置路径：`getServerConfigPath(port, name)`（多端口核心，见 VS_YUNZAI）。
- 日志：`Bot.makeLog`；禁止空 catch。

## 相对经典 Yunzai

| | 模块 | 说明 |
|---|------|------|
| **compat** | `plugin` / `Handler` / `Runtime` / `makeConfig` / `EventListener` | 第三方插件契约 |
| **ext** | `AiWorkflow` / `HttpApi` / `CommonConfig` / `LLMFactory` / `HotReloadBase` | XRK 多出来的基类与工具 |

---

## plugin（`lib/plugins/plugin.js`）— compat + ext

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
    });
  }
  async run(e) {
    await this.reply('ok');
  }
}
```

- 工作流（ext）：`this.callWorkflow(name, params, { e })`；`this.getWorkflow(name)?.execute(…)`。
- 资源：`async destroy()`。

## HttpApi（`lib/http/http.js`）— ext

```javascript
export default {
  name: 'my-api',
  dsc: '说明',
  priority: 100,
  routes: [{ method: 'GET', path: '/api/foo', handler: async (req, res, Bot) => { res.json({ success: true }); } }],
};
```

亦可 `extends HttpApi`。目录：`plugins/<名>/http/`。

## AiWorkflow（`lib/ai-workflow/ai-workflow.js`）— ext

```javascript
import AiWorkflow from '../../lib/ai-workflow/ai-workflow.js';

export default class MyWorkflow extends AiWorkflow {
  constructor() {
    super({
      name: 'my-workflow',
      description: '说明',
      priority: 100,
      config: { enabled: true, temperature: 0.8 },
    });
  }
  async init() {
    await super.init();
    this.registerMCPTool('tool_name', { description, inputSchema, handler });
  }
  buildSystemPrompt(context) { return '...'; }
  async buildChatContext(e, question) { return [...]; }
}
```

目录：**仅** `plugins/<名>/workflow/`（不扫 `streams/`）。

## CommonConfig（`lib/commonconfig/commonconfig.js`）— ext

注册：`plugins/<名>/commonconfig/`。键名 `插件名_文件名`（system-plugin 的 `system.js` → `system`）。

## EventListener（`lib/listener/listener.js`）— compat

```javascript
import EventListener from '../../lib/listener/listener.js';

export default class MyListener extends EventListener {
  constructor() {
    super({ event: 'message' });
  }
}
```

`execute(e)` → `PluginsLoader.deal(e)`。目录：`plugins/<名>/events/`。

## 历史 makeConfig（`lib/plugins/config.js`）— compat

`makeConfig(name, defaults)` → `config/<name>.yaml`。**禁止删除**。新插件用 CommonConfig。

## Renderer / LLMFactory / HotReloadBase

- Renderer：`lib/renderer/Renderer.js`，包在 `renderers/`
- LLMFactory：`lib/factory/llm/`；默认 Provider 读 `getAiWorkflowConfigOptional().llm`
- HotReloadBase：各 Loader 统一监视；业务勿直连 chokidar

## AiWorkflowLoader / MCP（`lib/ai-workflow/loader.js`）— ext

- 扫描 `plugins/<名>/workflow/`
- MCP：`Bot.AiWorkflowLoader.mcpServer`（勿用已移除的全局挂载）
- 配置：`getAiWorkflowConfigOptional()`
- 详见 [reference/AISTREAM_AND_MCP.md](./reference/AISTREAM_AND_MCP.md)

## 热重载与工具

- 扫描：`PluginDirScanner`；导入：`FileUtils.toImportUrl`
- I/O：`FileUtils`；对象：`ObjectUtils`
- 插件 `destroy()`；工作流 `cleanup()`
