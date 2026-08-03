# XRK-Yunzai 与经典 Yunzai（TRSS）对照

完整特性对比。标记：[lib/plugins/README.md](../lib/plugins/README.md) · 基类：[base-classes.md](./base-classes.md)

**读法**：标 **[compat]** 的勿随意改形状；**[ext]** 为 XRK 产品面，第三方插件可不依赖。

---

## 分层原则：`lib` 基建，业务进 `plugins`

相对经典 Yunzai（很多东西钉在 `lib/` 里），XRK 刻意拆成：

| 层 | 放什么 | 谁扩展 |
|----|--------|--------|
| **`lib/`** | Bot、PluginsLoader、ListenerLoader、ApiLoader、AiWorkflowLoader、基类、工厂、工具 | 框架维护；第三方一般只**调用**，不往这里堆业务 |
| **`plugins/<名>/`** | 消息插件、events、adapter、http、workflow、commonconfig、www | **开发者扩展面**：加目录即可被对应 Loader 扫到 |

典型「从 lib 挪出 / 不塞进 lib」的例子：

| 经典 TRSS 常见位置 | XRK |
|-------------------|-----|
| `lib/events/*.js` | `plugins/*/events/`（内置在 system-plugin） |
| `plugins/adapter/` 或框架内嵌 | `plugins/*/adapter/`（主要 system-plugin） |
| 无框架级 HTTP 业务 API | `plugins/*/http/` → ApiLoader |
| 无框架级 AI 业务流 | `plugins/*/workflow/` → AiWorkflowLoader |
| 配置只能改 yaml | `plugins/*/commonconfig/` → 控制台可编辑 |

因此：**协议消息链契约仍在 lib（compat）**；**可替换、可热更、可多插件并存的业务**放在 plugins，允许你自己的插件与 `system-plugin` 并列扩展，而不用改框架核心。

---

## 0. 一句话

| | 经典 Yunzai / TRSS | XRK-Yunzai |
|--|-------------------|------------|
| 定位 | QQ/多协议机器人框架 | 同兼容面 + **多端口多业务** + AI/HTTP/设备/控制台 |
| 进程 | 常单进程、一套 `config/config/` | **启动必选端口**；每端口一套配置进程 |
| 账号 | 单进程多 `uin`（多 Bot 连接） | **同样支持**；多业务优先多端口隔离 |

---

## 1. 启动与进程

