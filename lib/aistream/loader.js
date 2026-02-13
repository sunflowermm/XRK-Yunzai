import path from 'path';
import { pathToFileURL } from 'url';
import fs from 'fs';
import BotUtil from '../util.js';
import { FileUtils } from '../utils/file-utils.js';
import { ObjectUtils } from '../utils/object-utils.js';
import { MCPServer } from '../utils/mcp-server.js';

/**
 * AI工作流加载器
 * 标准化初始化流程，避免重复加载
 */
class StreamLoader {
  constructor() {
    this.streams = new Map();
    this.streamClasses = new Map();
    this.loaded = false;
    this._loadingPromise = null; // 防止并发加载
    this.mcpServer = null; // 统一 MCP 服务器，所有工具仅通过 MCP 暴露
    this.loadStats = {
      streams: [],
      totalLoadTime: 0,
      startTime: 0,
      totalStreams: 0,
      failedStreams: 0
    };
  }

  /**
   * 加载所有工作流（标准化流程）
   */
  async load(isRefresh = false) {
    // 防止重复加载
    if (!isRefresh && this.loaded) {
      return;
    }

    // 如果正在加载，等待加载完成
    if (this._loadingPromise) {
      return await this._loadingPromise;
    }

    // 创建加载Promise
    this._loadingPromise = this._doLoad(isRefresh);
    
    try {
      await this._loadingPromise;
    } finally {
      this._loadingPromise = null;
    }
  }

  /**
   * 获取所有工作流目录
   * @private
   * @returns {Array<string>}
   */
  _getStreamDirs() {
    const dirs = [];
    const cwd = process.cwd();
    
    // 从 plugins/<插件根>/stream 业务层目录加载工作流
    const pluginsDir = path.join(cwd, 'plugins');
    if (FileUtils.existsSync(pluginsDir)) {
      try {
        const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.')) continue;

          const streamDir = path.join(pluginsDir, entry.name, 'stream');
          if (FileUtils.existsSync(streamDir)) {
            dirs.push(streamDir);
          }
        }
      } catch {
        // 忽略错误
      }
    }
    
