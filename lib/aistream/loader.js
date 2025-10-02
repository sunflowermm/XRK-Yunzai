import path from 'path';
import fs from 'fs';
import BotUtil from '../common/util.js';

const _path = process.cwd();
const STREAMS_DIR = path.join(_path, 'plugins/stream');

/**
 * AI工作流加载器
 * 负责加载和管理所有工作流
 */
class StreamLoader {
  constructor() {
    this.streams = new Map();
    this.loaded = false;
  }

  /**
   * 加载所有工作流
   */
  async load() {
    if (this.loaded) {
      BotUtil.makeLog('warn', '工作流已加载，跳过重复加载', 'StreamLoader');
      return;
    }

    try {
      // 确保目录存在
      if (!fs.existsSync(STREAMS_DIR)) {
        fs.mkdirSync(STREAMS_DIR, { recursive: true });
        BotUtil.makeLog('info', '创建工作流目录', 'StreamLoader');
      }

      // 加载所有工作流文件
      const files = await BotUtil.glob(path.join(STREAMS_DIR, '*.js'));
      
      for (const file of files) {
        await this.loadStream(file);
      }

      this.loaded = true;
      BotUtil.makeLog('success', `✓ 加载了 ${this.streams.size} 个工作流`, 'StreamLoader');
      
      // 显示工作流列表
      this.listStreams();
    } catch (error) {
      BotUtil.makeLog('error', `工作流加载失败: ${error.message}`, 'StreamLoader');
    }
  }

  /**
   * 加载单个工作流
   */
  async loadStream(file) {
    try {
      const module = await import(`file://${file}`);
      const StreamClass = module.default;

      if (!StreamClass || typeof StreamClass !== 'function') {
        BotUtil.makeLog('warn', `工作流文件无效: ${path.basename(file)}`, 'StreamLoader');
        return;
      }

      const stream = new StreamClass();
      
      if (!stream.name) {
        BotUtil.makeLog('warn', `工作流缺少name属性: ${path.basename(file)}`, 'StreamLoader');
        return;
      }

      this.streams.set(stream.name, stream);
      BotUtil.makeLog('info', `✓ 加载工作流: ${stream.name} v${stream.version}`, 'StreamLoader');
    } catch (error) {
      BotUtil.makeLog('error', `加载工作流失败[${path.basename(file)}]: ${error.message}`, 'StreamLoader');
    }
  }

  /**
   * 重新加载工作流
   */
  async reload() {
    this.streams.clear();
    this.loaded = false;
    await this.load();
  }

  /**
   * 获取工作流
   */
  getStream(name) {
    return this.streams.get(name);
  }

  /**
   * 获取所有工作流
   */
  getAllStreams() {
    return Array.from(this.streams.values());
  }

  /**
   * 获取已启用的工作流
   */
  getEnabledStreams() {
    return this.getAllStreams().filter(s => s.config.enabled);
  }

  /**
   * 按优先级排序获取工作流
   */
  getStreamsByPriority() {
    return this.getAllStreams().sort((a, b) => a.priority - b.priority);
  }

  /**
   * 列出所有工作流
   */
  listStreams() {
    if (this.streams.size === 0) {
      BotUtil.makeLog('info', '暂无工作流', 'StreamLoader');
      return;
    }

    const streams = this.getStreamsByPriority();
    BotUtil.makeLog('info', '━━━━━━━━━ 工作流列表 ━━━━━━━━━', 'StreamLoader');
    
    for (const stream of streams) {
      const status = stream.config.enabled ? '✓' : '✗';
      const funcCount = stream.functions.size;
      BotUtil.makeLog('info', 
        `${status} ${stream.name} v${stream.version} - ${stream.description} (${funcCount}个功能)`,
        'StreamLoader'
      );
    }
    
    BotUtil.makeLog('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'StreamLoader');
  }

  /**
   * 启用/禁用工作流
   */
  toggleStream(name, enabled) {
    const stream = this.streams.get(name);
    if (stream) {
      stream.config.enabled = enabled;
      BotUtil.makeLog('info', `工作流[${name}]已${enabled ? '启用' : '禁用'}`, 'StreamLoader');
      return true;
    }
    return false;
  }

  /**
   * 获取工作流统计信息
   */
  getStats() {
    const total = this.streams.size;
    const enabled = this.getEnabledStreams().length;
    const totalFunctions = this.getAllStreams().reduce((sum, s) => sum + s.functions.size, 0);

    return {
      total,
      enabled,
      disabled: total - enabled,
      totalFunctions
    };
  }
}

export default new StreamLoader();