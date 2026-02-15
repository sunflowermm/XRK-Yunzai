import { promises as fs } from 'fs';
import path from 'path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'child_process';
import inquirer from 'inquirer';
import chalk from 'chalk';
import cfg from './lib/config/config.js';

if (process.platform === 'win32') {
  try {
    process.stdout.setEncoding('utf8');
    process.stderr.setEncoding('utf8');
    spawnSync('chcp', ['65001'], { stdio: 'ignore', shell: false });
  } catch {}
}

process.setMaxListeners(30);

const entry = process.argv[1];
if (entry && path.basename(entry) === 'start.js') {
  const appPath = path.resolve(process.cwd(), 'app.js');
  const result = spawnSync(process.argv[0], [appPath, ...process.argv.slice(2)], { stdio: 'inherit', cwd: process.cwd() });
  process.exit(result.status !== null ? result.status : 1);
}

let globalSignalHandler = null;

const PATHS = {
  LOGS: './logs',
  DATA: './data',
  CONFIG: './config',
  DEFAULT_CONFIG: './config/default_config',
  SERVER_BOTS: './data/server_bots',
  PM2_CONFIG: './config/pm2',
  RESOURCE_USAGE: './resources'
};

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

async function writeFileIfChanged(filePath, content) {
  try {
    const existing = await fs.readFile(filePath, typeof content === 'string' ? 'utf8' : undefined);
    if (existing === content) return false;
  } catch {}

  await fs.writeFile(filePath, content);
  return true;
}

class Logger {
  constructor() {
    this.logFile = path.join(PATHS.LOGS, 'restart.log');
    this.isWriting = false;
    this.queue = [];
  }

  async log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    this.queue.push(logMessage);
    
    if (!this.isWriting) {
      await this.flushQueue();
    }
  }

  async flushQueue() {
    if (this.queue.length === 0 || this.isWriting) return;
    
    this.isWriting = true;
    const messages = this.queue.splice(0, this.queue.length);
    
    try {
      await fs.appendFile(this.logFile, messages.join(''));
    } catch (error) {
      // 静默失败，避免递归错误
    } finally {
      this.isWriting = false;
      if (this.queue.length > 0) {
        await this.flushQueue();
      }
    }
  }

  async error(message) {
    await this.log(message, 'ERROR');
  }

  async success(message) {
    await this.log(message, 'SUCCESS');
  }

  async warning(message) {
    await this.log(message, 'WARNING');
  }
}

class BaseManager {
  constructor(logger) {
    this.logger = logger;
  }
}

class PM2Manager extends BaseManager {
  getPM2Path() {
    return process.platform === 'win32' 
      ? 'pm2' 
      : path.join(process.cwd(), 'node_modules', 'pm2', 'bin', 'pm2');
  }

  getProcessName(port) {
    return `XRK-Yunzai-Server-${port}`;
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
    
    const result = spawnSync(cmdCommand, cmdArgs, {
      stdio: 'inherit',
      windowsHide: true,
      detached: false,
      shell: process.platform === 'win32'
    });
    
    const success = result.status === 0;
    
    if (success) {
      await this.logger.success(`PM2 ${command} ${processName} 成功`);
    } else {
      await this.logger.error(`PM2 ${command} ${processName} 失败，状态码: ${result.status}`);
      if (process.platform === 'win32' && command === 'start') {
        await this.tryAlternativeStartMethod(args);
      }
    }
    
    return success;
  }