    return dirs;
  }

  async _doLoad(isRefresh = false) {
    try {
      this.loadStats.startTime = Date.now();
      this.loadStats.streams = [];
      this.loadStats.failedStreams = 0;

      if (!isRefresh) {
        this.streams.clear();
        this.streamClasses.clear();
      }

      // 获取所有工作流目录
      const streamDirs = this._getStreamDirs();
      
      // 扫描所有目录中的工作流文件
      const files = [];
      for (const dir of streamDirs) {
        const dirFiles = this.scanStreamFiles(dir);
        files.push(...dirFiles);
      }
      
      if (files.length === 0) {
        this.loaded = true;
        return;
      }

      // 加载工作流类
      for (const file of files) {
        await this.loadStreamClass(file);
      }

      // 统一初始化 MCP：将所有工作流的 mcpTools 注册到单一 MCPServer
      await this.initMCP();

      this.loadStats.totalLoadTime = Date.now() - this.loadStats.startTime;
      this.loadStats.totalStreams = this.streams.size;
      this.loaded = true;

      // 显示加载结果（简化日志）
      this.displayLoadSummary();
    } catch (error) {
      BotUtil.makeLog('error', `工作流加载失败: ${error.message}`, 'StreamLoader');
      throw error;
    }
  }

  /**
   * 扫描工作流文件（通用方法，跨平台兼容）
   * @param {string} dir - 工作流目录路径
   * @returns {string[]} 工作流文件路径数组
   */
  scanStreamFiles(dir) {
    try {
      if (!FileUtils.existsSync(dir)) {
        return [];
      }

      const files = fs.readdirSync(dir);
      const streamFiles = files
        .filter(file => {
          // 只加载.js文件，排除测试文件和隐藏文件
          return file.endsWith('.js') && 
                 !file.startsWith('.') && 
                 !file.includes('.test.') &&
                 !file.includes('.spec.');
        })
        .map(file => path.resolve(dir, file))
        .filter(filePath => {
          // 确保是文件而不是目录
          try {
            const stat = fs.statSync(filePath);
            return stat.isFile();
          } catch {
            return false;
          }
        });

      return streamFiles;
    } catch (error) {
      BotUtil.makeLog('error', `扫描工作流目录失败: ${error.message}`, 'StreamLoader');
      return [];
    }
  }

  /**
   * 加载单个工作流类
   */
  async loadStreamClass(file) {
    const streamName = path.basename(file, '.js');
    const startTime = Date.now();

    try {
      const normalizedPath = path.resolve(file);
      const fileUrl = pathToFileURL(normalizedPath).href;
      const timestamp = Date.now();
      const module = await import(`${fileUrl}?t=${timestamp}`);
      const StreamClass = module.default;

      if (!ObjectUtils.isFunction(StreamClass)) {
        throw new Error('无效的工作流文件');
      }

      // 创建实例
      const stream = new StreamClass();
      
      if (!stream.name) {
        throw new Error('工作流缺少name属性');
      }

      // 调用基础 init
      if (typeof stream.init === 'function') {
        await stream.init();
      }

      // 保存
      this.streams.set(stream.name, stream);
      this.streamClasses.set(stream.name, StreamClass);

      const loadTime = Date.now() - startTime;
      this.loadStats.streams.push({
        name: stream.name,
        version: stream.version,
        loadTime: loadTime,
        success: true,
        priority: stream.priority,
        functions: stream.functions?.size || 0
      });

      // 简化日志输出
    } catch (error) {
      this.loadStats.failedStreams++;
      const loadTime = Date.now() - startTime;
      
      this.loadStats.streams.push({
        name: streamName,
        loadTime: loadTime,
        success: false,
        error: error.message
      });

      BotUtil.makeLog('error', 
        `工作流加载失败 ${streamName}: ${error.message}`, 
        'StreamLoader'
      );
    }
  }

  /**
   * 显示加载摘要（简化版）
   */
  displayLoadSummary() {
    const successCount = this.streams.size;
    const failedCount = this.loadStats.failedStreams;
    const totalTime = (this.loadStats.totalLoadTime / 1000).toFixed(2);

    if (successCount > 0) {
      const streamNames = Array.from(this.streams.values())
        .map(s => `${s.name} v${s.version}`)
        .join(', ');
      BotUtil.makeLog('success', `工作流加载完成: ${streamNames} (${totalTime}s)`, 'StreamLoader');
    }
    
    if (failedCount > 0) {
      BotUtil.makeLog('error', `工作流加载失败: ${failedCount} 个`, 'StreamLoader');
    }
  }


  /**
   * 重新加载工作流
   */
  async reload() {
    BotUtil.makeLog('info', '🔄 开始重新加载...', 'StreamLoader');
    
    // 清理
    for (const stream of this.streams.values()) {
      if (typeof stream.cleanup === 'function') {
        await stream.cleanup().catch(() => {});
      }
    }

    this.streams.clear();
    this.streamClasses.clear();
    this.loaded = false;
    
    // 重新加载（会再次执行 initMCP，更新 global.mcpServer）
    await this.load();
    BotUtil.makeLog('success', '✅ 重新加载完成', 'StreamLoader');
  }

  /**
   * 获取工作流
   */
  getStream(name) {
    return this.streams.get(name);
  }

  getStreamClass(name) {
    return this.streamClasses.get(name);
  }

  getAllStreams() {
    return Array.from(this.streams.values());
  }

  getEnabledStreams() {
    return this.getAllStreams().filter(s => s.config.enabled);
  }

  getStreamsByPriority() {
    return this.getAllStreams().sort((a, b) => a.priority - b.priority);
  }

  /**
   * 将当前已加载的所有工作流的 mcpTools 注册到 MCP 服务器（全改成 MCP，唯一出口）
   * @param {MCPServer} mcpServer - MCP 服务器实例
   */
  registerMCP(mcpServer) {
    if (!mcpServer?.registerTool) return;
    const registered = new Set();
    let count = 0;
    for (const stream of this.streams.values()) {
      if (!stream.mcpTools || stream.mcpTools.size === 0) continue;
      for (const [toolName, tool] of stream.mcpTools.entries()) {
        if (!tool?.enabled) continue;
        const fullName = stream.name !== 'mcp' ? `${stream.name}.${toolName}` : toolName;
        if (registered.has(fullName)) continue;
        mcpServer.registerTool(fullName, {
          description: tool.description || `执行 ${toolName}`,
          inputSchema: tool.inputSchema || {},
          handler: async (args) => {
            const context = { e: this.currentEvent || null, stream };
            try {
              const result = await (tool.handler || (() => ({})))(args, context);
              if (result === undefined) return { success: true, message: '已执行' };
              if (typeof result === 'object' && ('success' in result || 'error' in result)) return result;
              return { success: true, data: result };
            } catch (err) {
              BotUtil.makeLog('error', `MCP工具调用失败[${fullName}]: ${err.message}`, 'StreamLoader');
              return { success: false, error: err.message };
            }
          }
        });
        registered.add(fullName);
        count++;
      }
    }
    if (count > 0) {
      BotUtil.makeLog('info', `MCP 已注册 ${count} 个工具`, 'StreamLoader');
    }
  }

  /**
   * 初始化 MCP 服务：创建 MCPServer、注册所有工作流 mcpTools、挂载到 global 供 LLM 与 HTTP 使用
   */
  async initMCP() {
    if (!this.mcpServer) {
      this.mcpServer = new MCPServer();
    }
    // 只移除来自工作流的工具（保留 core 工具如 system.info、time.now）
    for (const [name] of this.mcpServer.tools) {
      const streamName = name.split('.')[0];
      if (streamName && this.streams.has(streamName)) {
        this.mcpServer.tools.delete(name);
      }
    }
    this.registerMCP(this.mcpServer);
    this.mcpServer.initialized = true;
    if (typeof global !== 'undefined') {
      global.mcpServer = this.mcpServer;
    }
    if (typeof globalThis !== 'undefined') {
      globalThis.mcpServer = this.mcpServer;
    }
  }

  /**
   * 创建合并工作流（主工作流 + 副工作流）
   * @param {Object} options - { name, main, secondary[], prefixSecondary?, description? }
   * @returns {Object|null} 合并后的工作流实例
   */
  mergeStreams(options = {}) {
    const {
      name,
      main,
      secondary = [],
      prefixSecondary = true,
      description
    } = options;

    if (!main || !Array.isArray(secondary) || secondary.length === 0) {
      BotUtil.makeLog('warn', 'mergeStreams 需要主工作流和至少一个副工作流', 'StreamLoader');
      return null;
    }

    const mainStream = this.getStream(main);
    if (!mainStream) {
      BotUtil.makeLog('error', `主工作流未找到: ${main}`, 'StreamLoader');
      return null;
    }

    const secondaryStreams = secondary
      .map(n => this.getStream(n))
      .filter(Boolean);

    if (secondaryStreams.length === 0) {
      BotUtil.makeLog('warn', '未找到有效的副工作流', 'StreamLoader');
      return null;
    }

    const mergedName = name || `${main}-merged`;
    if (this.streams.has(mergedName)) {
      return this.streams.get(mergedName);
    }

    const merged = Object.create(Object.getPrototypeOf(mainStream));
    Object.assign(merged, mainStream);
    merged.name = mergedName;
    merged.description = description || `${mainStream.description || main} + ${secondary.join(',')}`;
    merged.primaryStream = mainStream.name;
    merged.secondaryStreams = secondaryStreams.map(s => s.name);
    merged._mergedStreams = [mainStream, ...secondaryStreams];
    merged.functions = new Map();
    if (!merged.mcpTools) merged.mcpTools = new Map();

    const adoptFunctions = (source, isPrimary) => {
      if (source.functions) {
        for (const [fname, fconfig] of source.functions.entries()) {
          const newName = (!isPrimary && prefixSecondary) ? `${source.name}.${fname}` : fname;
          if (merged.functions.has(newName)) continue;
          merged.functions.set(newName, { ...fconfig, source: source.name, primary: isPrimary });
        }
      }
      if (source.mcpTools) {
        for (const [tname, tconfig] of source.mcpTools.entries()) {
          const newName = (!isPrimary && prefixSecondary) ? `${source.name}.${tname}` : tname;
          if (merged.mcpTools.has(newName)) continue;
          merged.mcpTools.set(newName, { ...tconfig, source: source.name, primary: isPrimary });
        }
      }
    };

    adoptFunctions(mainStream, true);
    for (const s of secondaryStreams) {
      adoptFunctions(s, false);
    }

    this.streams.set(mergedName, merged);
    return merged;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const total = this.streams.size;
    const enabled = this.getEnabledStreams().length;
    const totalFunctions = this.getAllStreams().reduce(
      (sum, s) => sum + (s.functions?.size || 0) + (s.mcpTools?.size || 0), 0
    );
    const embeddingEnabled = this.getAllStreams().filter(
      s => s.embeddingConfig?.enabled
    ).length;

    return {
      total,
      enabled,
      disabled: total - enabled,
      totalFunctions,
      embedding: {
        enabled: embeddingEnabled,
        ready: embeddingEnabled,
        provider: 'bm25',
        configured: embeddingEnabled > 0
      },
      loadStats: this.loadStats
    };
  }

  /**
   * 清理所有资源
   */
  async cleanupAll() {
    BotUtil.makeLog('info', '🧹 清理资源...', 'StreamLoader');
    
    for (const stream of this.streams.values()) {
      if (typeof stream.cleanup === 'function') {
        await stream.cleanup().catch(() => {});
      }
    }

    this.streams.clear();
    this.streamClasses.clear();
    this.loaded = false;

    BotUtil.makeLog('success', '✅ 清理完成', 'StreamLoader');
  }
}

export default new StreamLoader();