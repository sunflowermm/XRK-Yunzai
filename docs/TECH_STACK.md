# XRK-Yunzai 技术栈全景

本文档盘点 XRK-Yunzai 的核心技术栈、依赖与关键决策，帮助开发者快速理解系统边界与可扩展点。

---

## 1. 运行时 & 语言特性

| 模块 | 说明 |
|------|------|
| Node.js 18+ | 原生 ES Modules、顶级 `await`、`fetch`、`AbortController`。 |
| pnpm workspaces | 插件与核心库共用一套依赖树，锁版本更快。 |
| Type Strategy | 目前 TypeScript 与 JSDoc 并存，核心库使用 JSDoc 注释暴露签名。 |

---

## 2. Web 服务层

| 组件 | 用途 |
|------|------|
| Express 4 | HTTP 路由、中间件体系、静态文件服务。 |
| `ws` | 原生 WebSocket 服务，覆盖插件、设备、OneBot 协议。 |
| `http-proxy-middleware` | 反向代理、SNI、多域名、路径重写。 |
| Helmet / rate-limit / compression | 安全头、限流、压缩。 |
| `http2` (可选) | HTTPS 启用 HTTP/2，支持降级。 |

关键设计：
- HTTP/HTTPS/代理共用 `Bot` 的生命周期，API/插件只需面向统一事件。
- 中间件注册顺序模拟 nginx：精确匹配、前缀、认证、静态。
- 白名单 + API-Key + 本地地址三层鉴权。

---

## 3. 数据与缓存

| 技术 | 描述 |
|------|------|
| Redis 5+ | 单实例即可；用于 AI 记忆、Embedding、速率限制、会话锁。 |
| `redis` 官方客户端 | RESP3、连接池计算（根据 CPU/内存）、自动健康检查。 |
| YAML 配置 | `config/default_config/*.yaml` + `data/server_bots/<port>/`，支持 chokidar 热更新。 |
| 内存缓存 | `BotUtil.getMap()` 生成带 TTL 的 Map，用于 IP 缓存、API key 等。 |

Redis 连接策略：
- 首次运行自动尝试拉起本地 redis-server（非生产环境）。
- 多次重连使用指数退避，日志掩码敏感信息。
- `global.redis` 注入全局，供插件/工作流直接使用。

---

## 4. 工作流 & AI 能力

| 组件 | 说明 |
|------|------|
| `lib/aistream/aistream.js` | AI 工作流基架，封装 Chat Completion、功能解析、上下文增强。 |
| Memory System | Redis ZSet + JSON 存储长短期记忆，按场景隔离。 |
| Workflow Manager | 注册/串行/并行执行工作流，带超时控制。 |
| Embedding provider | 轻量 BM25（默认）、ONNX、本地 fastText、HF API、自定义 HTTP API。 |
| `node-fetch` | 统一对外 HTTP 请求，支持 Abort 超时。 |

设计亮点：
- 工作流执行 pipeline：`buildChatContext → buildEnhancedContext → callAI → parseFunctions → runActionTimeline`。
- 函数调用解析器可由工作流自定义 `registerFunction`、`parser`、`handler`。
- Embedding 支持多提供商自动降级，结果落地 Redis 以供语义检索。

---

## 5. 插件/模块体系

| 目录 | 说明 |
|------|------|
| `lib/plugins/plugin.js` | 插件运行时：上下文、工作流调用、热重载钩子。 |
| `plugins/stream/` | 工作流脚本目录（Chat、Device、文件处理等）。 |
| `plugins/api/` | REST/SSE/WS API 声明式路由。 |
| `plugins/adapter/` | 协议适配器（OneBotv11、ComWeChat 等）。 |
| `plugins/system/` | 内置权限、好友维护、邀请处理。 |

特性：
- 插件定义 `rule` 以正则/函数匹配事件。
- `callWorkflow / callWorkflows / callWorkflowsSequential` 提供工作流 Orchestration。
- 通过 `stateArr` 提供上下文等待、超时取消能力。

---

## 6. 渲染与前端

| 组件 | 用途 |
|------|------|
| Puppeteer / Playwright | 图片渲染、面板截图、设备反馈。 |
| `renderers/*/config_default.yaml` | 渲染器配置（浏览器路径、无头模式等），自动复制到服务器工作目录。 |
| `www/` | 内置 Web 面板（`www/xrk/app.js`）、静态资源与 favicon。 |

---

## 7. DevOps & 工具

| 文件 | 描述 |
|------|------|
| `docker-compose.yml` | Node + Redis 一键启动，包含 Volume 与健康检查。 |
| `Dockerfile` | 多阶段构建，便于 CI/CD。 |
| `docker.sh` | Linux 快速部署脚本。 |
| `debug.js` | 本地调试入口，可禁用某些模块。 |
| `pnpm-workspace.yaml` | 工作区配置。 |

---

## 8. 扩展建议

- **更多协议**：在 `plugins/adapter` 新增适配器，复用 `Bot`/`e` API，可参考 OneBotv11 实现。
- **任务编排**：基于 Workflow Manager 快速构建多工作流协作（串行/并行/条件触发）。
- **观测性**：结合 `logger` 与 `Bot._setupRequestLogging` 输出结构化日志，再由 Loki/ELK 收集。
- **Redis 集群**：如需高可用，可将 `cfg.redis` 指向哨兵/集群并扩展 `redisInit` 逻辑。

---

> 进一步的函数级 API 说明，请查阅 `docs/reference/*.md`。***

