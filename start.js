/**
 * @file start.js
 * @description 主启动脚本，用于管理葵崽服务器模式。支持交互菜单、PM2进程管理、信号处理和错误日志记录。
 *              默认开启调试模式，通过详细的错误日志（包括栈追踪）来捕获和报告问题。
 *              保留原有结构：命令行直接启动、交互菜单、PM2集成、信号处理等。
 */

import { promises as fs } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import inquirer from 'inquirer';
import chalk from 'chalk';

// 增加事件监听器上限以避免警告
process.setMaxListeners(30);

// 全局信号处理器单例
let globalSignalHandler = null;

// 统一路径配置
const PATHS = {
  LOGS: './logs',
  DATA: './data',
  BOTS: './data/bots',
  BACKUPS: './data/backups',
  CONFIG: './config',
  DEFAULT_CONFIG: './config/default_config',
  SERVER_BOTS: './data/server_bots',
  PM2_CONFIG: './config/pm2',
  RESOURCE_USAGE: './resources'
};

// 统一配置常量
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

/**
 * @class BaseManager
 * @description 基础管理类，提供目录确保等通用方法。
 */
class BaseManager {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * 确保所有必要目录存在。
   */
  async ensureDirectories() {
    for (const dir of Object.values(PATHS)) {
      await fs.mkdir(dir, { recursive: true }).catch(() => {});
    }
  }
}

/**
 * @class Logger
 * @description 日志管理类，支持队列化写入以避免并发问题。默认记录详细错误，包括栈追踪。
 */
class Logger {
  constructor() {
    this.logFile = path.join(PATHS.LOGS, 'restart.log');
    this.isWriting = false;
    this.queue = [];
  }

  /**
   * 确保日志目录存在。
   */
  async ensureLogDir() {
    await fs.mkdir(PATHS.LOGS, { recursive: true });
  }

  /**
   * 记录日志消息，支持不同级别。
   * @param {string} message - 日志消息。
   * @param {string} [level='INFO'] - 日志级别。
   */
  async log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    this.queue.push(logMessage);
    if (!this.isWriting) {
      await this.flushQueue();
    }
  }

  /**
   * 刷新日志队列到文件。
   */
  async flushQueue() {
    if (this.queue.length === 0 || this.isWriting) return;
    this.isWriting = true;
    const messages = this.queue.splice(0, this.queue.length);
    try {
      await fs.appendFile(this.logFile, messages.join(''));
    } catch (error) {
      console.error('日志写入失败:', error);
    } finally {
      this.isWriting = false;
      if (this.queue.length > 0) {
        await this.flushQueue();
      }
    }
  }

  /**
   * 记录错误日志，包括栈追踪，并输出到控制台。
   * @param {string} message - 错误消息。
   */
  async error(message) {
    await this.log(message, 'ERROR');
    console.error(chalk.red(message));
  }

  /**
   * 记录成功日志，并输出到控制台。
   * @param {string} message - 成功消息。
   */
  async success(message) {
    await this.log(message, 'SUCCESS');
    console.log(chalk.green(message));
  }
}

/**
 * @class PM2Manager
 * @description PM2进程管理类，处理启动、停止、重启等操作。
 * @extends BaseManager
 */
class PM2Manager extends BaseManager {
  /**
   * 获取PM2可执行路径。
   * @returns {string} PM2路径。
   */
  getPM2Path() {
    return process.platform === 'win32' ? 'pm2' : path.join(process.cwd(), 'node_modules', 'pm2', 'bin', 'pm2');
  }

  /**
   * 获取进程名称。
   * @param {number} port - 端口号。
   * @returns {string} 进程名称。
   */
  getProcessName(port) {
    return `XRK-MultiBot-Server-${port}`;
  }

