import path from 'path';
import fs from 'fs/promises';
import HttpApi from './http.js';
import BotUtil from '../util.js';
import { FileUtils } from '../utils/file-utils.js';
import { ObjectUtils } from '../utils/object-utils.js';
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
    
    // 获取所有 API 目录（兼容多种目录结构）
    const apiDirs = await this._getApiDirs();
    
    // 加载每个API目录
    for (const apiDir of apiDirs) {
      const files = await this.getApiFiles(apiDir);
      for (const file of files) {
        await this.loadApi(file);
      }
    }
    
    // 按优先级排序
    this.sortByPriority();
    
    this.loaded = true;
    const loadTime = Date.now() - startTime;
    BotUtil.makeLog('info', `API模块加载完成: ${this.apis.size}个, 耗时${loadTime}ms`, 'ApiLoader');
    
    return this.apis;
  }

  /**
   * 获取所有API目录
   * @private
   * @returns {Promise<Array<string>>}
   */
  async _getApiDirs() {
    const dirs = [];
    const cwd = process.cwd();
    
    // 仅从 plugins/<插件根>/http 业务层目录加载 API
    const pluginsDir = path.join(cwd, 'plugins');
    if (FileUtils.existsSync(pluginsDir)) {
      try {
        const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.')) continue;

          const apiDir = path.join(pluginsDir, entry.name, 'http');
          if (FileUtils.existsSync(apiDir)) {
            dirs.push(apiDir);
          }
        }
      } catch (err) {
        BotUtil.makeLog('warn', '扫描插件 http 目录失败', 'ApiLoader', err);
      }
    }

    return dirs;
  }

  /**
   * 获取API文件列表
   * @param {string} dir - 目录路径
   * @returns {Promise<Array>} 文件路径数组
   */
  async getApiFiles(dir) {
    return await FileLoader.readFiles(dir, {
      ext: '.js',
      recursive: true,
      ignore: ['.', '_']
    });
  }
  
  /**
   * 加载单个API文件
   * @param {string} filePath - 文件路径
   * @returns {Promise<boolean>} 是否成功
   */
  async loadApi(filePath) {
    try {
      const key = await this.getApiKey(filePath);
      
      // 如果已加载，先卸载
      if (this.apis.has(key)) {
        await this.unloadApi(key);
      }
      
      // 动态导入模块（Windows兼容：file://协议需要正确的路径格式）
      const normalizedPath = filePath.replace(/\\/g, '/');
      const isWindows = process.platform === 'win32';
      let fileUrl;
      if (isWindows) {
        // Windows: file:///C:/path/to/file
        const driveLetter = normalizedPath.match(/^([A-Za-z]:)/);
        if (driveLetter) {
          const pathWithoutDrive = normalizedPath.substring(driveLetter[0].length);
          const encodedPath = encodeURI(pathWithoutDrive).replace(/#/g, '%23');
          fileUrl = `file:///${driveLetter[0].toLowerCase()}${encodedPath}?t=${Date.now()}`;
        } else {
          const encodedPath = encodeURI(normalizedPath).replace(/#/g, '%23');
          fileUrl = `file:///${encodedPath}?t=${Date.now()}`;
        }
      } else {
        // Unix: file:///path/to/file
        const encodedPath = encodeURI(normalizedPath).replace(/#/g, '%23');
        fileUrl = `file://${encodedPath}?t=${Date.now()}`;
      }
      const module = await import(fileUrl);
      
      // 检查是否是有效的API模块
      if (!module.default) {
        BotUtil.makeLog('warn', `无效的API模块: ${key} (缺少default导出)`, 'ApiLoader');
        return false;
      }
      
      let apiInstance;
      
      // 支持类和对象两种导出方式
      if (ObjectUtils.isFunction(module.default)) {
        apiInstance = new module.default();
      } else if (ObjectUtils.isPlainObject(module.default)) {
        apiInstance = new HttpApi(module.default);
      } else {
        BotUtil.makeLog('warn', `无效的API模块: ${key} (导出类型错误)`, 'ApiLoader');
        return false;
      }
      
      // 验证和标准化API实例
      if (!validateApiInstance(apiInstance, key)) {
        return false;
      }
      
      // 确保有getInfo方法
      if (!ObjectUtils.isFunction(apiInstance.getInfo)) {
        apiInstance.getInfo = function() {
          return {
            name: this.name || key,
            dsc: this.dsc || '暂无描述',
            priority: getApiPriority(this),
            routes: this.routes ? this.routes.length : 0,
            enable: this.enable !== false,
            createTime: this.createTime || Date.now()
          };
        };
      }
      
      // 设置API的key和文件路径
      apiInstance.key = key;
      apiInstance.filePath = filePath;
      
      // 存储API实例
      this.apis.set(key, apiInstance);
      
      BotUtil.makeLog('debug', `加载API模块: ${apiInstance.name || key}`, 'ApiLoader');
      return true;
    } catch (error) {
      BotUtil.makeLog('error', `加载API失败: ${filePath}`, 'ApiLoader', error);
      return false;
    }
  }
  
  /**
   * 计算API的key（从文件路径）
   * @param {string} filePath - 文件路径
   * @returns {Promise<string>} API key
   */
  async getApiKey(filePath) {
    const normalizedPath = path.normalize(filePath);
    const cwd = process.cwd();
    
    // 从 plugins/<插件根>/http 计算相对路径: <plugin>/<subpath>
    const pluginsDir = path.join(cwd, 'plugins');
    if (normalizedPath.startsWith(pluginsDir)) {
      const relativeToPlugins = path.relative(pluginsDir, normalizedPath);
      const [pluginName, ...rest] = relativeToPlugins.split(path.sep);
      if (pluginName && rest.length > 0) {
        const subPath = rest.join(path.sep).replace(/\\/g, '/').replace(/\.js$/, '');
        return `${pluginName}/${subPath}`;
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
    
    BotUtil.makeLog('info', '开始注册API路由', 'ApiLoader');
    
    // 全局中间件
    app.use((req, res, next) => {
      req.bot = bot;
      req.apiLoader = this;
      next();
    });
    
    // 按优先级顺序初始化 API
    for (const api of this.priority) {
      const apiName = api.name || api.key || 'unknown';
      const apiPriority = getApiPriority(api);
      
      try {
        const routeCount = api.routes ? api.routes.length : 0;
        const wsCount = api.wsHandlers ? Object.keys(api.wsHandlers).length : 0;
        
        if (api.init) {
          await api.init(app, bot);
        }
        
        if (routeCount > 0 || wsCount > 0) {
          BotUtil.makeLog('info', `注册API: ${apiName} (优先级: ${apiPriority}, 路由: ${routeCount}, WS: ${wsCount})`, 'ApiLoader');
        }
      } catch (error) {
        BotUtil.makeLog('error', `注册API失败: ${apiName} - ${error.message}`, 'ApiLoader', error);
        // 继续处理下一个API，不中断整个注册过程
      }
    }
    
    // 404处理（排除代理路由，避免拦截 /api/god/*）
    app.use('/api/*', (req, res, next) => {
      // 跳过代理路由，让代理中间件处理
      if (req.path.startsWith('/api/god/')) {
        return next();
      }
      
      if (!res.headersSent) {
        res.status(404).json({
          success: false,
          message: 'API endpoint not found',
          path: req.originalUrl,
          timestamp: Date.now()
        });
      }
    });
    
    BotUtil.makeLog('info', 'API注册完成', 'ApiLoader');
  }
  
  /**
   * 重载API
   * @param {string} key - API键名
   */
  async changeApi(key) {
    const api = this.apis.get(key);
    if (!api || !api.filePath) {
      BotUtil.makeLog('warn', `API不存在: ${key}`, 'ApiLoader');
      // 如果API不存在但文件存在，尝试直接加载
      const apiDirs = await this._getApiDirs();
      for (const apiDir of apiDirs) {
        const files = await this.getApiFiles(apiDir);
        const file = files.find(f => {
          const fileKey = path.relative(apiDir, f).replace(/\\/g, '/').replace(/\.js$/, '');
          return fileKey === key || path.basename(f, '.js') === key;
        });
        if (file) {
          BotUtil.makeLog('debug', `尝试重新加载API: ${key}`, 'ApiLoader');
          await this.loadApi(file);
          this.sortByPriority();
          const newApi = this.apis.get(await this.getApiKey(file));
          if (newApi?.init && this.app && this.bot) {
            await newApi.init(this.app, this.bot);
          }
          return true;
        }
      }
      return false;
    }
    
    try {
      BotUtil.makeLog('debug', `重载API: ${api.name || key}`, 'ApiLoader');
      
      // 保存文件路径
      const filePath = api.filePath;
      
      // 先卸载
      await this.unloadApi(key);
      
      // 重新加载文件
      await this.loadApi(filePath);
      
      // 重新排序
      this.sortByPriority();
      
      // 重新初始化
      const newApi = this.apis.get(key);
      if (newApi && this.app && this.bot && typeof newApi.init === 'function') {
        await newApi.init(this.app, this.bot);
      }
      
      BotUtil.makeLog('info', `API重载成功: ${api.name || key}`, 'ApiLoader');
      return true;
    } catch (error) {
      BotUtil.makeLog('error', `API重载失败: ${api.name || key}`, 'ApiLoader', error);
      return false;
    }
  }
  
  /**
   * 获取API列表
   * @returns {Array} API信息数组
   */
  getApiList() {
    const apiList = [];
    
    for (const api of this.apis.values()) {
      if (!api) continue;

      // 约定：所有放入 apis 的实例要么实现 getInfo，要么至少具备基础字段
      if (typeof api.getInfo === 'function') {
        apiList.push(api.getInfo());
        continue;
      }

      apiList.push({
        name: api.name || api.key || 'undefined',
        dsc: api.dsc || '暂无描述',
        priority: api.priority || 100,
        routes: Array.isArray(api.routes) ? api.routes.length : 0,
        enable: api.enable !== false,
        createTime: api.createTime || Date.now()
      });
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
          const fileName = path.basename(filePath);
          BotUtil.makeLog('debug', `检测到新文件: ${fileName}`, 'ApiLoader');
          const key = await this.getApiKey(filePath);
          await this.loadApi(filePath);
          this.sortByPriority();
          
          if (this.app && this.bot) {
            const api = this.apis.get(key);
            if (api?.init) {
              await api.init(this.app, this.bot);
            }
          }
        },
        onChange: async (filePath) => {
          const key = await this.getApiKey(filePath);
          BotUtil.makeLog('debug', `检测到文件变更: ${key}`, 'ApiLoader');
          await this.changeApi(key);
        },
        onUnlink: async (filePath) => {
          const key = await this.getApiKey(filePath);
          BotUtil.makeLog('debug', `检测到文件删除: ${key}`, 'ApiLoader');
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