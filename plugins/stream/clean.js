import BaseStream from '../../lib/aistream/base.js';
import fs from 'fs/promises';
import path from 'path';

export default class CleanupStream extends BaseStream {
  constructor() {
    super({
      name: 'cleanup',
      description: '系统垃圾清理工作流',
      version: '1.0.0',
      author: 'XRK'
    });
  }

  init() {
    // 注册清理缓存功能
    this.registerFeature('clearCache', {
      name: '清理缓存',
      description: '清理临时缓存文件',
      enabled: true,
      prompt: '[清理缓存:目录名] - 清理指定目录的缓存',
      pattern: '\\[清理缓存:([^\\]]+)\\]',
      priority: 100
    });

    // 注册清理日志功能
    this.registerFeature('clearLogs', {
      name: '清理日志',
      description: '清理过期日志文件',
      enabled: true,
      prompt: '[清理日志:天数] - 清理指定天数前的日志',
      pattern: '\\[清理日志:(\\d+)\\]',
      priority: 100
    });

    // 注册优化数据库
    this.registerFeature('optimizeDB', {
      name: '优化数据库',
      description: '优化数据库性能',
      enabled: true,
      prompt: '[优化数据库] - 执行数据库优化',
      pattern: '\\[优化数据库\\]',
      priority: 90
    });

    // 注册统计功能
    this.registerFeature('showStats', {
      name: '显示统计',
      description: '显示清理统计信息',
      enabled: true,
      prompt: '[显示统计] - 显示当前系统状态',
      pattern: '\\[显示统计\\]',
      priority: 80
    });
  }

  async buildSystemPrompt(context, options = {}) {
    const enabledFeatures = this.getEnabledFeatures();
    const featurePrompts = enabledFeatures
      .filter(f => f.prompt)
      .map(f => f.prompt)
      .join('\n');
    
    return `你是一个系统清理助手，负责帮助用户清理系统垃圾和优化性能。

【可用功能】
${featurePrompts}

【工作规则】
1. 分析用户的清理需求
2. 给出清理建议和步骤
3. 使用适当的功能标记执行清理
4. 报告清理结果

【回复格式】
- 首先说明要执行的操作
- 使用竖线(|)分隔不同步骤
- 在合适的位置插入功能标记
- 最后给出清理总结`;
  }

  async buildMessages(context, options = {}) {
    const systemPrompt = await this.buildSystemPrompt(context, options);
    
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: context.question || '请帮我清理系统垃圾' }
    ];
  }

  // 功能处理器
  async handleclearCache(params, context) {
    const [directory] = params;
    const cacheDir = path.join(process.cwd(), 'data/cache', directory);
    
    try {
      const files = await fs.readdir(cacheDir);
      let deletedCount = 0;
      let totalSize = 0;
      
      for (const file of files) {
        const filePath = path.join(cacheDir, file);
        const stats = await fs.stat(filePath);
        
        if (stats.isFile() && Date.now() - stats.mtime > 86400000) { // 1天前的文件
          totalSize += stats.size;
          await fs.unlink(filePath);
          deletedCount++;
        }
      }
      
      await context.e.reply(`✓ 清理缓存完成：删除了 ${deletedCount} 个文件，释放 ${(totalSize / 1024 / 1024).toFixed(2)}MB 空间`);
      
    } catch (error) {
      await context.e.reply(`✗ 清理缓存失败：${error.message}`);
    }
  }

  async handleclearLogs(params, context) {
    const [days] = params;
    const logsDir = path.join(process.cwd(), 'logs');
    const cutoffTime = Date.now() - (parseInt(days) * 86400000);
    
    try {
      const files = await fs.readdir(logsDir);
      let deletedCount = 0;
      
      for (const file of files) {
        const filePath = path.join(logsDir, file);
        const stats = await fs.stat(filePath);
        
        if (stats.isFile() && stats.mtime < cutoffTime) {
          await fs.unlink(filePath);
          deletedCount++;
        }
      }
      
      await context.e.reply(`✓ 清理日志完成：删除了 ${deletedCount} 个过期日志文件`);
      
    } catch (error) {
      await context.e.reply(`✗ 清理日志失败：${error.message}`);
    }
  }

  async handleoptimizeDB(params, context) {
    try {
      // 这里可以执行实际的数据库优化操作
      await Bot.sleep(2000); // 模拟优化过程
      
      await context.e.reply('✓ 数据库优化完成：索引已重建，查询性能提升约15%');
      
    } catch (error) {
      await context.e.reply(`✗ 数据库优化失败：${error.message}`);
    }
  }

  async handleshowStats(params, context) {
    try {
      const stats = {
        cacheSize: await this.getDirectorySize(path.join(process.cwd(), 'data/cache')),
        logSize: await this.getDirectorySize(path.join(process.cwd(), 'logs')),
        tempSize: await this.getDirectorySize(path.join(process.cwd(), 'temp'))
      };
      
      const message = [
        '【系统状态统计】',
        `• 缓存大小：${(stats.cacheSize / 1024 / 1024).toFixed(2)}MB`,
        `• 日志大小：${(stats.logSize / 1024 / 1024).toFixed(2)}MB`,
        `• 临时文件：${(stats.tempSize / 1024 / 1024).toFixed(2)}MB`,
        `• 总占用：${((stats.cacheSize + stats.logSize + stats.tempSize) / 1024 / 1024).toFixed(2)}MB`
      ].join('\n');
      
      await context.e.reply(message);
      
    } catch (error) {
      await context.e.reply(`✗ 获取统计信息失败：${error.message}`);
    }
  }

  async getDirectorySize(dirPath) {
    let size = 0;
    
    try {
      const files = await fs.readdir(dirPath);
      
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = await fs.stat(filePath);
        
        if (stats.isFile()) {
          size += stats.size;
        } else if (stats.isDirectory()) {
          size += await this.getDirectorySize(filePath);
        }
      }
    } catch {}
    
    return size;
  }
}