  /**
   * 执行PM2命令。
   * @param {string} command - PM2命令。
   * @param {string[]} [args=[]] - 命令参数。
   * @param {string} [processName=''] - 进程名称。
   * @returns {Promise<boolean>} 执行是否成功。
   */
  async executePM2Command(command, args = [], processName = '') {
    const pm2Path = this.getPM2Path();
    let cmdCommand = pm2Path;
    let cmdArgs = [command, ...args];
    if (process.platform === 'win32') {
      cmdCommand = 'cmd';
      cmdArgs = ['/c', 'pm2', command, ...args];
    }
    await this.logger.log(`执行PM2命令: ${command} ${args.join(' ')}`);
    const result = spawnSync(cmdCommand, cmdArgs, { stdio: 'inherit', windowsHide: true, detached: false, shell: process.platform === 'win32' });
    if (result.status === 0) {
      await this.logger.success(`PM2 ${command} ${processName} 成功`);
    } else {
      await this.logger.error(`PM2 ${command} ${processName} 失败，状态码: ${result.status}`);
      if (process.platform === 'win32' && command === 'start') {
        await this.tryAlternativeStartMethod(args);
      }
    }
    return result.status === 0;
  }

  /**
   * 尝试使用替代路径启动PM2（Windows专用）。
   * @param {string[]} args - 启动参数。
   */
  async tryAlternativeStartMethod(args) {
    console.log(chalk.yellow('尝试使用替代方法启动PM2...'));
    try {
      const npmWhich = spawnSync('npm', ['bin', '-g'], { encoding: 'utf8', shell: true });
      if (npmWhich.stdout) {
        const globalPath = npmWhich.stdout.trim();
        const absolutePm2Path = path.join(globalPath, 'pm2.cmd');
        const retryResult = spawnSync(absolutePm2Path, ['start', ...args], { stdio: 'inherit', windowsHide: true, shell: true });
        if (retryResult.status === 0) {
          await this.logger.success('PM2替代方法启动成功');
        }
      }
    } catch (error) {
      await this.logger.error(`PM2替代方法失败: ${error.message}`);
    }
  }

  /**
   * 创建PM2配置文件。
   * @param {number} port - 端口号。
   * @param {string} mode - 模式。
   * @returns {Promise<string>} 配置路径。
   */
  async createConfig(port, mode) {
    const processName = this.getProcessName(port);
    const nodeArgs = getNodeArgs();
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
      env: { NODE_ENV: 'production', XRK_SELECTED_MODE: mode, XRK_SERVER_PORT: port.toString() }
    };
    await fs.mkdir(PATHS.PM2_CONFIG, { recursive: true });
    const configPath = path.join(PATHS.PM2_CONFIG, `pm2_server_${port}.json`);
    await fs.writeFile(configPath, JSON.stringify({ apps: [pm2Config] }, null, 2));
    return configPath;
  }

  /**
   * 执行端口相关的PM2命令。
   * @param {string} action - 操作类型（start, logs, stop, restart）。
   * @param {number} port - 端口号。
   * @returns {Promise<boolean>} 执行是否成功。
   */
  async executePortCommand(action, port) {
    const processName = this.getProcessName(port);
    const commandMap = {
      start: async () => {
        const configPath = await this.createConfig(port, 'server');
        return this.executePM2Command('start', [configPath], processName);
      },
      logs: () => this.executePM2Command('logs', [processName, '--lines', CONFIG.PM2_LINES.toString()], processName),
      stop: () => this.executePM2Command('stop', [processName], processName),
      restart: () => this.executePM2Command('restart', [processName], processName)
    };
    return commandMap[action]?.() || false;
  }
}

/**
 * @class ServerManager
 * @description 服务器管理类，处理端口管理、启动、重启等。
 * @extends BaseManager
 */
class ServerManager extends BaseManager {
  constructor(logger, pm2Manager) {
    super(logger);
    this.pm2Manager = pm2Manager;
    if (!globalSignalHandler) {
      globalSignalHandler = new SignalHandler(logger);
    }
    this.signalHandler = globalSignalHandler;
  }

  /**
   * 获取可用端口列表。
   * @returns {Promise<number[]>} 端口数组。
   */
  async getAvailablePorts() {
    try {
      const files = await fs.readdir(PATHS.SERVER_BOTS);
      return files.filter(file => !isNaN(file)).map(file => parseInt(file));
    } catch {
      return [];
    }
  }

