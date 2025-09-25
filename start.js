/**
 * 多服务器管理系统
 * @description 支持多端口服务器的启动、停止、重启和PM2管理
 * @author XRK-MultiBot
 * @version 2.0.0
 */

import { promises as fs } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import inquirer from 'inquirer';
import chalk from 'chalk';

// ========================= 配置部分 =========================

/** 调试模式开关 */
const DEBUG_MODE = process.env.DEBUG === 'true' || process.argv.includes('--debug');

/** 路径配置 */
const PATHS = {
  LOGS: './logs',
  DATA: './data',
  BOTS: './data/bots',
  BACKUPS: './data/backups',
  CONFIG: './config',
  DEFAULT_CONFIG: './config/default_config',
  SERVER_BOTS: './data/server_bots',
  PM2_CONFIG: './config/pm2',
};

/** 系统配置 */
const CONFIG = {
  MAX_RESTARTS: 1000,
  SIGNAL_TIME_THRESHOLD: 3000,
  PM2_LINES: 100,
  MEMORY_LIMIT: '512M',
  RESTART_DELAYS: {
    SHORT: 1000,
    MEDIUM: 5000,
    LONG: 15000
  }
};

// ========================= 错误追踪系统 =========================

/**
 * 错误追踪器
 * 提供详细的错误信息和调用栈追踪
 */
class ErrorTracker {
  /**
   * 格式化错误信息
   * @param {Error} error - 错误对象
   * @param {string} context - 错误上下文
   * @returns {string} 格式化后的错误信息
   */
  static format(error, context = '') {
    const timestamp = new Date().toISOString();
    const stack = error.stack || error.toString();
    
    let formatted = `
╔════════════════════════════════════════════════════════════
║ 错误报告 - ${timestamp}
║ 上下文: ${context || '未知'}
║ 消息: ${error.message}
╠════════════════════════════════════════════════════════════
║ 调用栈:
${stack.split('\n').map(line => `║   ${line}`).join('\n')}
╠════════════════════════════════════════════════════════════
║ 环境信息:
║   Node版本: ${process.version}
║   平台: ${process.platform}
║   架构: ${process.arch}
║   内存使用: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
╚════════════════════════════════════════════════════════════
`;
    return formatted;
  }

  /**
   * 包装异步函数以捕获错误
   * @param {Function} fn - 要包装的函数
   * @param {string} context - 上下文描述
   * @returns {Function} 包装后的函数
   */
  static wrap(fn, context) {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        if (DEBUG_MODE) {
          console.error(ErrorTracker.format(error, context));
        }
        throw error;
      }
    };
  }
}

// ========================= 日志系统 =========================

/**
 * 增强型日志管理器
 * 支持多级别日志和调试模式
 */
class Logger {
  constructor() {
    this.logFile = path.join(PATHS.LOGS, 'restart.log');
    this.debugFile = path.join(PATHS.LOGS, 'debug.log');
    this.queue = [];
    this.isWriting = false;
  }

  /**
   * 确保日志目录存在
   */
  async ensureLogDir() {
    await fs.mkdir(PATHS.LOGS, { recursive: true });
  }

  /**
   * 记录日志
   * @param {string} message - 日志消息
   * @param {string} level - 日志级别
   * @param {boolean} toDebugFile - 是否写入调试文件
   */
  async log(message, level = 'INFO', toDebugFile = false) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    
    // 调试模式下输出到控制台
    if (DEBUG_MODE || level === 'DEBUG') {
      console.log(chalk.gray(`[DEBUG] ${message}`));
    }
    
    // 选择日志文件
    const targetFile = toDebugFile || level === 'DEBUG' ? this.debugFile : this.logFile;
    
    try {
      await fs.appendFile(targetFile, logMessage);
    } catch (error) {
      console.error('日志写入失败:', error.message);
    }
  }

  /**
   * 调试日志
   */
  async debug(message, data = null) {
    if (DEBUG_MODE) {
      let debugMessage = message;
      if (data) {
        debugMessage += '\n' + JSON.stringify(data, null, 2);
      }
      await this.log(debugMessage, 'DEBUG', true);
    }
  }

  /**
   * 错误日志
   */
  async error(message, error = null) {
    await this.log(message, 'ERROR');
    console.error(chalk.red(message));
    
    if (error && DEBUG_MODE) {
      console.error(ErrorTracker.format(error, message));
      await this.log(ErrorTracker.format(error, message), 'ERROR', true);
    }
  }

  /**
   * 成功日志
   */
  async success(message) {
    await this.log(message, 'SUCCESS');
    console.log(chalk.green(message));
  }

  /**
   * 警告日志
   */
  async warn(message) {
    await this.log(message, 'WARN');
    console.log(chalk.yellow(message));
  }
}

