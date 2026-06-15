import path from 'path';
import { FileUtils } from '../utils/file-utils.js';
import { PluginDirScanner } from '../utils/plugin-dir-scanner.js';
import { HotReloadBase } from '../utils/hot-reload-base.js';

/**
 * 配置加载器
 * 负责加载和管理所有配置类
 */
class ConfigLoader {
  /** 所有配置实例 */
  configs = new Map();
  /** 配置文件绝对路径 → Map key */
  fileKeys = new Map();
  /** 加载状态 */
  loaded = false;
  /** 文件监视器 */
  watcher = null;

  /**
   * 加载所有配置
   * @returns {Promise<Map>}
   */
  async load() {
    if (this.loaded) return this.configs;

    try {
      const startTime = Date.now();

      const configDirs = this._getConfigDirs();

      // 加载每个配置目录
      for (const configDir of configDirs) {
        const files = this._getConfigFiles(configDir);
        for (const file of files) {
          await this._loadConfig(file);
        }
      }

      this.loaded = true;
      const loadTime = Date.now() - startTime;
      
      Bot.makeLog('info', 
        `配置管理器加载完成: ${this.configs.size}个配置, 耗时${loadTime}ms`, 
        'ConfigLoader'
      );

      return this.configs;
    } catch (error) {
      Bot.makeLog('error', '配置管理器加载失败', 'ConfigLoader', error);
      throw error;
    }
  }

  /**
   * 获取所有配置目录
   * @private
   * @returns {string[]}
   */
  _getConfigDirs() {
    return PluginDirScanner.listSubdirPaths('commonconfig');
  }

  /**
   * 获取配置文件列表
   * @private
   * @param {string} dir
   * @returns {string[]}
   */
  _getConfigFiles(dir) {
    try {
      return PluginDirScanner.listJsFiles(dir);
    } catch (err) {
      Bot.makeLog('error', `读取配置目录失败: ${dir}`, 'ConfigLoader', err);
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
      const pluginName = pluginsMatch[1];
      return `${pluginName}_${fileName}`;
    }
    
    // 默认配置目录，直接使用文件名
    return fileName;
  }

  /**
   * 由配置文件路径解析已加载的 Map key
   * @private
   */
  _resolveKeyByFilePath(filePath) {
    const normalized = path.resolve(filePath);
    if (this.fileKeys.has(normalized)) return this.fileKeys.get(normalized);
    for (const [key, inst] of this.configs) {
      if (inst?.filePath && path.resolve(inst.filePath) === normalized) return key;
    }
    return this._getConfigKey(filePath);
  }

  /**
   * 按文件路径移除已加载配置
   * @private
   */
  _deleteByFilePath(filePath) {
    const normalized = path.resolve(filePath);
    const key = this._resolveKeyByFilePath(normalized);
    if (key && this.configs.has(key)) {
      this.configs.delete(key);
    }
    this.fileKeys.delete(normalized);
  }

  /**
   * 加载单个配置文件
   * @private
   */
  async _loadConfig(filePath) {
    try {
      const derivedKey = this._getConfigKey(filePath);
      
      const module = await import(FileUtils.toImportUrl(filePath));
      
      if (!module.default) {
        Bot.makeLog('warn', `无效的配置模块: ${derivedKey} (缺少default导出)`, 'ConfigLoader');
        return false;
      }

      let configInstance;
      
      if (typeof module.default === 'function') {
        try {
          configInstance = new module.default();
        } catch (err) {
          Bot.makeLog('warn', `无法实例化配置模块: ${derivedKey} (${err?.message || err})`, 'ConfigLoader');
          return false;
        }
      } else if (typeof module.default === 'object' && module.default !== null && !Array.isArray(module.default)) {
        configInstance = module.default;
      } else {
        Bot.makeLog('warn', `无效的配置模块: ${derivedKey} (导出类型错误)`, 'ConfigLoader');
        return false;
      }

      if (typeof configInstance.getStructure !== 'function') {
        Bot.makeLog('warn', `无效的配置模块: ${derivedKey} (缺少 getStructure 方法)`, 'ConfigLoader');
        return false;
      }

      // 最终 key：优先使用配置实例自身的 name（插件可控），否则回退到路径推导 key
      const key = (typeof configInstance.name === 'string' && configInstance.name.trim())
        ? configInstance.name.trim()
        : derivedKey;

      // 存储配置实例（如果已存在同名配置，使用优先级更高的）
      const existing = this.configs.get(key);
      if (existing) {
        const existingPath = existing.filePath || '';
        const isPluginPath = filePath.includes('/plugins/') || filePath.includes('\\plugins\\');
        const existingIsPlugin = existingPath.includes('/plugins/') || existingPath.includes('\\plugins\\');
        
        // 优先级：插件配置 > 默认配置
        if (isPluginPath && !existingIsPlugin) {
          Bot.makeLog('debug', `替换配置: ${key} (插件配置优先级更高)`, 'ConfigLoader');
        } else if (!isPluginPath && existingIsPlugin) {
          // 已存在插件配置，新加载的是默认配置：应保留插件配置
          Bot.makeLog('debug', `跳过配置: ${key} (已存在插件配置，优先级更高)`, 'ConfigLoader');
          return false;
        } else {
          Bot.makeLog('debug', `跳过配置: ${key} (已存在)`, 'ConfigLoader');
          return false;
        }
      }
      
      // 设置文件路径和键名
      configInstance.filePath = filePath;
      // 仅在未声明 name 时，回填为最终 key
      if (!configInstance.name) configInstance.name = key;
      this.configs.set(key, configInstance);
      this.fileKeys.set(path.resolve(filePath), key);
      
      return true;
    } catch (error) {
      Bot.makeLog('error', `加载配置失败: ${filePath}`, 'ConfigLoader', error);
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
      if (config && typeof config.getStructure === 'function') {
        list.push(config.getStructure());
      }
    }
    return this._sortConfigList(list);
  }

