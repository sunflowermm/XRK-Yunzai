---
name: xrk-plugin-development
description: Develop XRK-Yunzai plugins. Use when creating or modifying plugins in plugins/, extending plugin base class, handling message events, or integrating with AIStream workflows.
---

# XRK-Yunzai 插件开发

## 快速结构

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
    await this.reply('回复内容');
  }
}
```

## 关键点

- **事件对象 e**：含 `e.bot`、`e.friend`、`e.group`、`e.reply()`、`e.isMaster`
- **工作流**：`this.getStream('chat')` 获取，`stream.execute(e, question, config)` 执行
- **文件**：用 `FileUtils`，不用 `fs` 直接操作
- **配置**：`cfg` 或 `makeConfig`（lib/plugins/config.js）

## 参考

- [docs/PLUGIN_BASE_CLASS.md](../../docs/PLUGIN_BASE_CLASS.md)
- [docs/reference/PLUGINS.md](../../docs/reference/PLUGINS.md)
