import path from 'path';
import BaseStream from './base.js';
import BotUtil from '../common/util.js';
import { pathToFileURL } from 'url'; 

class StreamLoader {
  constructor() {
    this.streams = new Map();
    this.streamInstances = new Map();
    this.loaded = false;
  }

  /**
   * 加载所有工作流
   */
  async load() {
    if (this.loaded) return;
    
    try {
      const streamDir = path.join(process.cwd(), 'plugins/stream');
      await BotUtil.mkdir(streamDir);
      
      const files = await BotUtil.glob(path.join(streamDir, '**/*.js'));
      
      for (const file of files) {
        try {
          const fileUrl = pathToFileURL(file).href;
          const StreamClass = (await import(fileUrl)).default;
          
          // 验证是否继承自BaseStream
          if (StreamClass.prototype instanceof BaseStream || StreamClass === BaseStream) {
            const instance = new StreamClass();
            const streamName = instance.name || path.basename(file, '.js');
            
            this.streams.set(streamName, StreamClass);
            this.streamInstances.set(streamName, instance);
            
            BotUtil.makeLog('info', `✓ 加载工作流：${streamName}`, 'StreamLoader');
          }
        } catch (error) {
          BotUtil.makeLog('error', `加载工作流失败 ${file}: ${error.message}`, 'StreamLoader');
        }
      }
      
      this.loaded = true;
      BotUtil.makeLog('success', `⚡ 工作流系统初始化完成，已加载 ${this.streams.size} 个工作流`, 'StreamLoader');
      
    } catch (error) {
      BotUtil.makeLog('error', `工作流系统初始化失败：${error.message}`, 'StreamLoader');
    }
  }

  /**
   * 获取工作流实例
   */
  getStream(name) {
    return this.streamInstances.get(name);
  }

  /**
   * 获取所有工作流
   */
  getAllStreams() {
    return Array.from(this.streamInstances.values());
  }

  /**
   * 注册新工作流
   */
  registerStream(name, StreamClass) {
    if (!(StreamClass.prototype instanceof BaseStream)) {
      throw new Error('工作流必须继承自BaseStream');
    }
    
    const instance = new StreamClass();
    this.streams.set(name, StreamClass);
    this.streamInstances.set(name, instance);
    
    BotUtil.makeLog('info', `动态注册工作流：${name}`, 'StreamLoader');
  }

  /**
   * 执行工作流
   */
  async execute(streamName, context, options = {}) {
    const stream = this.streamInstances.get(streamName);
    if (!stream) {
      throw new Error(`工作流 ${streamName} 不存在`);
    }
    
    return await stream.process(context, options);
  }

  /**
   * 重载工作流
   */
  async reload(streamName) {
    if (streamName) {
      // 重载特定工作流
      const StreamClass = this.streams.get(streamName);
      if (StreamClass) {
        const instance = new StreamClass();
        this.streamInstances.set(streamName, instance);
        BotUtil.makeLog('info', `重载工作流：${streamName}`, 'StreamLoader');
      }
    } else {
      // 重载所有工作流
      this.loaded = false;
      this.streams.clear();
      this.streamInstances.clear();
      await this.load();
    }
  }
}

export default new StreamLoader();