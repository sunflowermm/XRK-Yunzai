import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// 复制 Logger 类从 start.js 以避免循环导入，并在 bootstrap 中使用
class Logger {
  constructor() {
    this.logFile = path.join('./logs', 'restart.log');
    this.isWriting = false;
    this.queue = [];
  }

  async ensureLogDir() {
    await fs.mkdir('./logs', { recursive: true });
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
}

const checkAndInstallDependencies = async ({ packageJsonPath, nodeModulesPath }) => {
  const logger = new Logger();
  await logger.ensureLogDir();
  try {
    const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    const missingDependencies = await Promise.all(
      Object.keys(dependencies).map(async (dep) => {
        const depPath = path.join(nodeModulesPath, dep);
        return (await fs.stat(depPath).catch(() => false)) ? null : dep;
      })
    ).then((results) => results.filter(Boolean));

    if (missingDependencies.length > 0) {
      await logger.log('缺失的依赖: ' + missingDependencies.join(', '));
      await logger.log('正在运行 pnpm install...');
      await execAsync('pnpm install', { stdio: 'inherit' });
      await logger.log('依赖安装完成');
    } else {
    }
  } catch (error) {
    await logger.error('依赖检查或安装失败: ' + error.message);
    process.exit(1);
  }
};

const main = async () => {
  const logger = new Logger();
  await logger.ensureLogDir();
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  const nodeModulesPath = path.join(process.cwd(), 'node_modules');
  await checkAndInstallDependencies({ packageJsonPath, nodeModulesPath });
  await import('./start.js');
};

main().catch(async (error) => {
  const logger = new Logger();
  await logger.ensureLogDir();
  await logger.error('app程序执行出错: ' + error.message);
  process.exit(1);
});