// ========================= PM2管理器 =========================

/**
 * PM2进程管理器
 * 处理PM2相关的所有操作
 */
class PM2Manager {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * 获取PM2可执行文件路径
   */
  getPM2Path() {
    const isWindows = process.platform === 'win32';
    const pm2Path = isWindows ? 
      'pm2' : 
      path.join(process.cwd(), 'node_modules', 'pm2', 'bin', 'pm2');
    
    this.logger.debug(`PM2路径: ${pm2Path}`);
    return pm2Path;
  }

  /**
   * 生成进程名称
   */
  getProcessName(port) {
    return `XRK-MultiBot-Server-${port}`;
  }

  /**
   * 执行PM2命令
   */
  async executePM2Command(command, args = [], processName = '') {
    const pm2Path = this.getPM2Path();
    const isWindows = process.platform === 'win32';
    
    let cmdCommand = pm2Path;
    let cmdArgs = [command, ...args];
    const spawnOptions = { 
      stdio: 'inherit', 
      windowsHide: true,
      detached: false
    };

    if (isWindows) {
      cmdCommand = 'cmd';
      cmdArgs = ['/c', 'pm2', command, ...args];
      spawnOptions.shell = true;
    }

    await this.logger.debug(`执行PM2命令`, {
      command: cmdCommand,
      args: cmdArgs,
      processName
    });

    try {
      const result = spawnSync(cmdCommand, cmdArgs, spawnOptions);

      if (result.status === 0) {
        await this.logger.success(`PM2 ${command} ${processName} 成功`);
        return true;
      } else {
        const errorMsg = `PM2 ${command} ${processName} 失败，状态码: ${result.status}`;
        await this.logger.error(errorMsg);
        
        if (DEBUG_MODE && result.stderr) {
          await this.logger.debug('PM2错误输出:', result.stderr.toString());
        }
        
        return false;
      }
    } catch (error) {
      await this.logger.error(`PM2命令执行异常`, error);
      return false;
    }
  }

  /**
   * 创建PM2配置文件
   */
  async createConfig(port, mode) {
    const processName = this.getProcessName(port);
    const nodeArgs = this.getNodeArgs();

    const pm2Config = {
      name: processName,
      script: './app.js',
      args: ['server', port.toString()],
      interpreter: 'node',
      node_args: nodeArgs.join(' '),
      cwd: './',
      exec_mode: 'fork',
      max_memory_restart: CONFIG.MEMORY_LIMIT,
      out_file: `./logs/pm2_server_out_${port}.log`,
      error_file: `./logs/pm2_server_error_${port}.log`,
      env: { 
        NODE_ENV: 'production',
        DEBUG: DEBUG_MODE ? 'true' : 'false',
        XRK_SELECTED_MODE: mode, 
        XRK_SERVER_PORT: port.toString() 
      },
    };

    await fs.mkdir(PATHS.PM2_CONFIG, { recursive: true });
    const configPath = path.join(PATHS.PM2_CONFIG, `pm2_server_${port}.json`);
    
    await this.logger.debug('创建PM2配置', pm2Config);
    await fs.writeFile(configPath, JSON.stringify({ apps: [pm2Config] }, null, 2));
    
    return configPath;
  }

  /**
   * 获取Node参数
   */
  getNodeArgs() {
    const nodeArgs = [...process.execArgv];
    
    // 添加必要的Node参数
    if (!nodeArgs.includes('--expose-gc')) {
      nodeArgs.push('--expose-gc');
    }
    
    // 调试模式下添加检查参数
    if (DEBUG_MODE) {
      if (!nodeArgs.includes('--trace-warnings')) {
        nodeArgs.push('--trace-warnings');
      }
      if (!nodeArgs.includes('--trace-deprecation')) {
        nodeArgs.push('--trace-deprecation');
      }
    }
    
    return nodeArgs;
  }

