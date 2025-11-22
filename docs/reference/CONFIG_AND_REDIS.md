<div align="center">

# 配置系统 & Redis 客户端完整手册

> 包含 `lib/config/config.js` 与 `lib/config/redis.js` 的所有导出/工具函数、属性与方法。

</div>

---

<div align="center">

## 1. `Cfg` 单例 (`lib/config/config.js`)

</div>

`Cfg` 是配置管理类的单例实例，负责加载、缓存和监听 YAML 配置文件。支持多端口隔离配置，自动热更新。

### 1.1 构造函数与初始化

#### constructor()
- **作用**: 初始化配置系统
- **功能**:
  - 初始化 `config` 内存缓存对象
  - 从命令行参数解析端口号（`node app server <port>`）
  - 初始化文件监听器 `watcher` 对象
  - 设置路径常量 `PATHS`
  - 如果指定了端口，自动调用 `ensureServerConfigDir()` 确保配置目录存在

#### PATHS 路径常量
```javascript
{
  DEFAULT_CONFIG: 'config/default_config',      // 默认配置目录
  SERVER_BOTS: 'data/server_bots',              // 服务器配置目录
  RENDERERS: 'renderers'                        // 渲染器配置目录
}
```

### 1.2 目录管理方法

#### ensureServerConfigDir()
- **作用**: 确保服务器配置目录存在
- **流程**:
  1. 检查是否指定了端口（`this._port`）
  2. 如果配置目录不存在，创建目录
  3. 从 `config/default_config` 复制所有默认配置文件到 `data/server_bots/<port>/`
- **触发时机**: 构造函数中自动调用（如果指定了端口）

#### getConfigDir()
- **返回**: `string` - 当前端口对应的配置目录路径
- **格式**: `data/server_bots/<port>`
- **示例**: `data/server_bots/8086`

### 1.3 配置获取器（Getter）

#### get bot()
- **返回**: `Object` - 机器人配置对象
- **来源**: 合并 `config/default_config/bot.yaml` 和 `data/server_bots/<port>/bot.yaml`
- **自动追加属性**:
  - `platform: 2` - 平台标识
  - `data_dir: 'data/server_bots/<port>'` - 数据目录路径
  - `server.port: <port>` - 服务器端口
- **用途**: 机器人账号、日志、渲染器等配置

#### get other() / getOther()
- **返回**: `Object` - 其他配置对象
- **来源**: 合并默认和服务器级 `other.yaml`
- **常用字段**:
  - `masterQQ` - 主人QQ号数组
  - 其他自定义配置项
- **注意**: `getOther()` 是方法形式，功能相同

#### get redis()
- **返回**: `Object` - Redis 连接配置
- **字段**:
  - `host` - Redis 主机地址
  - `port` - Redis 端口
  - `db` - 数据库编号
  - `username` - 用户名（可选）
  - `password` - 密码（可选）

#### get renderer()
- **返回**: `Object` - 渲染器配置对象
- **结构**: `{ playwright: {...}, puppeteer: {...} }`
- **加载流程**:
  1. 读取 `renderers/<type>/config_default.yaml` 作为默认配置
  2. 读取 `data/server_bots/<port>/renderers/<type>/config.yaml` 作为服务器配置
  3. 服务器配置覆盖默认配置
  4. 如果服务器配置文件不存在，自动创建
  5. 为每个配置文件创建 `chokidar` 监听器，支持热更新
- **支持的渲染器类型**: `playwright`, `puppeteer`

#### get notice() / getNotice()
- **返回**: `Object` - 通知配置对象
- **来源**: 合并默认和服务器级 `notice.yaml`
- **用途**: 系统通知、提醒等配置

#### get server()
- **返回**: `Object` - 服务器配置对象
- **字段**:
  - `server.port` - HTTP 端口
  - `server.url` - 服务器URL
  - `https` - HTTPS 配置
  - `proxy` - 反向代理配置
  - `security` - 安全配置

#### get device()
- **返回**: `Object` - 设备配置对象
- **来源**: `device.yaml`
- **用途**: 设备事件相关配置

#### get db()
- **返回**: `Object` - 数据库配置对象
- **来源**: `db.yaml`
- **用途**: 数据库连接配置

#### get monitor()
- **返回**: `Object` - 监控配置对象
- **来源**: `monitor.yaml`
- **用途**: 系统监控相关配置