  /**
   * 添加新端口并创建目录。
   * @returns {Promise<number|null>} 新端口号。
   */
  async addNewPort() {
    const { port } = await inquirer.prompt([{
      type: 'input',
      name: 'port',
      message: '请输入新的服务器端口号:',
      validate: (input) => {
        const portNum = parseInt(input);
        return !isNaN(portNum) && portNum > 0 && portNum < 65536;
      }
    }]);
    const portNum = parseInt(port);
    const portDir = path.join(PATHS.SERVER_BOTS, portNum.toString());
    await fs.mkdir(portDir, { recursive: true });
    await this.copyDefaultConfigs(portDir);
    return portNum;
  }

  /**
   * 复制默认配置文件到目标目录。
   * @param {string} targetDir - 目标目录。
   */
  async copyDefaultConfigs(targetDir) {
    try {
      const defaultConfigFiles = await fs.readdir(PATHS.DEFAULT_CONFIG);
      for (const file of defaultConfigFiles) {
        if (file.endsWith('.yaml') && file !== 'qq.yaml') {
          await fs.copyFile(path.join(PATHS.DEFAULT_CONFIG, file), path.join(targetDir, file));
        }
      }
      await this.logger.log(`已创建配置文件`);
    } catch (error) {
      await this.logger.error(`创建配置文件失败: ${error.message}\n${error.stack}`);
    }
  }

  /**
   * 启动服务器模式。
   * @param {number} port - 端口号。
   */
  async startServerMode(port) {
    await this.logger.log(`葵崽启动服务器模式，端口: ${port}`);
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
      await this.logger.error(`服务器模式启动失败: ${error.message}\n${error.stack}`);
      throw error;
    }
  }

  /**
   * 以重启机制启动服务器（前端模式）。
   * @param {number} port - 端口号。
   */
  async startWithFrontendRestart(port) {
    global.selectedMode = 'server';
    if (!this.signalHandler.isSetup) {
      this.signalHandler.setup();
    }
    let restartCount = 0;
    const startTime = Date.now();
    while (restartCount < CONFIG.MAX_RESTARTS) {
      const nodeArgs = getNodeArgs();
      const startArgs = [...nodeArgs, process.argv[1], 'server', port.toString()];
      await this.logger.log(`启动新进程 (${restartCount + 1}/${CONFIG.MAX_RESTARTS})`);
      const cleanEnv = Object.assign({}, process.env);
      cleanEnv.XRK_SELECTED_MODE = 'server';
      cleanEnv.XRK_SERVER_PORT = port.toString();
      const result = spawnSync(process.argv[0], startArgs, { stdio: 'inherit', windowsHide: true, env: cleanEnv, detached: false });
      const exitCode = result.status || 0;
      await this.logger.log(`进程退出，状态码: ${exitCode}`);
      if (exitCode === 0 || exitCode === 255) {
        await this.logger.log('正常退出或重启请求');
        return;
      }
      const waitTime = this.calculateRestartDelay(Date.now() - startTime, restartCount);
      await this.logger.log(`将在${waitTime / 1000}秒后重启`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      restartCount++;
    }
    await this.logger.error(`达到最大重启次数(${CONFIG.MAX_RESTARTS})，停止重启`);
  }

  /**
   * 计算重启延迟。
   * @param {number} runTime - 运行时间。
   * @param {number} restartCount - 重启次数。
   * @returns {number} 延迟毫秒。
   */
  calculateRestartDelay(runTime, restartCount) {
    if (runTime < 10000 && restartCount > 2) {
      return restartCount > 5 ? CONFIG.RESTART_DELAYS.LONG : CONFIG.RESTART_DELAYS.MEDIUM;
    }
    return CONFIG.RESTART_DELAYS.SHORT;
  }

  /**
   * 停止服务器。
   * @param {number} port - 端口号。
   */
  async stopServer(port) {
    await this.logger.log(`尝试关闭端口 ${port} 上的服务器`);
    try {
      const { default: fetch } = await import('node-fetch');
      await fetch(`http://localhost:${port}/shutdown`, { method: 'POST' });
      await this.logger.success('已发送停止请求');
    } catch (error) {
      await this.logger.error(`停止请求失败: ${error.message}\n${error.stack}`);
    }
  }
}