  /**
   * 执行端口相关的PM2命令
   */
  async executePortCommand(action, port) {
    const processName = this.getProcessName(port);
    
    try {
      switch(action) {
        case 'start':
          const configPath = await this.createConfig(port, 'server');
          return await this.executePM2Command('start', [configPath], processName);
        
        case 'logs':
          return await this.executePM2Command('logs', [processName, '--lines', CONFIG.PM2_LINES.toString()], processName);
        
        case 'stop':
          return await this.executePM2Command('stop', [processName], processName);
        
        case 'restart':
          return await this.executePM2Command('restart', [processName], processName);
        
        default:
          await this.logger.error(`未知的PM2操作: ${action}`);
          return false;
      }
    } catch (error) {
      await this.logger.error(`PM2操作失败: ${action}`, error);
      return false;
    }
  }
}

// ========================= 服务器管理器 =========================

/**
 * 服务器管理器
 * 处理服务器的启动、停止和重启
 */
class ServerManager {
  constructor(logger, pm2Manager) {
    this.logger = logger;
    this.pm2Manager = pm2Manager;
    this.signalHandler = new SignalHandler(logger);
  }

  /**
   * 确保必要目录存在
   */
  async ensureDirectories() {
    for (const [name, dir] of Object.entries(PATHS)) {
      try {
        await fs.mkdir(dir, { recursive: true });
        await this.logger.debug(`确保目录存在: ${name} -> ${dir}`);
      } catch (error) {
        await this.logger.error(`创建目录失败: ${dir}`, error);
      }
    }
  }

  /**
   * 获取可用端口列表
   */
  async getAvailablePorts() {
    try {
      const files = await fs.readdir(PATHS.SERVER_BOTS);
      const ports = files.filter(file => !isNaN(file)).map(file => parseInt(file));
      await this.logger.debug(`可用端口: ${ports.join(', ')}`);
      return ports;
    } catch (error) {
      await this.logger.debug('获取端口失败，返回空列表', error);
      return [];
    }
  }

  /**
   * 启动服务器（带自动重启）
   */
  async startWithAutoRestart(port) {
    global.selectedMode = 'server';
    
    if (!this.signalHandler.isSetup) {
      this.signalHandler.setup();
    }

    let restartCount = 0;
    const startTime = Date.now();

    while (restartCount < CONFIG.MAX_RESTARTS) {
      try {
        await this.logger.log(`启动服务器 [端口:${port}] [重启:${restartCount + 1}/${CONFIG.MAX_RESTARTS}]`);
        
        const result = await this.spawnServer(port);
        const exitCode = result.status || 0;
        
        await this.logger.log(`服务器退出 [端口:${port}] [退出码:${exitCode}]`);

        // 正常退出或重启信号
        if (exitCode === 0 || exitCode === 255) {
          await this.logger.log('检测到正常退出或重启请求');
          return;
        }

        // 计算重启延迟
        const delay = this.calculateRestartDelay(Date.now() - startTime, restartCount);
        await this.logger.warn(`将在${delay / 1000}秒后重启服务器`);
        
        await new Promise(resolve => setTimeout(resolve, delay));
        restartCount++;
        
      } catch (error) {
        await this.logger.error(`服务器启动失败 [端口:${port}]`, error);
        
        if (DEBUG_MODE) {
          // 调试模式下等待用户输入
          const { shouldContinue } = await inquirer.prompt([{
            type: 'confirm',
            name: 'shouldContinue',
            message: '是否继续尝试重启？',
            default: false
          }]);
          
          if (!shouldContinue) {
            break;
          }
        }
        
        restartCount++;
      }
    }

    await this.logger.error(`达到最大重启次数(${CONFIG.MAX_RESTARTS})，停止重启`);
  }

  /**
   * 生成服务器进程
   */
  async spawnServer(port) {
    const nodeArgs = this.pm2Manager.getNodeArgs();
    const startArgs = [...nodeArgs, process.argv[1], 'server', port.toString()];
    
    const env = Object.assign({}, process.env, {
      XRK_SELECTED_MODE: 'server',
      XRK_SERVER_PORT: port.toString(),
      DEBUG: DEBUG_MODE ? 'true' : 'false'
    });

    await this.logger.debug('启动参数', {
      node: process.argv[0],
      args: startArgs,
      env: { XRK_SELECTED_MODE: env.XRK_SELECTED_MODE, XRK_SERVER_PORT: env.XRK_SERVER_PORT }
    });

    return spawnSync(process.argv[0], startArgs, {
      stdio: 'inherit',
      windowsHide: true,
      env,
      detached: false
    });
  }