  async tryAlternativeStartMethod(args) {
    try {
      const npmWhich = spawnSync('npm', ['bin', '-g'], {
        encoding: 'utf8',
        shell: true
      });
      
      if (npmWhich.stdout) {
        const globalPath = npmWhich.stdout.trim();
        const absolutePm2Path = path.join(globalPath, 'pm2.cmd');
        
        const retryResult = spawnSync(absolutePm2Path, ['start', ...args], {
          stdio: 'inherit',
          windowsHide: true,
          shell: true
        });
        
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
        XRK_SERVER_PORT: port.toString()
      }
    };
    
    const configPath = path.join(PATHS.PM2_CONFIG, `pm2_server_${port}.json`);
    await writeFileIfChanged(configPath, JSON.stringify({ apps: [pm2Config] }, null, 2));
    
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

class ServerManager extends BaseManager {
  constructor(logger, pm2Manager) {
    super(logger);
    this.pm2Manager = pm2Manager;
    if (!globalSignalHandler) {
      globalSignalHandler = new SignalHandler(logger);
    }
    this.signalHandler = globalSignalHandler;
  }

  async getAvailablePorts() {
    try {
      const files = await fs.readdir(PATHS.SERVER_BOTS);
      return files
        .filter(file => !isNaN(file))
        .map(file => parseInt(file))
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  async addNewPort() {
    const { port } = await inquirer.prompt([{
      type: 'input',
      name: 'port',
      message: chalk.bold('请输入新的服务器端口号:'),
      validate: (input) => {
        const portNum = parseInt(input);
        return !isNaN(portNum) && portNum > 0 && portNum < 65536
          ? true
          : chalk.red('请输入有效的端口号 (1-65535)');
      }
    }]);
    
    const portNum = parseInt(port);
    await this.ensurePortConfig(portNum);
    
    return portNum;
  }

  async ensurePortConfig(port) {
    const portDir = path.join(PATHS.SERVER_BOTS, port.toString());

    try {
      cfg.ensurePortConfigs(port);

      await this.logger.success(`端口 ${port} 的配置已就绪 (${portDir})`);
    } catch (error) {
      await this.logger.error(`初始化端口 ${port} 配置失败: ${error.message}\n${error.stack}`);
      throw error;
    }
  }

  async startServerMode(port) {
    const skipConfigCheck = process.env.XRK_SKIP_CONFIG_CHECK === '1';
    if (!skipConfigCheck) {
      await this.logger.log(`启动葵崽服务器，端口: ${port}`);
      await this.ensurePortConfig(port);
    }
    global.selectedMode = 'server';
    try {
      const { default: BotClass } = await import('./lib/bot.js');
      delete global.Bot;
      global.Bot = new BotClass();
      await global.Bot.run({ port });
    } catch (error) {
      await this.logger.error(`服务器模式启动失败: ${error.message}\n${error.stack}`);
      throw error;
    }
  }

  async startWithAutoRestart(port) {
    await this.ensurePortConfig(port);
    if (!this.signalHandler.isSetup) this.signalHandler.setup();
    this.signalHandler.inRestartLoop = true;
    let restartCount = 0;
    const startTime = Date.now();
    try {
      while (restartCount < CONFIG.MAX_RESTARTS) {
        if (restartCount > 0) {
          await this.logger.log(`重启进程 (尝试 ${restartCount + 1}/${CONFIG.MAX_RESTARTS})`);
        }
        
        const exitCode = await this.runServerProcess(port, restartCount > 0);
        if (exitCode === 0 || exitCode === 255) {
          await this.logger.log('正常退出');
          return;
        }
        await this.logger.log(`进程退出，状态码: ${exitCode}`);
        
        const waitTime = this.calculateRestartDelay(Date.now() - startTime, restartCount);
        if (waitTime > 0) {
          await this.logger.warning(`将在 ${waitTime / 1000} 秒后重启`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        restartCount++;
      }
      await this.logger.error(`达到最大重启次数 (${CONFIG.MAX_RESTARTS})，停止自动重启并返回菜单`);
    } finally {
      this.signalHandler.inRestartLoop = false;
    }
  }

  async runServerProcess(port, skipConfigCheck = false) {
    const nodeArgs = getNodeArgs();
    const entryScript = path.join(process.cwd(), 'app.js');
    const startArgs = [...nodeArgs, entryScript, 'server', port.toString()];
    const cleanEnv = {
      ...process.env,
      XRK_SERVER_PORT: port.toString(),
      XRK_SKIP_CONFIG_CHECK: skipConfigCheck ? '1' : '0'
    };
    return new Promise((resolve) => {
      this.signalHandler._closeReadline();
      const child = spawn(process.argv[0], startArgs, {
        stdio: 'inherit',
        windowsHide: true,
        env: cleanEnv,
        detached: false
      });
      this.signalHandler.currentChild = child;
      child.on('exit', (code, signal) => {
        this.signalHandler.currentChild = null;
        this.signalHandler._ensureReadline();
        const ret = signal ? 1 : (code !== null && code !== undefined ? code : 0);
        if (signal) this.logger.warning(`子进程被信号 ${signal} 终止，将自动重启`).catch(() => {});
        resolve(ret);
      });
      child.on('error', (err) => {
        this.signalHandler.currentChild = null;
        this.signalHandler._ensureReadline();
        this.logger.error(`子进程启动失败: ${err.message}`).catch(() => {});
        resolve(1);
      });
    });
  }

  calculateRestartDelay(runTime, restartCount) {
    if (runTime < 10000 && restartCount > 2) {
      return restartCount > 5 
        ? CONFIG.RESTART_DELAYS.LONG 
        : CONFIG.RESTART_DELAYS.MEDIUM;
    }
    return CONFIG.RESTART_DELAYS.SHORT;
  }

  async stopServer(port) {
    await this.logger.log(`尝试停止端口 ${port} 的服务器`);
    
    try {
      const { default: fetch } = await import('node-fetch');
      const response = await fetch(`http://localhost:${port}/shutdown`, {
        method: 'POST',
        timeout: 5000
      });
      
      if (response.ok) {
        await this.logger.success('服务器停止请求已发送');
      } else {
        await this.logger.warning(`服务器响应异常: ${response.status}`);
      }
    } catch (error) {
      await this.logger.error(`停止请求失败: ${error.message}`);
    }
  }

  async checkServerHealth(port) {
    try {
      const { default: fetch } = await import('node-fetch');
      const response = await fetch(`http://localhost:${port}/health`, {
        method: 'GET',
        timeout: 3000
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async removePortConfig(port) {
    const portDir = path.join(PATHS.SERVER_BOTS, port.toString());
    const pm2ConfigPath = path.join(PATHS.PM2_CONFIG, `pm2_server_${port}.json`);
    try {
      await this.pm2Manager.executePortCommand('stop', port);
      await fs.rm(portDir, { recursive: true, force: true });
      try {
        await fs.unlink(pm2ConfigPath);
      } catch {}
      await this.logger.success(`端口 ${port} 的配置已删除`);
    } catch (error) {
      await this.logger.error(`删除端口配置失败: ${error.message}`);
      throw error;
    }
  }
}

class SignalHandler {
  constructor(logger) {
    this.logger = logger;
    this.lastSignal = null;
    this.lastSignalTime = 0;
    this.isSetup = false;
    this.inRestartLoop = false;
    this.currentChild = null;
    this.handlers = {};
    this._rl = null;
  }

  _closeReadline() {
    if (this._rl) {
      this._rl.close();
      this._rl = null;
    }
  }

  _ensureReadline() {
    if (!this.isSetup || !process.stdin || this._rl) return;
    this._rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this._rl.on('SIGINT', () => process.emit('SIGINT'));
  }

  setup() {
    if (this.isSetup) return;
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const createHandler = (signal) => async () => {
      const currentTime = Date.now();
      if (this.inRestartLoop) {
        if (this.currentChild) this.currentChild.kill('SIGINT');
        else process.exit(0);
        return;
      }
      if (this.shouldExit(signal, currentTime)) {
        await this.logger.log(`检测到双击 ${signal} 信号，准备退出`);
        await this.cleanup();
        process.exit(0);
      }
      this.lastSignal = signal;
      this.lastSignalTime = currentTime;
      await this.logger.warning(`收到 ${signal} 信号，再次发送将退出程序`);
    };
    signals.forEach(signal => {
      this.handlers[signal] = createHandler(signal);
      process.on(signal, this.handlers[signal]);
    });
    this._ensureReadline();
    this.isSetup = true;
  }

  async cleanup() {
    if (!this.isSetup) return;
    this._closeReadline();
    Object.keys(this.handlers).forEach(signal => {
      process.removeListener(signal, this.handlers[signal]);
      delete this.handlers[signal];
    });
    this.isSetup = false;
  }

  shouldExit(signal, currentTime) {
    return signal === this.lastSignal &&
           currentTime - this.lastSignalTime < CONFIG.SIGNAL_TIME_THRESHOLD;
  }
}

class MenuManager {
  constructor(serverManager, pm2Manager) {
    this.serverManager = serverManager;
    this.pm2Manager = pm2Manager;
  }

  async run() {
    if (global.bootstrapLogger) {
      console.log(chalk.gray('  引导日志: logs/bootstrap.log'));
    }
    console.log(chalk.cyan('\n' + '='.repeat(50)));
    console.log(chalk.cyan.bold('  🤖 XRK-Yunzai 多端口服务器管理系统'));
    console.log(chalk.cyan('='.repeat(50)));
    console.log(chalk.gray(`  版本: 3.1.3 | Node.js: ${process.version}`));
    console.log(chalk.cyan('='.repeat(50) + '\n'));

    let shouldExit = false;
    
    while (!shouldExit) {
      try {
        const selected = await this.showMainMenu();
        shouldExit = await this.handleMenuAction(selected);
      } catch (error) {
        if (error?.isTtyError) {
          console.error(chalk.red('无法在当前环境中渲染菜单'));
          console.error(chalk.yellow('提示: 请确保终端支持交互式输入'));
          break;
        }

        const errMsg = error?.stack || error?.message || String(error);
        await this.serverManager.logger.error(`菜单操作出错: ${errMsg}`);
        console.error(chalk.red(errMsg));
      }
    }
  }

  async showMainMenu() {
    const availablePorts = await this.serverManager.getAvailablePorts();
    
    const choices = [
      ...availablePorts.map(port => ({
        name: chalk.green(`> 启动服务器 (端口: ${port})`),
        value: { action: 'start_server', port },
        short: `启动端口 ${port}`
      })),
      { 
        name: chalk.blue('+ 添加新端口'), 
        value: { action: 'add_port' },
        short: '添加新端口'
      },
      { 
        name: chalk.yellow('- 删除端口配置'), 
        value: { action: 'delete_port_config' },
        short: '删除端口配置'
      },
      { 
        name: chalk.cyan('* PM2管理'), 
        value: { action: 'pm2_menu' },
        short: 'PM2管理'
      },
      new inquirer.Separator(chalk.gray('─────────────────────────────')),
      { 
        name: chalk.red('X 退出'), 
        value: { action: 'exit' },
        short: '退出'
      }
    ];
    
    if (choices.length === 0) {
      choices.unshift({ 
        name: chalk.blue('+ 添加新端口'), 
        value: { action: 'add_port' },
        short: '添加新端口'
      });
    }
    
    const { selected } = await inquirer.prompt([{
      type: 'list',
      name: 'selected',
      message: chalk.cyan('请选择操作:'),
      choices,
      loop: false,
      pageSize: 15
    }]);
    
    return selected;
  }

  async handleMenuAction(selected) {
    switch (selected.action) {
      case 'start_server':
        console.log(chalk.blue(`\n正在启动端口 ${selected.port} 的服务器...\n`));
        await this.serverManager.startWithAutoRestart(selected.port);
        break;
        
      case 'add_port':
        await this.handleAddPort();
        break;
        
      case 'delete_port_config':
        await this.handleDeletePortConfig();
        break;
        
      case 'pm2_menu':
        await this.showPM2Menu();
        break;
        
      case 'system_info':
        await this.showSystemInfo();
        break;
        
      case 'exit':
        console.log(chalk.cyan('\n' + '='.repeat(50)));
        console.log(chalk.cyan.bold('  感谢使用 XRK-Yunzai！'));
        console.log(chalk.cyan('='.repeat(50)));
        console.log(chalk.gray('  再见！👋\n'));
        if (globalSignalHandler) {
          await globalSignalHandler.cleanup();
        }
        return true;
    }
    
    return false;
  }
  
  async showSystemInfo() {
    const os = await import('os');
    const systemInfo = {
      'Node.js 版本': process.version,
      '平台': `${os.platform()} ${os.arch()}`,
      'CPU 核心数': os.cpus().length,
      '总内存': `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB`,
      '可用内存': `${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)} GB`,
      '工作目录': process.cwd(),
      '运行时间': `${(process.uptime() / 60).toFixed(2)} 分钟`
    };
    
    console.log(chalk.cyan('\n' + '='.repeat(50)));
    console.log(chalk.cyan.bold('  系统信息'));
    console.log(chalk.cyan('='.repeat(50)));
    
    for (const [key, value] of Object.entries(systemInfo)) {
      console.log(chalk.gray(`  ${key.padEnd(15)}: ${chalk.yellow(value)}`));
    }
    
    console.log(chalk.cyan('='.repeat(50) + '\n'));
    
    await inquirer.prompt([{
      type: 'input',
      name: 'continue',
      message: '按 Enter 键返回主菜单...'
    }]);
  }

  async handleDeletePortConfig() {
    const ports = await this.serverManager.getAvailablePorts();
    if (ports.length === 0) {
      console.log(chalk.yellow('! 没有可删除的端口配置'));
      return;
    }

    const port = await this.selectPort(ports, 'delete');
    if (!port) return;

    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: chalk.bold.yellow(`确定删除端口 ${port} 的配置目录及相关PM2配置文件吗？`),
      default: false
    }]);

    if (confirm) {
      await this.serverManager.removePortConfig(port);
    }
  }

  async handleAddPort() {
    const newPort = await this.serverManager.addNewPort();
    
    if (newPort) {
      console.log(chalk.green(`\n✓ 端口 ${newPort} 已添加`));
      console.log(chalk.gray(`  配置文件已创建: data/server_bots/${newPort}/`));
      
      const { startNow } = await inquirer.prompt([{
        type: 'confirm',
        name: 'startNow',
        message: chalk.cyan(`是否立即启动端口 ${newPort} 的服务器?`),
        default: true
      }]);
      
      if (startNow) {
        console.log(chalk.blue(`\n正在启动端口 ${newPort} 的服务器...\n`));
        await this.serverManager.startWithAutoRestart(newPort);
      } else {
        console.log(chalk.yellow(`\n提示: 稍后可以通过主菜单启动端口 ${newPort} 的服务器`));
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  async showPM2Menu() {
    const availablePorts = await this.serverManager.getAvailablePorts();
    
    if (availablePorts.length === 0) {
      console.log(chalk.yellow('⚠ 没有可用的服务器端口'));
      return;
    }
    
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'PM2管理:',
      choices: [
        { name: '启动服务器', value: 'start' },
        { name: '查看日志', value: 'logs' },
        { name: '停止进程', value: 'stop' },
        { name: '重启进程', value: 'restart' },
        new inquirer.Separator(),
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
      start: '选择要启动的端口:',
      logs: '查看哪个端口的日志?',
      stop: '停止哪个端口?',
      restart: '重启哪个端口?'
    };
    
    const choices = availablePorts.map(port => ({
      name: `端口 ${port}`,
      value: port
    }));
    
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

function getNodeArgs() {
  const nodeArgs = [...process.execArgv];
  if (!nodeArgs.includes('--expose-gc')) nodeArgs.push('--expose-gc');
  if (!nodeArgs.includes('--no-warnings')) nodeArgs.push('--no-warnings');
  return nodeArgs;
}

function getLogger() {
  return global.bootstrapLogger || new Logger();
}

process.on('uncaughtException', async (error) => {
  await getLogger().error(`未捕获的异常: ${error.message}\n${error.stack}`);
  if (globalSignalHandler) await globalSignalHandler.cleanup();
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
  await getLogger().error(`未处理的 Promise 拒绝: ${msg}`);
});

process.on('exit', () => {
  if (globalSignalHandler) globalSignalHandler.cleanup();
});

async function main() {
  const logger = getLogger();
  const pm2Manager = new PM2Manager(logger);
  const serverManager = new ServerManager(logger, pm2Manager);
  const menuManager = new MenuManager(serverManager, pm2Manager);
  const envPort = process.env.XRK_SERVER_PORT;
  const commandArg = process.argv[2];
  const portArg = process.argv[3] || envPort;
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
  await menuManager.run();
  if (globalSignalHandler) await globalSignalHandler.cleanup();
}

export default main;

main().catch(async (error) => {
  await getLogger().error(`启动失败: ${error.message}\n${error.stack}`);
  if (globalSignalHandler) await globalSignalHandler.cleanup();
  process.exit(1);
});