# 配置系统 & Redis 客户端手册

> 包含 `lib/config/config.js` 与 `lib/config/redis.js` 的所有导出/工具函数。

---

## 1. `Cfg` 单例 (`lib/config/config.js`)

### constructor()
- 初始化 `config` 缓存、端口信息、文件监听器与路径常量；若通过 `node app server <port>` 启动会自动复制默认配置。

### ensureServerConfigDir()
- **作用**: 确保 `data/server_bots/<port>/` 存在；不存在时复制 `config/default_config`。

### getConfigDir()
- **返回**: 当前端口对应的配置目录路径。

### get bot()
- 加载 `bot.yaml`（默认 + 服务器目录），追加 `platform`、`data_dir`、`server.port`。

### get other() / getOther()
- 合并默认 & 服务器级 `other.yaml`。

### get redis()
- 返回 Redis 连接配置（`host/port/db/password/...`）。

### get renderer()
- **作用**: 懒加载 `renderers/<type>/config_default.yaml` 与服务器目录 `config.yaml`，并为每个文件创建 watcher。

### get notice() / getNotice()
- 合并默认/服务器 `notice.yaml`。

### get server()
- 返回 `server.yaml` 配置（HTTP/HTTPS/代理/安全）。

### get device()
- 返回 `device.yaml`。

### get db()
- 返回 `db.yaml`。

### get monitor()
- 返回 `monitor.yaml`。

### get kuizai()
- 返回 `kuizai.yaml`。

### get masterQQ()
- 将 `other.masterQQ` 转换为数组并统一为数字/字符串。

### get master()
- 构造 `{ bot_uin: masterQQ[] }` 映射，兼容旧逻辑。

### get package()
- 懒读取 `package.json`。

### get aistream()
- 返回 `aistream.yaml`。

### getGroup(groupId = '', userID = '')
- 合并 `group.yaml` 默认配置与指定群配置。

### setConfig(name, data)
- **作用**: 写入 `data/server_bots/<port>/<name>.yaml`，更新缓存并打印日志。

### setOther(data) / setGroup(data)
- 分别调用 `setConfig('other', data)` / `setConfig('group', data)`。

### getdefSet(name)
- **作用**: 读取 `config/default_config/<name>.yaml` 并缓存。

### getConfig(name)
- **作用**: 读取服务器级配置；如缺失则复制默认文件；最后调用 `watch()` 监听变更。

### watch(file, name, key)
- **作用**: 使用 `chokidar` 监听文件，变更后清除缓存并调用 `change_<name>` 钩子（若存在）。

### change_bot()
- **作用**: 在 `bot.yaml` 修改时重新加载 `config/log.js`。

### destroy()
- **作用**: 关闭所有 watcher 并清空缓存。

---

## 2. Redis 客户端 (`lib/config/redis.js`)

### redisInit()
- **签名**: `async redisInit(): Promise<RedisClientType>`
- **流程**:
  1. 若全局客户端存在直接返回。
  2. 通过 `buildRedisUrl(cfg.redis)` 组合连接串。
  3. 按 `buildClientConfig` 创建 client，并最多重试 `MAX_RETRIES` 次。
  4. 注册事件监听器与健康检查，将实例挂到 `global.redis`。

### buildRedisUrl(redisConfig)
- **作用**: 生成 `redis://[user[:pass]@]host:port/db` 字符串。

### buildClientConfig(redisUrl)
- **作用**: 返回 `{ url, socket: { reconnectStrategy, connectTimeout }, connectionPoolSize, commandsQueueMaxLength }`。

### createReconnectStrategy()
- **作用**: 指数退避（每次 ×2，最大 30s），并记录日志。

### getOptimalPoolSize()
- **作用**: 基于 CPU 核数与内存估算连接池大小（3~50）。

### attemptRedisStart(retryCount)
- **作用**: 在开发环境尝试执行 `redis-server --daemonize yes ...` 自动启服务。

### handleFinalConnectionFailure(error, port)
- **作用**: 打印排障提示并在生产级失败时 `process.exit(1)`。

### registerEventHandlers(client)
- **作用**: 对 Redis client 绑定 `error/ready/reconnecting/end` 事件，并在错误时尝试重连。

### startHealthCheck(client)
- **作用**: 每 30 秒 `PING` 一次，打印健康日志。

### getArchitectureOptions()
- **作用**: 在非 Windows 平台检测架构；ARM64 + Redis≥6 时附加 `--ignore-warnings ARM64-COW-BUG`。

### execCommand(cmd)
- **作用**: `child_process.exec` Promise 化封装，返回 `{ error, stdout, stderr }`。

### maskRedisUrl(url)
- **作用**: 将连接串中的密码部分替换为 `******`，用于日志。

### closeRedis()
- **签名**: `async closeRedis(): Promise<void>`
- **作用**: 关闭全局客户端（优先 `quit`，失败则 `disconnect`）。

### getRedisClient()
- **作用**: 返回当前全局 Redis 实例（若未初始化则为 `null`）。

---

## 3. 使用提示

- `cfg` 单例已自动导出并注入到全局，可 `import cfg from './lib/config/config.js'` 或直接访问 `global.cfg`。
- Redis 客户端初始化后可在任意模块使用 `global.redis`，但推荐先判断 `redisInit` 是否成功。
- 文件监听器在内存中保留，扩展配置字段时记得复用 `watch()` 以支持热更新。***

