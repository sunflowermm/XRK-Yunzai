import cfg from './config.js'
import common from '../common/common.js'
import { exec } from 'node:child_process'
import os from 'node:os'
import { createClient } from 'redis'

// Redis客户端全局实例
let globalClient = null
let healthCheckInterval = null

/**
 * Redis配置常量
 */
const REDIS_CONFIG = {
  MAX_RETRIES: 3,
  CONNECT_TIMEOUT: 10000,
  MAX_COMMAND_QUEUE: 5000,
  MIN_POOL_SIZE: 3,
  MAX_POOL_SIZE: 50,
  RECONNECT_BASE_DELAY: 1000,
  RECONNECT_MAX_DELAY: 30000,
  HEALTH_CHECK_INTERVAL: 30000
}

/**
 * 初始化Redis客户端
 * @returns {Promise<import('redis').RedisClientType>} Redis客户端实例
 */
export default async function redisInit() {
  if (globalClient && globalClient.isOpen) {
    Bot.makeLog('info', 'Redis客户端已存在，返回现有实例', 'Redis')
    return globalClient
  }

  const redisUrl = buildRedisUrl(cfg.redis)
  const clientConfig = buildClientConfig(redisUrl)
  
  let client = createClient(clientConfig)
  let connected = false
  let retryCount = 0

  // 尝试连接Redis
  while (!connected && retryCount < REDIS_CONFIG.MAX_RETRIES) {
    try {
      Bot.makeLog('info', `正在连接Redis [尝试 ${retryCount + 1}/${REDIS_CONFIG.MAX_RETRIES}]: ${logger.blue(maskRedisUrl(redisUrl, 'Redis'))}`)
      await client.connect()
      connected = true
      Bot.makeLog('info', '✓ Redis连接成功', 'Redis')
    } catch (err) {
      retryCount++
      Bot.makeLog('warn', `✗ Redis连接失败 (${retryCount}/${REDIS_CONFIG.MAX_RETRIES}, 'Redis'): ${err.message}`)

      if (retryCount < REDIS_CONFIG.MAX_RETRIES) {
        await attemptRedisStart(retryCount)
        client = createClient(clientConfig)
      } else {
        await handleFinalConnectionFailure(err, cfg.redis.port)
      }
    }
  }

  // 注册事件监听器
  registerEventHandlers(client)
  
  // 启动健康检查
  startHealthCheck(client)

  globalClient = client
  global.redis = client
  
  return client
}

/**
 * 构建Redis连接URL
 * @param {Object} redisConfig - Redis配置对象
 * @returns {string} Redis连接URL
 */
function buildRedisUrl(redisConfig) {
  const { username = '', password = '', host, port, db } = redisConfig
  
  let auth = ''
  if (username || password) {
    const user = username || ''
    const pass = password ? `:${password}` : ''
    auth = `${user}${pass}@`
  }
  
  return `redis://${auth}${host}:${port}/${db}`
}

/**
 * 构建Redis客户端配置
 * @param {string} redisUrl - Redis连接URL
 * @returns {Object} 客户端配置对象
 */
function buildClientConfig(redisUrl) {
  return {
    url: redisUrl,
    socket: {
      reconnectStrategy: createReconnectStrategy(),
      connectTimeout: REDIS_CONFIG.CONNECT_TIMEOUT
    },
    connectionPoolSize: getOptimalPoolSize(),
    commandsQueueMaxLength: REDIS_CONFIG.MAX_COMMAND_QUEUE
  }
}

/**
 * 创建重连策略
 * @returns {Function} 重连策略函数
 */
function createReconnectStrategy() {
  return (retries) => {
    const delay = Math.min(
      Math.pow(2, retries) * REDIS_CONFIG.RECONNECT_BASE_DELAY,
      REDIS_CONFIG.RECONNECT_MAX_DELAY
    )
    Bot.makeLog('info', `Redis重连策略: 第${retries + 1}次重连将在${delay}ms后执行`, 'Redis')
    return delay
  }
}