/**
 * @class SignalHandler
 * @description 信号处理器类（单例），处理SIGINT等信号，支持双击退出。
 */
class SignalHandler {
  constructor(logger) {
    this.logger = logger;
    this.lastSignal = null;
    this.lastSignalTime = 0;
    this.isSetup = false;
    this.handlers = {};
  }

  /**
   * 设置信号监听器。
   */
  setup() {
    if (this.isSetup) return;
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const createHandler = (signal) => async () => {
      const currentTime = Date.now();
      if (this.shouldExit(signal, currentTime)) {
        await this.logger.log(`检测到连续两次${signal}信号，程序将退出`);
        await this.cleanup();
        process.exit(1);
      }
      this.lastSignal = signal;
      this.lastSignalTime = currentTime;
      await this.logger.log(`收到${signal}信号，继续运行，再次发送同一信号强制退出`);
    };
    signals.forEach(signal => {
      this.handlers[signal] = createHandler(signal);
      process.on(signal, this.handlers[signal]);
    });
    this.isSetup = true;
  }

  /**
   * 清理信号监听器。
   */
  async cleanup() {
    if (!this.isSetup) return;
    Object.keys(this.handlers).forEach(signal => {
      process.removeListener(signal, this.handlers[signal]);
      delete this.handlers[signal];
    });
    this.isSetup = false;
  }

  /**
   * 检查是否应退出。
   * @param {string} signal - 信号类型。
   * @param {number} currentTime - 当前时间。
   * @returns {boolean} 是否退出。
   */
  shouldExit(signal, currentTime) {
    return signal === this.lastSignal && currentTime - this.lastSignalTime < CONFIG.SIGNAL_TIME_THRESHOLD;
  }
}

/**
 * @class MenuManager
 * @description 菜单管理类，处理用户交互。
 */
class MenuManager {
  constructor(serverManager, pm2Manager) {
    this.serverManager = serverManager;
    this.pm2Manager = pm2Manager;
  }

  /**
   * 运行主菜单循环。
   */
  async run() {
    let shouldExit = false;
    while (!shouldExit) {
      try {
        const selected = await this.selectMainMenuOption();
        shouldExit = await this.handleMenuAction(selected);
      } catch (error) {
        console.error(chalk.red('菜单操作出错:'), error);
      }
    }
  }

  /**
   * 选择主菜单选项。
   * @returns {Promise<object>} 选中选项。
   */
  async selectMainMenuOption() {
    const availablePorts = await this.serverManager.getAvailablePorts();
    const choices = [
      ...availablePorts.map(port => ({ name: `启动服务器 (端口: ${port})`, value: { action: 'start_server', port } })),
      { name: '添加新端口', value: { action: 'add_port' } },
      { name: 'PM2管理', value: { action: 'pm2_menu' } },
      { name: '退出', value: { action: 'exit' } }
    ];
    const { selected } = await inquirer.prompt([{
      type: 'list',
      name: 'selected',
      message: '🤖 葵崽 - 请选择操作:',
      choices,
      loop: false
    }]);
    return selected;
  }

  /**
   * 处理菜单动作。
   * @param {object} selected - 选中选项。
   * @returns {Promise<boolean>} 是否退出。
   */
  async handleMenuAction(selected) {
    switch (selected.action) {
      case 'start_server':
        await this.serverManager.startWithFrontendRestart(selected.port);
        break;
      case 'add_port':
        await this.handleAddPort();
        break;
      case 'pm2_menu':
        await this.pm2Menu();
        break;
      case 'exit':
        if (globalSignalHandler) await globalSignalHandler.cleanup();
        return true;
    }
    return false;
  }

  /**
   * 处理添加端口。
   */
  async handleAddPort() {
    const newPort = await this.serverManager.addNewPort();
    if (newPort) {
      const { startNow } = await inquirer.prompt([{
        type: 'confirm',
        name: 'startNow',
        message: `是否立即启动端口 ${newPort} 的服务器?`,
        default: true
      }]);
      if (startNow) {
        await this.serverManager.startWithFrontendRestart(newPort);
      }
    }
  }

