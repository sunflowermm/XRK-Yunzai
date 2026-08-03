import path from 'path';
import { FileUtils } from '../utils/file-utils.js';
import { ObjectUtils } from '../utils/object-utils.js';
import { PluginDirScanner } from '../utils/plugin-dir-scanner.js';
import { MCPServer } from '../utils/mcp-server.js';
import { tryParseJson } from '../utils/json-utils.js';
import { HotReloadBase } from '../utils/hot-reload-base.js';
import { getAiWorkflowConfigOptional } from '../utils/ai-workflow-config.js';
import { normalizeStringArray } from '../utils/string-array-utils.js';
import cfg from '../config/config.js';
import { getWorkflowRequestContext } from './workflow-request-context.js';
import { resolveWorkspaceAbsFromContext } from '../utils/agent-workspace-paths.js';
import { resetAgentSessionRevisions } from './agent-session.js';
import {
  buildWorkflowCacheKey,
  getWorkflowResultCache,
  shouldCacheWorkflowResult,
  clearWorkflowResultCache,
} from './workflow-cache.js';
import { runWithWorkflowRequestContext } from './workflow-request-context.js';

/**
 * AI工作流加载器
 * 标准化初始化流程，避免重复加载
 */
class AiWorkflowLoader {
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
  _nextRemoteRequestId = 1;
  _syncRemoteMcpPromise = null;
  _onConfigWrite = null;
  loadStats = {
    streams: [],
    totalLoadTime: 0,
    startTime: 0,
    totalStreams: 0,
    failedStreams: 0
  };

  _isMcpEnabled() {
    return getAiWorkflowConfigOptional().mcp?.enabled !== false;
  }

  _maxConcurrent() {
    const max = Number(getAiWorkflowConfigOptional().global?.maxConcurrent);
    return Number.isFinite(max) && max > 0 ? max : null;
  }