/**
 * 根据系统资源计算最佳连接池大小
 * @returns {number} 推荐的连接池大小
 */
function getOptimalPoolSize() {
  const cpuCount = os.cpus().length
  const memoryGB = os.totalmem() / (1024 ** 3)
  
  let poolSize = Math.ceil(cpuCount * 3)
  
  // 根据内存大小调整连接池
  if (memoryGB < 2) {
    poolSize = Math.min(poolSize, 5)
  } else if (memoryGB < 4) {
    poolSize = Math.min(poolSize, 10)
  } else if (memoryGB < 8) {
    poolSize = Math.min(poolSize, 20)
  }
  
  const finalSize = Math.max(
    REDIS_CONFIG.MIN_POOL_SIZE,
    Math.min(poolSize, REDIS_CONFIG.MAX_POOL_SIZE)
  )
  
  Bot.makeLog('debug', `系统资源: CPU=${cpuCount}核, 内存=${memoryGB.toFixed(2)}GB, 连接池大小=${finalSize}`, 'Redis')
  
  return finalSize
}

/**
 * 尝试启动本地Redis服务（仅开发环境）
 * @param {number} retryCount - 当前重试次数
 */
async function attemptRedisStart(retryCount) {
  if (process.env.NODE_ENV === 'production') {
    Bot.makeLog('warn', '生产环境不自动启动Redis服务，请确保Redis服务已运行', 'Redis')
    return
  }

  try {
    const archOptions = await getArchitectureOptions()
    const redisConfig = '--save 900 1 --save 300 10 --daemonize yes'
    const cmd = `redis-server ${redisConfig}${archOptions}`
    
    Bot.makeLog('info', '尝试启动本地Redis服务...', 'Redis')
    const result = await execCommand(cmd)
    
    if (result.error) {
      Bot.makeLog('debug', `Redis启动命令执行: ${result.error.message}`, 'Redis')
    }
    
    const waitTime = 2000 + retryCount * 1000
    Bot.makeLog('info', `等待Redis服务启动 (${waitTime}ms, 'Redis')...`)
    await common.sleep(waitTime)
  } catch (err) {
    Bot.makeLog('debug', `启动Redis服务时出错: ${err.message}`, 'Redis')
  }
}

/**
 * 处理最终连接失败
 * @param {Error} error - 错误对象
 * @param {number} port - Redis端口
 */
async function handleFinalConnectionFailure(error, port) {
  Bot.makeLog('error', `Redis连接失败: ${logger.red(error.message, 'Redis')}`)
  Bot.makeLog('error', '请检查以下项目:', 'Redis')
  Bot.makeLog('error', `  1. Redis服务是否已启动`, 'Redis')
  Bot.makeLog('error', `  2. Redis配置是否正确 (data/server_bots/redis.yaml, 'Redis')`)
  Bot.makeLog('error', `  3. 端口 ${port} 是否被占用或被防火墙阻止`, 'Redis')
  Bot.makeLog('error', `  4. 网络连接是否正常`, 'Redis')

  if (process.env.NODE_ENV !== 'production') {
    const archOptions = await getArchitectureOptions()
    Bot.makeLog('error', `\n手动启动命令: ${logger.blue(`redis-server --daemonize yes${archOptions}`, 'Redis')}`)
  }

  process.exit(1)
}

/**
 * 注册Redis事件监听器
 * @param {import('redis').RedisClientType} client - Redis客户端
 */
