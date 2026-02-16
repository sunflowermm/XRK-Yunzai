# system-plugin 说明文档

本文档介绍 XRK-Yunzai 项目自带的 **system-plugin**：其职责、目录结构、核心模块与配置方式，便于维护与扩展。

---

## 一、概述

**system-plugin** 是框架内置的“系统插件”，提供：

- **多端适配**：OneBot（QQ）、标准输入、QBQBot、GSUIDCORE、ComWeChat 等适配器，将各端消息/事件转为统一事件流。
- **AI 工作流**：chat、memory、tools、database、desktop、device 等流，通过 MCP 工具供 AI 调用。
- **AI 助手入口**：`plugin/ai.js` 根据 `data/ai/config.yaml` 触发聊天、合并工作流，并处理白名单与冷却。
- **通用能力**：HTTP API（插件列表、MCP、设备、文件等）、事件监听（消息、连接、请求、通知）、进群/退群/撤回/邀请等小功能。

工作流由全局 `Bot.StreamLoader` 从各插件的 `stream/` 目录扫描并加载；AI 助手只负责“何时触发、用哪个流、传什么人设”。

---

## 二、目录结构

```
plugins/system-plugin/
├── adapter/           # 协议适配器（连接真实端）
│   ├── OneBotv11.js  # QQ OneBot 11 协议
│   ├── stdin.js      # 标准输入/调试
│   ├── QBQBot.js
│   ├── GSUIDCORE.js
│   └── ComWeChat.js
├── stream/            # AI 工作流（MCP 工具在此注册）
│   ├── chat.js        # 聊天 + 群管/互动/表情/消息
│   ├── memory.js      # 长期记忆
│   ├── tools.js       # 读写/搜索/执行（read/grep/write/run）
│   ├── database.js    # 知识库
│   ├── desktop.js     # 桌面/系统/浏览器等
│   └── device.js      # 设备语音与表情
├── plugin/             # 消息/请求级插件
│   ├── ai.js          # XRK-AI 助手（入口，调 chat/chat-merged）
│   ├── recallReply.js # 撤回回复
│   ├── invite.js      # 主人邀请自动进群
│   ├── quit.js        # 退群
│   ├── friend.js
│   ├── status.js
│   ├── disablePrivate.js
│   ├── 进群退群通知.js
│   ├── 伪造消息.js
│   ├── 主动复读.js
│   ├── 模拟定时输入.js
│   └── 葵崽插件.js
├── http/               # HTTP 服务与 API
│   ├── core.js        # 核心接口（系统信息等）
│   ├── plugin.js      # 插件列表/统计
│   ├── mcp.js         # MCP JSON-RPC
│   ├── ai.js          # AI 相关接口
│   ├── bot.js
│   ├── device.js
│   ├── files.js
│   ├── config.js
│   ├── write.js
│   └── stdin.js
├── events/             # 事件监听器
│   ├── message.js     # message 事件
│   ├── connect.js
│   ├── request.js
│   ├── notice.js
│   └── online.js
├── commonconfig/       # 通用配置（ConfigManager 加载，供 API/前端编辑）
│   ├── system.js       # 系统配置（bot/other/server/device 等子配置）
│   ├── ai_config.js    # AI 助手配置（data/ai/config.yaml），键名 system-plugin_ai_config
│   ├── openai_llm.js
│   ├── openai_compat_llm.js
│   ├── anthropic_llm.js
│   ├── azure_openai_llm.js
│   ├── volcengine_llm.js
│   ├── xiaomimimo_llm.js
│   ├── gptgod_llm.js
│   ├── gemini_llm.js
│   ├── volcengine_asr.js
│   ├── volcengine_tts.js
│   └── tools.js
├── www/                # 前端静态与页面
│   └── xrk/
├── SYSTEM-PLUGIN.md    # 本文档
└── .gitignore
```

---

## 三、核心模块

### 3.1 适配器（adapter）

将各端的连接与消息转为框架统一事件（如 `message`、`request`、`notice`），并挂载 `sendMsg`、`sendApi`、`pickGroup`、`pickFriend`、`pickMember` 等能力。

| 文件         | 说明 |
|--------------|------|
| **OneBotv11.js** | QQ 端，OneBot 11 协议。支持群/私聊消息、戳一戳（群+私聊）、群管、好友、MCP 等；`sendPoke` 群聊传 `group_id+user_id`，私聊仅传 `user_id`。 |
| **stdin.js**     | 标准输入，便于本地/调试。 |
| **QBQBot.js**    | QQ 协议另一实现。 |
| **GSUIDCORE.js** | 对应端适配。 |
| **ComWeChat.js** | 微信端适配。 |

适配器通过 `Bot.adapter.push(adapterInstance)` 注册；事件经 `events/message.js` 等进入插件规则与 AI 流程。

### 3.2 工作流（stream）

工作流继承 `lib/aistream/aistream.js` 的 `AIStream`，在 `init()` 里调用 `registerMCPTool()` 注册工具。`StreamLoader` 会扫描所有 `plugins/<插件名>/stream/*.js` 并加载，再将各流注册的 MCP 工具汇总到统一的 MCP 服务。

