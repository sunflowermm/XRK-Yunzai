/**
 * @file debug.js
 * @description 手动调试启动脚本
 * 
 * 使用方法:
 * 1. 在终端中直接运行 `node debug.js [port]`
 * 2. 脚本会直接启动 Bot 核心，不经过 app.js 的依赖检查和进程守护
 * 3. 所有错误和日志都会直接输出到控制台，方便调试
 * 4. 支持通过命令行参数指定端口: `node debug.js 8086`
 * 
 * 特性:
 * - 跳过依赖检查，快速启动
 * - 详细的错误堆栈输出
 * - 支持环境变量配置
 * - 自动创建必要目录
 */

import fs from 'fs/promises';
import path from 'path';
import Bot from './lib/bot.js';
import chalk from 'chalk';

// 默认调试端口（可通过命令行参数或环境变量覆盖）
const DEFAULT_DEBUG_PORT = 11451;

/**
 * 确保必要目录存在
 */
async function ensureDirectories() {
  const dirs = [
    './logs',
    './data',
    './data/server_bots',
    './config',
    './config/default_config'
  ];
  
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      console.warn(chalk.yellow(`[WARN] 无法创建目录 ${dir}: ${error.message}`));
    }
  }
}

/**
 * 解析命令行参数
 */
function parseArgs() {
  const args = process.argv.slice(2);
  let port = DEFAULT_DEBUG_PORT;
  
  // 从命令行参数获取端口
  if (args.length > 0 && !isNaN(parseInt(args[0]))) {
    port = parseInt(args[0]);
  }
  
  // 从环境变量获取端口
  if (process.env.XRK_SERVER_PORT && !isNaN(parseInt(process.env.XRK_SERVER_PORT))) {
    port = parseInt(process.env.XRK_SERVER_PORT);
  }
  
  return { port };
}

/**
 * 打印启动信息
 */
function printBanner(port) {
  console.log(chalk.cyan('='.repeat(50)));
  console.log(chalk.cyan.bold('          XRK-Yunzai 调试模式启动'));
  console.log(chalk.cyan('='.repeat(50)));
  console.log(chalk.green(`[+] 启动端口: ${chalk.yellow(port)}`));
  console.log(chalk.green(`[+] Node.js 版本: ${chalk.yellow(process.version)}`));
  console.log(chalk.green(`[+] 工作目录: ${chalk.yellow(process.cwd())}`));
  console.log(chalk.green(`[+] 环境模式: ${chalk.yellow(process.env.NODE_ENV || 'development')}`));
  console.log(chalk.cyan('='.repeat(50)));
}

/**
 * 启动函数
 */
async function start() {
  try {
    // 解析参数
    const { port } = parseArgs();
    
    // 打印启动信息
    printBanner(port);
    
    // 确保目录存在
    console.log(chalk.blue('[+] 检查必要目录...'));
    await ensureDirectories();
    console.log(chalk.green('[✓] 目录检查完成'));
    
    // 设置调试环境变量
    process.env.NODE_ENV = process.env.NODE_ENV || 'development';
    process.env.DEBUG = process.env.DEBUG || 'true';
    
    console.log(chalk.blue('[+] 正在初始化 Bot 核心...'));
    
    // 模拟服务器启动参数
    if (!process.argv.includes('server')) {
      process.argv.push('server', port.toString());
    }
    
    // 创建 Bot 实例
    const bot = new Bot();
    
    // 将实例暴露到全局，供 Listener/Plugins 等模块使用
    global.Bot = bot;
    
    // 运行 Bot
    await bot.run({ port });
    
    console.log(chalk.cyan('='.repeat(50)));
    console.log(chalk.green.bold('[✓] Bot 核心已成功启动'));
    console.log(chalk.cyan(`[+] 访问地址: http://localhost:${port}`));
    console.log(chalk.cyan(`[+] 健康检查: http://localhost:${port}/health`));
    console.log(chalk.cyan('='.repeat(50)));
    console.log(chalk.yellow('[提示] 按 Ctrl+C 停止服务'));
    
  } catch (error) {
    console.error(chalk.red('='.repeat(50)));
    console.error(chalk.red.bold('[-] Bot 启动失败'));
    console.error(chalk.red('='.repeat(50)));
    console.error(chalk.red(`错误信息: ${error.message}`));
    
    if (error.stack) {
      console.error(chalk.red('\n堆栈追踪:'));
      console.error(chalk.gray(error.stack));
    }
    
    console.error(chalk.red('='.repeat(50)));
    process.exit(1);
  }
}

// 全局异常捕获，确保所有错误都能被看到
process.on('uncaughtException', (error) => {
  console.error(chalk.red('\n[未捕获异常]'), error);
  if (error.stack) {
    console.error(chalk.gray(error.stack));
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(chalk.red('\n[未处理的 Promise Rejection]'), reason);
  if (reason instanceof Error && reason.stack) {
    console.error(chalk.gray(reason.stack));
  }
});

// 优雅退出处理（debug 模式下仍保持简单行为，但不影响正式多端口管理逻辑）
process.on('SIGINT', () => {
  console.log(chalk.yellow('\n[!] 收到退出信号，正在关闭...'));
  if (Bot.closeServer) {
    Bot.closeServer().then(() => {
      console.log(chalk.green('[✓] 服务已优雅关闭'));
      process.exit(0);
    }).catch((error) => {
      console.error(chalk.red(`[!] 关闭服务时出错: ${error.message}`));
      process.exit(1);
    });
  } else {
    process.exit(0);
  }
});

// 启动应用
start();
