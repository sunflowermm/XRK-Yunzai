/**
 * @file start.js
 * @description 主启动脚本，用于管理葵崽服务器模式
 */

import { promises as fs } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import inquirer from 'inquirer';
import chalk from 'chalk';

// 屏蔽Node警告
process.removeAllListeners('warning');
process.on('warning', () => {});

// 屏蔽console输出的包装函数
const createLogger = () => {
  const isProduction = process.env.NODE_ENV === 'production' || process.env.DISABLE_CONSOLE === 'true';
  const noop = () => {};
  
  if (isProduction) {
    return {
      log: noop,
      info: noop,
      warn: noop,
      error: noop,
      debug: noop
    };
  }
  
  return {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console)
  };
};

const logger = createLogger();

// 增加事件监听器上限以避免警告
process.setMaxListeners(0);

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
 */
class BaseManager {
  constructor(loggerInstance) {
    this.logger = loggerInstance;
  }

  async ensureDirectories() {
    for (const dir of Object.values(PATHS)) {
      await fs.mkdir(dir, { recursive: true }).catch(() => {});
    }
  }
}

/**
 * @class Logger
 */
class Logger {
  constructor() {
    this.logFile = path.join(PATHS.LOGS, 'restart.log');
    this.isWriting = false;
    this.queue = [];
    this.useFileLog = process.env.USE_FILE_LOG !== 'false';
  }

  async ensureLogDir() {
    if (this.useFileLog) {
      await fs.mkdir(PATHS.LOGS, { recursive: true });
    }
  }

  async log(message, level = 'INFO') {
    if (!this.useFileLog) return;
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    this.queue.push(logMessage);
    if (!this.isWriting) {
      await this.flushQueue();
    }
  }

  async flushQueue() {
    if (!this.useFileLog || this.queue.length === 0 || this.isWriting) return;
    this.isWriting = true;
    const messages = this.queue.splice(0, this.queue.length);
    try {
      await fs.appendFile(this.logFile, messages.join(''));
    } catch (error) {
      // 静默处理错误
    } finally {
      this.isWriting = false;
      if (this.queue.length > 0) {
        await this.flushQueue();
      }
    }
  }

  async error(message) {
    await this.log(message, 'ERROR');
    if (process.env.DEBUG === 'true') {
      logger.error(chalk.red(message));
    }
  }

  async success(message) {
    await this.log(message, 'SUCCESS');
    if (process.env.DEBUG === 'true') {
      logger.log(chalk.green(message));
    }
  }
}

/**
 * @class PM2Manager
 */
class PM2Manager extends BaseManager {
  getPM2Path() {
    return process.platform === 'win32' ? 'pm2' : path.join(process.cwd(), 'node_modules', 'pm2', 'bin', 'pm2');
  }

  getProcessName(port) {
    return `XRK-MultiBot-Server-${port}`;
  }

  async executePM2Command(command, args = [], processName = '') {
    const pm2Path = this.getPM2Path();
    let cmdCommand = pm2Path;
    let cmdArgs = [command, ...args];
    if (process.platform === 'win32') {
      cmdCommand = 'cmd';
      cmdArgs = ['/c', 'pm2', command, ...args];
    }
    await this.logger.log(`执行PM2命令: ${command} ${args.join(' ')}`);
    const stdio = process.env.DEBUG === 'true' ? 'inherit' : 'ignore';
    const result = spawnSync(cmdCommand, cmdArgs, { stdio, windowsHide: true, detached: false, shell: process.platform === 'win32' });
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

  async tryAlternativeStartMethod(args) {
    if (process.env.DEBUG === 'true') {
      logger.log(chalk.yellow('尝试使用替代方法启动PM2...'));
    }
    try {
      const npmWhich = spawnSync('npm', ['bin', '-g'], { encoding: 'utf8', shell: true });
      if (npmWhich.stdout) {
        const globalPath = npmWhich.stdout.trim();
        const absolutePm2Path = path.join(globalPath, 'pm2.cmd');
        const stdio = process.env.DEBUG === 'true' ? 'inherit' : 'ignore';
        const retryResult = spawnSync(absolutePm2Path, ['start', ...args], { stdio, windowsHide: true, shell: true });
        if (retryResult.status === 0) {
          await this.logger.success('PM2替代方法启动成功');
        }
      }
    } catch (error) {
      await this.logger.error(`PM2替代方法失败: ${error.message}`);
    }
  }

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
      env: { 
        NODE_ENV: 'production', 
        XRK_SELECTED_MODE: mode, 
        XRK_SERVER_PORT: port.toString(),
        DISABLE_CONSOLE: 'true'
      }
    };
    await fs.mkdir(PATHS.PM2_CONFIG, { recursive: true });
    const configPath = path.join(PATHS.PM2_CONFIG, `pm2_server_${port}.json`);
    await fs.writeFile(configPath, JSON.stringify({ apps: [pm2Config] }, null, 2));
    return configPath;
  }

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
 */
