# XRK-Yunzai 与经典 Yunzai 对照

进程入口、插件布局、**多端口多业务**、以及相对经典 Yunzai（含 TRSS）多出的基类。

标记约定：[lib/plugins/README.md](../lib/plugins/README.md) · 基类短契约：[base-classes.md](./base-classes.md)

---

## 1. 进程入口：`app.js` 与 `start.js`

| 文件 | 角色 |
|------|------|
| **`app.js`** | `package.json` 的 `"main"`。引导：Node 版本、目录、依赖、`--expose-gc`。 |
| **`start.js`** | 菜单 / 选端口 / PM2。直接跑 `start.js`（非 `stop`）会**转回 `app.js`**。 |
| **`lib/bot.js`** | 单次进程内的 Bot 运行时；`Bot.run({ port })`。 |

```text
node app.js | node start.js
       → app.js 引导
       → start.js 选端口 / 菜单
       → Bot.run({ port })  →  PluginsLoader / ListenerLoader / AiWorkflowLoader …
```

根目录**没有**业务 `index.js`（避免与插件包 `index.js` 混淆）。

---

## 2. 核心：多端口、多业务

XRK 把 **HTTP 监听端口**当作「一条业务线 / 一套隔离配置」：

| 概念 | 路径 / 行为 |
|------|-------------|
| 启动必选端口 | 菜单选择已有端口，或输入新端口；`ensurePortConfigs(port)` |
| 端口级配置 | `data/server_bots/<port>/{bot,other,server,group,renderer,ai-workflow}.yaml` |
| 全局配置 | `data/server_bots/{device,monitor,notice,redis,db}.yaml`（不随端口） |
| 工厂 LLM | `data/server_bots/*_llm.yaml`（根级，不按端口分子目录） |
| 进程名 | 如 `XRK-Yunzai-Server-<port>`（PM2 可多开） |
| 环境变量 | `XRK_SERVER_PORT` |

同一机器可跑 **多个端口进程** = 多套业务（不同 QQ 业务、不同 AI 配置、不同主人名单等），互不覆盖配置目录。

默认模板在 `config/default_config/`；首次选端口时拷贝/合并进 `data/server_bots/<port>/`。路径 API：`getServerConfigPath(port, name)`。

详见 [CONFIG_PRIORITY.md](./CONFIG_PRIORITY.md)、[reference/CONFIG_AND_REDIS.md](./reference/CONFIG_AND_REDIS.md)。

### 仍兼容：单端口多 Bot（TRSS 式）

经典 TRSS：**一个进程、一个 HTTP 口**，多个协议账号经 adapter 连入，`Bot.uin` 持有多个 bot_id，`Bot[uin]` / `bots[uin]` 分发。

XRK **同一端口进程内同样支持**：

- 多个 adapter（OneBot / 其它）`Bot.adapter.push` 后各自连上 → 多个 `uin`
- `cfg.master` 可按 `bot:user` 分主人；扁平 `masterQQ` 则广播到所有 `Bot.uin`
- 插件侧 `e.self_id` / `e.bot` 区分账号

区别只是：**多业务隔离优先用多端口进程**；单端口多账号是兼容路径，不是「只能一个 QQ」。

```text
[推荐]  端口 A 进程 ── 业务 A 配置 ── 可挂 1..N 个协议 Bot
        端口 B 进程 ── 业务 B 配置 ── 可挂 1..N 个协议 Bot

[兼容]  单端口进程 ── 一套配置 ── 多 adapter / 多 uin（贴近 TRSS）
```

---

## 3. 插件入口：`index.js` / system-plugin

`getPlugins()`：

```text
有 index.js → 只加载它（经典桶，如 logier-plugin）
否则若 system-plugin → 只扫 plugin/*.js（故意无根 index）
否则 → 扫目录顶层 *.js
```

**system-plugin 无 index**：合集含 `plugin/`、`events/`、`adapter/`、`http/`、`workflow/`、`commonconfig/`、`www/`，分属不同 Loader；放根 `index.js` 会按 Yunzai 规则只认一个文件。说明见 [SYSTEM-PLUGIN.md](../plugins/system-plugin/SYSTEM-PLUGIN.md)。

---

## 4. 基类：兼容面 vs XRK 多出来的

| 基类 / 模块 | 路径 | 相对经典 Yunzai |
|-------------|------|-----------------|
| `plugin` | `lib/plugins/plugin.js` | **[compat]**；工作流 API 为 **[ext]** |
| `Handler` | `lib/plugins/handler.js` | **[compat]** |
| `Runtime` / `makeConfig` | `runtime.js` / `config.js` | **[compat]** |
| `EventListener` | `lib/listener/listener.js` | **[compat]**（events → deal） |
| `Renderer` | `lib/renderer/Renderer.js` | 有，路径与 TRSS 略异 |
| **`AiWorkflow`** | `lib/ai-workflow/ai-workflow.js` | **[ext]** 工作流基类 |
| **`HttpApi`** | `lib/http/http.js` | **[ext]** HTTP/WS API |
| **`CommonConfig`** | `lib/commonconfig/commonconfig.js` | **[ext]** 可编辑配置 schema |
| **`BaseFactory` / LLMFactory** | `lib/factory/` | **[ext]** LLM 提供商 |
| **`HotReloadBase`** | `lib/utils/hot-reload-base.js` | **[ext]** 统一热更 |

短契约：[base-classes.md](./base-classes.md) · 详述：[BASE_CLASSES.md](./BASE_CLASSES.md) · 写法：[coding-style.md](./coding-style.md)

---

## 5. 能力对照（摘要）

| 能力 | 经典 Yunzai / TRSS | XRK-Yunzai |
|------|-------------------|------------|
| 插件 rule/task/context、deal 链 | 有 | **[compat]** |
| 单进程多 uin | 有 | **[compat]** |
| **启动选端口 / 多端口业务隔离** | 弱或无 | **核心 [ext]** |
| device / stdin | 弱 | **[ext]** |
| HTTP API + www 控制台 | 少 | **[ext]** |
| AI 工作流 / MCP / CommonConfig | 无或外挂 | **[ext]** |

---

## 6. 文档地图

| 文档 | 内容 |
|------|------|
| 本文 | 入口 · 多端口 · 插件布局 · 基类对照 |
| [base-classes.md](./base-classes.md) | 业务扩展短契约 |
| [BASE_CLASSES.md](./BASE_CLASSES.md) | 基类索引 |
| [coding-style.md](./coding-style.md) | 写法速查 |
| [runtime-surface.md](./runtime-surface.md) | Bot / cfg 挂载面 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 架构图 |
| [lib/plugins/README.md](../lib/plugins/README.md) | loader `[compat]`/`[ext]` |
| [SYSTEM-PLUGIN.md](../plugins/system-plugin/SYSTEM-PLUGIN.md) | 内置插件 |
| [reference/PLUGINS.md](./reference/PLUGINS.md) | 插件 API |
| [ADAPTER_AND_ROUTING.md](./reference/ADAPTER_AND_ROUTING.md) | 适配器与事件 |
| [AISTREAM_AND_MCP.md](./reference/AISTREAM_AND_MCP.md) | 工作流 / MCP 配置 |
