import path from 'path';
import { pathToFileURL } from 'url';
import fs from 'fs/promises';
import HttpApi from './http.js';
import BotUtil from '../util.js';
import { FileUtils } from '../utils/file-utils.js';
import { FileLoader } from '../utils/file-loader.js';
import { validateApiInstance, getApiPriority } from './utils/helpers.js';

/**
 * API加载器类
 * 负责加载、管理和调度所有API模块
 */
class ApiLoader {
  constructor() {
    /** 所有API实例 */
    this.apis = new Map();
    
    /** 按优先级排序的API列表 */
    this.priority = [];
    
    /** API文件监视器 */
    this.watcher = {};
    
    /** 加载状态 */
    this.loaded = false;
    
    /** Express应用实例 */
    this.app = null;
    
    /** Bot实例 */
    this.bot = null;
  }
  
  /**
   * 加载所有API模块
   * @returns {Promise<Map>} API集合
   */
  async load() {
    const startTime = Date.now();
    BotUtil.makeLog('info', '开始加载API模块...', 'ApiLoader');
    
    const apiDirs = await this._getApiDirs();
    let successCount = 0;
    let failCount = 0;
    
    // 加载每个API目录中的文件
    for (const apiDir of apiDirs) {
      const files = await this.getApiFiles(apiDir);
      for (const file of files) {
        const success = await this.loadApi(file);
        if (success) {
          successCount++;
        } else {
          failCount++;
        }
      }
    }
    
    // 按优先级排序
    this.sortByPriority();
    
    this.loaded = true;
    const loadTime = Date.now() - startTime;
    BotUtil.makeLog('info', `API模块加载完成: 成功${successCount}个, 失败${failCount}个, 总计${this.apis.size}个, 耗时${loadTime}ms`, 'ApiLoader');
    
    return this.apis;
  }

  /**
   * 获取所有API目录
   * @private
   * @returns {Promise<Array<string>>} API目录路径数组（已规范化）
   */
  async _getApiDirs() {
    const dirs = [];
    const cwd = path.resolve(process.cwd());
    const pluginsDir = path.resolve(cwd, 'plugins');
    
    if (!FileUtils.existsSync(pluginsDir)) {
      BotUtil.makeLog('debug', `plugins目录不存在: ${pluginsDir}`, 'ApiLoader');
      return dirs;
    }
    
    try {
      const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

        const apiDir = path.resolve(pluginsDir, entry.name, 'http');
        if (FileUtils.existsSync(apiDir)) {
          dirs.push(apiDir);
          BotUtil.makeLog('debug', `发现API目录: ${entry.name}/http`, 'ApiLoader');
        }
      }
    } catch (err) {
      BotUtil.makeLog('error', `扫描插件 http 目录失败: ${err.message}`, 'ApiLoader', err);
    }

