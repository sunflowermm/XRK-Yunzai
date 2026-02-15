/**
 * @file app.js
 * @description 应用程序引导文件（依赖检查与环境校验后启动 start.js）
 * @author XRK
 * @copyright 2025 XRK Studio
 * @license MIT
 *
 * 逻辑对齐 XRK-AGT：Node 版本校验、基础目录创建、根依赖与插件依赖检查安装，再加载 start.js。
 */

import fs from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { BASE_DIRS } from './lib/base-dirs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 确保进程带 --expose-gc，供 start.js 及系统优化使用；缺失则自举一次
if (!process.execArgv.includes('--expose-gc')) {
  const appPath = process.argv[1] || path.join(__dirname, 'app.js');
  const result = spawnSync(process.argv[0], ['--expose-gc', ...process.execArgv, appPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: process.cwd()
  });
  process.exit(result.status ?? (result.signal ? 128 + 1 : 1));
}

/**
 * 引导阶段日志：写文件 + 控制台着色
 * @param {string} logFile - 日志文件路径
 * @param {boolean} useConsole - 是否同时输出到控制台
 */
function createBootstrapLogger(logFile, useConsole = true) {
  const colors = { INFO: '\x1b[36m', SUCCESS: '\x1b[32m', WARNING: '\x1b[33m', ERROR: '\x1b[31m', RESET: '\x1b[0m' };
  async function write(message, level = 'INFO') {
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    try {
      await fs.appendFile(logFile, line, 'utf8');
    } catch {}
    if (useConsole) {
      console.log(`${colors[level] || ''}${message}${colors.RESET}`);
    }
  }
  return {
    log: (msg) => write(msg, 'INFO'),
    success: (msg) => write(msg, 'SUCCESS'),
    warning: (msg) => write(msg, 'WARNING'),
    error: (msg) => write(msg, 'ERROR')
  };
}

/**
 * 环境校验：Node 版本 + 基础目录
 */
async function validateEnvironment() {
  const [major, minor] = process.version.slice(1).split('.').map(Number);
  if (major < 18 || (major === 18 && minor < 14)) {
    throw new Error(`Node.js 需 v18.14.0+，当前: ${process.version}`);
  }
  await Promise.all(BASE_DIRS.map(dir => fs.mkdir(dir, { recursive: true }).catch(() => {})));
}

/**
 * 依赖管理器（对齐 XRK-AGT：缺失检测 + pnpm install）
 */
class DependencyManager {
  constructor(logger) {
    this.logger = logger;
  }

  async parsePackageJson(packageJsonPath) {
    const content = await fs.readFile(packageJsonPath, 'utf-8');
    return JSON.parse(content);
  }

  async getMissingDependencies(depNames, nodeModulesPath) {
    const results = await Promise.all(
      depNames.map(async dep => {
        try {
          const st = await fs.stat(path.join(nodeModulesPath, dep));
          return st.isDirectory();
        } catch {
          return false;
        }
      })
    );
    return depNames.filter((_, i) => !results[i]);
  }

  async installDependencies(missingDeps, cwd = process.cwd()) {
    const prefix = cwd !== process.cwd() ? `[${path.basename(cwd)}] ` : '';
    await this.logger.warning(`${prefix}发现 ${missingDeps.length} 个缺失依赖，使用 pnpm 安装...`);
    await this.logger.log(`${prefix}正在安装依赖，若出现 DEP0190 警告可忽略，请稍候...`);
    const result = spawnSync('pnpm', ['install'], {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, CI: 'true' }
    });
    if (result.status !== 0) {
      const err = result.error || new Error(`pnpm install 退出码 ${result.status}`);
      if (err.code === 'ENOENT') {
        throw new Error('pnpm 未安装或不在 PATH 中，请执行: npm install -g pnpm');
      }
      throw new Error(`依赖安装失败: ${err.message}`);
    }
    await this.logger.success(`${prefix}依赖安装完成`);
  }

  async checkAndInstall(packageJsonPath, nodeModulesPath) {
    const pkg = await this.parsePackageJson(packageJsonPath);
    const depNames = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
    if (depNames.length === 0) return;
    const missing = await this.getMissingDependencies(depNames, nodeModulesPath);
    if (missing.length > 0) {
      await this.installDependencies(missing, path.dirname(packageJsonPath));
    }
  }

  /**
   * 扫描 plugins/、renderers/ 下子目录，对有 package.json 的做依赖检查与安装
   */
  async ensurePluginDependencies(rootDir = process.cwd()) {
    const baseDirs = ['plugins', 'renderers'];
    const dirs = [];
    for (const base of baseDirs) {
      const dir = path.join(rootDir, base);
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const d of entries) {
          if (d.isDirectory() && !d.name.startsWith('.')) {
            dirs.push(path.join(dir, d.name));
          }
        }
      } catch {}
    }
    for (const d of dirs) {
      const pkgPath = path.join(d, 'package.json');
      const nodeModulesPath = path.join(d, 'node_modules');
      try {
        await fs.access(pkgPath);
      } catch {
        continue;
      }
      try {
        await this.checkAndInstall(pkgPath, nodeModulesPath);
      } catch (e) {
        await this.logger.warning(`${path.relative(rootDir, d)}: ${e.message}`);
      }
    }
  }
}

/**
 * 引导器：环境校验 → 根依赖 → 插件依赖 → 加载 start.js
 */
class Bootstrap {
  constructor() {
    this.logger = createBootstrapLogger(path.join('./logs', 'bootstrap.log'), true);
    this.dependencyManager = new DependencyManager(this.logger);
  }

  async initialize() {
    await validateEnvironment();
    const root = process.cwd();
    await this.dependencyManager.checkAndInstall(
      path.join(root, 'package.json'),
      path.join(root, 'node_modules')
    );
    await this.dependencyManager.ensurePluginDependencies(root);
  }

  async run() {
    try {
      await this.initialize();
      await new Promise(r => setImmediate(r));
      await import('./start.js');
    } catch (e) {
      await this.logger.error(`引导失败: ${e.stack || e.message}`);
      await this.logger.log('\n可尝试: pnpm install');
      process.exit(1);
    }
  }
}

process.on('uncaughtException', err => {
  createBootstrapLogger(path.join('./logs', 'bootstrap.log'), true)
    .error(`未捕获的异常: ${err?.stack || err?.message || err}`)
    .then(() => process.exit(1));
});

process.on('unhandledRejection', reason => {
  createBootstrapLogger(path.join('./logs', 'bootstrap.log'), true)
    .error(`未处理的 Promise 拒绝: ${reason?.stack || reason?.message || reason}`);
});

const bootstrap = new Bootstrap();
bootstrap.run();

export default Bootstrap;
