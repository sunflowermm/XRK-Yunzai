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

  async load() {
    if (this.loaded) return;
    
    const streamDir = path.join(process.cwd(), 'plugins/stream');
    await BotUtil.mkdir(streamDir);
    
    const files = await BotUtil.glob(path.join(streamDir, '**/*.js'));
    
    for (const file of files) {
      const fileUrl = pathToFileURL(file).href;
      const StreamClass = (await import(fileUrl)).default;
      
      if (StreamClass.prototype instanceof BaseStream || StreamClass === BaseStream) {
        const instance = new StreamClass();
        const streamName = instance.name || path.basename(file, '.js');
        
        this.streams.set(streamName, StreamClass);
        this.streamInstances.set(streamName, instance);
        
        BotUtil.makeLog('info', `✓ 加载工作流：${streamName}`, 'StreamLoader');
      }
    }
    
    this.loaded = true;
    BotUtil.makeLog('success', `⚡ 工作流系统初始化完成，已加载 ${this.streams.size} 个工作流`, 'StreamLoader');
  }

  getStream(name) {
    return this.streamInstances.get(name);
  }

  getAllStreams() {
    return Array.from(this.streamInstances.values());
  }

  registerStream(name, StreamClass) {
    if (!(StreamClass.prototype instanceof BaseStream)) {
      throw new Error('工作流必须继承自BaseStream');
    }
    
    const instance = new StreamClass();
    this.streams.set(name, StreamClass);
    this.streamInstances.set(name, instance);
    
    BotUtil.makeLog('info', `动态注册工作流：${name}`, 'StreamLoader');
  }

  async execute(streamName, context, options = {}) {
    const stream = this.streamInstances.get(streamName);
    if (!stream) {
      throw new Error(`工作流 ${streamName} 不存在`);
    }
    
    return await stream.process(context, options);
  }

  async reload(streamName) {
    if (streamName) {
      const StreamClass = this.streams.get(streamName);
      if (StreamClass) {
        const instance = new StreamClass();
        this.streamInstances.set(streamName, instance);
        BotUtil.makeLog('info', `重载工作流：${streamName}`, 'StreamLoader');
      }
    } else {
      this.loaded = false;
      this.streams.clear();
      this.streamInstances.clear();
      await this.load();
    }
  }
}

export default new StreamLoader();