#### get kuizai()
- **返回**: `Object` - 快哉配置对象
- **来源**: `kuizai.yaml`
- **用途**: AI 相关配置

#### get aistream()
- **返回**: `Object` - AI工作流配置对象
- **来源**: `aistream.yaml`
- **用途**: AI 工作流相关配置

#### get masterQQ()
- **返回**: `Array<number|string>` - 主人QQ号数组
- **处理逻辑**:
  1. 从 `other.masterQQ` 读取（可能是单个值或数组）
  2. 统一转换为数组
  3. 数字字符串转换为数字，其他保持原样
- **用途**: 权限判断、主人命令识别

#### get master()
- **返回**: `Object` - 主人映射对象（向后兼容）
- **结构**: `{ bot_uin: [masterQQ数组] }`
- **用途**: 兼容旧版插件的主人类权限判断

#### get package()
- **返回**: `Object` - `package.json` 内容
- **缓存**: 首次读取后缓存到 `this._package`
- **用途**: 获取版本号、项目信息等

### 1.4 配置读取方法

#### getdefSet(name)
- **参数**: `name` (string) - 配置名称
- **返回**: `Object` - 默认配置对象
- **流程**:
  1. 检查内存缓存 `config['default.<name>']`
  2. 如果不存在，读取 `config/default_config/<name>.yaml`
  3. 解析 YAML 并缓存
  4. 如果文件不存在，返回空对象
- **用途**: 获取默认配置模板

#### getConfig(name)
- **参数**: `name` (string) - 配置名称
- **返回**: `Object` - 服务器级配置对象
- **流程**:
  1. 检查内存缓存 `config['server.<port>.<name>']`
  2. 如果不存在，读取 `data/server_bots/<port>/<name>.yaml`
  3. 如果文件不存在，尝试从默认配置复制
  4. 调用 `watch()` 监听文件变更
  5. 返回合并后的配置（默认 + 服务器）
- **用途**: 获取服务器级配置（会覆盖默认配置）

#### getGroup(groupId = '', userID = '')
- **参数**:
  - `groupId` (string|number) - 群组ID
  - `userID` (string) - 用户ID（可选，暂未使用）
- **返回**: `Object` - 群组配置对象
- **流程**:
  1. 读取默认群配置 `group.yaml` 的 `default` 字段
  2. 读取服务器级群配置 `group.yaml` 的 `default` 字段
  3. 如果指定了 `groupId`，读取该群的特定配置
  4. 按优先级合并：默认 < 服务器默认 < 群特定配置
- **用途**: 获取群组特定配置（如机器人别名、权限等）

### 1.5 配置写入方法

#### setConfig(name, data)
- **参数**:
  - `name` (string) - 配置名称
  - `data` (Object) - 要保存的配置数据
- **返回**: `boolean` - 是否成功
- **流程**:
  1. 更新内存缓存 `config['server.<port>.<name>']`
  2. 确保目录存在
  3. 将数据序列化为 YAML 并写入文件
  4. 记录日志
- **用途**: 保存配置到文件并触发热更新

#### setOther(data)
- **参数**: `data` (Object) - 其他配置数据
- **返回**: `boolean` - 是否成功
- **实现**: 调用 `setConfig('other', data)`
- **用途**: 保存其他配置

#### setGroup(data)
- **参数**: `data` (Object) - 群组配置数据
- **返回**: `boolean` - 是否成功
- **实现**: 调用 `setConfig('group', data)`
- **用途**: 保存群组配置

### 1.6 文件监听与热更新

#### watch(file, name, key)
- **参数**:
  - `file` (string) - 文件路径
  - `name` (string) - 配置名称
  - `key` (string) - 缓存键
- **作用**: 使用 `chokidar` 监听配置文件变更
- **流程**:
  1. 如果已存在监听器，直接返回
  2. 创建 `chokidar` 监听器
  3. 监听 `change` 事件
  4. 文件变更时：
     - 删除内存缓存
     - 记录日志
     - 如果存在 `change_<name>` 方法，调用它
- **用途**: 实现配置热更新

#### change_bot()
- **作用**: Bot 配置变更时的回调钩子
- **流程**:
  1. 重新加载日志配置 `config/log.js`
  2. 更新日志系统
- **触发时机**: `bot.yaml` 文件被修改时自动调用

### 1.7 清理方法