| 项 | TRSS | XRK |
|----|------|-----|
| 主入口 | `app.js` → `Bot.run()` | `app.js` 引导 → `start.js` 菜单/**选端口** → `Bot.run({ port })` |
| 其它模式 | `stop` / `daemon` / `pm2`（`app_type`） | 菜单 + PM2；`debug.js [port]` 前台调试 |
| PM2 | 常单名 `TRSS-Yunzai` | 每端口 `XRK-Yunzai-Server-<port>`，`XRK_SERVER_PORT` |
| 根 `index.js` | 无业务桶 | 无（避免与插件 `index.js` 混淆） |

```text
XRK:  node app.js|start.js → 引导 → 选端口 → Bot.run({ port })
      → PluginsLoader / ListenerLoader / ApiLoader / AiWorkflowLoader / ConfigLoader
```

---

## 2. 多端口多业务（XRK 核心）

| 概念 | XRK |
|------|-----|
| 端口级配置 | `data/server_bots/<port>/{bot,other,server,group,renderer,ai-workflow}.yaml` |
| 全局配置 | `data/server_bots/{device,monitor,notice,redis,db}.yaml` |
| 工厂 LLM | `data/server_bots/*_llm.yaml`（根级） |
| 模板 | `config/default_config/` → 首次 `ensurePortConfigs(port)` |
| API | `getServerConfigPath(port, name)` |

**TRSS**：运行配置在 `config/config/`（从 default 拷贝），一般不按端口分目录。

**仍兼容单端口多 Bot（TRSS 式）**：同一进程多 adapter → 多 `Bot.uin`；`cfg.master` 支持 `bot:user`，或扁平 `masterQQ` 广播。多业务隔离用多端口；单端口多账号是兼容路径。

```text
[推荐] 端口 A / B 各一进程 = 两套业务配置，每套仍可挂 1..N 个协议 Bot
[兼容] 单端口进程 + 多 uin（贴近 TRSS）
```

详见 [CONFIG_PRIORITY.md](./CONFIG_PRIORITY.md)、[CONFIG_AND_REDIS.md](./reference/CONFIG_AND_REDIS.md)。

---

## 3. 插件目录与加载

| 项 | TRSS | XRK |
|----|------|-----|
| 有 `index.js` | 只加载桶入口 | **同左 [compat]** |
| 无 index | 扫目录顶层 `*.js` | 同左；**额外**：`system-plugin` → 只扫 `plugin/*.js` |
| 内置系统 | 常 `plugins/system/*.js` 扁平 | `system-plugin/{plugin,events,adapter,http,workflow,commonconfig,www}` 分 Loader |
| adapter 目录 | `plugins/adapter/` 等 | 主要在 `system-plugin/adapter/`；仍可扫 `plugins/*/adapter` |

**为何 system-plugin 无根 index**：若放 index，按 Yunzai 规则只认一个文件，其它子系统挂不上。见 [SYSTEM-PLUGIN.md](../plugins/system-plugin/SYSTEM-PLUGIN.md)。

---

## 4. 消息链（deal）

| 项 | TRSS | XRK |
|----|------|-----|
| 主链 receive → Runtime → 前缀 → 插件 → reply | 有 | **[compat]** |
| 星铁 / 绝区零前缀 | `srReg` / `zzzReg` | **同 [compat]**；`getMysApi` 含 zzz |
| 群/单人 CD、禁言、onlyReplyAt、权限 | 有 | **[compat]**；`groupCD`↔`groupGlobalCD` 别名 |
| 黑白名单 | QQ/群 | 同 + **设备黑名单 / disableDevice [ext]** |
| 设备 CD | 无 | **`deviceCD` [ext]** |
| 旁路节流 | 无 | **`bypassThrottle` [ext]** |
| 扩展队列 | 少 | **`priority: 'extended'` [ext]** |
| JSON 卡片抽链 | 弱 | **`extractJsonCardText` [ext]**（xml/json→`e.msg` 仍 compat） |
| 事件订阅 | Bot.on | 同 + **`eventSubscribe` [ext]**（如 connect） |

---

## 5. Runtime / makeConfig / puppeteer（硬兼容）

| 项 | TRSS | XRK |
|----|------|-----|
| `e.runtime` | getMysApi / render / Handler… | **[compat]**；截图路径用模板名；copyright `XRK-Yunzai` |
| `makeConfig` | `lib/plugins/config.js` → `config/<name>.yaml` | **同路径，禁止删** |
| puppeteer import | `lib/puppeteer/puppeteer.js` | **同路径 shim → Renderer，禁止删** |

---

## 6. Adapter / events

| 项 | TRSS | XRK |
|----|------|-----|
| events | 常固定 `lib/events/` | **`plugins/*/events/`**，可热更 **[compat 契约 / ext 布局]** |
| 内置协议面 | OneBot、企微、GSUID、stdin、以及 Satori/Milky/OPQ 等（随版本） | OneBotv11、ComWeChat、GSUID、stdin、QBQBot 等 |
| 加载 | Listener 一次加载 | events → API → adapters；可 watch / 解绑 |

**不要假设协议集合完全对等**；第三方仍按 OneBot 等主流契约写。见 [ADAPTER_AND_ROUTING.md](./reference/ADAPTER_AND_ROUTING.md)。

---

## 7. HTTP / 控制台 www

| 项 | TRSS | XRK |
|----|------|-----|
| HTTP 角色 | 适配器网关、`/status` `/exit` 等 | **ApiLoader** 全量 `/api/...` + 静态 + 上传 |
| 安全 | auth | auth + helmet + rate-limit + … |
| HTTPS / 反代 | 可选 | https + 反代/域名/健康检查（`server.yaml` 更厚） |
| 前端 | 弱 / 模板调试 | **Vue 控制台** `system-plugin/www/xrk`（配置/聊天/设备 WS） |
| 构建 | — | `pnpm build:www`（sign.json 等） |

纯 **[ext]** 产品面。

---

## 8. AI / MCP / CommonConfig / LLMFactory

| 项 | TRSS | XRK |
|----|------|-----|
| 工作流基类 | 无框架级 | **`AiWorkflow`** + `plugins/*/workflow/`（不扫 `streams/`） |
| Loader | — | **`AiWorkflowLoader`**，`Bot.AiWorkflowLoader.mcpServer` |
| MCP | 无 | 内置工具 + 远程 mcpServers + HTTP MCP |
| CommonConfig | 无 | schema + 控制台可编辑 |
| LLM 工厂 | 无 | **`LLMFactory`** + `*_llm.yaml` |
| 配置读取 | — | **`getAiWorkflowConfigOptional()`**（lib 内统一） |

详见 [AISTREAM_AND_MCP.md](./reference/AISTREAM_AND_MCP.md)、[lib/ai-workflow/README.md](../lib/ai-workflow/README.md)。

---

## 9. device / stdin

| 项 | TRSS | XRK |
|----|------|-----|
| stdin | 有 adapter | 有，并接调试/www 临时媒体 **[ext 加深]** |
| device | 无一等 `post_type=device` | **一等事件**：deal 特判、CD、黑名单、事件名映射 **[ext]** |
| 接入 | — | WS `/device` + `http/device.js` + 控制台 |

见 [DEVICE.md](./reference/DEVICE.md)。

---

## 10. Redis / 消息计数

| 项 | TRSS | XRK |
|----|------|-----|
| 客户端 | `lib/config/redis.js` | 同职责 + 健康检查 / `persistRedis` / `closeRedis` |
| 配置路径 | `config/config/redis.yaml` | **`data/server_bots/redis.yaml`（全局）** |
| 计数键 | `Yz:count:${type}:${scope}`（日/月/年/total×bot/user/group） | **双写**：XRK 旧键 + Compat TRSS 键（喂 yenai 等面板） |
| 不计 | — | device / stdin 消息不计入 |

---

## 11. 渲染器

| 项 | TRSS | XRK |
|----|------|-----|
| 引擎 | 主 puppeteer | **puppeteer + playwright** |
| 安装 | 各自文档 | `pnpm setup:browsers` 等 |
| Runtime.render | 经 shim | 经 RendererLoader + compat 路径 |

---

## 12. 热重载

| 项 | TRSS | XRK |
|----|------|-----|
| 实现 | loader 内 chokidar | **`HotReloadBase`**（debounce + 内容哈希） **[ext]** |
| 覆盖 | 插件为主 | 插件 + events/adapter/http/workflow/commonconfig |
| 卸载 | 弱 | `destroy` / `cleanup` / 解绑监听 |

`file_watch: false` 可关监视（两边思路相近）。

---

## 13. 运行时与工具链

| 项 | TRSS | XRK |
|----|------|-----|
| Node | 常 ≥23（以官方 README 为准） | **`engines.node >= 24`**，`app.js` 硬校验 |
| 包管理 | 推荐 pnpm | **`pnpm@9`**（`packageManager` + engines） |
| 脚本取向 | start/stop/web/lint(prettier) 等 | lint(eslint)、test、validate:skills、build:www、setup:browsers |
| 依赖面 | 更瘦 | 更厚（AI/爬虫/playwright/helmet/控制台…） |

---

## 14. 基类一览

| 模块 | 路径 | 相对 TRSS |
|------|------|-----------|
| plugin / Handler / Runtime / makeConfig | `lib/plugins/*` | **[compat]** |
| EventListener | `lib/listener/listener.js` | **[compat]**（布局可在插件下） |
| Renderer | `lib/renderer/Renderer.js` | 有，双引擎为 ext |
| **AiWorkflow** | `lib/ai-workflow/ai-workflow.js` | **[ext]** |
| **HttpApi** | `lib/http/http.js` | **[ext]** |
| **CommonConfig** | `lib/commonconfig/commonconfig.js` | **[ext]** |
| **LLMFactory / BaseFactory** | `lib/factory/` | **[ext]** |
| **HotReloadBase** | `lib/utils/hot-reload-base.js` | **[ext]** |

---

## 15. 文档地图

| 文档 | 内容 |
|------|------|
| 本文 | 全量对照 |
| [base-classes.md](./base-classes.md) | 短契约 |
| [BASE_CLASSES.md](./BASE_CLASSES.md) | 基类索引 |
| [coding-style.md](./coding-style.md) | 写法 |
| [runtime-surface.md](./runtime-surface.md) | 挂载面 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 架构 |
| [CONFIG_PRIORITY.md](./CONFIG_PRIORITY.md) | 端口配置 + LLM 优先级 |
| [lib/plugins/README.md](../lib/plugins/README.md) | loader 标记 |
| [SYSTEM-PLUGIN.md](../plugins/system-plugin/SYSTEM-PLUGIN.md) | 内置插件 |
| [ADAPTER_AND_ROUTING.md](./reference/ADAPTER_AND_ROUTING.md) | 适配器 |
| [DEVICE.md](./reference/DEVICE.md) | 设备 |
| [AISTREAM_AND_MCP.md](./reference/AISTREAM_AND_MCP.md) | 工作流 / MCP |
| [TECH_STACK.md](./TECH_STACK.md) | 技术栈 |