  _isDebugEnabled() {
    return !!getAiWorkflowConfigOptional().global?.debug;
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
  _getWorkflowDirs() {
    return PluginDirScanner.listWorkflowDirs();
  }

  async _doLoad() {
    try {
      const aiWorkflowCfg = getAiWorkflowConfigOptional();
      if (aiWorkflowCfg.enabled === false) {
        Bot.makeLog('info', '工作流已禁用（ai-workflow.enabled: false）', 'AiWorkflowLoader');
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
    clearWorkflowResultCache();
    resetAgentSessionRevisions();

      const streamDirs = this._getWorkflowDirs();
      
      // 扫描所有目录中的工作流文件
      const files = [];
      for (const dir of streamDirs) {
        const dirFiles = this.scanWorkflowFiles(dir);
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

      // 统一初始化 MCP（依赖 ConfigManager 已就绪）
      if (this._isMcpEnabled()) {
        await this.initMCP();
      }

      this.loadStats.totalLoadTime = Date.now() - this.loadStats.startTime;
      this.loadStats.totalStreams = this.streams.size;
      this.loaded = true;

      // 显示加载结果（简化日志）
      this.displayLoadSummary();
    } catch (error) {
      Bot.makeLog('error', `工作流加载失败: ${error.message}`, 'AiWorkflowLoader');
      throw error;
    }
  }

  /**
   * 扫描工作流文件（通用方法，跨平台兼容）
   * @param {string} dir - 工作流目录路径
   * @returns {string[]} 工作流文件路径数组
   */
  scanWorkflowFiles(dir) {
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
      Bot.makeLog('error', `工作流加载失败 ${streamName}: ${error.message}${stack ? '\n' + stack : ''}`, 'AiWorkflowLoader');
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
      Bot.makeLog('success', `工作流加载完成: ${streamNames} (${totalTime}s)`, 'AiWorkflowLoader');
    }
    
    if (failedCount > 0) {
      Bot.makeLog('error', `工作流加载失败: ${failedCount} 个`, 'AiWorkflowLoader');
    }
  }


  /**
   * 重新加载工作流
   */
  async reload() {
    Bot.makeLog('info', '🔄 开始重新加载...', 'AiWorkflowLoader');
    
    // 清理
    for (const stream of this.streams.values()) {
      if (typeof stream.cleanup === 'function') {
        await stream.cleanup().catch((err) => {
          Bot.makeLog('debug', `[AiWorkflowLoader] 工作流 cleanup 失败: ${err?.message || err}`, 'AiWorkflowLoader');
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
    
    // 重新加载（会再次执行 initMCP，更新 AiWorkflowLoader.mcpServer）
    await this.load();
    Bot.makeLog('success', '✅ 重新加载完成', 'AiWorkflowLoader');
  }

  _purgeBuiltinMcpForFile(filePath) {
    const normalized = path.resolve(filePath);
    const names = this.fileBuiltinMcp.get(normalized);
    if (!names?.length) return;
    for (const name of names) this.builtinMcpServers.delete(name);
    this.fileBuiltinMcp.delete(normalized);
  }

  _disposeRemoteMCPServer(name) {
    const entry = this.remoteMCPServers.get(name);
    if (!entry) return;
    if (entry.type === 'stdio' && entry.process) {
      const client = entry._stdioClient;
      if (client?.pending) {
        for (const [, p] of client.pending) {
          if (p.timeout) clearTimeout(p.timeout);
          try { p.reject(new Error('远程MCP已卸载')); } catch { /* ignore */ }
        }
        client.pending.clear();
      }
      if (client?.onData) {
        try { entry.process.stdout?.removeListener('data', client.onData); } catch { /* ignore */ }
      }
      try {
        entry.process.stdin?.end?.();
        entry.process.kill('SIGTERM');
      } catch (err) {
        Bot.makeLog('debug', `[AiWorkflowLoader] 终止 MCP 进程失败(${name}): ${err?.message || err}`, 'AiWorkflowLoader');
      }
    }
    this.remoteMCPServers.delete(name);
  }

  _disposeRemoteMCPServers() {
    for (const name of [...this.remoteMCPServers.keys()]) {
      this._disposeRemoteMCPServer(name);
    }
  }

  _makeRemoteRequestId() {
    const id = this._nextRemoteRequestId++;
    if (this._nextRemoteRequestId > 1_000_000_000) this._nextRemoteRequestId = 1;
    return id;
  }

  /** 单一 stdout 监听 + pending map，避免 fire-and-forget / 多 listener 抢包 */
  _ensureStdioClient(serverName, entry) {
    if (!entry || entry.type !== 'stdio' || !entry.process) return null;
    if (entry._stdioClient) return entry._stdioClient;

    const child = entry.process;
    const client = { buffer: '', stderr: '', pending: new Map(), onData: null, closed: false };

    const flushPending = (errMsg) => {
      for (const [, p] of client.pending) {
        if (p.timeout) clearTimeout(p.timeout);
        try { p.reject(new Error(errMsg)); } catch { /* ignore */ }
      }
      client.pending.clear();
    };

    client.onData = (data) => {
      if (client.closed) return;
      client.buffer += data?.toString?.() || '';
      const lines = client.buffer.split('\n');
      client.buffer = lines.pop() || '';
      for (const line of lines) {
        const s = String(line || '').trim();
        if (!s) continue;
        const msg = tryParseJson(s);
        if (!msg || msg.id == null) continue;
        const pending = client.pending.get(msg.id);
        if (!pending) continue;
        client.pending.delete(msg.id);
        if (pending.timeout) clearTimeout(pending.timeout);
        if (msg.error) pending.reject(new Error(msg.error?.message || '远程MCP返回错误'));
        else pending.resolve(msg.result);
      }
    };

    child.stdout?.on('data', client.onData);
    child.stderr?.on('data', (chunk) => {
      const text = chunk?.toString?.() || '';
      client.stderr = (client.stderr + text).slice(-2000);
      const trimmed = text.trim();
      if (!trimmed) return;
      if (/npm warn/i.test(trimmed) || /已启动|waiting for|等待来自/i.test(trimmed)) return;
      Bot.makeLog('debug', `MCP服务器[${serverName}] stderr: ${trimmed}`, 'AiWorkflowLoader');
    });
    child.on('exit', (code, signal) => {
      client.closed = true;
      try { child.stdout?.removeListener('data', client.onData); } catch { /* ignore */ }
      const detail = client.stderr.trim().replace(/\s+/g, ' ').slice(0, 400);
      const why = [
        '远程MCP进程已退出',
        code != null ? `code=${code}` : null,
        signal ? `signal=${signal}` : null,
        detail || null
      ].filter(Boolean).join(' | ');
      Bot.makeLog('warn', `MCP服务器[${serverName}] ${why}`, 'AiWorkflowLoader');
      flushPending(why);
    });
    child.on('error', (err) => {
      client.closed = true;
      try { child.stdout?.removeListener('data', client.onData); } catch { /* ignore */ }
      flushPending(err?.message || '远程MCP进程错误');
    });

    entry._stdioClient = client;
    return client;
  }

  async _stdioRequest(serverName, entry, method, params, { timeoutMs = 15000 } = {}) {
    const client = this._ensureStdioClient(serverName, entry);
    if (!client || client.closed) throw new Error(`远程MCP服务器 ${serverName} 不可用`);
    const id = this._makeRemoteRequestId();
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.pending.delete(id);
        reject(new Error('调用超时'));
      }, Math.max(1000, Number(timeoutMs) || 15000));
      client.pending.set(id, { resolve, reject, timeout });
    });
    entry.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    return promise;
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
        Bot.makeLog('debug', `[AiWorkflowLoader] 工作流 cleanup 失败(${name}): ${err?.message || err}`, 'AiWorkflowLoader');
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
    clearWorkflowResultCache();
    resetAgentSessionRevisions();
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
      Bot.makeLog('info', '工作流文件监视已停止', 'AiWorkflowLoader');
      return;
    }

    if (this.watcher.streams) return;

    try {
      this.watcher.streams = await HotReloadBase.watchModuleDirs({
        loggerName: 'AiWorkflowLoader',
        dirs: this._getWorkflowDirs(),
        debounceMs: HotReloadBase.WATCH_DEBOUNCE_MS,
        jsOnly: true,
        onAdd: async (normalizedPath) => {
          Bot.makeLog('info', `检测到新工作流: ${path.basename(normalizedPath)}`, 'AiWorkflowLoader');
          await this.loadStreamClass(normalizedPath, { cacheBust: true });
          if (this._isMcpEnabled()) {
            await this.initMCP();
          }
        },
        onChange: async (normalizedPath) => {
          Bot.makeLog('info', `检测到工作流变更: ${path.basename(normalizedPath)}`, 'AiWorkflowLoader');
          await this.changeStreamFile(normalizedPath);
        },
        onUnlink: async (normalizedPath) => {
          const name = this.streamFiles.get(normalizedPath) ?? path.basename(normalizedPath, '.js');
          Bot.makeLog('info', `检测到工作流删除: ${name}`, 'AiWorkflowLoader');
          await this.unloadStream(name);
          if (this._isMcpEnabled()) {
            await this.initMCP();
          }
        },
      });
    } catch (error) {
      Bot.makeLog('error', '启动工作流文件监视失败', 'AiWorkflowLoader', error);
    }
  }

  /**
   * 获取工作流
   */
  getWorkflow(name) {
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

  async executeWorkflow(stream, e, question, config = {}) {
    if (!stream || typeof stream.execute !== 'function') {
      throw new Error('无效的工作流实例');
    }

    const run = async () => {
      const useCache = shouldCacheWorkflowResult(stream, e, question, config);
      const cache = useCache ? getWorkflowResultCache() : null;
      const cacheKey = useCache ? buildWorkflowCacheKey(stream.name, e, question, config) : null;

      if (cache && cacheKey) {
        const cached = cache.get(cacheKey);
        if (cached !== undefined) {
          if (this._isDebugEnabled()) {
            Bot.makeLog('debug', `[AiWorkflowLoader] 缓存命中 ${stream.name}`, 'AiWorkflowLoader');
          }
          return typeof cached === 'string' ? cached : ObjectUtils.clone(cached);
        }
      }

      await this._acquireExecuteSlot();
      try {
        if (this._isDebugEnabled()) {
          Bot.makeLog('debug', `[AiWorkflowLoader] 执行工作流 ${stream.name}`, 'AiWorkflowLoader');
        }
        const result = await stream.execute(e, question, config);
        if (cache && cacheKey && result != null) {
          cache.set(cacheKey, typeof result === 'string' ? result : ObjectUtils.clone(result));
        }
        return result;
      } finally {
        this._releaseExecuteSlot();
      }
    };

    const existing = getWorkflowRequestContext();
    if (Array.isArray(config?.toolStreamNames)) {
      // 已有 ALS（如 ChatStream 外层）时也必须写入，否则 remote-mcp.* 挂上了却不进工具白名单
      if (existing) {
        existing.toolStreamNames = config.toolStreamNames;
        return run();
      }
      return runWithWorkflowRequestContext(
        { e, turnState: null, toolStreamNames: config.toolStreamNames },
        run
      );
    }
    if (existing) return run();
    return runWithWorkflowRequestContext({ e, turnState: null }, run);
  }

  getWorkflowClass(name) {
    return this.streamClasses.get(name);
  }

  getAllWorkflows() {
    return Array.from(this.streams.values());
  }

  getEnabledStreams() {
    return this.getAllWorkflows().filter((s) => s.config?.enabled !== false);
  }

  getWorkflowsByPriority() {
    return this.getAllWorkflows().sort((a, b) => a.priority - b.priority);
  }

  /** 将所有工作流的 mcpTools 注册到 MCPServer；context.e 来自 AsyncLocalStorage 请求上下文。 */
  registerMCP(mcpServer) {
    if (!mcpServer?.registerTool) return;
    const registered = new Set();
    let count = 0;
    const loader = this;
    
    for (const stream of this.streams.values()) {
      if (!stream.mcpTools?.size) continue;
      const context = {
        get e() {
          return getWorkflowRequestContext()?.e ?? null;
        },
        get turnState() {
          return getWorkflowRequestContext()?.turnState ?? null;
        },
        get config() {
          return getAiWorkflowConfigOptional();
        },
        get workspace() {
          const tools = loader.getWorkflow('tools');
          if (tools?.workspace) return tools.workspace;
          return resolveWorkspaceAbsFromContext({ config: this.config, e: this.e });
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
                  Bot.makeLog('debug', `[AiWorkflowLoader] recordToolCallResult: ${recErr.message}`, 'AiWorkflowLoader');
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
                  Bot.makeLog('debug', `[AiWorkflowLoader] recordToolCallResult on error: ${recErr.message}`, 'AiWorkflowLoader');
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
      Bot.makeLog('info', `MCP 已注册 ${count} 个工具`, 'AiWorkflowLoader');
    }
  }

  /**
   * 初始化 MCP：注册本地工具 → 按勾选同步远程 → 监听 config:write
   */
  async initMCP() {
    const mcpCfg = getAiWorkflowConfigOptional().mcp ?? {};
    if (mcpCfg.enabled === false) {
      this._unbindRemoteMcpConfigEvents();
      for (const name of [...this.remoteMCPServers.keys()]) this._purgeRemoteTools(name);
      this._disposeRemoteMCPServers();
      if (this.mcpServer?.tools?.clear) this.mcpServer.tools.clear();
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
    this.registerMCP(this.mcpServer);
    await this.syncSelectedRemoteMCP();
    this._bindRemoteMcpConfigEvents();
    this.mcpServer.initialized = true;
  }

  _unbindRemoteMcpConfigEvents() {
    if (!this._onConfigWrite) return;
    globalThis.Bot?.off?.('config:write', this._onConfigWrite);
    this._onConfigWrite = null;
  }

  /** Bot.on('config:write') → 按勾选同步远程 MCP */
  _bindRemoteMcpConfigEvents() {
    if (this._onConfigWrite) return;
    this._onConfigWrite = (ev = {}) => {
      const name = String(ev.name || '');
      if (
        name !== 'ai-workflow'
        && name !== 'ai_config'
        && !name.endsWith('_ai_config')
        && !name.endsWith('/ai_config')
      ) return;
      if (name === 'ai-workflow') cfg.clearConfig('ai-workflow');
      void this.syncSelectedRemoteMCP().catch((err) => {
        Bot.makeLog('error', `远程 MCP 同步失败: ${err?.message || err}`, 'AiWorkflowLoader');
      });
    };
    globalThis.Bot?.on?.('config:write', this._onConfigWrite);
  }

  _purgeRemoteTools(serverName) {
    if (!this.mcpServer?.tools) return;
    const prefix = `remote-mcp.${serverName}.`;
    for (const name of [...this.mcpServer.tools.keys()]) {
      if (name.startsWith(prefix)) this.mcpServer.tools.delete(name);
    }
  }

  _countRemoteTools(serverName) {
    if (!this.mcpServer?.tools) return 0;
    const prefix = `remote-mcp.${serverName}.`;
    let n = 0;
    for (const name of this.mcpServer.tools.keys()) {
      if (name.startsWith(prefix)) n++;
    }
    return n;
  }

  /** defaultWorkflows + AI 助手 mergeWorkflows（含群覆盖） */
  async _collectSelectedRemoteMcpNames() {
    const lists = [getAiWorkflowConfigOptional()?.mcp?.defaultWorkflows];
    try {
      const cm = globalThis.Bot?.ConfigManager || globalThis.ConfigManager;
      const inst = cm?.get?.('ai_config')
        || cm?.get?.('system-plugin_ai_config')
        || (typeof cm?.getAll === 'function'
          ? [...cm.getAll()].find(([k]) => k === 'ai_config' || String(k).endsWith('_ai_config') || String(k).endsWith('/ai_config'))?.[1]
          : null);
      if (inst?.read) {
        const data = await inst.read(false);
        lists.push(data?.mergeWorkflows);
        for (const row of Array.isArray(data?.groupOverrides) ? data.groupOverrides : []) {
          lists.push(row?.mergeWorkflows);
        }
      }
    } catch (e) {
      Bot.makeLog('debug', `读取 AI 助手勾选失败: ${e?.message || e}`, 'AiWorkflowLoader');
    }
    return this._remoteServerNamesFromToolStreams(lists.flatMap((x) => normalizeStringArray(x)));
  }

  /** 挂载尚未启动的远程 MCP（不卸载） */
  async _mountWantedRemoteServers(wanted) {
    if (!wanted?.size) return;
    if (!this.mcpServer) this.mcpServer = new MCPServer();
    for (const name of wanted) {
      if (this.remoteMCPServers.has(name)) continue;
      try {
        await this._mountRemoteMCP(name);
        Bot.makeLog('info', `远程 MCP[${name}] 已挂载（${this._countRemoteTools(name)} 工具）`, 'AiWorkflowLoader');
      } catch (e) {
        Bot.makeLog('error', `远程 MCP[${name}] 挂载失败: ${e.message}`, 'AiWorkflowLoader');
      }
    }
  }

  /**
   * 按配置勾选同步远程 MCP（启动 / config:write）
   */
  async syncSelectedRemoteMCP() {
    if (this._syncRemoteMcpPromise) return this._syncRemoteMcpPromise;
    this._syncRemoteMcpPromise = this._syncSelectedRemoteMCPInner().finally(() => {
      this._syncRemoteMcpPromise = null;
    });
    return this._syncRemoteMcpPromise;
  }

  async _syncSelectedRemoteMCPInner() {
    if (getAiWorkflowConfigOptional().mcp?.enabled === false) {
      for (const name of [...this.remoteMCPServers.keys()]) this._purgeRemoteTools(name);
      this._disposeRemoteMCPServers();
      return;
    }

    const wanted = await this._collectSelectedRemoteMcpNames();
    for (const name of [...this.remoteMCPServers.keys()]) {
      if (wanted.has(name)) continue;
      this._purgeRemoteTools(name);
      this._disposeRemoteMCPServer(name);
      Bot.makeLog('info', `远程 MCP[${name}] 已卸载（未勾选）`, 'AiWorkflowLoader');
    }
    if (!wanted.size) return;
    Bot.makeLog('info', `远程 MCP 同步: [${[...wanted].join(', ')}]`, 'AiWorkflowLoader');
    await this._mountWantedRemoteServers(wanted);
  }

  /**
   * 解析 mcp.remote.mcpServers JSON 块为 { name, cfg }[]
   * 支持 mcpServers 包装 / name+command / 裸 command（名从包名推断）
   * @private
   */
  _parseRemoteMCPServerEntries() {
    const remoteConfig = getAiWorkflowConfigOptional().mcp?.remote || {};
    const blocks = Array.isArray(remoteConfig.mcpServers) ? remoteConfig.mcpServers : [];
    if (!blocks.length) return [];

    const merged = {};
    const put = (name, cfg) => {
      const n = String(name || '').trim();
      if (!n || !cfg || typeof cfg !== 'object') return;
      if (!cfg.command && !cfg.url) return;
      merged[n] = cfg;
    };

    const inferName = (cfg, index) => {
      if (cfg.name != null && String(cfg.name).trim()) return String(cfg.name).trim();
      const args = Array.isArray(cfg.args) ? cfg.args : [];
      const pkg = args.find((a) => typeof a === 'string' && a.trim() && !a.startsWith('-'));
      if (pkg) {
        return String(pkg)
          .replace(/@latest$/i, '')
          .replace(/^@/, '')
          .replace(/[^\w.\u4e00-\u9fa5-]+/g, '_')
          .slice(0, 64) || `mcp-${index + 1}`;
      }
      return `mcp-${index + 1}`;
    };

    const mergeObj = (obj, index) => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      const map = obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)
        ? obj.mcpServers
        : null;
      if (map) {
        for (const [name, serverCfg] of Object.entries(map)) put(name, serverCfg);
        return;
      }
      if (obj.command || obj.url) put(inferName(obj, index), obj);
    };

    blocks.forEach((block, index) => {
      let obj = block?.config ?? block;
      if (typeof obj === 'string') obj = tryParseJson(obj);
      mergeObj(obj, index);
    });

    return Object.entries(merged).map(([name, cfg]) => ({ name, cfg }));
  }

  /** 从工具流白名单提取 remote-mcp.<server> 名 */
  _remoteServerNamesFromToolStreams(streamNames = []) {
    const out = new Set();
    for (const raw of streamNames) {
      const s = String(raw || '').trim();
      if (!s.startsWith('remote-mcp.')) continue;
      const server = s.slice('remote-mcp.'.length).split('.')[0];
      if (server) out.add(server);
    }
    return out;
  }

  /** HTTP 临时白名单补挂（不卸载） */
  async ensureRemoteMCPServers(streamNames = []) {
    if (getAiWorkflowConfigOptional().mcp?.enabled === false) return;
    await this._mountWantedRemoteServers(this._remoteServerNamesFromToolStreams(streamNames));
  }

  /** @private */
  async _mountRemoteMCP(name) {
    const builtin = this.builtinMcpServers.get(name);
    if (builtin) {
      if (builtin.command) await this._registerStdioMCP(name, builtin);
      else if (builtin.url) await this._registerHttpMCP(name, builtin);
      else throw new Error('内置 MCP 缺少 command/url');
      return;
    }

    const entry = this._parseRemoteMCPServerEntries().find((e) => e.name === name);
    if (!entry) throw new Error('配置中未找到该远程 MCP（检查 JSON 是否含 command/url，或使用 mcpServers 包装）');
    if (entry.cfg.command) await this._registerStdioMCP(name, entry.cfg);
    else if (entry.cfg.url) await this._registerHttpMCP(name, entry.cfg);
    else throw new Error('远程 MCP 缺少 command/url');
  }

  _resolveRemoteEnv(config = {}) {
    if (config.env && typeof config.env === 'object') return config.env;
    if (config.values && typeof config.values === 'object') return config.values;
    return {};
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
   * 注册 stdio MCP：await initialize → tools/list 后再返回（否则首轮对话看不到工具）
   */
  async _registerStdioMCP(serverName, config) {
    const { spawn } = await import('child_process');
    const command = this._resolveStdioCommand(config);
    if (!command) throw new Error('缺少 command');
    const args = this._resolveStdioArgs(config);
    const env = { ...process.env, ...this._resolveRemoteEnv(config) };
    const cwd = typeof config.cwd === 'string' && config.cwd.trim() ? config.cwd.trim() : process.cwd();
    // Windows 下 npx/npm 常为 .cmd，裸 spawn 会 ENOENT
    const needShell = typeof config.shell === 'boolean'
      ? config.shell
      : (process.platform === 'win32'
        && /^(npx|npm|pnpm|yarn)(\.cmd)?$/i.test(String(command).trim()));

    this._disposeRemoteMCPServer(serverName);

    Bot.makeLog('info', `启动 stdio MCP[${serverName}]: ${command} ${args.join(' ')}`, 'AiWorkflowLoader');
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        shell: needShell,
        windowsHide: true,
        cwd
      });
    } catch (error) {
      const msg = error?.code === 'ENOENT'
        ? `未找到命令 "${command}"，请先安装或检查 PATH`
        : error.message;
      const err = new Error(msg);
      err.code = error?.code;
      throw err;
    }

    const entry = { type: 'stdio', process: child, config };
    this.remoteMCPServers.set(serverName, entry);
    this._ensureStdioClient(serverName, entry);

    const cmdLower = String(command).toLowerCase();
    const initTimeoutMs = /npx(\.cmd)?$/i.test(cmdLower) || cmdLower.endsWith('\\npx') || cmdLower.endsWith('/npx')
      ? 90000
      : 15000;

    try {
      await this._stdioRequest(serverName, entry, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'xrk-yunzai', version: '3.1.3' }
      }, { timeoutMs: initTimeoutMs });

      try {
        child.stdin.write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized'
        }) + '\n');
      } catch { /* ignore */ }

      const listResult = await this._stdioRequest(serverName, entry, 'tools/list', {}, { timeoutMs: 30000 });
      if (listResult?.tools) this._registerRemoteTools(serverName, listResult.tools);
    } catch (error) {
      this._disposeRemoteMCPServer(serverName);
      throw error;
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
      if (tools.length > 0) Bot.makeLog('info', `已从 HTTP MCP[${serverName}] 注册 ${tools.length} 个工具`, 'AiWorkflowLoader');
    } catch (e) {
      Bot.makeLog('error', `注册 HTTP MCP[${serverName}] 失败: ${e.message}`, 'AiWorkflowLoader');
      throw e;
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
      Bot.makeLog('info', `已从 stdio MCP[${serverName}] 注册 ${names.length} 个工具`, 'AiWorkflowLoader');
    }
  }

  _safeStr(x) {
    if (x == null) return '';
    if (typeof x === 'string') return x;
    try { return JSON.stringify(x); } catch (err) {
      Bot.makeLog('debug', `[AiWorkflowLoader] JSON.stringify 失败: ${err?.message || err}`, 'AiWorkflowLoader');
      return String(x);
    }
  }

  _normalizeRemoteMCPResult(raw) {
    try {
      if (raw == null) return { success: false, error: '远程MCP返回空' };
      const c0 = raw?.content?.[0];
      let text = typeof c0 === 'string' ? c0 : (c0?.text ?? c0?.value ?? c0?.content);
      if (typeof text !== 'string' || !text.trim()) {
        if (typeof raw.text === 'string' && raw.text.trim()) text = raw.text;
        else if (Array.isArray(raw.content) && raw.content.length > 0) {
          text = raw.content.map(c => (typeof c === 'string' ? c : (c?.text ?? c?.value ?? c?.content ?? this._safeStr(c)))).filter(Boolean).join('\n');
        }
      }
      if (typeof text === 'string' && text.trim()) return { success: true, raw: text };
      const fallback = this._safeStr(raw);
      return fallback ? { success: true, raw: fallback } : { success: false, error: '远程MCP返回空结果' };
    } catch (e) {
      return { success: false, error: String(e?.message || e) };
    }
  }

  async _callRemoteTool(serverName, toolName, args) {
    const server = this.remoteMCPServers.get(serverName);
    if (!server) return { success: false, error: `MCP服务器 ${serverName} 未找到` };

    if (server.type === 'stdio') {
      try {
        const result = await this._stdioRequest(
          serverName,
          server,
          'tools/call',
          { name: toolName, arguments: args || {} },
          { timeoutMs: 30000 }
        );
        return this._normalizeRemoteMCPResult(result);
      } catch (e) {
        return { success: false, error: e?.message || String(e) };
      }
    }

    if (server.type === 'http') {
      try {
        const request = {
          jsonrpc: '2.0',
          id: this._makeRemoteRequestId(),
          method: 'tools/call',
          params: { name: toolName, arguments: args || {} }
        };
        const url = (server.url || '').replace(/\/+$/, '') + '/api/mcp/jsonrpc';
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(server.headers || {}) },
          body: JSON.stringify(request)
        });
        const data = await res.json();
        if (data.error) return { success: false, error: data.error.message || '未知错误' };
        return this._normalizeRemoteMCPResult(data.result);
      } catch (e) {
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
  mergeWorkflows(options = {}) {
    const {
      name,
      main,
      secondary = [],
      prefixSecondary = true,
      description
    } = options;

    if (!main || !Array.isArray(secondary) || secondary.length === 0) {
      Bot.makeLog('warn', 'mergeWorkflows 需要主工作流和至少一个副工作流', 'AiWorkflowLoader');
      return null;
    }

    const mainStream = this.getWorkflow(main);
    if (!mainStream) {
      Bot.makeLog('error', `主工作流未找到: ${main}`, 'AiWorkflowLoader');
      return null;
    }

    const secondaryStreams = secondary
      .map(n => {
        const stream = this.getWorkflow(n);
        if (!stream) {
          Bot.makeLog('warn', `[AiWorkflowLoader] 副工作流未找到: ${n}`, 'AiWorkflowLoader');
        }
        return stream;
      })
      .filter(Boolean);

    if (secondaryStreams.length === 0) {
      Bot.makeLog('warn', `[AiWorkflowLoader] 未找到有效的副工作流，请求的副工作流: [${secondary.join(', ')}]`, 'AiWorkflowLoader');
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
    const totalFunctions = this.getAllWorkflows().reduce(
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
    Bot.makeLog('info', '🧹 清理资源...', 'AiWorkflowLoader');

    if (this._onConfigWrite) {
      this._unbindRemoteMcpConfigEvents();
    }

    await this.watch(false);
    
    for (const stream of this.streams.values()) {
      if (typeof stream.cleanup === 'function') {
        await stream.cleanup().catch((err) => {
          Bot.makeLog('debug', `[AiWorkflowLoader] 工作流 cleanup 失败: ${err?.message || err}`, 'AiWorkflowLoader');
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

    Bot.makeLog('success', '✅ 清理完成', 'AiWorkflowLoader');
  }

  /**
   * 可供勾选的远程 MCP 服务器名（声明 + 已挂 + 内置）
   */
  listRemoteMCPServers() {
    const names = new Set([
      ...this.builtinMcpServers.keys(),
      ...this.remoteMCPServers.keys(),
      ...this._parseRemoteMCPServerEntries().map((s) => s.name)
    ]);
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  /** 工具流白名单 key：remote-mcp.<server> */
  listRemoteMcpWorkflowKeys() {
    return this.listRemoteMCPServers().map((n) => `remote-mcp.${n}`);
  }
}

export default new AiWorkflowLoader();