#### destroy()
- **作用**: 销毁配置系统，清理资源
- **流程**:
  1. 关闭所有文件监听器
  2. 清空 `watcher` 对象
  3. 清空 `config` 缓存
- **用途**: 优雅关闭、测试清理等

### 1.8 内部属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `config` | `Object` | 配置缓存对象，键格式：`default.<name>` 或 `server.<port>.<name>` |
| `_port` | `number\|null` | 当前服务器端口号 |
| `watcher` | `Object` | 文件监听器对象，键为配置键名 |
| `_renderer` | `Object\|null` | 渲染器配置缓存 |
| `_package` | `Object\|null` | package.json 缓存 |
| `PATHS` | `Object` | 路径常量对象 |

### 1.9 使用示例

```javascript
import cfg from './lib/config/config.js';

// 获取配置
const botConfig = cfg.bot;
const redisConfig = cfg.redis;
const masterQQ = cfg.masterQQ;

// 获取群配置
const groupConfig = cfg.getGroup('123456789');

// 保存配置
cfg.setOther({
  masterQQ: [123456789, 987654321]
});

// 监听配置变更（自动，无需手动调用）
// 当配置文件被修改时，会自动清除缓存并触发 change_<name> 钩子
```

---

<div align="center">

## 2. Redis 客户端 (`lib/config/redis.js`)

</div>

Redis 客户端基于 `redis` 官方库（v4+），支持 RESP3 协议、连接池、自动重连和健康检查。

### 2.1 配置常量

```javascript
const REDIS_CONFIG = {
  MAX_RETRIES: 3,                    // 最大重试次数
  CONNECT_TIMEOUT: 10000,            // 连接超时（毫秒）
  MAX_COMMAND_QUEUE: 5000,           // 最大命令队列长度
  MIN_POOL_SIZE: 3,                  // 最小连接池大小
  MAX_POOL_SIZE: 50,                 // 最大连接池大小
  RECONNECT_BASE_DELAY: 1000,        // 重连基础延迟（毫秒）
  RECONNECT_MAX_DELAY: 30000,        // 重连最大延迟（毫秒）
  HEALTH_CHECK_INTERVAL: 30000       // 健康检查间隔（毫秒）
}
```

### 2.2 主要导出函数

#### redisInit()
- **签名**: `async redisInit(): Promise<RedisClientType>`
- **返回**: Redis 客户端实例
- **流程**:
  1. 检查全局客户端是否存在且已连接，存在则直接返回
  2. 通过 `buildRedisUrl(cfg.redis)` 构建连接URL
  3. 通过 `buildClientConfig()` 构建客户端配置
  4. 创建客户端并尝试连接，最多重试 `MAX_RETRIES` 次
  5. 每次失败后尝试自动启动 Redis 服务（仅开发环境）
  6. 连接成功后：
     - 注册事件监听器 `registerEventHandlers()`
     - 启动健康检查 `startHealthCheck()`
     - 将实例挂载到 `global.redis`
     - 保存到 `globalClient`
  7. 如果最终连接失败，调用 `handleFinalConnectionFailure()` 并退出进程
- **用途**: 初始化 Redis 连接，应在应用启动时调用
- **示例**:
```javascript
import redisInit from './lib/config/redis.js';

const client = await redisInit();
// 现在可以使用 global.redis 或返回的 client
```

#### closeRedis()
- **签名**: `async closeRedis(): Promise<void>`
- **作用**: 优雅关闭 Redis 连接
- **流程**:
  1. 检查全局客户端是否存在且已连接
  2. 优先调用 `quit()` 优雅关闭
  3. 如果 `quit()` 失败，调用 `disconnect()` 强制断开
  4. 记录日志
- **用途**: 应用关闭时清理资源
- **示例**:
```javascript
import { closeRedis } from './lib/config/redis.js';

await closeRedis();
```

#### getRedisClient()
- **签名**: `getRedisClient(): RedisClientType|null`
- **返回**: 当前全局 Redis 客户端实例，如果未初始化则返回 `null`
- **用途**: 获取 Redis 客户端实例（主要用于测试或扩展）
- **示例**:
```javascript
import { getRedisClient } from './lib/config/redis.js';

const client = getRedisClient();
if (client && client.isOpen) {
  await client.set('key', 'value');
}
```

### 2.3 内部工具函数

