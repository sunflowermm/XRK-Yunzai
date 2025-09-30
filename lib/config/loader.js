import chalk from "chalk";
import setLog from "./log.js";
import redisInit from "./redis.js";
import startBrowserMonitoring from "../monitor/browserMemoryMonitor.js";
import NodeMemoryAPI from "../monitor/nodeMemoryMonitor.js";

// 统一配置
const CONFIG = {
  PROCESS_TITLE: "XRK-Yunzai",
  SIGNAL_TIME_THRESHOLD: 3000,
  RESTART_DELAY: 5000,
  TIMEZONE: "Asia/Shanghai",
  MONITORING: {
    BROWSER: {
      interval: 120000,
      maxInstances: 7,
      memoryThreshold: 95,
      reserveNewest: true
    },
    MEMORY: {
      interval: 300000,
      memoryThreshold: 80,
      nodeMemoryThreshold: 85,
      autoOptimize: true,
      diagnostics: false,
      memoryLimitMB: 0
    },
    REPORT_INTERVAL: 3600000 // 1小时
  }
};

// 网络错误代码
const NETWORK_ERROR_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST'];

/**
 * 进程管理类
 */
class ProcessManager {
  constructor() {
    this.lastSignal = null;
    this.lastSignalTime = 0;
    this.signalHandlersSetup = false;
    this.errorHandlersSetup = false;
  }

  /**
   * 更新进程标题
   */
  async updateTitle() {
    const currentQQ = global.selectedQQ || process.argv.find(arg => /^\d+$/.test(arg));
    
    if (currentQQ === "server") {
      process.title = `${CONFIG.PROCESS_TITLE}@Server`;
    } else {
      process.title = CONFIG.PROCESS_TITLE;
    }
  }

  /**
   * 重启程序
   */
  async restart() {
    try {
      logger.mark(chalk.yellow("重启中..."));
      if (global.redis) {
        await global.redis.save().catch(err => logger.error(`Redis 保存失败: ${err.message}`));
      }
      if (global.Bot?.exit) {
        await global.Bot.exit().catch(() => {});
      }
      process.exit(1);
    } catch (error) {
      logger.error(`重启过程中发生错误: ${error.message}`);
      process.exit(1);
    }
  }

  /**
   * 检查是否为网络错误
   */
  isNetworkError(error) {
    return error && NETWORK_ERROR_CODES.includes(error.code);
  }

  /**
   * 设置信号处理器
   */
  setupSignalHandlers() {
    if (this.signalHandlersSetup) return;
    this.signalHandlersSetup = true;

    const handleSignal = async (signal) => {
      const currentTime = Date.now();
      
      if (this.shouldForceExit(signal, currentTime)) {
        logger.mark(chalk.yellow(`检测到连续两次${signal}信号，程序退出`));
        await this.cleanup();
        process.exit(0);
      } else {
        this.lastSignal = signal;
        this.lastSignalTime = currentTime;
        logger.mark(chalk.yellow(`接收到${signal}信号，程序重启`));
        await this.restart();
      }
    };

    // 清理并设置信号处理器
    ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(signal => {
      process.removeAllListeners(signal);
      process.on(signal, () => handleSignal(signal));
    });
  }

  /**
   * 判断是否应该强制退出
   */
  shouldForceExit(signal, currentTime) {
    return signal === this.lastSignal && 
           currentTime - this.lastSignalTime < CONFIG.SIGNAL_TIME_THRESHOLD;
  }

  /**
   * 设置错误处理器
   */
  setupErrorHandlers() {
    if (this.errorHandlersSetup) return;
    this.errorHandlersSetup = true;

    process.on("uncaughtException", async (error) => {
      logger.debug(`未捕获异常: ${error.stack || error}`);
      if (this.isNetworkError(error)) {
        logger.error(chalk.red(`检测到网络连接错误(${error.code})，准备重启程序`));
        await this.restart();
      }
    });

    process.on("unhandledRejection", async (error) => {
      logger.debug(`未处理 Promise 拒绝: ${error.stack || error}`);
      if (this.isNetworkError(error)) {
        logger.error(chalk.red(`检测到网络 Promise 错误(${error.code})，准备重启程序`));
        await this.restart();
      }
    });

    process.on("exit", async (code) => {
      await this.cleanup();
      logger.mark(chalk.magenta(`XRK-Yunzai 已停止，退出码: ${code}`));
    });
  }