| 工作流      | 说明与主要工具 |
|-------------|----------------|
| **chat**    | 智能聊天与群内互动。工具：`reply`、`at`（可选 text）、`emotion`（表情包，可选 text）、`poke`（群/私聊）、`emojiReaction`、`thumbUp`、`sign`、`mute`/`unmute`、`muteAll`/`unmuteAll`、`setCard`、`setGroupName`、`setAdmin`/`unsetAdmin`、`setTitle`、`kick`、`setEssence`/`removeEssence`、`announce`、`recall`、`getGroupInfoEx`、`getAtAllRemain`、`getBanList`、`setGroupTodo`、`getFriendList`、`getGroupMembers` 等。 |
| **memory**  | 长期记忆。工具：`save_memory`、`query_memory`、`list_memories`。存储目录 `~/.xrk/memory`。 |
| **tools**   | 文件与执行。工具：`read`、`grep`、`write`、`run`。工作区默认 `~/Desktop`。 |
| **database**| 知识库。工具：`save_knowledge`、`query_knowledge`、`list_knowledge`。存储目录 `~/.xrk/knowledge`。 |
| **desktop** | 桌面/系统/浏览器等（如 `show_desktop`、`open_browser`、`open_application` 等）。 |
| **device**  | 设备语音与表情驱动，多用于设备端对话。 |

合并流（见下）会把主工作流与若干副工作流的工具合并到一个虚拟流（如 `chat-merged`），供 AI 一次调用。

### 3.3 插件（plugin）

- **ai.js（XRK-AI 助手）**  
  - 监听 `message`，根据 `data/ai/config.yaml` 判断是否触发（白名单群/用户、@ 或前缀、冷却与概率）。  
  - 触发后取 `chat` 或合并流 `chat-merged`，调用 `stream.process(e, { content, persona, ... })`。  
  - 若配置了 `mergeStreams`，会在 `init` 时调用 `StreamLoader.mergeStreams({ name: 'chat-merged', main: 'chat', secondary: mergeStreams, prefixSecondary: true })`。

- **recallReply.js**：回复撤回（如 `#撤回`），仅主人。  
- **invite.js**：处理 `request.group.invite`，主人邀请自动同意并私聊回复。  
- **quit.js**：退群相关。  
- **friend.js**：好友相关。  
- **status.js**：状态查询。  
- **disablePrivate.js**：禁用私聊/好友戳一戳等。  
- **进群退群通知.js**：新人进群、退群通知。  
- **伪造消息.js**、**主动复读.js**、**模拟定时输入.js**：示例或扩展功能。
- **葵崽插件.js**：主人发送「向日葵妈咪妈咪哄」一键安装/更新向日葵插件（XRK-plugin）与原神适配器（XRK-Genshin-Adapter-plugin）；也可在 Web 控制台、stdin 或 API 中发送该指令（上述渠道默认视为主人）。GitCode 克隆失败时自动切换 GitHub 镜像。

### 3.4 HTTP（http）

在框架 HTTP 服务上挂载路由，提供：

- **plugin.js**：插件列表与统计（如 `GET /api/plugins`）。  
- **mcp.js**：MCP 服务 HTTP 入口（如 `POST /api/mcp/jsonrpc`、`/api/mcp/jsonrpc/:stream`）。  
- **core.js**：系统信息、设备等。  
- **config.js**：配置管理 API（`/api/config/:name/read`、`write`、`structure`、`validate`、`backup` 等）。  
- **ai.js**、**bot.js**、**device.js**、**files.js**、**write.js**、**stdin.js**：各自业务 API。

### 3.5 事件（events）

- **message.js**：监听 `message` 事件，由适配器上报的消息经此进入规则与 AI。  
- **connect / request / notice / online**：连接、加群请求、通知、上线等。

### 3.6 通用配置（commonconfig）

