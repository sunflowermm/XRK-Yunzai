import path from 'path';
import { FileUtils } from '../utils/file-utils.js';
import { ObjectUtils } from '../utils/object-utils.js';
import { PluginDirScanner } from '../utils/plugin-dir-scanner.js';
import { MCPServer } from '../utils/mcp-server.js';
import { tryParseJson } from '../utils/json-utils.js';
import { HotReloadBase } from '../utils/hot-reload-base.js';
import { getAistreamConfigOptional } from '../utils/aistream-config.js';
import { getStreamRequestContext } from './stream-request-context.js';
import {
  buildStreamCacheKey,
  getStreamResultCache,
  shouldCacheStreamResult,
  clearStreamResultCache,
} from './stream-cache.js';

/**
 * AI工作流加载器
 * 标准化初始化流程，避免重复加载
 */
class StreamLoader {
  streams = new Map();
  streamClasses = new Map();
  remoteMCPServers = new Map();
  /** 插件内置 MCP：由 stream 模块 export 的 mcpServers 提供，用户无需在配置里填写 */
  builtinMcpServers = new Map();
  /** 源文件绝对路径 → 工作流 name（热重载卸载用） */
  streamFiles = new Map();
  /** 源文件 → 该模块 export 的内置 MCP 名列表 */
  fileBuiltinMcp = new Map();
  watcher = {};
  loaded = false;
  _loadingPromise = null;
  mcpServer = null;
  _runningExecutions = 0;
  _executeWaiters = [];
  stdioCallChains = new Map();
  loadStats = {
    streams: [],
    totalLoadTime: 0,
    startTime: 0,
    totalStreams: 0,
    failedStreams: 0
  };

  _isMcpEnabled() {
    return getAistreamConfigOptional().mcp?.enabled !== false;
  }

  _maxConcurrent() {
    const max = Number(getAistreamConfigOptional().global?.maxConcurrent);
    return Number.isFinite(max) && max > 0 ? max : null;
  }

  _isDebugEnabled() {
    return !!getAistreamConfigOptional().global?.debug;
  }

  /**
   * 加载所有工作流（标准化流程）
   */
  async load() {
    if (this.loaded) {
      return;
    }

    if (this._loadingPromise) {
      return await this._loadingPromise;
    }

    this._loadingPromise = this._doLoad();
    
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
    return PluginDirScanner.listStreamDirs();
  }

  async _doLoad() {
    try {
      const aistreamCfg = getAistreamConfigOptional();
      if (aistreamCfg.enabled === false) {
        Bot.makeLog('info', '工作流已禁用（aistream.enabled: false）', 'StreamLoader');
        this.loaded = true;
        return;
      }

      this.loadStats.startTime = Date.now();
      this.loadStats.streams = [];
      this.loadStats.failedStreams = 0;

    this.streams.clear();
    this.streamClasses.clear();
    this.builtinMcpServers.clear();
    this.streamFiles.clear();
    this.fileBuiltinMcp.clear();
    clearStreamResultCache();

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
      if (this._isMcpEnabled()) {
        await this.initMCP();
      }

      this.loadStats.totalLoadTime = Date.now() - this.loadStats.startTime;
      this.loadStats.totalStreams = this.streams.size;
      this.loaded = true;

      // 显示加载结果（简化日志）
      this.displayLoadSummary();
    } catch (error) {
      Bot.makeLog('error', `工作流加载失败: ${error.message}`, 'StreamLoader');
      throw error;
    }
  }

  /**
   * 扫描工作流文件（通用方法，跨平台兼容）
   * @param {string} dir - 工作流目录路径
   * @returns {string[]} 工作流文件路径数组
   */
  scanStreamFiles(dir) {
    return PluginDirScanner.listJsFiles(dir);
  }

  /**
   * 从 stream 模块合并内置 MCP 配置（export mcpServers 或 getMcpServers）
   * 格式：{ "server-name": { command, args, values? } | { url, transport?, headers? } }
   */
  _mergeModuleMcpServers(module, filePath) {
    const raw = module.mcpServers ?? module.getMcpServers?.();
    if (raw == null) return;
    const servers = typeof raw === 'function' ? raw() : raw;
    if (!servers || typeof servers !== 'object') return;
    const names = [];
    for (const [name, c] of Object.entries(servers)) {
      if (!name || !c) continue;
      const config = typeof c === 'object' && (c.command || c.url) ? { ...c } : null;
      if (config) {
        const trimmed = String(name).trim();
        this.builtinMcpServers.set(trimmed, config);
        names.push(trimmed);
      }
    }
    if (filePath && names.length) {
      this.fileBuiltinMcp.set(path.resolve(filePath), names);
    }
  }

