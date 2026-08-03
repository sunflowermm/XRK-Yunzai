# lib/plugins

XRK-Yunzai 插件底层。与经典 Yunzai 的对照见 [docs/VS_YUNZAI.md](../../docs/VS_YUNZAI.md)。

## 标记约定

| 标记 | 含义 |
|------|------|
| **[compat]** | 与经典 Yunzai 第三方插件契约对齐，勿随意改形状 |
| **[ext]** | XRK 相对经典 Yunzai 的扩展 |

## 文件

| 文件 | 标记 | 职责 |
|------|------|------|
| `plugin.js` | compat + ext | 基类（rule/task/context/handler）；工作流 API 为 ext |
| `loader.js` | compat + ext | 扫描、分发、冷却、热更；device/stdin/extended 等为 ext |
| `runtime.js` | compat | `e.runtime`（getMysApi / render / Handler 等） |
| `handler.js` | compat | `Handler.add\|del\|call\|callAll\|has` |
| `config.js` | compat | `makeConfig()` → `config/<name>.yaml`，**禁止删除** |

## 插件目录怎么扫（`getPlugins`）

对每个 `plugins/<名>/`：

1. **有 `index.js`** → 只加载它（经典桶入口，如 logier-plugin）。
2. **名为 `system-plugin` 且无 index** → 只扫 `plugin/*.js`（内置合集，见下）。
3. **其它无 index** → 扫该目录顶层 `*.js`。

`events/`、`adapter/`、`http/`、`workflow/`、`commonconfig/`、`www/` **不由** PluginsLoader 当消息插件扫，由 ListenerLoader / ApiLoader / AiWorkflowLoader / ConfigLoader / 静态挂载分别加载。

### 为何 system-plugin 没有 index.js

它是多子系统合集。若根目录放 `index.js`，按 Yunzai 规则会只认这一个文件，`plugin/`、`events/`、`adapter/` 等要么塞进巨型桶、要么加载不到。故**故意无 index**，PluginsLoader 特判扫 `plugin/`，其余交给对应 Loader。第三方常规插件仍应使用 `index.js`。

## loader 契约速查

**[compat]** `load` / `getPlugins` / `importPlugin` / `loadPlugin` · `deal` · `dealMsg` / `parseMessage` · `filtEvent` / `filtPermission` · `checkLimit` / `setLimit` / `onlyReplyAt` / `checkBlack` / `checkDisable` · `reply` · `count` / `saveCount` · `createTask` / `changePlugin` / `watch` · `load_time` · `srReg` / `zzzReg` · xml/json→`e.msg`

**[ext]** `device` / `stdin` · `extended` · `bypassThrottle` · `eventSubscribe` · `extractJsonCardText` · `pluginLoadStats` / `getPluginStats` · `destroy` · `saveCountCompat`

## 外围（同属插件事件链）

| 路径 | 标记 | 说明 |
|------|------|------|
| `lib/listener/*` | compat | `events/` → `EventListener` → `PluginsLoader.deal` |
| `plugins/.../events/` | compat | message / notice / request / online… |
| `plugins/.../adapter/` | compat / ext | OneBot 等 compat；stdin 等 ext |
| `plugins/.../plugin/` | compat | 消息级插件（system-plugin 专用子目录） |

## makeConfig（compat）

```javascript
import makeConfig from '../../../lib/plugins/config.js'
const { config, configSave } = await makeConfig('my-plugin', { foo: 1 })
```

新插件优先 CommonConfig（`plugins/<名>/commonconfig/`）。
