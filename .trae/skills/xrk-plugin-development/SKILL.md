---
name: xrk-plugin-development
description: 在 XRK-Yunzai 中开发或修改插件时使用；涉及 plugins/ 下插件、插件基类扩展、消息事件处理或与 AIStream 工作流集成时使用。
---

# XRK-Yunzai 插件开发

## 快速结构

- 基类：`lib/plugins/plugin.js`。
- 插件文件放在 `plugins/<插件名>/` 下（入口可为插件根目录或子目录，由加载器扫描约定决定）。

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

- **事件对象 e**：含 `e.bot`、`e.friend`、`e.group`、`e.reply()`、`e.isMaster` 等。
- **工作流**：`this.getStream('chat')` 获取，`stream.execute(e, question, config)` 执行。
- **文件**：用 `FileUtils`，不用 `fs` 直接操作。
- **配置**：`cfg`（`lib/config/config.js`）或 `makeConfig`（`lib/plugins/config.js`）。

## 参考

- 插件基类与加载：`lib/plugins/plugin.js`、`lib/plugins/loader.js`；项目内文档如 `docs/PLUGIN_BASE_CLASS.md`、`docs/reference/PLUGINS.md` 若有则以之为辅，以代码为准。
