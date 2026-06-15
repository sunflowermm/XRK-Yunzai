---
name: xrk-plugin-development
description: 在 XRK-Yunzai 中开发或修改插件时使用；涉及 plugins/ 下插件、插件基类扩展、消息事件处理或与 AIStream 工作流集成时使用。
---

# XRK-Yunzai 插件开发

## 权威入口

- **写法**：`docs/coding-style.md` · **挂载**：`docs/runtime-surface.md`
- **短契约**：`docs/base-classes.md`（plugin 段）· **详述**：`docs/PLUGIN_BASE_CLASS.md`
- **基类**：`lib/plugins/plugin.js` · **加载**：`lib/plugins/loader.js`

## 适用场景

- 新增/修改 `plugins/<名>/` 下消息、通知、请求类插件
- 修改内置底层 `plugins/system-plugin/`（http/stream/plugin/events/adapter/commonconfig）
- 插件内调用工作流、回复消息、权限与冷却

## 非适用场景

- HTTP API → skill `xrk-http-api`
- AI 工作流本体 → skill `xrk-workflow-stream`
- CommonConfig → skill `xrk-config-commonconfig`

## 结构

```javascript
import plugin from '../../lib/plugins/plugin.js';

export default class MyPlugin extends plugin {
  cooldown = new Map();

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

  async destroy() {
    // 释放 watcher / 定时器
  }
}
```

## 约定

| 项 | 要求 |
|----|------|
| 路径 | `plugins/<插件名>/`；内置底层 `plugins/system-plugin/` |
| 日志 | `Bot.makeLog(level, msg, tag)` |
| 状态 | **类字段**存 Map/缓存；constructor 不 `new Map()` |
| 全局 | 裸名 `Bot`、`segment`；勿 `import Bot` |
| 文件 | `FileUtils`；配置 `getServerConfigPath` / `cfg` |
| 历史 YAML 配置 | `lib/plugins/config.js` 的 `makeConfig()`（TRSS 兼容，**禁止删**） |
| 新插件配置 | CommonConfig（`plugins/<名>/commonconfig/`） |
| 热重载 | 监视用 `HotReloadBase`；实现 `async destroy()` |

## 工作流调用

1. 优先：`this.callWorkflow('chat', { question }, { e })`
2. 并行：`this.callWorkflows([...], sharedParams, { e })`
3. 低层：`this.getStream('chat')?.execute(e, question, config)`

## Rule 匹配

`event` → `reg` → `permission` → `fnc`；返回 `false` 继续下一条。

## 常见陷阱

- 增删 `system-plugin` 内置模块须更新 `tests/helpers/system-plugin-baseline.mjs`
- 在 constructor 内创建 `this.cache = new Map()`
- 业务层直接使用 `fs.existsSync`
- 工作流文件误放到 `streams/`（Loader 不扫描）

## 参考

- skill `xrk-coding-style`、`xrk-base-layer`
- 规则 `.cursor/rules/xrk-dev-requirements.mdc`、`plugin-development.mdc`