    BotUtil.makeLog('info', `扫描完成: 找到 ${dirs.length} 个API目录`, 'ApiLoader');
    return dirs;
  }

  /**
   * 获取API文件列表
   * @param {string} dir - 目录路径
   * @returns {Promise<Array<string>>} 文件路径数组（已规范化）
   */
  async getApiFiles(dir) {
    const normalizedDir = path.resolve(dir);
    const files = await FileLoader.readFiles(normalizedDir, {
      ext: '.js',
      recursive: true,
      ignore: ['.', '_']
    });
    
    // 规范化所有文件路径，确保跨平台兼容
    const normalizedFiles = files.map(f => path.resolve(f));
    BotUtil.makeLog('debug', `从目录 ${path.basename(normalizedDir)} 找到 ${normalizedFiles.length} 个API文件`, 'ApiLoader');
    return normalizedFiles;
  }
  /**
   * 加载单个API文件
   * @param {string} filePath - 文件路径
   * @returns {Promise<boolean>} 是否成功
   */
  async loadApi(filePath) {
    const normalizedPath = path.resolve(filePath);
    let key = null;
    
    try {
      key = await this.getApiKey(normalizedPath);
      
      // 如果已加载，先卸载
      if (this.apis.has(key)) {
        BotUtil.makeLog('debug', `API已存在，先卸载: ${key}`, 'ApiLoader');
        await this.unloadApi(key);
      }
      
      // 使用 file:// URL 导入，确保跨平台兼容
      const fileUrl = `${pathToFileURL(normalizedPath).href}?t=${Date.now()}`;
      BotUtil.makeLog('debug', `导入API模块: key=${key}, path=${normalizedPath}`, 'ApiLoader');
      const module = await import(fileUrl);
      
      // 验证模块导出
      if (!module.default) {
        BotUtil.makeLog('warn', `无效的API模块: ${key} (缺少default导出)`, 'ApiLoader');
        return false;
      }
      
      // 创建API实例
      let apiInstance;
      const def = module.default;
      if (typeof def === 'function') {
        apiInstance = new def();
      } else if (def && typeof def === 'object' && !Array.isArray(def)) {
        apiInstance = new HttpApi(def);
      } else {
        BotUtil.makeLog('warn', `无效的API模块: ${key} (导出类型错误，期望函数或对象)`, 'ApiLoader');
        return false;
      }
      
      // 验证API实例
      if (!validateApiInstance(apiInstance, key)) {
        BotUtil.makeLog('warn', `API实例验证失败: ${key}`, 'ApiLoader');
        return false;
      }
      
      // 确保 getInfo 方法存在
      if (typeof apiInstance.getInfo !== 'function') {
        apiInstance.getInfo = function() {
          return {
            name: this.name || key,
            dsc: this.dsc || '暂无描述',
            priority: getApiPriority(this),
            routes: Array.isArray(this.routes) ? this.routes.length : 0,
            enable: this.enable !== false,
            createTime: this.createTime || Date.now()
          };
        };
      }
      
      // 保存元数据
      apiInstance.key = key;
      apiInstance.filePath = normalizedPath; // 保存规范化后的路径
      this.apis.set(key, apiInstance);
      
      BotUtil.makeLog('info', `API加载成功: ${apiInstance.name || key} (路由: ${Array.isArray(apiInstance.routes) ? apiInstance.routes.length : 0})`, 'ApiLoader');
      return true;
    } catch (error) {
      const errorKey = key || path.basename(filePath, '.js');
      const errorMsg = error.message || String(error);
      const errorStack = error.stack ? `\n${error.stack}` : '';
      BotUtil.makeLog('error', `加载API失败: ${errorKey} - ${errorMsg}${errorStack}`, 'ApiLoader');
      return false;
    }
  }
  
  /**
   * 计算API的key（从文件路径）
   * 统一使用 path.resolve 和 path.relative 处理路径，确保跨平台兼容
   * @param {string} filePath - 文件路径
   * @returns {Promise<string>} API key，格式: <plugin>/<subpath>
   */
  async getApiKey(filePath) {
    const normalizedPath = path.resolve(filePath);
    const cwd = path.resolve(process.cwd());
    const pluginsDir = path.resolve(cwd, 'plugins');
    
    // 从 plugins/<插件根>/http 计算相对路径
    if (normalizedPath.startsWith(pluginsDir)) {
      const relativeToPlugins = path.relative(pluginsDir, normalizedPath);
      const parts = relativeToPlugins.split(path.sep).filter(Boolean);
      
      if (parts.length >= 2) {
        const pluginName = parts[0];
        // 查找 'http' 目录位置，取后面的路径
        const httpIndex = parts.indexOf('http');
        const subParts = httpIndex !== -1 && parts.length > httpIndex + 1
          ? parts.slice(httpIndex + 1)
          : parts.slice(1);
        
        if (subParts.length > 0) {
          // 统一使用正斜杠作为分隔符（URL 风格），移除 .js 扩展名
          const subPath = subParts.join('/').replace(/\.js$/, '');
          return `${pluginName}/${subPath}`;
        }
      }
    }

    // 回退：使用文件名作为 key
    return path.basename(filePath, '.js');
  }

  /**
   * 卸载API
   * @param {string} key - API键名
   */
  async unloadApi(key) {
    const api = this.apis.get(key);
    if (!api) return;
    
    // 调用停止方法
    if (api.stop) {
      api.stop();
    }
    
    // 从集合中删除
    this.apis.delete(key);
    
    BotUtil.makeLog('debug', `卸载API: ${api.name || key}`, 'ApiLoader');
  }
  
  /**
   * 按优先级排序
   */
  sortByPriority() {
    this.priority = Array.from(this.apis.values())
      // 仅保留显式启用的 API，其他一律按约定视为合法 HttpApi 实例
      .filter(api => api && api.enable !== false)
      // 降序：优先级高的在前
      .sort((a, b) => getApiPriority(b) - getApiPriority(a));
  }
  
  /**
   * 注册所有API到Express应用
   * @param {Object} app - Express应用实例
   * @param {Object} bot - Bot实例
   */
  async register(app, bot) {
    this.app = app;
    this.bot = bot;
    
    BotUtil.makeLog('info', `开始注册API路由 (共${this.priority.length}个API)`, 'ApiLoader');
    
    // 全局中间件：注入 bot 和 apiLoader
    app.use((req, res, next) => {
      req.bot = bot;
      req.apiLoader = this;
      next();
    });
    
    // 按优先级顺序初始化 API
    let registeredCount = 0;
    let failedCount = 0;
    const totalRoutes = [];
    
    for (const api of this.priority) {
      const apiName = api.name || api.key || 'unknown';
      const apiPriority = getApiPriority(api);
      const routeCount = Array.isArray(api.routes) ? api.routes.length : 0;
      const wsCount = api.wsHandlers ? Object.keys(api.wsHandlers).length : 0;
      
      try {
        // HttpApi 类总是有 init 方法，确保调用
        if (typeof api.init === 'function') {
          await api.init(app, bot);
          registeredCount++;
          totalRoutes.push(...(api.routes || []).map(r => `${r.method} ${r.path}`));
          BotUtil.makeLog('info', `注册API: ${apiName} (优先级: ${apiPriority}, 路由: ${routeCount}, WS: ${wsCount})`, 'ApiLoader');
        } else {
          BotUtil.makeLog('warn', `API缺少init方法，跳过: ${apiName}`, 'ApiLoader');
          failedCount++;
        }
      } catch (error) {
        failedCount++;
        const errorMsg = error.message || String(error);
        const errorStack = error.stack ? `\n${error.stack}` : '';
        BotUtil.makeLog('error', `注册API失败: ${apiName} - ${errorMsg}${errorStack}`, 'ApiLoader');
      }
    }
    
    // 404 处理：未匹配的路由
    app.use('/api/*', (req, res, next) => {
      if (req.path.startsWith('/api/god/')) return next();
      if (!res.headersSent) {
        BotUtil.makeLog('warn', `API 404: ${req.method} ${req.originalUrl}`, 'ApiLoader');
        res.status(404).json({
          success: false,
          message: 'API endpoint not found',
          path: req.originalUrl,
          timestamp: Date.now()
        });
      }
    });
    
    BotUtil.makeLog('info', `API注册完成: 成功${registeredCount}个, 失败${failedCount}个, 总路由数${totalRoutes.length}`, 'ApiLoader');
  }
  
  /**
   * 重载API
   * @param {string} key - API键名
   */
  /**
   * 重载API
   * @param {string} key - API键名
   * @returns {Promise<boolean>} 是否成功
   */
  async changeApi(key) {
    const api = this.apis.get(key);
    
    // 如果API不存在，尝试从文件系统重新加载
    if (!api || !api.filePath) {
      BotUtil.makeLog('warn', `API不存在，尝试从文件系统加载: ${key}`, 'ApiLoader');
      const apiDirs = await this._getApiDirs();
      
      for (const apiDir of apiDirs) {
        const files = await this.getApiFiles(apiDir);
        // 使用 getApiKey 统一计算 key，确保跨平台兼容
        for (const file of files) {
          const fileKey = await this.getApiKey(file);
          if (fileKey === key || path.basename(file, '.js') === key) {
            BotUtil.makeLog('debug', `找到API文件，重新加载: ${key} -> ${file}`, 'ApiLoader');
            await this.loadApi(file);
            this.sortByPriority();
            
            const newApi = this.apis.get(await this.getApiKey(file));
            if (newApi && typeof newApi.init === 'function' && this.app && this.bot) {
              await newApi.init(this.app, this.bot);
            }
            return true;
          }
        }
      }
      
      BotUtil.makeLog('error', `无法找到API文件: ${key}`, 'ApiLoader');
      return false;
    }
    
    // 重载已存在的API
    try {
      const apiName = api.name || key;
      BotUtil.makeLog('info', `开始重载API: ${apiName}`, 'ApiLoader');
      
      const filePath = path.resolve(api.filePath);
      
      // 卸载 -> 重新加载 -> 重新排序 -> 重新初始化
      await this.unloadApi(key);
      await this.loadApi(filePath);
      this.sortByPriority();
      
      const newApi = this.apis.get(key);
      if (newApi && typeof newApi.init === 'function' && this.app && this.bot) {
        await newApi.init(this.app, this.bot);
        BotUtil.makeLog('info', `API重载成功: ${apiName}`, 'ApiLoader');
      } else {
        BotUtil.makeLog('warn', `API重载完成但未初始化: ${apiName}`, 'ApiLoader');
      }
      
      return true;
    } catch (error) {
      BotUtil.makeLog('error', `API重载失败: ${api.name || key} - ${error.message}`, 'ApiLoader', error);
      return false;
    }
  }
  
  /**
   * 获取API列表
   * @returns {Array<Object>} API信息数组
   */
  getApiList() {
    const apiList = [];
    
    for (const api of this.apis.values()) {
      if (!api) continue;

      // 统一使用 getInfo 方法获取信息
      if (typeof api.getInfo === 'function') {
        apiList.push(api.getInfo());
      } else {
        // 回退：手动构建信息对象
        apiList.push({
          name: api.name || api.key || 'undefined',
          dsc: api.dsc || '暂无描述',
          priority: api.priority || 100,
          routes: Array.isArray(api.routes) ? api.routes.length : 0,
          enable: api.enable !== false,
          createTime: api.createTime || Date.now()
        });
      }
    }
    
    return apiList;
  }
  
  /**
   * 获取API实例
   * @param {string} key - API键名
   * @returns {Object|null} API实例
   */
  getApi(key) {
    return this.apis.get(key) || null;
  }
  
  /**
   * 启用文件监视
   * @param {boolean} enable - 是否启用
   */
  async watch(enable = true) {
    if (!enable) {
      // 停止所有监视器
      for (const watcher of Object.values(this.watcher)) {
        if (watcher?.close) {
          watcher.close();
        }
      }
      this.watcher = {};
      BotUtil.makeLog('info', '文件监视已停止', 'ApiLoader');
      return;
    }
    
    try {
      const { HotReloadBase } = await import('../utils/hot-reload-base.js');
      const hotReload = new HotReloadBase({ loggerName: 'ApiLoader' });
      
      const apiDirs = await this._getApiDirs();
      if (apiDirs.length === 0) {
        BotUtil.makeLog('debug', '未找到 http 目录，跳过文件监视', 'ApiLoader');
        return;
      }

      await hotReload.watch(true, {
        dirs: apiDirs,
        onAdd: async (filePath) => {
          const normalizedPath = path.resolve(filePath);
          const fileName = path.basename(normalizedPath);
          BotUtil.makeLog('info', `检测到新API文件: ${fileName}`, 'ApiLoader');
          
          const key = await this.getApiKey(normalizedPath);
          const success = await this.loadApi(normalizedPath);
          
          if (success) {
            this.sortByPriority();
            if (this.app && this.bot) {
              const api = this.apis.get(key);
              if (api && typeof api.init === 'function') {
                await api.init(this.app, this.bot);
                BotUtil.makeLog('info', `新API已注册: ${api.name || key}`, 'ApiLoader');
              }
            }
          }
        },
        onChange: async (filePath) => {
          const normalizedPath = path.resolve(filePath);
          const key = await this.getApiKey(normalizedPath);
          BotUtil.makeLog('info', `检测到API文件变更: ${key}`, 'ApiLoader');
          await this.changeApi(key);
        },
        onUnlink: async (filePath) => {
          const normalizedPath = path.resolve(filePath);
          const key = await this.getApiKey(normalizedPath);
          BotUtil.makeLog('info', `检测到API文件删除: ${key}`, 'ApiLoader');
          await this.unloadApi(key);
          this.sortByPriority();
        }
      });

      this.watcher.api = hotReload.watcher;
      BotUtil.makeLog('info', '文件监视已启动', 'ApiLoader');
    } catch (error) {
      BotUtil.makeLog('error', '启动文件监视失败', 'ApiLoader', error);
    }
  }
}

// 导出单例
export default new ApiLoader();