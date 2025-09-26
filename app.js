/**
 * @file app.js
 * @description 应用程序引导文件
 * @author XRK
 * @copyright 2025 XRK Studio
 * @license MIT
 * 
 * 主要功能：
 * - 自动检查和安装缺失的依赖
 * - 确保运行环境完整性
 * - 启动主应用程序
 * 
 * 安全性说明：
 * - 依赖检查仅在本地执行
 * - 不会自动更新已安装的包
 * - 所有操作都有完整的错误处理
 */

import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

/** 获取当前模块的目录路径 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 异步执行命令 */
const execAsync = promisify(exec);

/**
 * 简化的日志类
 * 用于引导阶段的日志记录
 * 
 * @class BootstrapLogger
 */
class BootstrapLogger {
  constructor() {
    /** @type {string} 日志文件路径 */
    this.logFile = path.join('./logs', 'bootstrap.log');
    /** @type {boolean} 控制台输出开关 */
    this.consoleEnabled = true;
  }

  /**
   * 确保日志目录存在
   * @returns {Promise<void>}
   */
  async ensureLogDir() {
    await fs.mkdir('./logs', { recursive: true });
  }

  /**
   * 写入日志
   * @param {string} message - 日志消息
   * @param {string} [level='INFO'] - 日志级别
   * @returns {Promise<void>}
   */
  async log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    
    try {
      await fs.appendFile(this.logFile, logMessage);
      
      if (this.consoleEnabled) {
        const colorMap = {
          INFO: '\x1b[36m',    // 青色
          SUCCESS: '\x1b[32m', // 绿色
          WARNING: '\x1b[33m', // 黄色
          ERROR: '\x1b[31m'    // 红色
        };
        
        console.log(`${colorMap[level] || ''}${message}\x1b[0m`);
      }
    } catch (error) {
      console.error('日志写入失败:', error.message);
    }
  }

  /**
   * 记录成功消息
   * @param {string} message - 成功消息
   * @returns {Promise<void>}
   */
  async success(message) {
    await this.log(message, 'SUCCESS');
  }

  /**
   * 记录警告消息
   * @param {string} message - 警告消息
   * @returns {Promise<void>}
   */
  async warning(message) {
    await this.log(message, 'WARNING');
  }

  /**
   * 记录错误消息
   * @param {string} message - 错误消息
   * @returns {Promise<void>}
   */
  async error(message) {
    await this.log(message, 'ERROR');
  }
}

/**
 * 依赖管理器
 * 负责检查和安装项目依赖
 * 
 * @class DependencyManager
 */
class DependencyManager {
  /**
   * @param {BootstrapLogger} logger - 日志实例
   */
  constructor(logger) {
    this.logger = logger;
    /** @type {string} 包管理器类型 */
    this.packageManager = 'pnpm';
  }

  /**
   * 检测可用的包管理器
   * @private
   * @returns {Promise<string>} 包管理器名称
   */
  async detectPackageManager() {
    const managers = ['pnpm', 'npm', 'yarn'];
    
    for (const manager of managers) {
      try {
        await execAsync(`${manager} --version`);
        return manager;
      } catch {
        continue;
      }
    }
    
    throw new Error('未找到可用的包管理器 (pnpm/npm/yarn)');
  }

  /**
   * 解析package.json文件
   * @private
   * @param {string} packageJsonPath - package.json路径
   * @returns {Promise<Object>} 解析后的package.json内容
   */
  async parsePackageJson(packageJsonPath) {
    try {
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      throw new Error(`无法读取package.json: ${error.message}`);
    }
  }

