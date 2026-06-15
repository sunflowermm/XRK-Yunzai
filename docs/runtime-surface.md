# 运行时常量与全局挂载面

> **唯一事实源**：业务代码应如何使用 `Bot`、`segment`、`cfg` 等运行时对象。  
> 详述见 [CORE_OBJECTS.md](CORE_OBJECTS.md)；写法见 [coding-style.md](coding-style.md)。

---

## 全局裸名（插件 / 工作流 / 事件）

| 符号 | 用途 | 禁止 |
|------|------|------|
| `Bot` | 事件 `em()`、多实例、配置、发送 API | `import Bot`、`new Bot()`、`global.Bot` |
| `segment` | 构造消息段 | `import { segment } from 'oicq'`、`global.segment` |
| `cfg` | 运行时配置（`bot.js` 挂载后裸名可用） | `global.cfg`（业务层）；`lib/` 可 `import cfg` |

历史代码可用裸名 `plugin`（`loader.js` 挂载）；**新插件**应 `import plugin from '.../lib/plugins/plugin.js'`。

---

## HTTP / WebSocket

| 符号 | 用途 |
|------|------|
| `Bot`（handler 第三参） | 访问当前服务实例、配置、插件 |
| `req` / `res` | Express 标准对象 |

Handler 签名：`(req, res, Bot) => void | Promise<void>`。

---

## 配置

| API | 说明 |
|-----|------|
| `cfg` | `lib/config/config.js` 单例；`cfg.getLLMConfig(provider)` 等 |
| `getServerConfigPath(port, name)` | 默认模板或 `data/server_bots/` 路径 |
| `GLOBAL_CONFIG_NAMES` / `PORT_CONFIG_NAMES` | 全局 vs 端口级配置分类 |

工厂配置后缀：`_llm`、`_compat_llm`（无 ASR/TTS 工厂）。

---

## 工具入口

```javascript
import { FileUtils, ObjectUtils } from '../../lib/utils/index.js';
import { getServerConfigPath } from '../../lib/config/config-constants.js';
import BotUtil from '../../lib/util.js';
```

业务 `plugins/` **禁止**直连 `fs`；`lib/` 基础设施经 `FileUtils` 访问文件系统。

---

## 米游 / Runtime

- `e.runtime.getMysApi`（`lib/plugins/runtime.js`）
- 勿使用已移除的 Runtime 扩展注册机制

---

## 测试环境

设置 `process.env.XRK_TEST = '1'` 时，部分启动路径可跳过重依赖；框架单测见 `tests/framework/`。
