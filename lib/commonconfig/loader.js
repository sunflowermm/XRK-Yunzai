import fs from 'fs/promises';
import path from 'path';
import BotUtil from '../util.js';
import { FileUtils } from '../utils/file-utils.js';
import { FileLoader } from '../utils/file-loader.js';

/**
 * 配置加载器
 * 负责加载和管理所有配置类
 */
class ConfigLoader {
  constructor() {
    /** 所有配置实例 */
    this.configs = new Map();
    
    /** 加载状态 */
    this.loaded = false;
    
    /** 配置目录路径（不再使用固定路径） */
    this.configDir = path.join(process.cwd(), 'config/commonconfig');
    
    /** 文件监视器 */
    this.watcher = null;
  }

  /**
   * 加载所有配置
   * @returns {Promise<Map>}
   */
  async load() {
    try {
      const startTime = Date.now();
      BotUtil.makeLog('info', '开始加载配置管理器...', 'ConfigLoader');

      // 获取所有配置目录（兼容多种目录结构）
      const configDirs = await this._getConfigDirs();

      // 加载每个配置目录
      for (const configDir of configDirs) {
        const files = await this._getConfigFiles(configDir);
        for (const file of files) {
          await this._loadConfig(file);
        }
      }

      this.loaded = true;
      const loadTime = Date.now() - startTime;
      
      BotUtil.makeLog('info', 
        `配置管理器加载完成: ${this.configs.size}个配置, 耗时${loadTime}ms`, 
        'ConfigLoader'
      );

      return this.configs;
    } catch (error) {
      BotUtil.makeLog('error', '配置管理器加载失败', 'ConfigLoader', error);
      throw error;
    }
  }

  /**
   * 获取所有配置目录
   * @private
   * @returns {Promise<Array<string>>}
   */
  async _getConfigDirs() {
    const dirs = [];
    const cwd = process.cwd();
    
    // 1. 默认配置目录
    if (FileUtils.existsSync(this.configDir)) {
      dirs.push(this.configDir);
    }
    
    // 2. 从 plugins/<插件根>/commonconfig 加载业务层配置
    try {
      const pluginsDir = path.join(cwd, 'plugins');
      if (FileUtils.existsSync(pluginsDir)) {
        const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.')) continue;

          const commonconfigDir = path.join(pluginsDir, entry.name, 'commonconfig');
          if (FileUtils.existsSync(commonconfigDir)) {
            dirs.push(commonconfigDir);
          }
        }
      }
    } catch (err) {
      BotUtil.makeLog('warn', '扫描插件 commonconfig 目录失败', 'ConfigLoader', err);
    }

