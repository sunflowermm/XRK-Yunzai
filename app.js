import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

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
      console.log('缺失的依赖:', missingDependencies.join(', '));
      console.log('正在运行 pnpm install...');
      await execAsync('pnpm install', { stdio: 'inherit' });
      console.log('依赖安装完成');
    } else {
    }
  } catch (error) {
    console.error('依赖检查或安装失败:', error.message);
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
  console.error('app程序执行出错:', error.message);
  process.exit(1);
});