  /**
   * 计算重启延迟时间
   */
  calculateRestartDelay(runTime, restartCount) {
    // 快速崩溃检测
    if (runTime < 10000 && restartCount > 2) {
      return restartCount > 5 ? CONFIG.RESTART_DELAYS.LONG : CONFIG.RESTART_DELAYS.MEDIUM;
    }
    return CONFIG.RESTART_DELAYS.SHORT;
  }

  /**
   * 停止服务器
   */
  async stopServer(port) {
    await this.logger.log(`停止服务器 [端口:${port}]`);
    try {
      const { default: fetch } = await import('node-fetch');
      const response = await fetch(`http://localhost:${port}/shutdown`, { 
        method: 'POST',
        timeout: 5000
      });
      
      if (response.ok) {
        await this.logger.success('服务器停止成功');
      } else {
        await this.logger.warn(`停止请求返回状态码: ${response.status}`);
      }
    } catch (error) {
      await this.logger.error('停止服务器失败', error);
    }
  }

  /**
   * 启动服务器模式（直接运行）
   */
  async startServerMode(port) {
    await this.logger.log(`直接启动服务器模式 [端口:${port}]`);
    global.selectedMode = 'server';
    
    try {
      const originalArgv = [...process.argv];
      process.argv = [originalArgv[0], originalArgv[1], 'server', port.toString()];
      
      const { default: BotClass } = await import('./lib/bot.js');
      
      if (global.Bot) {
        delete global.Bot;
      }
      
      global.Bot = new BotClass();
      await global.Bot.run({ port });
      
      process.argv = originalArgv;
    } catch (error) {
      await this.logger.error('服务器模式启动失败', error);
      throw error;
    }
  }
}

// ========================= 信号处理器 =========================

/**
 * 信号处理器
 * 处理系统信号以优雅地关闭服务
 */
class SignalHandler {
  constructor(logger) {
    this.logger = logger;
    this.lastSignal = null;
    this.lastSignalTime = 0;
    this.isSetup = false;
    this.handlers = new Map();
  }

  /**
   * 设置信号处理
   */
  setup() {
    if (this.isSetup) return;
    
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    
    signals.forEach(signal => {
      const handler = async () => {
        const currentTime = Date.now();
        
        if (this.shouldExit(signal, currentTime)) {
          await this.logger.log(`收到双重${signal}信号，退出程序`);
          await this.cleanup();
          process.exit(0);
        }
        
        this.lastSignal = signal;
        this.lastSignalTime = currentTime;
        await this.logger.log(`收到${signal}信号，再次发送将退出`);
      };
      
      this.handlers.set(signal, handler);
      process.on(signal, handler);
    });
    
    this.isSetup = true;
    this.logger.debug('信号处理器已设置');
  }

  /**
   * 清理信号处理器
   */
  async cleanup() {
    if (!this.isSetup) return;
    
    for (const [signal, handler] of this.handlers) {
      process.removeListener(signal, handler);
    }
    
    this.handlers.clear();
    this.isSetup = false;
    await this.logger.debug('信号处理器已清理');
  }

  /**
   * 判断是否应该退出
   */
  shouldExit(signal, currentTime) {
    return signal === this.lastSignal && 
           currentTime - this.lastSignalTime < CONFIG.SIGNAL_TIME_THRESHOLD;
  }
}

// ========================= 菜单管理器 =========================

/**
 * 交互式菜单管理器
 */
class MenuManager {
  constructor(serverManager, pm2Manager, logger) {
    this.serverManager = serverManager;
    this.pm2Manager = pm2Manager;
    this.logger = logger;
  }