  /**
   * 检查单个依赖是否已安装
   * @private
   * @param {string} depName - 依赖名称
   * @param {string} nodeModulesPath - node_modules路径
   * @returns {Promise<boolean>} 是否已安装
   */
  async isDependencyInstalled(depName, nodeModulesPath) {
    try {
      const depPath = path.join(nodeModulesPath, depName);
      const stats = await fs.stat(depPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * 获取缺失的依赖列表
   * @private
   * @param {Object} dependencies - 依赖对象
   * @param {string} nodeModulesPath - node_modules路径
   * @returns {Promise<string[]>} 缺失的依赖名称数组
   */
  async getMissingDependencies(dependencies, nodeModulesPath) {
    const depNames = Object.keys(dependencies).filter(dep => dep !== 'md5' && dep !== 'oicq');
    const checkResults = await Promise.all(
      depNames.map(async (dep) => ({
        name: dep,
        installed: await this.isDependencyInstalled(dep, nodeModulesPath)
      }))
    );
    
    return checkResults
      .filter(result => !result.installed)
      .map(result => result.name);
  }

  /**
   * 安装缺失的依赖
   * @private
   * @param {string[]} missingDeps - 缺失的依赖列表
   * @returns {Promise<void>}
   */
  async installDependencies(missingDeps) {
    await this.logger.warning(`发现 ${missingDeps.length} 个缺失的依赖`);
    await this.logger.log(`缺失的依赖: ${missingDeps.join(', ')}`);
    
    const manager = await this.detectPackageManager();
    this.packageManager = manager;
    
    await this.logger.log(`使用 ${manager} 安装依赖...`);
    
    try {
      const { stdout, stderr } = await execAsync(`${manager} install`, {
        maxBuffer: 1024 * 1024 * 10, // 10MB缓冲区
        timeout: 300000 // 5分钟超时
      });
      
      if (stderr && !stderr.includes('warning')) {
        await this.logger.warning(`安装警告: ${stderr}`);
      }
      
      await this.logger.success('依赖安装完成');
    } catch (error) {
      throw new Error(`依赖安装失败: ${error.message}`);
    }
  }

  /**
   * 检查并安装依赖
   * @param {Object} config - 配置对象
   * @param {string} config.packageJsonPath - package.json路径
   * @param {string} config.nodeModulesPath - node_modules路径
   * @returns {Promise<void>}
   */
  async checkAndInstall(config) {
    const { packageJsonPath, nodeModulesPath } = config;
    
    try {
      /** 解析package.json */
      const packageJson = await this.parsePackageJson(packageJsonPath);
      
      /** 合并所有依赖 */
      const allDependencies = {
        ...packageJson.dependencies || {},
        ...packageJson.devDependencies || {}
      };
      
      /** 检查缺失的依赖 */
      const missingDeps = await this.getMissingDependencies(
        allDependencies, 
        nodeModulesPath
      );
      
      /** 安装缺失的依赖 */
      if (missingDeps.length > 0) {
        await this.installDependencies(missingDeps);
      } else { }
    } catch (error) {
      await this.logger.error(`依赖检查失败: ${error.message}`);
      throw error;
    }
  }
}

/**
 * 环境验证器
 * 确保运行环境满足要求
 * 
 * @class EnvironmentValidator
 */
class EnvironmentValidator {
  /**
   * @param {BootstrapLogger} logger - 日志实例
   */
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * 检查Node.js版本
   * @returns {Promise<void>}
   */
  async checkNodeVersion() {
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
    
    if (majorVersion < 14) {
      throw new Error(`Node.js版本过低: ${nodeVersion}, 需要 v14.0.0 或更高版本`);
    }
  }

  /**
   * 检查必要的目录
   * @returns {Promise<void>}
   */
  async checkRequiredDirectories() {
    const requiredDirs = [
      './logs',
      './config',
      './data'
    ];
    
    for (const dir of requiredDirs) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  /**
   * 验证环境
   * @returns {Promise<void>}
   */
  async validate() {
    
    await this.checkNodeVersion();
    await this.checkRequiredDirectories();
  }
}

/**
 * 应用程序引导器
 * 协调整个启动流程
 * 
 * @class Bootstrap
 */
class Bootstrap {
  constructor() {
    this.logger = new BootstrapLogger();
    this.dependencyManager = new DependencyManager(this.logger);
    this.environmentValidator = new EnvironmentValidator(this.logger);
  }

  /**
   * 初始化引导流程
   * @returns {Promise<void>}
   */
  async initialize() {
    await this.logger.ensureLogDir();
    /** 验证环境 */
    await this.environmentValidator.validate();
    
    /** 检查并安装依赖 */
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    const nodeModulesPath = path.join(process.cwd(), 'node_modules');
    
    await this.dependencyManager.checkAndInstall({
      packageJsonPath,
      nodeModulesPath
    });
  }

  /**
   * 启动主应用程序
   * @returns {Promise<void>}
   */
  async startMainApplication() {
    
    try {
      /** 动态导入主程序 */
      await import('./start.js');
    } catch (error) {
      await this.logger.error(`主程序启动失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 运行引导程序
   * @returns {Promise<void>}
   */
  async run() {
    try {
      await this.initialize();
      await this.startMainApplication();
    } catch (error) {
      await this.logger.error(`引导失败: ${error.message}`);
      
      /** 提供故障排除建议 */
      await this.logger.log('\n故障排除建议:');
      await this.logger.log('1. 确保Node.js版本 >= 14.0.0');
      await this.logger.log('2. 手动运行: pnpm install (或 npm install)');
      await this.logger.log('3. 检查网络连接');
      await this.logger.log('4. 查看日志文件: ./logs/bootstrap.log');
      
      process.exit(1);
    }
  }
}

/**
 * 全局错误处理
 * 确保所有错误都被捕获并记录
 */
process.on('uncaughtException', async (error) => {
  const logger = new BootstrapLogger();
  await logger.error(`未捕获的异常: ${error.message}\n${error.stack}`);
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  const logger = new BootstrapLogger();
  const errorMessage = reason instanceof Error 
    ? `${reason.message}\n${reason.stack}` 
    : String(reason);
  await logger.error(`未处理的Promise拒绝: ${errorMessage}`);
  process.exit(1);
});

/**
 * 程序入口点
 * 创建并运行引导器
 */
const bootstrap = new Bootstrap();
bootstrap.run();

/** 导出引导器供测试使用 */
export default Bootstrap;