# 配置系统 & Redis 客户端手册

> `lib/config/config.js`（Cfg 单例）与 `lib/config/redis.js` 的 API 摘要。

---

## 1. Cfg 单例 (`lib/config/config.js`)

单例，负责 YAML 配置加载、缓存与 chokidar 热更新；支持多端口隔离（`node app server <port>` → `data/server_bots/<port>/`）。

### 1.1 路径与目录

| 常量/方法 | 说明 |
|----------|------|
| `PATHS.DEFAULT_CONFIG` | `config/default_config` |
| `PATHS.SERVER_BOTS` | `data/server_bots` |
| `PATHS.RENDERERS` | `renderers` |
| `ensureServerConfigDir()` | 若指定端口则确保 `data/server_bots/<port>/` 存在，并复制端口级默认配置 |
| `getConfigDir()` | 返回 `data/server_bots/<port>` |

端口级复制文件：`bot.yaml`、`other.yaml`、`group.yaml`、`notice.yaml`、`server.yaml`。

### 1.2 配置 Getter（cfg.xxx）

| Getter | 来源/说明 |
|--------|-----------|
| `cfg.bot` | 合并默认 + 端口 `bot.yaml`；自动加 `platform`、`data_dir`、`server.port` |
| `cfg.other` | `other.yaml`；常用：masterQQ、autoFriend、disablePrivate、whiteGroup、blackGroup 等 |
| `cfg.redis` | Redis 连接：host、port、db、username、password |
| `cfg.server` | 端口、URL、https、proxy、security |
| `cfg.device` | `device.yaml` |
| `cfg.renderer` | 渲染器配置（playwright/puppeteer），合并默认 + 端口 |
| `cfg.notice` | `notice.yaml`（iyuu、sct、feishu_webhook 等） |
| `cfg.db` | `db.yaml` |
| `cfg.monitor` | `monitor.yaml` |
| `cfg.aistream` | `aistream.yaml` |
| `cfg.llm` | 所有 LLM 提供商配置（由 LLMFactory 等提供） |
| `cfg.masterQQ` | 从 other 归一化得到的主人 QQ 数组 |
| `cfg.master` | 兼容用：`{ bot_uin: [masterQQ] }` |
| `cfg.package` | `package.json` 内容（带缓存） |

### 1.3 配置读取 / 写入

| 方法 | 说明 |
|------|------|
| `getdefSet(name)` | 仅读默认配置 `config/default_config/<name>.yaml`，缓存键 `default.<name>` |
| `getConfig(name)` | 读端口配置，合并默认；缓存键 `server.<port>.<name>`；无则从默认复制并 watch |
| `getGroup(groupId?)` | 群配置：默认 default → 端口 default → 指定群；用于别名、权限等 |
| `setConfig(name, data)` | 写回 `data/server_bots/<port>/<name>.yaml` 并更新缓存 |
| `setOther(data)` | `setConfig('other', data)` |
| `setGroup(data)` | `setConfig('group', data)` |

### 1.4 监听与清理

- **watch(file, name, key)**：对文件建立 chokidar 监听；变更时清缓存，若有 `change_<name>` 则调用（如 `change_bot` 会重载日志）。
- **destroy()**：关闭所有 watcher、清空 config 缓存。

### 1.5 使用示例

```javascript
import cfg from './lib/config/config.js';

const botConfig = cfg.bot;
const master = cfg.masterQQ;
const groupCfg = cfg.getGroup('123456789');
cfg.setOther({ masterQQ: [123456789] });
```

---

## 2. Redis (`lib/config/redis.js`)

基于官方 `redis` 客户端（v4+），RESP3、连接池、指数退避重连、健康检查；初始化后挂载到 `global.redis`。

### 2.1 导出函数

| 函数 | 说明 |
|------|------|
| `redisInit()` | 建立连接并挂载到 `global.redis`；失败则重试，开发环境会尝试拉起 redis-server；最终失败则 `process.exit(1)` |
| `closeRedis()` | 优雅关闭连接 |
| `getRedisClient()` | 返回当前全局客户端实例，未初始化为 null |

### 2.2 内部工具（供实现/测试用）

- **buildRedisUrl(cfg.redis)** → 连接 URL  
- **buildClientConfig(url)** → 客户端配置（含 reconnectStrategy、连接池等）  
- **createReconnectStrategy()** → 指数退避重连  
- **getOptimalPoolSize()** → 根据 CPU/内存返回 3–50  
- **attemptRedisStart(retryCount)** → 开发环境尝试启动 redis-server  
- **registerEventHandlers(client)** / **startHealthCheck(client)** → 事件与定时 PING  
- **maskRedisUrl(url)** → 日志掩码密码  

### 2.3 使用与事件

初始化后使用 `global.redis` 或 `getRedisClient()`，支持标准 Redis 命令（set/get、lPush/lRange、zAdd、hSet、expire、multi 等）。  
客户端事件：`error`、`ready`、`reconnecting`、`end`。

### 2.4 配置示例（redis.yaml）

```yaml
redis:
  host: localhost
  port: 6379
  db: 0
  username: ''
  password: ''
```

---

## 3. 配置优先级（参考）

运行时传入 > 端口目录配置 > 默认配置 > 代码默认值。多端口时配置隔离在 `data/server_bots/<port>/`。

---

## 4. 常见问题

- **配置修改未生效**：确认 chokidar 正常、日志是否有配置变更记录。  
- **Redis 连不上**：检查服务是否启动、cfg.redis、端口与防火墙。  
- **多端口不同配置**：使用 `node app server <port>`，配置按端口隔离。  
- **Redis 命令**：见 [redis 官方文档](https://redis.io/commands)。
