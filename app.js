/**
 * @file app.js
 * @description 应用程序引导（依赖检查后加载 start.js）
 */

import path from 'path';
import { spawnSync } from 'child_process';
import { BASE_DIRS } from './lib/base-dirs.js';
import { LOGS_DIR, PLUGINS_DIR, RENDERERS_DIR, APP_ENTRY_REL, resolveProjectPath } from './lib/config/config-constants.js';
import { FileUtils } from './lib/utils/file-utils.js';

const projectRoot = resolveProjectPath();

if (process.platform === 'win32') {
  try {
    spawnSync('chcp', ['65001'], { stdio: 'ignore', windowsHide: true });
    process.stdout.setEncoding('utf8');
    process.stderr.setEncoding('utf8');
  } catch {}
}

if (!process.execArgv.includes('--expose-gc')) {
  const appPath = process.argv[1] || resolveProjectPath(APP_ENTRY_REL);
  const result = spawnSync(process.argv[0], ['--expose-gc', ...process.execArgv, appPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: projectRoot
  });
  process.exit(result.status ?? (result.signal ? 128 + 1 : 1));
}

function createBootstrapLogger(logFile, useConsole = true) {
  const colors = { INFO: '\x1b[36m', SUCCESS: '\x1b[32m', WARNING: '\x1b[33m', ERROR: '\x1b[31m', RESET: '\x1b[0m' };
  async function write(message, level = 'INFO') {
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    try {
      await FileUtils.appendFile(logFile, line, 'utf8');
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

async function validateEnvironment() {
  const major = parseInt(process.version.slice(1).split('.')[0], 10);
  if (major < 24) {
    throw new Error(`Node.js 需 v24.0.0+，当前: ${process.version}`);
  }
  await Promise.all(BASE_DIRS.map(dir => FileUtils.ensureDir(resolveProjectPath(dir.replace(/^\.\//, ''))).catch(() => {})));
}

class DependencyManager {
  constructor(logger) {
    this.logger = logger;
  }

  async parsePackageJson(packageJsonPath) {
    const content = await FileUtils.readFile(packageJsonPath, 'utf-8');
    if (!content) throw new Error(`无法读取 ${packageJsonPath}`);
    return JSON.parse(content);
  }

  async getMissingDependencies(depNames, nodeModulesPath) {
    const results = await Promise.all(
      depNames.map(async dep => {
        const st = await FileUtils.stat(path.join(nodeModulesPath, dep));
        return st?.isDirectory() === true;
      })
    );
    return depNames.filter((_, i) => !results[i]);
  }

  async installDependencies(missingDeps, cwd = projectRoot) {
    const prefix = cwd !== projectRoot ? `[${path.basename(cwd)}] ` : '';
    await this.logger.warning(`${prefix}发现 ${missingDeps.length} 个缺失依赖，使用 pnpm 安装...`);
    await this.logger.log(`${prefix}正在安装依赖，若出现 DEP0190 警告可忽略，请稍候...`);
    const runInstall = (extraArgs = []) => spawnSync('pnpm', ['install', ...extraArgs], {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env }
    });
    let result = runInstall();
    if (result.status !== 0) {
      result = runInstall(['--no-frozen-lockfile']);
    }
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

  async ensurePluginDependencies(rootDir = resolveProjectPath()) {
    const baseDirs = [PLUGINS_DIR, RENDERERS_DIR];
    const dirs = [];
    for (const base of baseDirs) {
      const dir = path.join(rootDir, base);
      const entries = await FileUtils.readDir(dir, { withFileTypes: true });
      for (const d of entries) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue;
        dirs.push(path.join(dir, d.name));
      }
    }
    for (const d of dirs) {
      const pkgPath = path.join(d, 'package.json');
      const nodeModulesPath = path.join(d, 'node_modules');
      if (!(await FileUtils.exists(pkgPath))) continue;
      try {
        await this.checkAndInstall(pkgPath, nodeModulesPath);
      } catch (e) {
        await this.logger.warning(`${path.relative(rootDir, d)}: ${e.message}`);
      }
    }
  }

  /**
   * 检查 plugins、renderers 下各子目录的 www（及一层子目录）中
   * 同时存在 package.json 与 sign.json 的前端依赖，与 AGT 逻辑对齐
   */
  async ensureFrontendDependencies(rootDir = resolveProjectPath()) {
    const baseDirs = [PLUGINS_DIR, RENDERERS_DIR];
    for (const base of baseDirs) {
      const basePath = path.join(rootDir, base);
      const entries = await FileUtils.readDir(basePath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const wwwDir = path.join(basePath, entry.name, 'www');
        const wwwStat = await FileUtils.stat(wwwDir);
        if (!wwwStat?.isDirectory()) continue;

        const candidateDirs = [wwwDir];
        const subEntries = await FileUtils.readDir(wwwDir, { withFileTypes: true });
        for (const sub of subEntries) {
          if (sub.isDirectory()) candidateDirs.push(path.join(wwwDir, sub.name));
        }

        for (const dir of candidateDirs) {
          const pkgPath = path.join(dir, 'package.json');
          const signPath = path.join(dir, 'sign.json');
          const hasPkg = await FileUtils.exists(pkgPath);
          const hasSign = await FileUtils.exists(signPath);
          if (!hasPkg || !hasSign) continue;

          try {
            await this.checkAndInstall(pkgPath, path.join(dir, 'node_modules'));
          } catch (e) {
            const rel = path.relative(rootDir, dir) || dir;
            await this.logger.warning(`${rel}: ${e.message}`);
          }
        }
      }
    }
  }
}

const BOOTSTRAP_LOG = resolveProjectPath(LOGS_DIR, 'bootstrap.log');

class Bootstrap {
  constructor() {
    this.logger = createBootstrapLogger(BOOTSTRAP_LOG, false);
    this.dependencyManager = new DependencyManager(this.logger);
  }

  async initialize() {
    await validateEnvironment();
    const root = resolveProjectPath();
    await this.dependencyManager.checkAndInstall(
      path.join(root, 'package.json'),
      path.join(root, 'node_modules')
    );
    await this.dependencyManager.ensurePluginDependencies(root);
    await this.dependencyManager.ensureFrontendDependencies(root);
  }

  async run() {
    try {
      await this.initialize();
      global.bootstrapLogger = this.logger;
      await new Promise(r => setImmediate(r));
      await import('./start.js');
    } catch (e) {
      await this.logger.error(`引导失败: ${e.stack || e.message}`);
      await this.logger.log('\n可尝试: pnpm install');
      console.error(`引导失败: ${e.message}\n详见 ${BOOTSTRAP_LOG}`);
      process.exit(1);
    }
  }
}

const bootstrap = new Bootstrap();
bootstrap.run();

export default Bootstrap;