  /**
   * 加载单个工作流类
   */
  async loadStreamClass(file, options = {}) {
    const streamName = path.basename(file, '.js');
    const startTime = Date.now();

    try {
      const normalizedPath = path.resolve(file);
      const importOpts = options.cacheBust ? { cacheBust: true } : {};
      const module = await import(FileUtils.toImportUrl(normalizedPath, importOpts));
      this._mergeModuleMcpServers(module, normalizedPath);
      const StreamClass = module.default;
      if (!ObjectUtils.isFunction(StreamClass)) {
        return; // 仅 MCP 包装模块（只 export mcpServers），不创建工作流
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
      this.streamFiles.set(normalizedPath, stream.name);

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
      this.loadStats.streams.push({
        name: streamName,
        loadTime: Date.now() - startTime,
        success: false,
        error: error.message
      });
      const stack = (error.stack || '').split('\n').slice(0, 5).join('\n');
      Bot.makeLog('error', `工作流加载失败 ${streamName}: ${error.message}${stack ? '\n' + stack : ''}`, 'StreamLoader');
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
      Bot.makeLog('success', `工作流加载完成: ${streamNames} (${totalTime}s)`, 'StreamLoader');
    }
    
    if (failedCount > 0) {
      Bot.makeLog('error', `工作流加载失败: ${failedCount} 个`, 'StreamLoader');
    }
  }


  /**
   * 重新加载工作流
   */
  async reload() {
    Bot.makeLog('info', '🔄 开始重新加载...', 'StreamLoader');
    
    // 清理
    for (const stream of this.streams.values()) {
      if (typeof stream.cleanup === 'function') {
        await stream.cleanup().catch((err) => {
          Bot.makeLog('debug', `[StreamLoader] 工作流 cleanup 失败: ${err?.message || err}`, 'StreamLoader');
        });
      }
    }

    this.streams.clear();
    this.streamClasses.clear();
    this.streamFiles.clear();
    this.fileBuiltinMcp.clear();
    this.builtinMcpServers.clear();
    this._disposeRemoteMCPServers();
    this.loaded = false;
    
    // 重新加载（会再次执行 initMCP，更新 StreamLoader.mcpServer）
    await this.load();
    Bot.makeLog('success', '✅ 重新加载完成', 'StreamLoader');
  }

  _purgeBuiltinMcpForFile(filePath) {
    const normalized = path.resolve(filePath);
    const names = this.fileBuiltinMcp.get(normalized);
    if (!names?.length) return;
    for (const name of names) this.builtinMcpServers.delete(name);
    this.fileBuiltinMcp.delete(normalized);
  }

  _disposeRemoteMCPServers() {
    for (const [name, entry] of this.remoteMCPServers) {
      if (entry?.type === 'stdio' && entry.process && !entry.process.killed) {
        try {
          entry.process.kill();
        } catch (err) {
          Bot.makeLog('debug', `[StreamLoader] 终止 MCP 进程失败(${name}): ${err?.message || err}`, 'StreamLoader');
        }
      }
    }
    this.remoteMCPServers.clear();
  }

  /**
   * 卸载单个工作流
   * @param {string} name - 工作流 name
   */
  async unloadStream(name) {
    const stream = this.streams.get(name);
    if (!stream) return;

    if (typeof stream.cleanup === 'function') {
      await stream.cleanup().catch((err) => {
        Bot.makeLog('debug', `[StreamLoader] 工作流 cleanup 失败(${name}): ${err?.message || err}`, 'StreamLoader');
      });
    }

    this.streams.delete(name);
    this.streamClasses.delete(name);
    for (const [filePath, streamName] of this.streamFiles) {
      if (streamName === name) {
        this._purgeBuiltinMcpForFile(filePath);
        this.streamFiles.delete(filePath);
      }
    }
  }

  /**
   * 热重载单个工作流文件
   * @param {string} filePath
   */
  async changeStreamFile(filePath) {
    clearStreamResultCache();
    const normalizedPath = path.resolve(filePath);
    this._purgeBuiltinMcpForFile(normalizedPath);
    const prevName = this.streamFiles.get(normalizedPath) ?? path.basename(normalizedPath, '.js');
    await this.unloadStream(prevName);
    await this.loadStreamClass(normalizedPath, { cacheBust: true });
    if (this._isMcpEnabled()) {
      await this.initMCP();
    }
  }

  /**
   * 监视工作流目录变更（与 ApiLoader 对齐）
   * @param {boolean} [enable=true]
   */
  async watch(enable = true) {
    if (!enable) {
      await HotReloadBase.closeWatchers(this.watcher);
      this.watcher = {};
      Bot.makeLog('info', '工作流文件监视已停止', 'StreamLoader');
      return;
    }

    if (this.watcher.streams) return;

    try {
      this.watcher.streams = await HotReloadBase.watchModuleDirs({
        loggerName: 'StreamLoader',
        dirs: this._getStreamDirs(),
        debounceMs: HotReloadBase.WATCH_DEBOUNCE_MS,
        jsOnly: true,
        onAdd: async (normalizedPath) => {
          Bot.makeLog('info', `检测到新工作流: ${path.basename(normalizedPath)}`, 'StreamLoader');
          await this.loadStreamClass(normalizedPath, { cacheBust: true });
          if (this._isMcpEnabled()) {
            await this.initMCP();
          }
        },
        onChange: async (normalizedPath) => {
          Bot.makeLog('info', `检测到工作流变更: ${path.basename(normalizedPath)}`, 'StreamLoader');
          await this.changeStreamFile(normalizedPath);
        },
        onUnlink: async (normalizedPath) => {
          const name = this.streamFiles.get(normalizedPath) ?? path.basename(normalizedPath, '.js');
          Bot.makeLog('info', `检测到工作流删除: ${name}`, 'StreamLoader');
          await this.unloadStream(name);
          if (this._isMcpEnabled()) {
            await this.initMCP();
          }
        },
      });
    } catch (error) {
      Bot.makeLog('error', '启动工作流文件监视失败', 'StreamLoader', error);
    }
  }

  /**
   * 获取工作流
   */
  getStream(name) {
    return this.streams.get(name);
  }

  async _acquireExecuteSlot() {
    const max = this._maxConcurrent();
    if (!max) return;
    if (this._runningExecutions < max) {
      this._runningExecutions++;
      return;
    }
    await new Promise((resolve) => this._executeWaiters.push(resolve));
    this._runningExecutions++;
  }

  _releaseExecuteSlot() {
    const max = this._maxConcurrent();
    if (!max) return;
    this._runningExecutions = Math.max(0, this._runningExecutions - 1);
    const next = this._executeWaiters.shift();
    if (next) next();
  }

  async executeStream(stream, e, question, config = {}) {
    if (!stream || typeof stream.execute !== 'function') {
      throw new Error('无效的工作流实例');
    }

    const useCache = shouldCacheStreamResult(stream, e, question, config);
    const cache = useCache ? getStreamResultCache() : null;
    const cacheKey = useCache ? buildStreamCacheKey(stream.name, e, question, config) : null;

    if (cache && cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        if (this._isDebugEnabled()) {
          Bot.makeLog('debug', `[StreamLoader] 缓存命中 ${stream.name}`, 'StreamLoader');
        }
        return typeof cached === 'string' ? cached : ObjectUtils.clone(cached);
      }
    }

    await this._acquireExecuteSlot();
    try {
      if (this._isDebugEnabled()) {
        Bot.makeLog('debug', `[StreamLoader] 执行工作流 ${stream.name}`, 'StreamLoader');
      }
      const result = await stream.execute(e, question, config);
      if (cache && cacheKey && result != null) {
        cache.set(cacheKey, typeof result === 'string' ? result : ObjectUtils.clone(result));
      }
      return result;
    } finally {
      this._releaseExecuteSlot();
    }
  }

