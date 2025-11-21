<div align="center">

# XRK-Yunzai v3.0.5

跨平台、多适配器的智能工作流机器人；承接 [Yunzai v3.0](https://gitee.com/le-niao/Yunzai-Bot) / [Miao-Yunzai](https://gitee.com/yoimiya-kokomi/Miao-Yunzai) / [TRSS-Yunzai](https://gitee.com/TimeRainStarSky/Yunzai) 的积累并持续现代化。

</div>

---

## ✨ Highlights

| 分类 | 能力 |
|------|------|
| 模块化工作流 | Chat / Device / File 等工作流并行、串行、管线化执行；内置记忆、推理、润色与语义检索。 |
| 统一对象 | `Bot`、事件 `e`、`logger`、`cfg`、`segment` 与全局 `redis` 客户端开箱即用，协议与设备场景一致。 |
| 现代 HTTP 栈 | Express + WebSocket + 反向代理 + HTTPS/HTTP2 + CORS + 限流 + 静态资源热重载。 |
| 插件生态 | 热重载、权限/优先级、上下文管理、多账号发送、转发消息、工作流调用。 |
| 渲染/面板 | Puppeteer / Playwright 渲染、Web 控制台、API 面板与静态站点。 |
| DevOps 友好 | Docker / Compose / PM2 / 原生 Node 统一入口，Redis 探活与自动拉起。 |

---

## 🧰 Tech Stack Overview

| 层级 | 组件 | 说明 |
|------|------|------|
| 运行时 | Node.js 18+、pnpm | ESM + 顶级 await，pnpm workspaces 管理插件依赖。 |
| Web 服务 | Express 4、`ws`、`http-proxy-middleware` | HTTP/WS、一体化代理、Helmet 安全头、独立速率限制器。 |
| 数据缓存 | Redis 5+（官方 client） | 记忆系统、会话缓存、API 限流、工作流 embedding、跨进程通信。 |
| 语义能力 | `node-fetch` + 第三方 LLM API | Chat Completions、流式输出、向量检索、轻量 BM25/ONNX/HF/fastText。 |
| 渲染与自动化 | Puppeteer / Playwright | 图像渲染、设备工作流截图、Web 控制台。 |
| 配置管理 | YAML + chokidar | 多端口隔离配置、热更新、默认值自动回写。 |

更多技术细节见 `docs/TECH_STACK.md`。

---

## 🧩 Runtime Objects & Redis

- **Bot**：事件驱动总线、HTTP/WS 服务、插件/工作流加载、代理协商、消息转发。
- **事件 `e`**：统一的消息/设备事件，内置 `reply`、`group`、`friend`、`member` 快捷方法。
- **`logger`**：多级别打印，配合 `BotUtil.makeLog()` 输出彩色日志。
- **`cfg`**：多层配置读取器，支持默认配置 + 端口隔离目录 + 热监听。
- **`segment`**：OneBot 消息片段构造器（图片、语音、转发等）。
- **`redis`**：由 `lib/config/redis.js` 初始化的全局客户端，职责包含：
  - AI 记忆：`ai:memory:*` / `ai:embedding:*`
  - 速率限制 / 缓存 / 会话锁
  - 状态持久化（如工作流上下文）

详细 API 请查阅 `docs/CORE_OBJECTS.md` 与各 reference 文档。

---

## 🚀 Quick Start

### 环境要求

| 组件 | 版本 |
|------|------|
| Node.js | ≥ 18.14.0 |
| Redis | ≥ 5.0.0（支持 RESP3） |
| 浏览器 | Chrome / Chromium / Edge（渲染或 Web 面板需要） |
| 包管理器 | 推荐 pnpm（npm/yarn 亦可） |

### 安装

```bash
# Gitcode（国内）
git clone --depth=1 https://gitcode.com/Xrkseek/XRK-Yunzai.git

# Gitee
git clone --depth=1 https://gitee.com/xrkseek/XRK-Yunzai.git

# GitHub
git clone --depth=1 https://github.com/Xrkseek/XRK-Yunzai.git

cd XRK-Yunzai
pnpm install   # 或 npm install / yarn
```

### 首次运行

```bash
node app   # 自动检查依赖 & 引导登录
```

按提示完成登录后即可在 `plugins/` 中开发工作流或 API。

---

## 🧱 Deployment Options

| 方式 | 步骤 | 适用场景 |
|------|------|---------|
| 原生 Node | `node app` | 开发/调试最快捷，自动检查依赖与 Redis 连接。 |
| Docker Compose | `docker-compose up -d` | 推荐；可一键启 Redis 与主程序、Volume 保留数据。 |
| Dockerfile | `docker build -t xrk-yunzai:latest .` → `docker run ...` | 适合 CI/CD、自托管。 |
| PM2 | `pm2 start app.js --name xrk-yunzai` | 持续运行、日志切割、自动拉起。 |

> **提示**：容器化部署务必映射 `data/ config/ plugins/ logs/ resources/`，首次登录可本地完成后再挂载。

---

## 🗂 Architecture Snapshot（已修订）

```
XRK-Yunzai/
├── app.js                 # 依赖检查 & 登录引导
├── start.js               # 生产入口（pm2 / docker 调用）
├── package.json
├── docker-compose.yml / Dockerfile / docker.sh
│
├── lib/
│   ├── bot.js             # Bot 主类
│   ├── aistream/
│   │   ├── aistream.js    # AIStream 基类
│   │   ├── memory.js      # MemorySystem
│   │   ├── workflow-manager.js
│   │   └── loader.js
│   ├── plugins/
│   │   ├── plugin.js      # 插件基类
│   │   └── loader.js
│   ├── http/              # API 基类 + loader
│   ├── listener/          # 事件监听 loader
│   ├── renderer/          # 渲染器 loader
│   ├── common/            # BotUtil, common helpers
│   └── config/            # cfg, redis, log
│
├── plugins/
│   ├── adapter/           # 协议接入 (OneBotv11, ComWeChat…)
│   ├── api/               # REST/WS/SSE
│   ├── stream/            # AI 工作流 (chat/device/…)
│   ├── events/            # 消息/系统事件
│   ├── system/ other/ …   # 系统工具类插件
│
├── config/
│   ├── default_config/*.yaml   # 默认模板
│   ├── cmd/tools.yaml
│   └── commonconfig/           # 公共配置加载
│
├── data/                  # 字体 / 渲染输出 / 登录数据
├── docs/                  # 开发文档 & 参考
├── renderers/             # Puppeteer / Playwright
├── www/                   # Web Panel & 静态资源
└── components/            # TTS/ASR/Utility 组件
```

---

## 📘 Documentation Hub & 导航

| 主题 | 入口 | 说明 |
|------|------|------|
| 技术栈全景 | [`docs/TECH_STACK.md`](./docs/TECH_STACK.md) | 框架栈、依赖、部署策略。 |
| 开发者导航（可视化） | [`docs/overview/DEVELOPER_HUB.md`](./docs/overview/DEVELOPER_HUB.md) | Mermaid 拓扑展示 `Bot → Plugins → Workflows` 关系及基类入口。 |
| 核心对象 | [`docs/CORE_OBJECTS.md`](./docs/CORE_OBJECTS.md) | Bot / 事件 `e` / 全局对象速查。 |
| Bot 函数全集 | [`docs/reference/BOT.md`](./docs/reference/BOT.md) | Server 生命周期、代理、好友/群等全部方法。 |
| 工作流 & 记忆 | [`docs/reference/WORKFLOWS.md`](./docs/reference/WORKFLOWS.md) | `AIStream` / `MemorySystem` / `WorkflowManager` 全函数。 |
| 插件运行时 | [`docs/reference/PLUGINS.md`](./docs/reference/PLUGINS.md) | 上下文管理、工作流调用、渲染。 |
| HTTP / WS API | [`docs/reference/HTTP.md`](./docs/reference/HTTP.md) | `HttpApi` 生命周期、路由/WS 注册。 |
| 配置 & Redis | [`docs/reference/CONFIG_AND_REDIS.md`](./docs/reference/CONFIG_AND_REDIS.md) | `cfg` API、Redis 初始化/事件。 |
| 用户向文档 | [`stdin.md`](./stdin.md) | 面板/功能简介。 |

> 基类的开发策略、调用顺序与示例在导航页集中展示，可从 README 直接跳转到子文档。

所有 reference 文件均针对源码中每个函数提供签名、参数类型、返回值与示例，不再遗漏。

---

## ⚙️ Configuration Quick View

主要配置位于 `config/default_config/*.yaml`，首次运行自动复制到 `data/server_bots/<port>/`。

- `kuizai.yaml`：AI 接口、推理、润色、工作流默认值。
- `server.yaml`：HTTP/HTTPS、CORS、安全策略、静态目录。
- `redis.yaml`：Redis 连接信息与数据库序号。
- `device.yaml` / `group.yaml` / `notice.yaml`：设备、群、通知策略。

> 优先级：运行时传入 > `cfg` 实例化时覆盖 > `data/server_bots/<port>` > `config/default_config` > 内置默认值。详情见 `docs/reference/CONFIG_AND_REDIS.md#配置优先级`。

---

## 🧪 Code Examples

<details>
<summary>插件内调用 Chat 工作流</summary>

```js
// plugins/example/workflow-demo.js
import plugin from '../../lib/plugins/plugin.js';

export default class WorkflowDemo extends plugin {
  constructor() {
    super({
      name: 'workflow-demo',
      event: 'message',
      rule: [{ reg: '^#ai (.+)$', fnc: 'chat' }]
    });
  }

  async chat(e) {
    const question = e.msg.replace(/^#ai\s+/, '');
    const result = await this.callWorkflow('chat', { question }, { e });
    return this.reply(result?.content || '暂无回复');
  }
}
```

</details>

<details>
<summary>独立 REST API</summary>

```js
// plugins/api/ping.js
export default {
  name: 'ping-api',
  dsc: '健康检查',
  routes: [{
    method: 'GET',
    path: '/api/ping',
    handler: async (req, res) => {
      res.json({ success: true, pong: Date.now() });
    }
  }]
};
```

</details>

<details>
<summary>自定义工作流</summary>

```js
// plugins/stream/file-builder.js
import AIStream from '../../lib/aistream/aistream.js';

export default class FileBuilder extends AIStream {
  constructor() {
    super({
      name: 'file-builder',
      description: '根据提示生成文本，落地为文件',
      config: { temperature: 0.6 }
    });
  }

  buildSystemPrompt() {
    return '你是文件生成器，只输出可写入文件的纯文本。';
  }

  async buildChatContext(e, question) {
    return [
      { role: 'system', content: this.buildSystemPrompt({ e, question }) },
      { role: 'user', content: question?.text || String(question) }
    ];
  }
}
```

</details>

---

## 🧭 Roadmap

- ✅ PM2 支持
- ✅ 任务处理器开源化（MySQL、公众号等）
- ✅ 农业场景设备工作流
- ✅ 任务类型体系与安全能力
- 🔄 拆分底层协议依赖、精简适配
- 🔄 更多工作流模板与智能体互操作

---

## 🙏 Credits

| 项目 | 作者 | 贡献 |
|:----:|:-----|:-----|
| [Yunzai v3.0](https://gitee.com/le-niao/Yunzai-Bot) | 乐神 | 元老级项目基座 |
| [Miao-Yunzai v3.1.3](https://gitee.com/yoimiya-kokomi/Miao-Yunzai) | 喵喵 | 功能优化与原神适配 |
| [TRSS-Yunzai v3.1.3](https://gitee.com/TimeRainStarSky/Yunzai) | 时雨 | Node 端底层设计灵感 |

> 感谢贡献者、测试者与使用者。欢迎提交 Issue / PR，共建更强大的 XRK-Yunzai！