  /**
   * 设置网络错误监听器
   */
  setupNetworkErrorListeners() {
    process.nextTick(() => {
      this.setupHttpServerErrorHandling();
      this.setupSocketErrorHandling();
    });
  }

  /**
   * 设置HTTP服务器错误处理
   */
  setupHttpServerErrorHandling() {
    if (!global.httpServer) return;

    global.httpServer.on('error', async (error) => {
      logger.error(chalk.red(`HTTP服务器错误: ${error.message}`));
      
      if (error.code === 'EADDRINUSE') {
        logger.error(chalk.red(`端口已被占用，请检查配置或关闭占用进程`));
      } else if (this.isNetworkError(error)) {
        logger.error(chalk.red(`HTTP连接错误，准备重启程序`));
        await this.restart();
      }
    });
  }

  /**
   * 设置Socket错误处理
   */
  setupSocketErrorHandling() {
    const socket = global.Bot?.adapter?.client?.socket;
    if (!socket) return;

    socket.on('error', async (error) => {
      logger.error(chalk.red(`Socket连接错误: ${error.message}`));
      if (this.isNetworkError(error)) {
        logger.error(chalk.red(`Socket连接错误，准备重启程序`));
        await this.restart();
      }
    });

    socket.on('close', async () => {
      logger.error(chalk.red(`Socket连接已关闭，准备重启程序`));
      setTimeout(() => this.restart(), CONFIG.RESTART_DELAY);
    });
  }

  /**
   * 清理资源
   */
  async cleanup() {
    if (global.redis) {
      await global.redis.save().catch(() => {});
    }
  }
}

/**
 * 监控管理类
 */
class MonitoringManager {
  /**
   * 启动浏览器监控
   */
  async setupBrowserMonitoring() {
    try {
      await startBrowserMonitoring(CONFIG.MONITORING.BROWSER);
      logger.info(chalk.green("浏览器监控已启动"));
    } catch (error) {
      logger.error(`浏览器监控启动失败: ${error.message}`);
    }
  }

  /**
   * 启动内存监控
   */
  async setupMemoryMonitoring() {
    try {
      await NodeMemoryAPI.startMonitoring(CONFIG.MONITORING.MEMORY);

      // 定期生成报告
      setInterval(async () => {
        await NodeMemoryAPI.getReport();
      }, CONFIG.MONITORING.REPORT_INTERVAL);
      
    } catch (error) {
      logger.error(`内存监控启动失败: ${error.message}`);
    }
  }
}

/**
 * 初始化管理类
 */
class InitManager {
  constructor() {
    this.processManager = new ProcessManager();
    this.monitoringManager = new MonitoringManager();
  }

  /**
   * 设置环境
   */
  setupEnvironment() {
    process.env.TZ = CONFIG.TIMEZONE;
    this.processManager.setupErrorHandlers();
    this.processManager.setupSignalHandlers();
    this.processManager.setupNetworkErrorListeners();
  }

  /**
   * 执行初始化
   */
  async init() {
    await setLog();
    logger.mark(chalk.cyan("XRK-Yunzai 初始化中..."));

    this.setupEnvironment();
    await redisInit();
    await this.processManager.updateTitle();
    await this.monitoringManager.setupBrowserMonitoring();
    await this.monitoringManager.setupMemoryMonitoring();
    
    const mode = "服务器模式";
    logger.mark(chalk.green(`XRK-Yunzai 初始化完成，模式: ${mode}`));

    return { success: true, mode: "server" };
  }
}

// 导出初始化函数
export default async function Packageloader() {
  const initManager = new InitManager();
  return await initManager.init();
}