#### buildRedisUrl(redisConfig)
- **参数**: `redisConfig` (Object) - Redis 配置对象（来自 `cfg.redis`）
- **返回**: `string` - Redis 连接URL
- **格式**: `redis://[username[:password]@]host:port/db`
- **处理**:
  - 如果提供了 `username` 或 `password`，构建认证部分
  - 组合完整的连接URL
- **示例**: `redis://user:pass@localhost:6379/0`

#### buildClientConfig(redisUrl)
- **参数**: `redisUrl` (string) - Redis 连接URL
- **返回**: `Object` - 客户端配置对象
- **结构**:
```javascript
{
  url: redisUrl,
  socket: {
    reconnectStrategy: Function,    // 重连策略函数
    connectTimeout: 10000           // 连接超时
  },
  connectionPoolSize: number,      // 连接池大小（3-50）
  commandsQueueMaxLength: 5000     // 最大命令队列长度
}
```

#### createReconnectStrategy()
- **返回**: `Function` - 重连策略函数
- **策略**: 指数退避算法
  - 第1次重连：2^0 × 1000ms = 1000ms
  - 第2次重连：2^1 × 1000ms = 2000ms
  - 第3次重连：2^2 × 1000ms = 4000ms
  - ...
  - 最大延迟：30000ms
- **用途**: 避免频繁重连造成资源浪费

#### getOptimalPoolSize()
- **返回**: `number` - 推荐的连接池大小（3-50）
- **计算逻辑**:
  1. 基础大小 = CPU核心数 × 3
  2. 根据内存大小调整上限：
     - 内存 < 2GB: 上限 5
     - 内存 < 4GB: 上限 10
     - 内存 < 8GB: 上限 20
     - 内存 ≥ 8GB: 上限 50
  3. 最终值 = max(3, min(计算值, 50))
- **用途**: 根据系统资源自动优化连接池大小

#### attemptRedisStart(retryCount)
- **参数**: `retryCount` (number) - 当前重试次数
- **作用**: 在开发环境尝试自动启动 Redis 服务
- **流程**:
  1. 检查是否为生产环境，如果是则跳过
  2. 获取系统架构特定选项（ARM64 特殊处理）
  3. 执行 `redis-server --save 900 1 --save 300 10 --daemonize yes [架构选项]`
  4. 等待 2-4 秒让服务启动
- **用途**: 开发环境自动启动 Redis，提升开发体验

#### handleFinalConnectionFailure(error, port)
- **参数**:
  - `error` (Error) - 连接错误对象
  - `port` (number) - Redis 端口
- **作用**: 处理最终连接失败，提供排障信息
- **流程**:
  1. 记录错误日志
  2. 打印排障提示：
     - Redis 服务是否已启动
     - 配置是否正确
     - 端口是否被占用
     - 网络连接是否正常
  3. 非生产环境提供手动启动命令
  4. 调用 `process.exit(1)` 退出进程
- **用途**: 帮助用户快速定位问题

#### registerEventHandlers(client)
- **参数**: `client` (RedisClientType) - Redis 客户端实例
- **作用**: 注册 Redis 事件监听器
- **监听的事件**:
  - `error`: 连接错误，自动尝试重连
  - `ready`: 连接就绪，可以接收命令
  - `reconnecting`: 正在重新连接
  - `end`: 连接已关闭
- **重连逻辑**:
  - 使用 `_isReconnecting` 标记避免重复重连
  - 如果连接断开，自动调用 `connect()` 重连
- **用途**: 确保 Redis 连接的稳定性

#### startHealthCheck(client)
- **参数**: `client` (RedisClientType) - Redis 客户端实例
- **作用**: 启动定期健康检查
- **流程**:
  1. 每 30 秒执行一次 `PING` 命令
  2. 如果连接正常，记录 debug 日志
  3. 如果失败，记录警告日志
- **用途**: 及时发现连接问题

#### getArchitectureOptions()
- **返回**: `Promise<string>` - 架构特定选项字符串
- **作用**: 获取系统架构特定的 Redis 启动选项
- **处理**:
  - Windows 平台：返回空字符串
  - 非 Windows 平台：
    1. 检测系统架构（`uname -m`）
    2. 如果是 ARM64 架构：
       - 检测 Redis 版本（`redis-server -v`）
       - 如果版本 ≥ 6.0，返回 `--ignore-warnings ARM64-COW-BUG`
    3. 其他架构：返回空字符串
- **用途**: 解决 ARM64 架构的 Redis 已知问题