  getStreamClass(name) {
    return this.streamClasses.get(name);
  }

  getAllStreams() {
    return Array.from(this.streams.values());
  }

  getEnabledStreams() {
    return this.getAllStreams().filter((s) => s.config?.enabled !== false);
  }

  getStreamsByPriority() {
    return this.getAllStreams().sort((a, b) => a.priority - b.priority);
  }

  /** 将所有工作流的 mcpTools 注册到 MCPServer，handler 绑定 stream 为 this，统一返回 { success, data?|error? }。context.e 在调用时从 currentEvent 读取，保证工具拿到当前会话事件。 */
  registerMCP(mcpServer) {
    if (!mcpServer?.registerTool) return;
    const registered = new Set();
    let count = 0;
    const loader = this;
    
    for (const stream of this.streams.values()) {
      if (!stream.mcpTools?.size) continue;
      const context = {
        get e() {
          return getStreamRequestContext()?.e ?? loader.currentEvent ?? null;
        },
        get turnState() {
          return getStreamRequestContext()?.turnState ?? null;
        },
        stream
      };
      for (const [toolName, tool] of stream.mcpTools.entries()) {
        if (!tool?.enabled) continue;
        const fullName = stream.name !== 'mcp' ? `${stream.name}.${toolName}` : toolName;
        if (registered.has(fullName)) continue;
        const fn = tool.handler || (() => ({}));
        mcpServer.registerTool(fullName, {
          description: tool.description || `执行 ${toolName}`,
          inputSchema: tool.inputSchema || {},
          handler: async (args) => {
            try {
              const result = await fn.call(stream, args, context);
              let normalized;
              if (result === undefined) normalized = { success: true, message: '已执行' };
              else if (typeof result === 'object' && result !== null && ('success' in result || 'error' in result)) {
                normalized = result;
              } else normalized = { success: true, data: result };

              if (typeof stream.recordToolCallResult === 'function') {
                try {
                  const ev = context.e;
                  if (ev?.isGroup && ev?.group_id) {
                    stream.recordToolCallResult(ev, fullName, normalized, args || {});
                  }
                } catch (recErr) {
                  Bot.makeLog('debug', `[StreamLoader] recordToolCallResult: ${recErr.message}`, 'StreamLoader');
                }
              }

              return normalized;
            } catch (err) {
              const fail = { success: false, error: { code: 'TOOL_ERROR', message: err.message } };
              if (typeof stream.recordToolCallResult === 'function') {
                try {
                  const ev = context.e;
                  if (ev?.isGroup && ev?.group_id) {
                    stream.recordToolCallResult(ev, fullName, fail, args || {});
                  }
                } catch (recErr) {
                  Bot.makeLog('debug', `[StreamLoader] recordToolCallResult on error: ${recErr.message}`, 'StreamLoader');
                }
              }
              return fail;
            }
          }
        });
        registered.add(fullName);
        count++;
      }
    }
    
    if (count > 0) {
      Bot.makeLog('info', `MCP 已注册 ${count} 个工具`, 'StreamLoader');
    }
  }