class ServerManager extends BaseManager {
  constructor(loggerInstance, pm2Manager) {
    super(loggerInstance);
    this.pm2Manager = pm2Manager;
    if (!globalSignalHandler) {
      globalSignalHandler = new SignalHandler(loggerInstance);
    }
    this.signalHandler = globalSignalHandler;
  }

  async getAvailablePorts() {
    try {
      const files = await fs.readdir(PATHS.SERVER_BOTS);
      return files.filter(file => !isNaN(file)).map(file => parseInt(file));
    } catch {
      return [];
    }
  }

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
      cleanEnv.DISABLE_CONSOLE = 'true';
      const stdio = process.env.DEBUG === 'true' ? 'inherit' : 'ignore';
      const result = spawnSync(process.argv[0], startArgs, { stdio, windowsHide: true, env: cleanEnv, detached: false });
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

  calculateRestartDelay(runTime, restartCount) {
    if (runTime < 10000 && restartCount > 2) {
      return restartCount > 5 ? CONFIG.RESTART_DELAYS.LONG : CONFIG.RESTART_DELAYS.MEDIUM;
    }
    return CONFIG.RESTART_DELAYS.SHORT;
  }

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
 */
class SignalHandler {
  constructor(loggerInstance) {
    this.logger = loggerInstance;
    this.lastSignal = null;
    this.lastSignalTime = 0;
    this.isSetup = false;
    this.handlers = {};
  }

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

  async cleanup() {
    if (!this.isSetup) return;
    Object.keys(this.handlers).forEach(signal => {
      process.removeListener(signal, this.handlers[signal]);
      delete this.handlers[signal];
    });
    this.isSetup = false;
  }

  shouldExit(signal, currentTime) {
    return signal === this.lastSignal && currentTime - this.lastSignalTime < CONFIG.SIGNAL_TIME_THRESHOLD;
  }
}

/**
 * @class MenuManager
 */
class MenuManager {
  constructor(serverManager, pm2Manager) {
    this.serverManager = serverManager;
    this.pm2Manager = pm2Manager;
  }

  async run() {
    let shouldExit = false;
    while (!shouldExit) {
      try {
        const selected = await this.selectMainMenuOption();
        shouldExit = await this.handleMenuAction(selected);
      } catch (error) {
        if (process.env.DEBUG === 'true') {
          logger.error(chalk.red('菜单操作出错:'), error);
        }
      }
    }
  }

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

  async pm2Menu() {
    const availablePorts = await this.serverManager.getAvailablePorts();
    if (availablePorts.length === 0) {
      if (process.env.DEBUG === 'true') {
        logger.log(chalk.yellow('没有可用的服务器端口'));
      }
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
 * 获取Node参数
 */
function getNodeArgs() {
  const nodeArgs = [...process.execArgv];
  // 添加参数以抑制警告
  if (!nodeArgs.includes('--expose-gc')) {
    nodeArgs.push('--expose-gc');
  }
  if (!nodeArgs.includes('--no-warnings')) {
    nodeArgs.push('--no-warnings');
  }
  if (!nodeArgs.includes('--no-deprecation')) {
    nodeArgs.push('--no-deprecation');
  }
  return nodeArgs;
}

// 全局异常处理
process.on('uncaughtException', async (error) => {
  const loggerInstance = new Logger();
  await loggerInstance.error(`未捕获的异常: ${error.message}\n${error.stack}`);
  if (process.env.DEBUG === 'true') {
    logger.error(chalk.red('未捕获的异常:'), error);
  }
  if (globalSignalHandler) await globalSignalHandler.cleanup();
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  const loggerInstance = new Logger();
  await loggerInstance.error(`未处理的Promise拒绝: ${reason instanceof Error ? `${reason.message}\n${reason.stack}` : reason}`);
  if (process.env.DEBUG === 'true') {
    logger.error(chalk.red('未处理的Promise拒绝:'), reason);
  }
});

// 主函数
async function main() {
  const loggerInstance = new Logger();
  const pm2Manager = new PM2Manager(loggerInstance);
  const serverManager = new ServerManager(loggerInstance, pm2Manager);
  const menuManager = new MenuManager(serverManager, pm2Manager);

  await serverManager.ensureDirectories();
  await loggerInstance.ensureLogDir();

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
  const loggerInstance = new Logger();
  await loggerInstance.ensureLogDir();
  await loggerInstance.error(`启动出错: ${error.message}\n${error.stack}`);
  if (globalSignalHandler) await globalSignalHandler.cleanup();
  process.exit(1);
});