    return dirs;
  }

  /**
   * 获取配置文件列表
   * @private
   */
  async _getConfigFiles(dir) {
    try {
      return await FileLoader.readFiles(dir, {
        ext: '.js',
        recursive: false,
        ignore: ['.', '_']
      });
    } catch (err) {
      BotUtil.makeLog('error', `读取配置目录失败: ${dir}`, 'ConfigLoader', err);
      return [];
    }
  }

  /**
   * 获取配置键名（从文件路径提取）
   * @private
   * @param {string} filePath - 文件路径
   * @returns {string} 配置键名
   */
  _getConfigKey(filePath) {
    const fileName = path.basename(filePath, '.js');
    
    // 如果是插件目录下的配置，包含插件名
    const pluginsMatch = filePath.match(/plugins[\/\\]([^\/\\]+)[\/\\]commonconfig[\/\\]/);
    if (pluginsMatch) {
      return `${pluginsMatch[1]}_${fileName}`;
    }
    
    // 默认配置目录，直接使用文件名
    return fileName;
  }

  /**
   * 加载单个配置文件
   * @private
   */
  async _loadConfig(filePath) {
    try {
      const key = this._getConfigKey(filePath);
      
      // 动态导入（兼容 Windows 路径）
      const normalizedPath = filePath.replace(/\\/g, '/');
      const isWindows = process.platform === 'win32';
      let fileUrl;
      if (isWindows) {
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
        const encodedPath = encodeURI(normalizedPath).replace(/#/g, '%23');
        fileUrl = `file://${encodedPath}?t=${Date.now()}`;
      }
      const module = await import(fileUrl);
      
      if (!module.default) {
        BotUtil.makeLog('warn', `无效的配置模块: ${key} (缺少default导出)`, 'ConfigLoader');
        return false;
      }

      let configInstance;
      
      if (typeof module.default === 'function') {
        try {
          configInstance = new module.default();
        } catch {
          BotUtil.makeLog('warn', `无法实例化配置模块: ${key}`, 'ConfigLoader');
          return false;
        }
      } else if (typeof module.default === 'object' && module.default !== null && !Array.isArray(module.default)) {
        configInstance = module.default;
      } else {
        BotUtil.makeLog('warn', `无效的配置模块: ${key} (导出类型错误)`, 'ConfigLoader');
        return false;
      }

      if (typeof configInstance.getStructure !== 'function') {
        BotUtil.makeLog('warn', `无效的配置模块: ${key} (缺少 getStructure 方法)`, 'ConfigLoader');
        return false;
      }

      // 存储配置实例（如果已存在同名配置，使用优先级更高的）
      const existing = this.configs.get(key);
      if (existing) {
        const existingPath = existing.filePath || '';
        const isPluginPath = filePath.includes('/plugins/') || filePath.includes('\\plugins\\');
        const existingIsPlugin = existingPath.includes('/plugins/') || existingPath.includes('\\plugins\\');
        
        // 优先级：插件配置 > 默认配置
        if (isPluginPath && !existingIsPlugin) {
          BotUtil.makeLog('debug', `替换配置: ${key} (插件配置优先级更高)`, 'ConfigLoader');
        } else if (!isPluginPath && existingIsPlugin) {
          BotUtil.makeLog('debug', `替换配置: ${key} (默认配置优先级更高)`, 'ConfigLoader');
        } else {
          BotUtil.makeLog('debug', `跳过配置: ${key} (已存在)`, 'ConfigLoader');
          return false;
        }
      }
      
      // 设置文件路径和键名
      configInstance.filePath = filePath;
      // 确保配置实例的name属性与key一致（用于后续查找）
      if (!configInstance.name || configInstance.name !== key) {
        configInstance.name = key;
      }
      this.configs.set(key, configInstance);
      
      BotUtil.makeLog('debug', `加载配置: ${configInstance.displayName || key}`, 'ConfigLoader');
      return true;
    } catch (error) {
      BotUtil.makeLog('error', `加载配置失败: ${filePath}`, 'ConfigLoader', error);
      return false;
    }
  }

  /**
   * 获取配置实例
   * @param {string} name - 配置名称
   * @returns {Object|null}
   */
  get(name) {
    return this.configs.get(name) || null;
  }

  /**
   * 获取所有配置
   * @returns {Map}
   */
  getAll() {
    return this.configs;
  }

  /**
   * 获取配置列表（用于API）
   * @returns {Array}
   */
  getList() {
    const list = [];
    for (const config of this.configs.values()) {
      list.push(config.getStructure());
    }
    return list;
  }

  /**
   * 重新加载指定配置
   * @param {string} name - 配置名称（可以是key或文件名）
   * @returns {Promise<boolean>}
   */
  async reload(name) {
    try {
      // 先尝试从已加载的配置中查找
      const existing = this.configs.get(name);
      if (existing?.filePath) {
        // 清除旧配置
        this.configs.delete(name);
        // 重新加载
        await this._loadConfig(existing.filePath);
        BotUtil.makeLog('info', `配置已重载: ${name}`, 'ConfigLoader');
        return true;
      }
      
      // 如果找不到，尝试在所有配置目录中查找
      const configDirs = await this._getConfigDirs();
      let configPath = null;
      
      // 先尝试直接文件名匹配
      for (const configDir of configDirs) {
        const filePath = path.join(configDir, `${name}.js`);
        if (FileUtils.existsSync(filePath)) {
          configPath = filePath;
          break;
        }
      }
      
      // 如果直接匹配失败，尝试匹配key（可能是插件名_文件名格式）
      if (!configPath) {
        for (const configDir of configDirs) {
          try {
            const entries = await fs.readdir(configDir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isFile() && entry.name.endsWith('.js')) {
                const filePath = path.join(configDir, entry.name);
                const key = this._getConfigKey(filePath);
                if (key === name) {
                  configPath = filePath;
                  break;
                }
              }
            }
            if (configPath) break;
          } catch (err) {
            BotUtil.makeLog('warn', `读取配置目录失败: ${configDir}`, 'ConfigLoader', err);
          }
        }
      }
      
      if (!configPath) {
        throw new Error(`配置文件不存在: ${name}`);
      }

      // 清除旧配置（如果存在）
      const oldKey = this._getConfigKey(configPath);
      if (this.configs.has(oldKey)) {
        this.configs.delete(oldKey);
      }
      
      await this._loadConfig(configPath);
      
      BotUtil.makeLog('info', `配置已重载: ${name}`, 'ConfigLoader');
      return true;
    } catch (error) {
      BotUtil.makeLog('error', `配置重载失败: ${name}`, 'ConfigLoader', error);
      return false;
    }
  }

  /**
   * 清除所有缓存
   */
  clearAllCache() {
    for (const config of this.configs.values()) {
      if (typeof config.clearCache === 'function') {
        config.clearCache();
      }
    }
    BotUtil.makeLog('debug', '已清除所有配置缓存', 'ConfigLoader');
  }

  /**
   * 启用文件监视（热加载）
   * @param {boolean} enable - 是否启用
   */
  async watch(enable = true) {
    if (!enable) {
      if (this.watcher) {
        await this.watcher.close();
        this.watcher = null;
      }
      return;
    }

    if (this.watcher) return;

    try {
      const { HotReloadBase } = await import('../utils/hot-reload-base.js');
      const hotReload = new HotReloadBase({ loggerName: 'ConfigLoader' });
      
      const configDirs = await this._getConfigDirs();
      if (configDirs.length === 0) return;

      await hotReload.watch(true, {
        dirs: configDirs,
        onAdd: async (filePath) => {
          const key = this._getConfigKey(filePath);
          BotUtil.makeLog('debug', `检测到新配置文件: ${key}`, 'ConfigLoader');
          await this._loadConfig(filePath);
        },
        onChange: async (filePath) => {
          const key = this._getConfigKey(filePath);
          BotUtil.makeLog('debug', `检测到配置文件变更: ${key}`, 'ConfigLoader');
          await this.reload(key);
        },
        onUnlink: async (filePath) => {
          const key = this._getConfigKey(filePath);
          BotUtil.makeLog('debug', `检测到配置文件删除: ${key}`, 'ConfigLoader');
          this.configs.delete(key);
        }
      });

      this.watcher = hotReload.watcher;
    } catch (error) {
      BotUtil.makeLog('error', '启动配置文件监视失败', 'ConfigLoader', error);
    }
  }
}

// 导出单例
export default new ConfigLoader();