function registerEventHandlers(client) {
  // 错误事件
  client.on('error', async (err) => {
    Bot.makeLog('error', `Redis错误: ${logger.red(err.message, 'Redis')}`)
    
    // 避免重复重连
    if (client._isReconnecting) {
      return
    }
    
    client._isReconnecting = true
    
    try {
      if (!client.isOpen) {
        Bot.makeLog('info', '尝试重新连接Redis...', 'Redis')
        await client.connect()
        Bot.makeLog('info', '✓ Redis重新连接成功', 'Redis')
      }
    } catch (reconnectErr) {
      Bot.makeLog('error', `Redis重连失败: ${reconnectErr.message}`, 'Redis')
    } finally {
      client._isReconnecting = false
    }
  })

  // 就绪事件
  client.on('ready', () => {
    Bot.makeLog('info', '✓ Redis就绪，可以接收命令', 'Redis')
  })

  // 重连事件
  client.on('reconnecting', () => {
    Bot.makeLog('info', '→ Redis正在重新连接...', 'Redis')
  })

  // 连接关闭事件
  client.on('end', () => {
    Bot.makeLog('warn', '✗ Redis连接已关闭', 'Redis')
  })
}

/**
 * 启动Redis健康检查
 * @param {import('redis').RedisClientType} client - Redis客户端
 */
function startHealthCheck(client) {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval)
    healthCheckInterval = null
  }
  healthCheckInterval = setInterval(async () => {
    try {
      if (client.isOpen) {
        await client.ping()
      }
    } catch (err) {
      Bot.makeLog('warn', `Redis健康检查失败: ${err.message}`, 'Redis')
    }
  }, REDIS_CONFIG.HEALTH_CHECK_INTERVAL)
}

/**
 * 获取系统架构特定的Redis选项
 * @returns {Promise<string>} 架构特定选项
 */
async function getArchitectureOptions() {
  if (process.platform === 'win32') {
    return ''
  }
  
  try {
    const { stdout: arch } = await execCommand('uname -m')
    const archType = arch.trim()
    
    // ARM64架构特殊处理
    if (archType.includes('aarch64') || archType.includes('arm64')) {
      const { stdout: versionOutput } = await execCommand('redis-server -v')
      const versionMatch = versionOutput.match(/v=(\d+)\.(\d+)/)
      
      if (versionMatch) {
        const [, major, minor] = versionMatch
        const majorVer = parseInt(major, 10)
        const minorVer = parseInt(minor, 10)
        
        if (majorVer > 6 || (majorVer === 6 && minorVer >= 0)) {
          return ' --ignore-warnings ARM64-COW-BUG'
        }
      }
    }
  } catch (err) {
    Bot.makeLog('debug', `检查系统架构失败: ${err.message}`, 'Redis')
  }
  
  return ''
}

/**
 * 执行Shell命令
 * @param {string} cmd - 要执行的命令
 * @returns {Promise<{error: Error|null, stdout: string, stderr: string}>} 命令执行结果
 */
function execCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (error, stdout, stderr) => {
      resolve({
        error,
        stdout: stdout?.toString() || '',
        stderr: stderr?.toString() || ''
      })
    })
  })
}

/**
 * 掩码Redis URL中的敏感信息
 * @param {string} url - Redis连接URL
 * @returns {string} 掩码后的URL
 */
function maskRedisUrl(url) {
  if (!url) {
    return url
  }
  return url.replace(/:([^@:]+)@/, ':******@')
}

/**
 * 将内存数据同步到 RDB（node-redis 无 .save()，须用 SAVE 命令）
 * @returns {Promise<void>}
 */
export async function persistRedis() {
  const client = globalClient || global.redis;
  if (!client?.isOpen) return;
  await client.sendCommand(['SAVE']);
}

/**
 * 优雅关闭Redis连接
 * @returns {Promise<void>}
 */
export async function closeRedis() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval)
    healthCheckInterval = null
  }
  if (globalClient && globalClient.isOpen) {
    try {
      await globalClient.quit()
      Bot.makeLog('info', 'Redis连接已优雅关闭', 'Redis')
    } catch (err) {
      Bot.makeLog('error', `关闭Redis连接失败: ${err.message}`, 'Redis')
      await globalClient.disconnect()
    }
  }
}

/**
 * 获取Redis客户端实例
 * @returns {import('redis').RedisClientType|null} Redis客户端实例
 */
export function getRedisClient() {
  return globalClient
}