  /**
   * 控制台侧栏顺序：system 置顶，其余按 displayName 排序
   * @param {Array} list
   * @returns {Array}
   */
  _sortConfigList(list) {
    return list.sort((a, b) => {
      const aPinned = a?.name === 'system' ? 0 : 1;
      const bPinned = b?.name === 'system' ? 0 : 1;
      if (aPinned !== bPinned) return aPinned - bPinned;
      const aLabel = String(a?.displayName || a?.name || '');
      const bLabel = String(b?.displayName || b?.name || '');
      return aLabel.localeCompare(bLabel, 'zh-CN');
    });
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
        Bot.makeLog('info', `配置已重载: ${name}`, 'ConfigLoader');
        return true;
      }
      
      // 如果找不到，尝试在所有配置目录中查找
      const configDirs = this._getConfigDirs();
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
            const entries = await FileUtils.readDir(configDir, { withFileTypes: true });
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
            Bot.makeLog('warn', `读取配置目录失败: ${configDir}`, 'ConfigLoader', err);
          }
        }
      }
      
      if (!configPath) {
        throw new Error(`配置文件不存在: ${name}`);
      }

      // 清除旧配置（如果存在）
      const resolvedKey = this._resolveKeyByFilePath(configPath);
      if (resolvedKey && this.configs.has(resolvedKey)) {
        this.configs.delete(resolvedKey);
      }
      this.fileKeys.delete(path.resolve(configPath));
      
      await this._loadConfig(configPath);
      
      Bot.makeLog('info', `配置已重载: ${name}`, 'ConfigLoader');
      return true;
    } catch (error) {
      Bot.makeLog('error', `配置重载失败: ${name}`, 'ConfigLoader', error);
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
    Bot.makeLog('debug', '已清除所有配置缓存', 'ConfigLoader');
  }

  /**
   * 启用文件监视（热加载）
   * @param {boolean} enable - 是否启用
   */
  async watch(enable = true) {
    if (!enable) {
      await HotReloadBase.closeWatcher(this.watcher);
      this.watcher = null;
      return;
    }

    if (this.watcher) return;

    try {
      this.watcher = await HotReloadBase.watchModuleDirs({
        loggerName: 'ConfigLoader',
        dirs: this._getConfigDirs(),
        debounceMs: HotReloadBase.WATCH_DEBOUNCE_MS,
        jsOnly: true,
        onAdd: async (filePath) => {
          const key = this._getConfigKey(filePath);
          Bot.makeLog('debug', `检测到新配置文件: ${key}`, 'ConfigLoader');
          await this._loadConfig(filePath);
        },
        onChange: async (filePath) => {
          const key = this._resolveKeyByFilePath(filePath);
          Bot.makeLog('debug', `检测到配置文件变更: ${key}`, 'ConfigLoader');
          this._deleteByFilePath(filePath);
          await this._loadConfig(filePath);
        },
        onUnlink: async (filePath) => {
          const key = this._resolveKeyByFilePath(filePath);
          Bot.makeLog('debug', `检测到配置文件删除: ${key}`, 'ConfigLoader');
          this._deleteByFilePath(filePath);
        },
      });
    } catch (error) {
      Bot.makeLog('error', '启动配置文件监视失败', 'ConfigLoader', error);
    }
  }
}

// 导出单例
export default new ConfigLoader();