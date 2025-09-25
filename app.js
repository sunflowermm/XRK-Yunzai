import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

// 屏蔽Node警告
process.removeAllListeners('warning');
process.on('warning', () => {});

// 屏蔽console输出
if (process.env.NODE_ENV === 'production' || process.env.DISABLE_CONSOLE === 'true') {
  const noop = () => {};
  console.log = noop;
  console.info = noop;
  console.warn = noop;
  console.error = noop;
  console.debug = noop;
  console.trace = noop;
}

const execAsync = promisify(exec);

const checkAndInstallDependencies = async ({ packageJsonPath, nodeModulesPath }) => {
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
      // 使用环境变量控制是否显示日志
      if (process.env.SHOW_INSTALL_LOG === 'true') {
        console.log('缺失的依赖:', missingDependencies.join(', '));
        console.log('正在运行 pnpm install...');
      }
      await execAsync('pnpm install', { stdio: process.env.SHOW_INSTALL_LOG === 'true' ? 'inherit' : 'ignore' });
      if (process.env.SHOW_INSTALL_LOG === 'true') {
        console.log('依赖安装完成');
      }
    }
  } catch (error) {
    if (process.env.DEBUG === 'true') {
      console.error('依赖检查或安装失败:', error.message);
    }
    process.exit(1);
  }
};

const main = async () => {
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  const nodeModulesPath = path.join(process.cwd(), 'node_modules');
  await checkAndInstallDependencies({ packageJsonPath, nodeModulesPath });
  await import('./start.js');
};

main().catch((error) => {
  if (process.env.DEBUG === 'true') {
    console.error('app程序执行出错:', error.message);
  }
  process.exit(1);
});