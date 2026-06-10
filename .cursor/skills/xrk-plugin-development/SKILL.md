---
name: xrk-plugin-development
description: 在 XRK-Yunzai 中开发或修改插件时使用；涉及 plugins/ 下插件、插件基类扩展、消息事件处理或与 AIStream 工作流集成时使用。
---

# XRK-Yunzai 插件开发

## 文档与代码

- 短契约：`docs/base-classes.md`；详述：`docs/PLUGIN_BASE_CLASS.md`
- 基类：`lib/plugins/plugin.js`；加载：`lib/plugins/loader.js`

## 结构

```javascript
import plugin from '../../lib/plugins/plugin.js';

export default class MyPlugin extends plugin {
  constructor() {
    super({
      name: 'my-plugin',
      dsc: '描述',
      event: 'message',
      priority: 5000,
      rule: [{ reg: '^#命令$', fnc: 'handleCmd' }]
    });
  }
  async handleCmd(e) {
    await this.reply('回复');
  }
}
```

## 约定（对齐 XRK-AGT，路径为 Yunzai）

- 路径：`plugins/<插件名>/`（入口由 PluginsLoader 扫描）。
- **类字段**存状态；constructor 不 `new Map()` / `{}` 缓存。
- 全局 `Bot`、`segment`；勿 import Bot / oicq segment。
- 文件：`FileUtils`；配置：`cfg` / `getServerConfigPath`。
- 资源：chokidar/定时器 → `async destroy()`；监视用 `HotReloadBase`。

## 工作流

- 优先：`this.callWorkflow('chat', { question }, { e })`
- 并行：`this.callWorkflows([...], sharedParams, { e })`
- 低层：`this.getStream('chat')?.execute(e, question, config)`

## Rule 匹配

`event` → `reg` → `permission` → `fnc`；返回 `false` 继续下一条。

## 参考

- 底层规范：skill `xrk-base-layer`；规则 `xrk-dev-requirements.mdc`
