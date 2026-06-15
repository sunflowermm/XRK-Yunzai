import cfg from "./config.js"
import chalk from "chalk";
import setLog from "./log.js";
import redisInit, { persistRedis, closeRedis } from "./redis.js";
import SystemMonitor from "../systemmonitor.js";

const CONFIG = {
  PROCESS_TITLE: "XRK-Yunzai",
  SIGNAL_TIME_THRESHOLD: 3000,
  TIMEZONE: "Asia/Shanghai"
};

const NETWORK_ERROR_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST'];

class ProcessManager {
  lastSignal = null;
  lastSignalTime = 0;

  async updateTitle() {
    const currentQQ = global.selectedQQ || process.argv.find(arg => /^\d+$/.test(arg));
    process.title = currentQQ === "server" ? `${CONFIG.PROCESS_TITLE}@Server` : CONFIG.PROCESS_TITLE;
  }

  async restart() {
    Bot.makeLog('mark', chalk.yellow("重启中..."), 'ProcessManager');
    await this.cleanup();
    if (Bot?.exit) {
      await Bot.exit().catch((err) => {
        Bot.makeLog('debug', `[ProcessManager] Bot.exit 失败: ${err?.message || err}`, 'ProcessManager');
      });
    }
    process.exit(1);
  }

  isNetworkError(error) {
    return error && NETWORK_ERROR_CODES.includes(error.code);
  }

  setupSignalHandlers() {
    const handleSignal = async (signal) => {
      const now = Date.now();
      if (signal === this.lastSignal && now - this.lastSignalTime < CONFIG.SIGNAL_TIME_THRESHOLD) {
        Bot.makeLog('mark', chalk.yellow(`检测到连续两次${signal}，程序退出`), 'ProcessManager');
        await this.cleanup();
        process.exit(0);
      }
      this.lastSignal = signal;
      this.lastSignalTime = now;
      Bot.makeLog('mark', chalk.yellow(`接收到${signal}，程序重启`), 'ProcessManager');
      try {
        await this.restart();
      } catch (e) {
        Bot.makeLog('error', `restart 异常: ${e?.message || e}`, 'ProcessManager');
      }
      process.exit(1);
    };

    ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(signal => {
      process.removeAllListeners(signal);
      process.on(signal, () => handleSignal(signal));
    });
  }

  setupErrorHandlers() {
    process.on("uncaughtException", async (error) => {
      Bot.makeLog('error', `未捕获异常: ${error.message}`, 'ProcessManager');
      if (this.isNetworkError(error)) {
        Bot.makeLog('error', chalk.red(`网络错误(${error.code})，准备重启`), 'ProcessManager');
        await this.restart();
      }
    });

    process.on("unhandledRejection", async (error) => {
      // 提取更详细的错误信息，避免只显示 [object Object]
      const errorMsg = error?.message || error?.toString() || String(error);
      const errorStack = error?.stack ? `\n${error.stack}` : '';
      Bot.makeLog('error', `未处理Promise: ${errorMsg}${errorStack}`, 'ProcessManager');
      
      // 网络错误特殊处理
      if (this.isNetworkError(error)) {
        Bot.makeLog('error', chalk.red(`网络Promise错误(${error.code})，准备重启`), 'ProcessManager');
        await this.restart();
      }
    });

    process.on("exit", () => {
      this.cleanup().catch((err) => {
        Bot.makeLog('debug', `[ProcessManager] exit cleanup 失败: ${err?.message || err}`, 'ProcessManager');
      });
    });
  }

  async cleanup() {
    await persistRedis().catch((err) => {
      Bot.makeLog('debug', `[ProcessManager] redis SAVE 失败: ${err?.message || err}`, 'ProcessManager');
    });
    await closeRedis().catch((err) => {
      Bot.makeLog('debug', `[ProcessManager] redis 关闭失败: ${err?.message || err}`, 'ProcessManager');
    });
  }
}

export default async function Packageloader() {
  await setLog();
  Bot.makeLog('mark', chalk.cyan("XRK-Yunzai 初始化中..."), 'ProcessManager');
  process.env.TZ = CONFIG.TIMEZONE;
  const processManager = new ProcessManager();
  processManager.setupErrorHandlers();
  processManager.setupSignalHandlers();
  await redisInit();
  await processManager.updateTitle();
  const monitorConfig = cfg?.monitor;
  if (monitorConfig?.enabled) {
    const systemMonitor = SystemMonitor.getInstance();
    await systemMonitor.start(monitorConfig);
    systemMonitor.on('critical', async ({ type }) => {
      Bot.makeLog('error', `系统资源严重不足: ${type}`, 'ProcessManager');
      if (monitorConfig.optimize?.autoRestart) {
        Bot.makeLog('error', '将在5秒后重启...', 'ProcessManager');
        setTimeout(() => processManager.restart(), 5000);
      }
    });
  } else {
    Bot.makeLog('debug', '系统监控未启用', 'ProcessManager');
  }
  Bot.makeLog('mark', chalk.green(`XRK-Yunzai 初始化完成`), 'ProcessManager');
  return { success: true, mode: "server" };
}