  /**
   * PM2子菜单。
   */
  async pm2Menu() {
    const availablePorts = await this.serverManager.getAvailablePorts();
    if (availablePorts.length === 0) {
      console.log(chalk.yellow('没有可用的服务器端口'));
      return;
    }
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'PM2管理:',
      choices: [
        { name: '使用PM2启动服务器', value: 'start' },
        { name: '查看PM2日志', value: 'logs' },
        { name: '停止PM2进程', value: 'stop' },
        { name: '重启PM2进程', value: 'restart' },
        { name: '返回主菜单', value: 'back' }
      ],
      loop: false
    }]);
    if (action === 'back') return;
    const port = await this.selectPort(availablePorts, action);
    if (port) {
      await this.pm2Manager.executePortCommand(action, port);
    }
  }

  /**
   * 选择端口。
   * @param {number[]} availablePorts - 可用端口。
   * @param {string} action - 操作类型。
   * @returns {Promise<number|null>} 选中端口。
   */
  async selectPort(availablePorts, action) {
    const actionMessages = {
      start: '选择要用PM2启动的服务器端口:',
      logs: '查看哪个端口的日志?',
      stop: '停止哪个端口的PM2进程?',
      restart: '重启哪个端口的PM2进程?'
    };
    let choices = availablePorts.map(port => ({ name: `端口 ${port}`, value: port }));
    if (action === 'start') {
      choices.push({ name: '添加新端口', value: 'add' });
    }
    const { port } = await inquirer.prompt([{
      type: 'list',
      name: 'port',
      message: actionMessages[action],
      choices
    }]);
    if (port === 'add') {
      return await this.serverManager.addNewPort();
    }
    return port;
  }
}

/**
 * 获取Node参数。
 * @returns {string[]} Node参数数组。
 */
function getNodeArgs() {
  const nodeArgs = [...process.execArgv];
  if (!nodeArgs.includes('--expose-gc')) {
    nodeArgs.push('--expose-gc');
  }
  return nodeArgs;
}

// 全局异常处理（默认调试模式：记录完整栈追踪）
process.on('uncaughtException', async (error) => {
  console.error(chalk.red('未捕获的异常:'), error);
  const logger = new Logger();
  await logger.error(`未捕获的异常: ${error.message}\n${error.stack}`);
  if (globalSignalHandler) await globalSignalHandler.cleanup();
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error(chalk.red('未处理的Promise拒绝:'), reason);
  const logger = new Logger();
  await logger.error(`未处理的Promise拒绝: ${reason instanceof Error ? `${reason.message}\n${reason.stack}` : reason}`);
});

// 主函数
async function main() {
  const logger = new Logger();
  const pm2Manager = new PM2Manager(logger);
  const serverManager = new ServerManager(logger, pm2Manager);
  const menuManager = new MenuManager(serverManager, pm2Manager);

  await serverManager.ensureDirectories();
  await logger.ensureLogDir();

  const envPort = process.env.XRK_SERVER_PORT;
  const commandArg = process.argv[2];
  const portArg = process.argv[3] || envPort;

  // 命令行直接模式
  if (commandArg && portArg && !isNaN(parseInt(portArg))) {
    const port = parseInt(portArg);
    switch (commandArg) {
      case 'server':
        await serverManager.startServerMode(port);
        return;
      case 'stop':
        await serverManager.stopServer(port);
        return;
    }
  }

  // 交互菜单模式
  await menuManager.run();

  // 清理
  if (globalSignalHandler) await globalSignalHandler.cleanup();
}

export default main;

// 退出时清理
process.on('exit', async () => {
  if (globalSignalHandler) await globalSignalHandler.cleanup();
});

main().catch(async (error) => {
  const logger = new Logger();
  await logger.ensureLogDir();
  await logger.error(`启动出错: ${error.message}\n${error.stack}`);
  if (globalSignalHandler) await globalSignalHandler.cleanup();
  process.exit(1);
});