import cfg from "./config.js"
import common from "../common/common.js"
import { exec } from "node:child_process"
import os from "node:os"

let redisClient;
try {
  redisClient = await import("valkey").catch(() => import("redis"));
} catch (e) {
  redisClient = await import("redis");
}
const { createClient } = redisClient;

/**
 * 初始化全局redis客户端
 * @returns {Promise<import('redis').RedisClientType>} Redis客户端实例
 */
export default async function redisInit() {
  const rc = cfg.redis
  const redisUn = rc.username || ""
  let redisPw = rc.password ? `:${rc.password}` : ""
  if (rc.username || rc.password)
    redisPw += "@"
  const redisUrl = `redis://${redisUn}${redisPw}${rc.host}:${rc.port}/${rc.db}`
  const clientConfig = {
    url: redisUrl,
    socket: {
      reconnectStrategy: (retries) => {
        const delay = Math.min(Math.pow(2, retries) * 1000, 30000);
        logger.info(`Redis重连策略: 将在${delay}ms后尝试第${retries+1}次重连`);
        return delay;
      },
      connectTimeout: 10000,
    },
    connectionPoolSize: getOptimalPoolSize(),
    commandsQueueMaxLength: 5000
  }
  
  let client = createClient(clientConfig);

  let connected = false;
  let retryCount = 0;
  const maxRetries = 3;

  while (!connected && retryCount < maxRetries) {
    try {
      logger.info(`正在连接Redis: ${logger.blue(maskRedisUrl(redisUrl))}`);
      await client.connect();
      connected = true;
    } catch (err) {
      retryCount++;
      logger.info(`Redis连接尝试 ${retryCount}/${maxRetries}: ${err.message || err}`);

      if (retryCount < maxRetries) {
        const redisConfig = "--save 900 1 --save 300 10 --daemonize yes";
        const archOptions = await getArchitectureOptions();
        const cmd = `redis-server ${redisConfig}${archOptions}`;
        
        logger.info("正在尝试启动Redis服务...");
        const result = await execCommand(cmd);
        
        if (result.error) {
          logger.warn(`Redis启动命令可能失败: ${result.error.message || result.error}`);
          if (result.stderr) logger.debug(`stderr: ${result.stderr}`);
        } else {
          logger.info("Redis启动命令已执行");
        }
        
        const waitTime = 2000 + retryCount * 1000;
        logger.info(`等待Redis服务启动... (${waitTime}ms)`);
        await common.sleep(waitTime);
        
        client = createClient(clientConfig);
      } else {
        const archOptions = await getArchitectureOptions();
        const startCommand = `redis-server --save 900 1 --save 300 10 --daemonize yes${archOptions}`;
        logger.error(`Redis错误：${logger.red(err.message || err)}`);
        logger.error(`在多次尝试后仍无法连接Redis。请检查Redis配置或手动启动：`);
        logger.error(`${logger.blue(startCommand)}`);
        logger.error(`或者检查Redis服务是否被防火墙阻止，端口(${rc.port})是否已开放`);
        process.exit(1);
      }
    }
  }
  client.on("error", async (err) => {
    logger.warn(`Redis连接中断: ${logger.yellow(err.message || err)}`);
    if (client._reconnecting) return;
    client._reconnecting = true;
    
    try {
      if (!client.isOpen) {
        logger.info("尝试重新连接Redis...");
        await client.connect();
        logger.info("Redis重新连接成功");
        client._reconnecting = false;
        return;
      }
    } catch (reconnectErr) {
      logger.warn(`重连失败: ${reconnectErr.message || reconnectErr}`);
      try {
        logger.info("尝试重启Redis服务...");
        const redisConfig = "--save 900 1 --save 300 10 --daemonize yes";
        const archOptions = await getArchitectureOptions();
        const cmd = `redis-server ${redisConfig}${archOptions}`;
        
        await execCommand(cmd);
        await common.sleep(3000);
        
        await client.connect();
        logger.info("Redis重启并重新连接成功");
      } catch (finalErr) {
        logger.error(`Redis恢复失败：${logger.red(finalErr.message || finalErr)}`);
        logger.error("请检查Redis服务状态或网络连接");
      }
    } finally {
      client._reconnecting = false;
    }
  });

  client.on("ready", () => {
    logger.info("Redis连接就绪，可以接收命令");
  });

  client.on("reconnecting", () => {
    logger.info("Redis正在尝试重新连接...");
  });

  client.on("server-error", (err) => {
    logger.error(`Redis服务端错误: ${logger.red(err.message || err)}`);
  });

  global.redis = client;
  logger.info("Redis连接成功");
  return client;
}

/**
 * 根据系统CPU核心数和内存大小计算最佳连接池大小
 * @returns {number} 推荐的连接池大小
 */
function getOptimalPoolSize() {
  const cpuCount = os.cpus().length;
  const memoryGB = os.totalmem() / 1024 / 1024 / 1024;
  let poolSize = Math.ceil(cpuCount * 3);
  
  if (memoryGB < 2) {
    poolSize = Math.min(poolSize, 5);
  } else if (memoryGB < 4) {
    poolSize = Math.min(poolSize, 10);
  } else if (memoryGB < 8) {
    poolSize = Math.min(poolSize, 20);
  }
  
  return Math.max(3, Math.min(poolSize, 50));
}

/**
 * 获取当前系统架构的特定Redis选项
 * @returns {Promise<string>} 适用于当前架构的Redis选项字符串
 */
async function getArchitectureOptions() {
  if (process.platform === "win32") {
    return "";
  }
  
  try {
    const archResult = await execCommand("uname -m");
    const arch = archResult.stdout ? archResult.stdout.trim() : "";
    
    if (arch.includes("aarch64") || arch.includes("arm64")) {
      try {
        const versionResult = await execCommand("redis-server -v");
        const versionOutput = versionResult.stdout || "";
        
        const versionMatch = versionOutput.match(/v=(\d+)\.(\d+)/);
        if (versionMatch) {
          const majorVersion = parseInt(versionMatch[1], 10);
          const minorVersion = parseInt(versionMatch[2], 10);
          
          if (majorVersion > 6 || (majorVersion === 6 && minorVersion >= 0)) {
            return " --ignore-warnings ARM64-COW-BUG";
          }
        }
      } catch (e) {
        logger.debug(`检查Redis版本时出错: ${e.message || e}`);
      }
    }
  } catch (e) {
    logger.debug(`检查系统架构时出错: ${e.message || e}`);
  }
  
  return "";
}

/**
 * 执行shell命令并返回Promise
 * @param {string} cmd 要执行的命令
 * @returns {Promise<{error: Error|null, stdout: string, stderr: string}>} 命令执行结果
 */
function execCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (error, stdout, stderr) => {
      resolve({
        error,
        stdout: stdout ? stdout.toString() : "",
        stderr: stderr ? stderr.toString() : ""
      });
    });
  });
}

/**
 * 对Redis URL进行掩码处理，避免在日志中泄露密码
 * @param {string} url Redis连接URL
 * @returns {string} 掩码处理后的URL
 */
function maskRedisUrl(url) {
  if (!url) return url;
  
  return url.replace(/:([^@:]+)@/, ':******@');
}