- **ConfigManager**（ConfigLoader）扫描：项目根下 **config/commonconfig**（若存在）、以及各插件目录 **plugins/&lt;插件名&gt;/commonconfig/** 下的 `.js` 文件；加载后通过 **配置管理 API**（`http/config.js`，路由前缀 `/api/config/:name/`）暴露读写。
- **system.js**：系统级子配置（bot、other、server、device、aistream 等），对应 `data/server_bots/{port}/` 或 `config/default_config/` 下各 yaml；loader 对 system-plugin 的 system 做特殊映射，**键名为 `system`**。
- **ai_config.js**：AI 助手配置，对应 **data/ai/config.yaml**，**键名为 `system-plugin_ai_config`**（插件名_文件名）。用户可通过 `GET /api/config/system-plugin_ai_config/read`、`POST /api/config/system-plugin_ai_config/write` 等接口或前端配置页编辑，与 `plugin/ai.js` 读取的为同一文件。
- 其余为 LLM/ASR/TTS 等工厂配置（OpenAI、Volc、小蜜、Gemini 等），被 aistream 等引用。

---

## 四、AI 助手与配置

### 4.1 配置文件

路径：**`data/ai/config.yaml`**（与 commonconfig **ai_config** 为同一文件，可通过配置管理 API 或前端编辑，见 4.4）。

| 字段           | 说明 |
|----------------|------|
| `persona`      | 人设/系统提示中的角色描述，会传入工作流。 |
| `prefix`       | 触发前缀，消息以此开头且在白名单内会触发。 |
| `groups`       | 白名单群 ID 列表，仅这些群可触发（@ 或前缀或随机）。 |
| `users`        | 白名单用户 ID 列表，私聊仅这些用户可触发。 |
| `cooldown`     | 群内随机触发冷却（秒）。 |
| `chance`       | 群内随机触发概率（0～1）。 |
| `mergeStreams` | 要合并到 chat 的副工作流名称列表，如 `['memory','tools','database']`；存在则使用合并流 `chat-merged`。 |

示例：

```yaml
persona: 你是本群助手，正常聊天、解决问题。
prefix: 李诗雅
groups: []
users: []
cooldown: 300
chance: 0.1
mergeStreams:
  - memory
  - tools
  - database
```

### 4.2 触发逻辑（ai.js）

1. **@ 机器人** 或 **消息以 prefix 开头**：在白名单群/用户内即触发。  
2. **群内未 @、无前缀**：在白名单群内且通过冷却与概率（`cooldown`、`chance`）则随机触发。  
3. 使用流：若配置了 `mergeStreams` 则用 `chat-merged`，否则用 `chat`。  
4. 调用 `stream.process(e, { content, text, persona, isGlobalTrigger })`；内容会做回复上下文、@ 转文本等处理。

### 4.3 合并流（chat-merged）

- 由 `StreamLoader.mergeStreams()` 在 AI 助手 `init` 时注册。  
- 主工作流：`chat`；副工作流：配置中的 `mergeStreams`。  
- 合并后 AI 在一次对话中可同时使用 chat 的回复/群管/表情与 memory、tools、database 等工具，无需切换流。

### 4.4 AI 配置的编辑方式（commonconfig）

- **commonconfig/ai_config.js** 将 `data/ai/config.yaml` 注册到 **ConfigManager**，键名为 **system-plugin_ai_config**。  
- 用户可通过 **配置管理 API** 读写，与 `plugin/ai.js` 使用同一文件，无需手改 YAML：
  - **GET /api/config/system-plugin_ai_config/read**：读取当前配置。  
  - **POST /api/config/system-plugin_ai_config/write**：写入完整配置（body：`{ data: { persona, prefix, groups, users, cooldown, chance, mergeStreams } }`）。  
  - 其他与通用配置 API 一致：`GET /api/config/system-plugin_ai_config/structure`，`POST .../validate`、`.../backup` 等。  
- 支持通过前端配置页（若项目提供）对 AI 助手进行表单化编辑。

---

## 五、扩展与注意

1. **新增工作流**：在 `plugins/<某插件>/stream/` 下新增 `xxx.js`，导出继承 `AIStream` 的类，实现 `init()` 并在其中 `registerMCPTool()`。StreamLoader 会自动扫描并加载。  
2. **合并到聊天**：在 `data/ai/config.yaml` 的 `mergeStreams` 中加上工作流名称即可（如 `desktop`、`device`），前提是 AI 助手 init 时已调用 `mergeStreams`。  
3. **适配器**：新端实现与 OneBotv11 类似的接口（事件上报、`sendMsg`、`sendApi` 等），并 `Bot.adapter.push(实例)`。  
4. **表情包资源**：chat 工作流从 `resources/aiimages/{开心|惊讶|伤心|大笑|害怕|生气}/` 读取图片，可按需放置。  
5. **文档与仓库**：本文档仅描述 system-plugin 自带的能力与结构。框架底层文档见项目根 **`docs/`** 与 **`docs/overview/DEVELOPER_HUB.md`**（核心对象、插件/工作流基类、适配器、配置等）。

---

## 六、小结

| 模块     | 作用 |
|----------|------|
| **adapter** | 多端连接与消息/事件上报，挂载发送与 pick 系列 API。 |
| **stream**  | AI 工作流与 MCP 工具，chat 负责聊天与群管，其余负责记忆/工具/知识库/桌面/设备等。 |
| **plugin**  | AI 助手入口（ai.js）与撤回、邀请、退群等小功能。 |
| **http**    | 插件列表、MCP、配置管理、设备、文件等 API。 |
| **events**  | 统一事件入口（message、connect 等）。 |
| **commonconfig** | 通用配置（含 system、**ai_config**、LLM/ASR/TTS 等）；system-plugin_ai_config 对应 data/ai/config.yaml，可经 API 编辑。 |

通过 `data/ai/config.yaml` 配置人设、白名单、冷却、概率与 `mergeStreams`，即可控制“谁在哪些群/私聊里、以何种方式触发 AI”以及“聊天时能用哪些工作流的工具”；该文件可通过 **/api/config/system-plugin_ai_config/read、write** 或前端配置页编辑。