  /**
   * 运行主菜单
   */
  async run() {
    console.log(chalk.cyan('\n╔════════════════════════════════════╗'));
    console.log(chalk.cyan('║     葵崽多服务器管理系统 v2.0      ║'));
    console.log(chalk.cyan('╚════════════════════════════════════╝\n'));
    
    if (DEBUG_MODE) {
      console.log(chalk.yellow('🔍 调试模式已开启\n'));
    }

    let shouldExit = false;
    
    while (!shouldExit) {
      try {
        const action = await this.showMainMenu();
        shouldExit = await this.handleAction(action);
      } catch (error) {
        await this.logger.error('菜单操作失败', error);
      }
    }
  }

  /**
   * 显示主菜单
   */
  async showMainMenu() {
    const ports = await this.serverManager.getAvailablePorts();
    
    const choices = [
      ...ports.map(port => ({ 
        name: `🚀 启动服务器 (端口: ${port})`, 
        value: { type: 'start', port } 
      })),
      { name: '➕ 添加新端口', value: { type: 'add' } },
      { name: '🔧 PM2管理', value: { type: 'pm2' } },
      { name: '🔍 调试工具', value: { type: 'debug' } },
      { name: '❌ 退出', value: { type: 'exit' } },
    ];

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: '请选择操作:',
      choices,
      loop: false,
    }]);

    return action;
  }

  /**
   * 处理菜单动作
   */
  async handleAction(action) {
    switch (action.type) {
      case 'start':
        await this.serverManager.startWithAutoRestart(action.port);
        break;
        
      case 'add':
        await this.addNewPort();
        break;
        
      case 'pm2':
        await this.showPM2Menu();
        break;
        
      case 'debug':
        await this.showDebugMenu();
        break;
        
      case 'exit':
        return true;
    }
    return false;
  }

  /**
   * 添加新端口
   */
  async addNewPort() {
    const { port } = await inquirer.prompt([{
      type: 'input',
      name: 'port',
      message: '请输入端口号 (1-65535):',
      validate: input => {
        const num = parseInt(input);
        return num > 0 && num < 65536 || '请输入有效端口号';
      }
    }]);

    const portNum = parseInt(port);
    const portDir = path.join(PATHS.SERVER_BOTS, portNum.toString());
    
    try {
      await fs.mkdir(portDir, { recursive: true });
      await this.copyDefaultConfigs(portDir);
      await this.logger.success(`端口 ${portNum} 添加成功`);
      
      const { startNow } = await inquirer.prompt([{
        type: 'confirm',
        name: 'startNow',
        message: '是否立即启动？',
        default: true
      }]);
      
      if (startNow) {
        await this.serverManager.startWithAutoRestart(portNum);
      }
    } catch (error) {
      await this.logger.error(`添加端口失败`, error);
    }
  }

  /**
   * 复制默认配置
   */
  async copyDefaultConfigs(targetDir) {
    try {
      const files = await fs.readdir(PATHS.DEFAULT_CONFIG);
      
      for (const file of files) {
        if (file.endsWith('.yaml') && file !== 'qq.yaml') {
          const src = path.join(PATHS.DEFAULT_CONFIG, file);
          const dest = path.join(targetDir, file);
          await fs.copyFile(src, dest);
          await this.logger.debug(`复制配置: ${file}`);
        }
      }
    } catch (error) {
      await this.logger.error('复制配置失败', error);
    }
  }

  /**
   * PM2管理菜单
   */
  async showPM2Menu() {
    const ports = await this.serverManager.getAvailablePorts();
    
    if (ports.length === 0) {
      await this.logger.warn('没有可用端口');
      return;
    }

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'PM2操作:',
      choices: [
        { name: '▶️ 启动', value: 'start' },
        { name: '📝 查看日志', value: 'logs' },
        { name: '⏹️ 停止', value: 'stop' },
        { name: '🔄 重启', value: 'restart' },
        { name: '↩️ 返回', value: 'back' }
      ]
    }]);

    if (action === 'back') return;

    const { port } = await inquirer.prompt([{
      type: 'list',
      name: 'port',
      message: '选择端口:',
      choices: ports.map(p => ({ name: `端口 ${p}`, value: p }))
    }]);

    await this.pm2Manager.executePortCommand(action, port);
  }

  /**
   * 调试工具菜单
   */
  async showDebugMenu() {
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: '调试工具:',
      choices: [
        { name: '📊 查看系统信息', value: 'sysinfo' },
        { name: '📝 查看日志文件', value: 'logs' },
        { name: '🧹 清理日志', value: 'clear' },
        { name: '↩️ 返回', value: 'back' }
      ]
    }]);

    switch(action) {
      case 'sysinfo':
        this.showSystemInfo();
        break;
        
      case 'logs':
        await this.showLogs();
        break;
        
      case 'clear':
        await this.clearLogs();
        break;
    }
  }

  /**
   * 显示系统信息
   */
  showSystemInfo() {
    const memUsage = process.memoryUsage();
    console.log(chalk.cyan('\n系统信息:'));
    console.log(`  Node版本: ${process.version}`);
    console.log(`  平台: ${process.platform}`);
    console.log(`  架构: ${process.arch}`);
    console.log(`  内存使用: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);
    console.log(`  运行时间: ${Math.round(process.uptime())}秒\n`);
  }

  /**
   * 显示日志
   */
  async showLogs() {
    try {
      const logFile = DEBUG_MODE ? 
        path.join(PATHS.LOGS, 'debug.log') : 
        path.join(PATHS.LOGS, 'restart.log');
      
      const content = await fs.readFile(logFile, 'utf-8');
      const lines = content.split('\n').slice(-50); // 最后50行
      console.log(chalk.gray('\n最近日志:'));
      console.log(lines.join('\n'));
    } catch (error) {
      await this.logger.error('读取日志失败', error);
    }
  }

  /**
   * 清理日志
   */
  async clearLogs() {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: '确定清理所有日志？',
      default: false
    }]);

    if (confirm) {
      try {
        const files = await fs.readdir(PATHS.LOGS);
        for (const file of files) {
          await fs.unlink(path.join(PATHS.LOGS, file));
        }
        await this.logger.success('日志清理完成');
      } catch (error) {
        await this.logger.error('清理失败', error);
      }
    }
  }
}

// ========================= 全局异常处理 =========================

/**
 * 设置全局异常处理
 */
function setupGlobalHandlers(logger) {
  process.on('uncaughtException', async (error) => {
    console.error(chalk.red('\n☠️ 未捕获的异常:'));
    console.error(ErrorTracker.format(error, '全局异常'));
    await logger.error('未捕获的异常', error);
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason, promise) => {
    console.error(chalk.red('\n⚠️ 未处理的Promise拒绝:'));
    console.error(reason);
    await logger.error(`未处理的Promise拒绝: ${reason}`);
    
    if (DEBUG_MODE) {
      console.error('Promise:', promise);
    }
  });

  process.on('warning', (warning) => {
    if (DEBUG_MODE) {
      console.warn(chalk.yellow('\n⚠️ 警告:'));
      console.warn(warning);
    }
  });
}

// ========================= 主函数 =========================

/**
 * 主入口函数
 */
async function main() {
  // 初始化日志
  const logger = new Logger();
  await logger.ensureLogDir();
  
  // 设置全局异常处理
  setupGlobalHandlers(logger);
  
  // 初始化管理器
  const pm2Manager = new PM2Manager(logger);
  const serverManager = new ServerManager(logger, pm2Manager);
  const menuManager = new MenuManager(serverManager, pm2Manager, logger);

  // 确保必要目录存在
  await serverManager.ensureDirectories();

  // 检查启动参数
  const [,, command, port] = process.argv;
  const envPort = process.env.XRK_SERVER_PORT;
  const targetPort = port || envPort;

  // 命令行模式
  if (command && targetPort && !isNaN(parseInt(targetPort))) {
    const portNum = parseInt(targetPort);
    
    try {
      switch (command) {
        case 'server':
          await serverManager.startServerMode(portNum);
          break;
          
        case 'stop':
          await serverManager.stopServer(portNum);
          break;
          
        default:
          await logger.error(`未知命令: ${command}`);
      }
    } catch (error) {
      await logger.error(`命令执行失败`, error);
      process.exit(1);
    }
    
    return;
  }

  // 交互模式
  await menuManager.run();
}

// ========================= 导出和启动 =========================

export default main;

// 启动应用
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (error) => {
    const logger = new Logger();
    await logger.ensureLogDir();
    await logger.error('启动失败', error);
    
    if (DEBUG_MODE) {
      console.error(ErrorTracker.format(error, '启动失败'));
    }
    
    process.exit(1);
  });
}