  /**
   * 初始化 MCP 服务：创建 MCPServer、注册所有工作流 mcpTools，供 LLM 与 HTTP 使用
   */
  async initMCP() {
    const mcpCfg = getAistreamConfigOptional().mcp ?? {};
    if (mcpCfg.enabled === false) {
      this._disposeRemoteMCPServers();
      if (this.mcpServer?.tools?.clear) {
        this.mcpServer.tools.clear();
      }
      if (this.mcpServer) this.mcpServer.initialized = false;
      return;
    }

    if (!this.mcpServer) this.mcpServer = new MCPServer();
    for (const name of this.mcpServer.tools.keys()) {
      const streamName = name.split('.')[0];
      if ((streamName && this.streams.has(streamName)) || name.startsWith('remote-mcp.')) {
        this.mcpServer.tools.delete(name);
      }
    }
    this._disposeRemoteMCPServers();
    if (mcpCfg.autoRegister !== false) {
      this.registerMCP(this.mcpServer);
    }
    await this.registerRemoteMCP();

    this.mcpServer.initialized = true;
  }

  _getRemoteMCPConfig() {
    const remoteConfig = getAistreamConfigOptional().mcp?.remote || {};
    if (!remoteConfig.enabled) return null;

    const blocks = Array.isArray(remoteConfig.mcpServers) ? remoteConfig.mcpServers : [];
    if (!blocks.length) return null;

    const merged = {};
    const mergeServers = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      const map = obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)
        ? obj.mcpServers
        : null;
      if (!map) return;
      for (const [name, serverCfg] of Object.entries(map)) {
        const n = String(name || '').trim();
        if (!n || !serverCfg || typeof serverCfg !== 'object') continue;
        merged[n] = serverCfg;
      }
    };

    for (const block of blocks) {
      let obj = block?.config ?? block;
      if (typeof obj === 'string') {
        obj = tryParseJson(obj);
      }
      mergeServers(obj);
    }

    const servers = Object.entries(merged)
      .map(([name, serverCfg]) => ({ name, cfg: serverCfg }))
      .filter((item) => item.name && item.cfg && typeof item.cfg === 'object');

    return servers.length ? { servers } : null;
  }

  async registerRemoteMCP() {
    let count = 0;
    for (const [name, obj] of this.builtinMcpServers) {
      try {
        if (obj.command) await this._registerStdioMCP(name, obj);
        else if (obj.url) await this._registerHttpMCP(name, obj);
        else continue;
        count++;
      } catch (e) {
        const optional = obj.optional === true;
        if (optional) Bot.makeLog('info', `跳过可选MCP[${name}]: ${e.message}`, 'StreamLoader');
        else Bot.makeLog('error', `注册内置MCP失败[${name}]: ${e.message}`, 'StreamLoader');
      }
    }
    if (count > 0) Bot.makeLog('info', `已注册 ${count} 个内置MCP服务器（来自 stream 插件）`, 'StreamLoader');

    const config = this._getRemoteMCPConfig();
    if (!config) return;

    const { servers } = config;
    let remoteCount = 0;
    for (const { name, cfg: serverCfg } of servers) {
      if (!name || this.remoteMCPServers.has(name)) continue;
      if (!serverCfg?.command && !serverCfg?.url) continue;
      try {
        if (serverCfg.command) await this._registerStdioMCP(name, serverCfg);
        else await this._registerHttpMCP(name, serverCfg);
        remoteCount++;
      } catch (e) {
        Bot.makeLog('error', `注册第三方MCP失败[${name}]: ${e.message}`, 'StreamLoader');
      }
    }
    if (remoteCount > 0) Bot.makeLog('info', `已注册 ${remoteCount} 个远程MCP服务器（来自配置）`, 'StreamLoader');
  }

  /**
   * 解析 stdio 命令（Windows 下可用 commandWin 或 command.cmd）
   * @param {Object} config - command, commandWin（可选，Windows 下优先）
   */
  _resolveStdioCommand(config) {
    const cmd = process.platform === 'win32' && config.commandWin != null
      ? config.commandWin
      : config.command;
    if (!cmd) return null;
    return typeof cmd === 'string' ? cmd : null;
  }

  /**
   * 解析 stdio 参数（Windows 下可用 argsWin）
   */
  _resolveStdioArgs(config) {
    const isWin = process.platform === 'win32';
    const args = isWin && Array.isArray(config.argsWin) ? config.argsWin : config.args;
    return Array.isArray(args) ? args : [];
  }

  /**
   * 注册 stdio 协议 MCP 服务器
   * @param {string} serverName - 服务器名称
   * @param {Object} config - command, commandWin（可选）, args, argsWin（可选，Windows 下优先）, values, optional
   */
  async _registerStdioMCP(serverName, config) {
    const { spawn } = await import('child_process');
    const command = this._resolveStdioCommand(config);
    if (!command) throw new Error('缺少 command');
    const args = this._resolveStdioArgs(config);
    const env = { ...process.env, ...(config.values && typeof config.values === 'object' ? config.values : {}) };
    try {
      const child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        windowsHide: true
      });

      let buffer = '';
      child.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = tryParseJson(line);
          if (message) this._handleStdioMessage(serverName, message);
        }
      });

      child.stderr.on('data', (data) => {
        const stderrText = data.toString().trim();
        if (!stderrText) return;
        
        // 过滤冗余的 npm 警告信息
        const npmWarnPatterns = [
          /npm warn Unknown project config/i,
          /npm warn.*will stop working in the next major version/i,
          /npm warn.*deprecated/i
        ];
        
        const isNpmWarning = npmWarnPatterns.some(pattern => pattern.test(stderrText));
        if (isNpmWarning) return;

        const startupNoise = /已启动|waiting for|等待来自/i.test(stderrText);
        if (startupNoise) return;
        
        Bot.makeLog('debug', `MCP服务器[${serverName}] stderr: ${stderrText}`, 'StreamLoader');
      });

      child.on('exit', (code) => {
        Bot.makeLog('warn', `MCP服务器[${serverName}] 进程退出，退出码: ${code}`, 'StreamLoader');
      });

      // 发送initialize请求
      const initRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: {
            name: 'xrk-yunzai',
            version: '3.1.3'
          }
        }
      };
      
      child.stdin.write(JSON.stringify(initRequest) + '\n');
      
      // 请求工具列表
      const toolsRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      };
      
      child.stdin.write(JSON.stringify(toolsRequest) + '\n');
      
      this.remoteMCPServers.set(serverName, { type: 'stdio', process: child });
    } catch (error) {
      const msg = error?.code === 'ENOENT'
        ? `未找到命令 "${command}"，请先安装或移除/禁用该 MCP 模块（如重命名 stream 文件为 .disabled）`
        : error.message;
      const err = new Error(msg);
      err.code = error?.code;
      throw err;
    }
  }

  /**
   * 注册HTTP/SSE/WebSocket协议的MCP服务器
   * @param {string} serverName - 服务器名称
   * @param {Object} config - 配置对象（url, transport, headers）
   */
  async _registerHttpMCP(serverName, config) {
    const baseUrl = (config.url || '').replace(/\/$/, '');
    const headers = config.headers || {};
    try {
      const toolsUrl = `${baseUrl}/api/mcp/tools`;
      const res = await fetch(toolsUrl, { method: 'GET', headers: { 'Content-Type': 'application/json', ...headers } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json();
      const tools = data.tools || data.data?.tools || [];
      this.remoteMCPServers.set(serverName, { type: 'http', url: baseUrl, headers });
      this._registerRemoteTools(serverName, tools);
      if (tools.length > 0) Bot.makeLog('info', `已从 HTTP MCP[${serverName}] 注册 ${tools.length} 个工具`, 'StreamLoader');
    } catch (e) {
      Bot.makeLog('error', `注册 HTTP MCP[${serverName}] 失败: ${e.message}`, 'StreamLoader');
      throw e;
    }
  }

  /**
   * 处理stdio消息
   * @param {string} serverName - 服务器名称
   * @param {Object} message - JSON-RPC消息
   */
  _handleStdioMessage(serverName, message) {
    if (message.id === 2 && message.result?.tools) {
      this._registerRemoteTools(serverName, message.result.tools);
    }
  }

  _registerRemoteTools(serverName, tools) {
    if (!this.mcpServer || !Array.isArray(tools)) return;
    const names = [];
    for (const tool of tools) {
      const name = `remote-mcp.${serverName}.${tool.name}`;
      names.push(tool.name);
      if (this.mcpServer.tools.has(name)) this.mcpServer.tools.delete(name);
      this.mcpServer.registerTool(name, {
        description: tool.description || '',
        inputSchema: tool.inputSchema || {},
        handler: (args) => this._callRemoteTool(serverName, tool.name, args)
      });
    }
    if (names.length > 0) {
      Bot.makeLog('info', `已从 stdio MCP[${serverName}] 注册 ${names.length} 个工具`, 'StreamLoader');
    }
  }

  _safeStr(x) {
    if (x == null) return '';
    if (typeof x === 'string') return x;
    try { return JSON.stringify(x); } catch (err) {
      Bot.makeLog('debug', `[StreamLoader] JSON.stringify 失败: ${err?.message || err}`, 'StreamLoader');
      return String(x);
    }
  }

  _normalizeRemoteMCPResult(raw) {
    try {
      if (raw == null) {
        Bot.makeLog('debug', '[StreamLoader] 远程MCP result=null', 'StreamLoader');
        return { success: false, error: '远程MCP返回空' };
      }
      const c0 = raw?.content?.[0];
      const c0Keys = c0 && typeof c0 === 'object' ? Object.keys(c0) : [];
      let text = typeof c0 === 'string' ? c0 : (c0?.text ?? c0?.value ?? c0?.content);
      if (typeof text !== 'string' || !text.trim()) {
        if (typeof raw.text === 'string' && raw.text.trim()) text = raw.text;
        else if (Array.isArray(raw.content) && raw.content.length > 0) {
          text = raw.content.map(c => (typeof c === 'string' ? c : (c?.text ?? c?.value ?? c?.content ?? this._safeStr(c)))).filter(Boolean).join('\n');
        }
      }
      if (typeof text === 'string' && text.trim()) {
        Bot.makeLog('debug', `[StreamLoader] _normalizeRemoteMCPResult 提取到文本 len=${text.length} 前1000字=${text.slice(0, 1000)}`, 'StreamLoader');
        // 完整传给 AI：不 parse 掉内容，统一用 raw 透传，和调接口一样
        return { success: true, raw: text };
      }
      Bot.makeLog('debug', `[StreamLoader] _normalizeRemoteMCPResult 无可用文本 content[0] keys=[${c0Keys.join(',')}] contentLen=${raw?.content?.length ?? 0}`, 'StreamLoader');
      const fallback = this._safeStr(raw);
      return fallback ? { success: true, raw: fallback } : { success: false, error: '远程MCP返回空结果' };
    } catch (e) {
      Bot.makeLog('debug', `[StreamLoader] 远程MCP归一异常 ${e?.message}`, 'StreamLoader');
      return { success: false, error: String(e?.message || e) };
    }
  }

  _runStdioQueued(serverName, task) {
    const prev = this.stdioCallChains.get(serverName) || Promise.resolve();
    const next = prev.then(task, task);
    this.stdioCallChains.set(serverName, next.finally(() => {
      if (this.stdioCallChains.get(serverName) === next) {
        this.stdioCallChains.delete(serverName);
      }
    }));
    return next;
  }

  _callStdioRemoteTool(server, serverName, toolName, request) {
    const child = server.process;
    if (!child || child.killed) {
      Bot.makeLog('warn', `[StreamLoader] 远程MCP[${serverName}] 进程不可用`, 'StreamLoader');
      return Promise.resolve({ success: false, error: 'MCP进程不可用' });
    }
    const reqId = request.id;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        Bot.makeLog('debug', `[StreamLoader] 远程MCP[${serverName}.${toolName}] 超时 reqId=${reqId} bufLen=${buf.length}`, 'StreamLoader');
        resolve({ success: false, error: '调用超时' });
      }, 30000);
      let buf = '';
      const tryResolve = (msg) => {
        if (msg.id == null || msg.id != reqId) return false;
        clearTimeout(timeout);
        child.stdout.removeListener('data', handler);
        const r = msg.result;
        const rKeys = r && typeof r === 'object' ? Object.keys(r).join(',') : (r === null ? 'null' : typeof r);
        const contentLen = r?.content?.length ?? 0;
        const c0 = r?.content?.[0];
        const c0Keys = c0 && typeof c0 === 'object' ? Object.keys(c0).join(',') : '';
        Bot.makeLog('debug', `[StreamLoader] 远程MCP[${serverName}.${toolName}] 收到 resultKeys=[${rKeys}] contentLen=${contentLen} content[0] keys=[${c0Keys}]`, 'StreamLoader');
        const out = this._normalizeRemoteMCPResult(r);
        Bot.makeLog('debug', `[StreamLoader] 远程MCP[${serverName}.${toolName}] 归一 hasRaw=${!!out?.raw} rawLen=${out?.raw?.length ?? 0} 前1000字=${(out?.raw ?? '').slice(0, 1000)}`, 'StreamLoader');
        resolve(out);
        return true;
      };
      const handler = (data) => {
        buf += data.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        Bot.makeLog('debug', `[StreamLoader] 远程MCP[${serverName}.${toolName}] stdout 收到 chunk lines=${lines.length} bufLen=${buf.length}`, 'StreamLoader');
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = tryParseJson(line);
          if (msg && tryResolve(msg)) return;
        }
        const msg = tryParseJson(buf);
        if (msg && tryResolve(msg)) buf = '';
      };
      child.stdout.on('data', handler);
      child.stdin.write(JSON.stringify(request) + '\n');
      Bot.makeLog('debug', `[StreamLoader] 远程MCP[${serverName}.${toolName}] 已发送 tools/call reqId=${reqId}`, 'StreamLoader');
    });
  }

  async _callRemoteTool(serverName, toolName, args) {
    const server = this.remoteMCPServers.get(serverName);
    if (!server) return { success: false, error: `MCP服务器 ${serverName} 未找到` };

    const request = { jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: toolName, arguments: args || {} } };
    Bot.makeLog('debug', `[StreamLoader] _callRemoteTool 开始 ${serverName}.${toolName} reqId=${request.id} argsKeys=${Object.keys(args || {}).join(',')}`, 'StreamLoader');

    if (server.type === 'stdio') {
      return this._runStdioQueued(serverName, () => this._callStdioRemoteTool(server, serverName, toolName, request));
    }

    if (server.type === 'http') {
      try {
        const url = (server.url || '').replace(/\/+$/, '') + '/api/mcp/jsonrpc';
        Bot.makeLog('debug', `[StreamLoader] _callRemoteTool HTTP POST ${url}`, 'StreamLoader');
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(server.headers || {}) },
          body: JSON.stringify(request)
        });
        const data = await res.json();
        if (data.error) {
          Bot.makeLog('debug', `[StreamLoader] 远程MCP HTTP 错误: ${data.error.message}`, 'StreamLoader');
          return { success: false, error: data.error.message || '未知错误' };
        }
        const out = this._normalizeRemoteMCPResult(data.result);
        Bot.makeLog('debug', `[StreamLoader] 远程MCP HTTP 归一 hasRaw=${!!out?.raw} rawLen=${out?.raw?.length ?? 0}`, 'StreamLoader');
        return out;
      } catch (e) {
        Bot.makeLog('debug', `[StreamLoader] 远程MCP HTTP 异常: ${e?.message}`, 'StreamLoader');
        return { success: false, error: e?.message || String(e) };
      }
    }

    return { success: false, error: '未知MCP类型' };
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
      Bot.makeLog('warn', 'mergeStreams 需要主工作流和至少一个副工作流', 'StreamLoader');
      return null;
    }

    const mainStream = this.getStream(main);
    if (!mainStream) {
      Bot.makeLog('error', `主工作流未找到: ${main}`, 'StreamLoader');
      return null;
    }

    const secondaryStreams = secondary
      .map(n => {
        const stream = this.getStream(n);
        if (!stream) {
          Bot.makeLog('warn', `[StreamLoader] 副工作流未找到: ${n}`, 'StreamLoader');
        }
        return stream;
      })
      .filter(Boolean);

    if (secondaryStreams.length === 0) {
      Bot.makeLog('warn', `[StreamLoader] 未找到有效的副工作流，请求的副工作流: [${secondary.join(', ')}]`, 'StreamLoader');
      return null;
    }

    const mergedName = name || `${main}-merged`;
    if (this.streams.has(mergedName)) {
      return this.streams.get(mergedName);
    }

    // ⚠️ 重要：使用 Object.create 创建合并工作流，但需要正确设置原型链和方法
    const merged = Object.create(Object.getPrototypeOf(mainStream));
    // 复制所有属性（包括方法）
    Object.assign(merged, mainStream);
    // 设置合并工作流的属性
    merged.name = mergedName;
    merged.description = description || `${mainStream.description || main} + ${secondary.join(',')}`;
    merged.primaryStream = mainStream.name;
    merged.secondaryStreams = secondaryStreams.map(s => s.name);
    merged._mergedStreams = [mainStream, ...secondaryStreams]; // ⚠️ 重要：保存合并的工作流列表
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

    return {
      total,
      enabled,
      disabled: total - enabled,
      totalFunctions,
      loadStats: this.loadStats
    };
  }

  /**
   * 清理所有资源
   */
  async cleanupAll() {
    Bot.makeLog('info', '🧹 清理资源...', 'StreamLoader');

    await this.watch(false);
    
    for (const stream of this.streams.values()) {
      if (typeof stream.cleanup === 'function') {
        await stream.cleanup().catch((err) => {
          Bot.makeLog('debug', `[StreamLoader] 工作流 cleanup 失败: ${err?.message || err}`, 'StreamLoader');
        });
      }
    }

    this.streams.clear();
    this.streamClasses.clear();
    this.streamFiles.clear();
    this.fileBuiltinMcp.clear();
    this.builtinMcpServers.clear();
    this._disposeRemoteMCPServers();
    this.loaded = false;

    Bot.makeLog('success', '✅ 清理完成', 'StreamLoader');
  }
}

export default new StreamLoader();