#### execCommand(cmd)
- **参数**: `cmd` (string) - Shell 命令
- **返回**: `Promise<{error: Error|null, stdout: string, stderr: string}>`
- **作用**: Promise 化的 `child_process.exec` 封装
- **用途**: 执行系统命令（如启动 Redis、检测架构等）

#### maskRedisUrl(url)
- **参数**: `url` (string) - Redis 连接URL
- **返回**: `string` - 掩码后的URL（密码部分替换为 `******`）
- **用途**: 在日志中隐藏敏感信息
- **示例**: `redis://user:******@localhost:6379/0`

### 2.4 Redis 客户端使用

初始化后，可以通过 `global.redis` 访问 Redis 客户端，支持所有 Redis 命令：

```javascript
// 字符串操作
await redis.set('key', 'value');
const value = await redis.get('key');

// 列表操作
await redis.lPush('list', 'item1', 'item2');
const items = await redis.lRange('list', 0, -1);

// 有序集合操作
await redis.zAdd('sorted_set', { score: 1, value: 'member1' });
const members = await redis.zRange('sorted_set', 0, -1);

// 哈希操作
await redis.hSet('hash', 'field', 'value');
const fieldValue = await redis.hGet('hash', 'field');

// 过期时间
await redis.expire('key', 3600);  // 1小时后过期

// 批量操作
await redis.multi()
  .set('key1', 'value1')
  .set('key2', 'value2')
  .exec();
```

### 2.5 事件监听

Redis 客户端支持以下事件：

```javascript
import { getRedisClient } from './lib/config/redis.js';

const client = getRedisClient();

client.on('error', (err) => {
  logger.error('Redis错误:', err);
});

client.on('ready', () => {
  logger.info('Redis已就绪');
});

client.on('reconnecting', () => {
  logger.info('Redis正在重连...');
});

client.on('end', () => {
  logger.warn('Redis连接已关闭');
});
```

### 2.6 使用提示

1. **初始化时机**: 在应用启动时（`app.js` 或 `start.js`）调用 `redisInit()`
2. **全局访问**: 初始化后可通过 `global.redis` 访问，无需重复导入
3. **错误处理**: 建议在使用前检查 `redis.isOpen` 状态
4. **连接池**: 系统会根据 CPU 和内存自动优化连接池大小
5. **自动重连**: 连接断开后会自动重连，使用指数退避策略
6. **健康检查**: 每 30 秒自动检查连接健康状态
7. **开发环境**: 开发环境会自动尝试启动本地 Redis 服务
8. **生产环境**: 生产环境需要确保 Redis 服务已运行

### 2.7 配置示例

在 `config/default_config/redis.yaml` 中配置：

```yaml
redis:
  host: localhost
  port: 6379
  db: 0
  username: ''        # 可选
  password: ''        # 可选
```

---

<div align="center">

## 3. 使用提示与最佳实践

</div>

### 3.1 配置系统

- **单例模式**: `cfg` 是单例，已自动导出，可直接 `import cfg from './lib/config/config.js'`
- **热更新**: 配置文件修改后自动清除缓存，无需重启应用
- **多端口隔离**: 通过 `node app server <port>` 启动时，配置自动隔离到 `data/server_bots/<port>/`
- **配置优先级**: 服务器配置 > 默认配置
- **文件监听**: 使用 `chokidar` 监听文件变更，支持实时更新

### 3.2 Redis 客户端

- **全局访问**: 初始化后可通过 `global.redis` 访问，推荐先判断是否已初始化
- **连接管理**: 系统自动管理连接池、重连和健康检查
- **错误处理**: 连接失败时会自动重试，最终失败会退出进程
- **性能优化**: 根据系统资源自动调整连接池大小
- **开发体验**: 开发环境自动尝试启动 Redis 服务

### 3.3 常见问题

**Q: 配置文件修改后没有生效？**  
A: 检查文件监听器是否正常工作，查看日志中是否有 `[修改配置文件]` 提示。

**Q: Redis 连接失败怎么办？**  
A: 检查 Redis 服务是否运行、配置是否正确、端口是否被占用、防火墙是否阻止。

**Q: 如何在不同端口使用不同配置？**  
A: 使用 `node app server <port>` 启动，配置会自动隔离到对应端口的目录。

**Q: Redis 客户端支持哪些命令？**  
A: 支持所有 Redis 命令，详见 [redis 官方文档](https://redis.io/commands)。

