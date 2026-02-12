import path from 'path';
import yaml from 'yaml';
import BotUtil from '../util.js';
import { FileUtils } from '../utils/file-utils.js';
import { ObjectUtils } from '../utils/object-utils.js';
import { cleanConfigData, applyDefaults, deepMergeConfig } from './config-utils.js';

/**
 * 配置文件管理基类
 * 
 * 提供统一的配置文件读写接口，支持YAML和JSON格式。
 * 支持动态路径、缓存、备份、验证等功能。
 * 
 * @abstract
 * @class ConfigBase
 * @example
 * // 继承ConfigBase创建自定义配置类
 * class MyConfig extends ConfigBase {
 *   constructor() {
 *     super({
 *       name: 'myconfig',
 *       displayName: '我的配置',
 *       description: '自定义配置示例',
 *       filePath: 'config/myconfig.yaml',
 *       fileType: 'yaml',
 *       schema: { /* 配置结构定义 *\/ }
 *     });
 *   }
 * }
 * 
 * // 使用
 * const config = new MyConfig();
 * const data = await config.read();
 * await config.write({ key: 'value' });
 */
export default class ConfigBase {
  /**
   * 构造函数
   * 
   * @param {Object} metadata - 配置元数据
   * @param {string} metadata.name - 配置名称（用于标识，必填）
   * @param {string} metadata.displayName - 显示名称（用于UI显示）
   * @param {string} metadata.description - 配置描述
   * @param {string|Function} metadata.filePath - 配置文件相对路径或动态路径函数
   *   - 字符串：相对于项目根目录的路径，如 'config/myconfig.yaml'
   *   - 函数：动态计算路径，接收cfg对象，返回路径字符串
   * @param {string} metadata.fileType - 文件类型：'yaml' 或 'json'（默认'yaml'）
   * @param {Object} metadata.schema - 配置结构定义（用于验证）
   */
  constructor(metadata = {}) {
    this.name = metadata.name || 'config';
    this.displayName = metadata.displayName || this.name;
    this.description = metadata.description || '';
    this.filePath = metadata.filePath || '';
    this.fileType = metadata.fileType || 'yaml';
    this.schema = metadata.schema || {};
    
    // 如果 filePath 是函数，则动态计算路径
    if (ObjectUtils.isFunction(this.filePath)) {
      this._getFilePath = this.filePath;
    } else {
      // 完整文件路径
      this.fullPath = path.join(process.cwd(), this.filePath);
    }
    
    // 缓存配置内容
    this._cache = null;
    this._cacheTime = 0;
    this._cacheTTL = 5000; // 5秒缓存
  }
  
  /**
   * 获取配置文件的完整路径（支持动态路径）
   * @returns {string}
   */
  _resolveFilePath() {
    if (this._getFilePath) {
      // 动态路径：从 cfg 获取端口
      // cfg 在系统初始化时已经确保存在
      const cfg = global.cfg;
      const dynamicPath = this._getFilePath(cfg);
      return path.join(process.cwd(), dynamicPath);
    }
    // 如果没有 fullPath，尝试构造默认路径
    if (!this.fullPath) {
      return path.join(process.cwd(), `config/config/${this.name}.yaml`);
    }
    return this.fullPath;
  }

  /**
   * 获取配置文件的完整路径
   * @returns {string}
   */
  getFilePath() {
    return this._resolveFilePath();
  }

  /**
   * 检查文件是否存在
   * @returns {Promise<boolean>}
   */
  async exists() {
    return FileUtils.exists(this._resolveFilePath());
  }

  /**
   * 读取配置文件
   * @param {boolean} useCache - 是否使用缓存
   * @returns {Promise<Object>}
   */
  async read(useCache = true) {
    // 检查缓存
    if (useCache && this._cache && (Date.now() - this._cacheTime < this._cacheTTL)) {
      return this._cache;
    }
    
    try {
      let data = {};

      // 读取文件内容
      const filePath = this._resolveFilePath();
      const content = await FileUtils.readFile(filePath);
      
      if (content) {
        // 解析内容
        if (this.fileType === 'yaml') {
          data = yaml.parse(content) || {};
        } else if (this.fileType === 'json') {
          data = JSON.parse(content);
        } else {
          throw new Error(`不支持的文件类型: ${this.fileType}`);
        }
      }

      // 确保数据是对象
      if (!ObjectUtils.isPlainObject(data)) {
        data = {};
      }

      // 先应用默认值（无论文件是否存在）
      if (this.schema && this.schema.fields) {
        data = applyDefaults(data, this.schema);
        // 然后进行类型清理和转换
        data = cleanConfigData(data, { schema: this.schema });
      }

      // 应用transformRead转换（如果存在）
      if (this.transformRead) {
        data = this.transformRead(data);
      }

      // 更新缓存
      this._cache = data;
      this._cacheTime = Date.now();

      return data;
    } catch (error) {
      BotUtil.makeLog('error', `读取配置失败 [${this.name}]: ${error.message}`, 'ConfigBase');
      throw error;
    }
  }

  /**
   * 写入配置文件
   * @param {Object} data - 配置数据
   * @param {Object} options - 写入选项
   * @param {boolean} options.backup - 是否备份原文件
   * @param {boolean} options.validate - 是否验证数据
   * @returns {Promise<boolean>}
   */
  async write(data, options = {}) {
    const { backup = true, validate = true } = options;

    try {
      // 创建数据副本，避免直接修改原始数据
      let dataToWrite = JSON.parse(JSON.stringify(data));

      // 应用transformWrite转换（如果存在）
      if (this.transformWrite) {
        dataToWrite = this.transformWrite(dataToWrite);
      }

      if (this.schema && this.schema.fields) {
        dataToWrite = cleanConfigData(dataToWrite, { schema: this.schema });
      }

      // 验证数据（验证过程中会进行类型转换，所以传入的数据对象可能会被修改）
      if (validate) {
        // 对于批量更新，先读取现有数据并合并，确保必需字段不会丢失
        let dataToValidate = dataToWrite;
        try {
          const existingData = await this.read(false); // 不使用缓存
          if (ObjectUtils.isPlainObject(existingData)) {
            dataToValidate = deepMergeConfig(existingData, dataToWrite, this.schema);
          }
        } catch (e) {
          // 如果读取失败（可能是首次创建），使用新数据
          dataToValidate = dataToWrite;
        }
        
        const validation = await this.validate(dataToValidate);
        if (!validation.valid) {
          throw new Error(`配置验证失败: ${validation.errors.join(', ')}`);
        }
        
        // 使用验证后的数据（可能包含合并的必需字段）
        dataToWrite = dataToValidate;
      }

      // 备份原文件
      if (backup && await this.exists()) {
        await this.backup();
      }

      // 序列化数据
      const filePath = this._resolveFilePath();
      let content;
      if (this.fileType === 'yaml') {
        content = yaml.stringify(dataToWrite, {
          indent: 2,
          lineWidth: 0,
          minContentWidth: 0
        });
      } else if (this.fileType === 'json') {
        content = JSON.stringify(dataToWrite, null, 2);
      } else {
        throw new Error(`不支持的文件类型: ${this.fileType}`);
      }

      // 写入文件（自动创建目录）
      await FileUtils.writeFile(filePath, content);

      // 清除缓存
      this._cache = dataToWrite;
      this._cacheTime = Date.now();

      // 只在非静默模式下记录日志
      if (!options || !options.silent) {
        BotUtil.makeLog('info', `配置已保存 [${this.name}]`, 'ConfigBase');
      }
      return true;
    } catch (error) {
      BotUtil.makeLog('error', `写入配置失败 [${this.name}]: ${error.message}`, 'ConfigBase');
      throw error;
    }
  }

  /**
   * 备份配置文件
   * @returns {Promise<string>} 备份文件路径
   */
  async backup() {
    const filePath = this._resolveFilePath();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const backupPath = `${filePath}.backup.${timestamp}`;
    
    if (await FileUtils.copyFile(filePath, backupPath)) {
      BotUtil.makeLog('debug', `配置已备份 [${this.name}]: ${backupPath}`, 'ConfigBase');
      return backupPath;
    }
    throw new Error('备份失败');
  }

  /**
   * 获取指定路径的配置值
   * 
   * 支持点号路径和数组索引，如 'server.host' 或 'server.proxy.domains[0].domain'
   * 
   * @param {string} keyPath - 键路径
   *   - 点号分隔：'server.host'
   *   - 数组索引：'domains[0]' 或 'server.proxy.domains[0].domain'
   * @returns {Promise<any>} 配置值，如果路径不存在返回undefined
   * @example
   * const host = await config.get('server.host');
   * const firstDomain = await config.get('server.proxy.domains[0].domain');
   */
  async get(keyPath) {
    const data = await this.read();
    return this._getValueByPath(data, keyPath);
  }

  /**
   * 设置指定路径的配置值
   * 
   * 如果路径不存在，会自动创建中间对象。
   * 
   * @param {string} keyPath - 键路径（支持点号和数组索引）
   * @param {any} value - 新值
   * @param {Object} options - 写入选项
   *   - backup: 是否备份（默认true）
   *   - validate: 是否验证（默认true）
   * @returns {Promise<boolean>} 是否成功
   * @example
   * await config.set('server.host', '0.0.0.0');
   * await config.set('server.proxy.domains[0].domain', 'example.com');
   */
  async set(keyPath, value, options = {}) {
    const data = await this.read();
    this._setValueByPath(data, keyPath, value);
    return await this.write(data, options);
  }

  /**
   * 删除指定路径的配置
   * 
   * 删除指定路径的配置项，如果路径不存在则忽略。
   * 
   * @param {string} keyPath - 键路径（支持点号和数组索引）
   * @param {Object} options - 写入选项
   * @returns {Promise<boolean>} 是否成功
   * @example
   * await config.delete('server.proxy.domains[0]');
   */
  async delete(keyPath, options = {}) {
    const data = await this.read();
    this._deleteValueByPath(data, keyPath);
    return await this.write(data, options);
  }

  /**
   * 追加到数组配置
   * 
   * 将值追加到指定路径的数组末尾。
   * 
   * @param {string} keyPath - 数组键路径（必须是数组类型）
   * @param {any} value - 要追加的值
   * @param {Object} options - 写入选项
   * @returns {Promise<boolean>} 是否成功
   * @throws {Error} 如果路径不是数组类型
   * @example
   * await config.append('server.auth.whitelist', '/new-path');
   */
  async append(keyPath, value, options = {}) {
    const data = await this.read();
    const current = this._getValueByPath(data, keyPath);
    
    if (!ObjectUtils.isArray(current)) {
      throw new Error(`路径 ${keyPath} 不是数组`);
    }
    
    current.push(value);
    return await this.write(data, options);
  }

  /**
   * 从数组配置中移除元素
   * 
   * 支持通过索引或查找函数移除数组元素。
   * 
   * @param {string} keyPath - 数组键路径（必须是数组类型）
   * @param {number|Function} indexOrPredicate - 移除方式
   *   - 数字：按索引移除，如 0 移除第一个元素
   *   - 函数：查找函数，如 (item) => item.id === 'target'
   * @param {Object} options - 写入选项
   * @returns {Promise<boolean>} 是否成功
   * @throws {Error} 如果路径不是数组类型
   * @example
   * // 按索引移除
   * await config.remove('server.auth.whitelist', 0);
   * 
   * // 按条件移除
   * await config.remove('domains', (item) => item.domain === 'old.com');
   */
  async remove(keyPath, indexOrPredicate, options = {}) {
    const data = await this.read();
    const current = this._getValueByPath(data, keyPath);
    
    if (!ObjectUtils.isArray(current)) {
      throw new Error(`路径 ${keyPath} 不是数组`);
    }
    
    if (typeof indexOrPredicate === 'number') {
      current.splice(indexOrPredicate, 1);
    } else if (ObjectUtils.isFunction(indexOrPredicate)) {
      const index = current.findIndex(indexOrPredicate);
      if (index !== -1) {
        current.splice(index, 1);
      }
    }
    
    return await this.write(data, options);
  }

  /**
   * 合并配置
   * 
   * 将新配置数据合并到现有配置中，支持浅合并和深合并。
   * 
   * @param {Object} newData - 新配置数据
   * @param {Object} options - 合并选项
   *   - deep: 是否深度合并（默认true）
   *   - backup: 是否备份（默认true）
   *   - validate: 是否验证（默认true）
   * @returns {Promise<boolean>} 是否成功
   * @example
   * await config.merge({
   *   server: {
   *     host: '0.0.0.0',
   *     port: 8086
   *   }
   * });
   */
  async merge(newData, options = {}) {
    const { deep = true } = options;
    const currentData = await this.read();
    
    // 使用标准化的合并函数
    const mergedData = deep && this.schema && this.schema.fields
      ? deepMergeConfig(currentData, newData, this.schema)
      : { ...currentData, ...newData };
    
    return await this.write(mergedData, options);
  }

  /**
   * 验证配置数据
   * 
   * 根据schema定义验证配置数据的类型、范围、长度等。
   * 
   * @param {Object} data - 要验证的数据
   * @returns {Promise<Object>} 验证结果
   *   - valid: 是否有效
   *   - errors: 错误信息数组
   * @example
   * const result = await config.validate({ host: '0.0.0.0', port: 8086 });
   * if (!result.valid) {
   *   BotUtil.makeLog('error', `验证失败: ${result.errors.join(', ')}`, 'ConfigBase');
   * }
   */
  async validate(data) {
    const errors = [];

    try {
      // 基础验证：检查必需字段
      if (this.schema.required) {
        for (const field of this.schema.required) {
          if (!(field in data)) {
            errors.push(`缺少必需字段: ${field}`);
          }
        }
      }

      // 类型验证和转换
      if (this.schema.fields) {
        for (const [field, fieldSchema] of Object.entries(this.schema.fields)) {
          if (field in data) {
            let value = data[field];
            const expectedType = fieldSchema.type;

            // 允许 null 和 undefined 值（空值不进行类型验证）
            if (value === null || value === undefined) {
              // 如果字段允许为空（nullable），跳过类型验证
              if (fieldSchema.nullable !== false) {
                continue; // 跳过后续验证
              }
              // 如果字段不允许为空且是必需字段，已在上面检查过
            } else {
              // 类型转换：尝试将字符串数字转换为数字（优先处理枚举）
              if (expectedType === 'number' && typeof value === 'string') {
                const numValue = Number(value);
                if (!isNaN(numValue) && value.trim() !== '') {
                  value = numValue;
                  data[field] = value; // 更新数据中的值
                }
              }
              
              // 类型转换：尝试将字符串布尔值转换为布尔
              if (expectedType === 'boolean' && typeof value === 'string') {
                if (value === 'true' || value === '1') {
                  value = true;
                  data[field] = value;
                } else if (value === 'false' || value === '0') {
                  value = false;
                  data[field] = value;
                }
              }
              
              // 类型验证
              if (expectedType && !this._checkType(value, expectedType)) {
                errors.push(`字段 ${field} 类型错误，期望 ${expectedType}`);
              }
            }

            // 数值范围验证（仅当值不为 null/undefined 时）
            if (expectedType === 'number' && value != null) {
              if (fieldSchema.min !== undefined && value < fieldSchema.min) {
                errors.push(`字段 ${field} 不能小于 ${fieldSchema.min}`);
              }
              if (fieldSchema.max !== undefined && value > fieldSchema.max) {
                errors.push(`字段 ${field} 不能大于 ${fieldSchema.max}`);
              }
            }

            // 字符串长度验证（仅当值不为 null/undefined 时）
            if (expectedType === 'string' && value != null) {
              if (fieldSchema.minLength !== undefined && value.length < fieldSchema.minLength) {
                errors.push(`字段 ${field} 长度不能小于 ${fieldSchema.minLength}`);
              }
              if (fieldSchema.maxLength !== undefined && value.length > fieldSchema.maxLength) {
                errors.push(`字段 ${field} 长度不能大于 ${fieldSchema.maxLength}`);
              }
              if (fieldSchema.pattern && !new RegExp(fieldSchema.pattern).test(value)) {
                errors.push(`字段 ${field} 格式不正确`);
              }
            }

            // 枚举值验证（仅当值不为 null/undefined 时）
            // 注意：枚举验证在类型转换之后进行，确保转换后的值参与验证
            if (fieldSchema.enum && value != null) {
              // 再次尝试类型转换（如果之前没有转换成功）
              let enumValue = value;
              if (expectedType === 'number' && typeof value === 'string') {
                const numValue = Number(value);
                if (!isNaN(numValue)) {
                  enumValue = numValue;
                  data[field] = enumValue; // 更新数据
                }
              }
              if (!fieldSchema.enum.includes(enumValue)) {
                errors.push(`字段 ${field} 值必须是: ${fieldSchema.enum.join(', ')}`);
              }
            }
          }
        }
      }

      // 自定义验证器
      if (this.customValidate) {
        const customErrors = await this.customValidate(data);
        if (ObjectUtils.isArray(customErrors)) {
          errors.push(...customErrors);
        }
      }

    } catch (error) {
      errors.push(`验证过程出错: ${error.message}`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 获取配置结构（用于前端渲染表单）
   * @returns {Object}
   */
  getStructure() {
    return {
      name: this.name,
      displayName: this.displayName,
      description: this.description,
      filePath: this.filePath,
      fileType: this.fileType,
      schema: this.schema
    };
  }

  /**
   * 重置为默认配置
   * @param {Object} options - 写入选项
   * @returns {Promise<boolean>}
   */
  async reset(options = {}) {
    if (!this.defaultConfig) {
      throw new Error('未定义默认配置');
    }
    return await this.write(this.defaultConfig, options);
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this._cache = null;
    this._cacheTime = 0;
  }

  // ==================== 私有辅助方法 ====================

  /**
   * 通过路径获取值
   * @private
   */
  _getValueByPath(obj, keyPath) {
    if (!keyPath) return obj;
    
    const keys = keyPath.split('.');
    let current = obj;

    for (const key of keys) {
      // 处理数组索引，如 domains[0]
      const arrayMatch = key.match(/^(.+?)\[(\d+)\]$/);
      if (arrayMatch) {
        const [, arrayKey, index] = arrayMatch;
        current = current && current[arrayKey] && current[arrayKey][parseInt(index)];
      } else {
        current = current && current[key];
      }

      if (current === undefined) {
        return undefined;
      }
    }

    return current;
  }

  /**
   * 通过路径设置值
   * @private
   */
  _setValueByPath(obj, keyPath, value) {
    const keys = keyPath.split('.');
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      
      // 处理数组索引
      const arrayMatch = key.match(/^(.+?)\[(\d+)\]$/);
      if (arrayMatch) {
        const [, arrayKey, index] = arrayMatch;
        if (!current[arrayKey]) current[arrayKey] = [];
        if (!current[arrayKey][index]) current[arrayKey][index] = {};
        current = current[arrayKey][index];
      } else {
        if (!current[key]) current[key] = {};
        current = current[key];
      }
    }

    const lastKey = keys[keys.length - 1];
    const arrayMatch = lastKey.match(/^(.+?)\[(\d+)\]$/);
    
    if (arrayMatch) {
      const [, arrayKey, index] = arrayMatch;
      if (!current[arrayKey]) current[arrayKey] = [];
      current[arrayKey][parseInt(index)] = value;
    } else {
      current[lastKey] = value;
    }
  }

  /**
   * 通过路径删除值
   * @private
   */
  _deleteValueByPath(obj, keyPath) {
    const keys = keyPath.split('.');
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      const arrayMatch = key.match(/^(.+?)\[(\d+)\]$/);
      
      if (arrayMatch) {
        const [, arrayKey, index] = arrayMatch;
        current = current[arrayKey] && current[arrayKey][parseInt(index)];
      } else {
        current = current[key];
      }

      if (!current) return;
    }

    const lastKey = keys[keys.length - 1];
    const arrayMatch = lastKey.match(/^(.+?)\[(\d+)\]$/);
    
    if (arrayMatch) {
      const [, arrayKey, index] = arrayMatch;
      if (current[arrayKey]) current[arrayKey].splice(parseInt(index), 1);
    } else {
      delete current[lastKey];
    }
  }

  // _deepMerge 已移除，统一使用 deepMergeConfig（在 config-utils.js 中）

  /**
   * 检查是否为对象
   * @private
   */
  _isObject(item) {
    return ObjectUtils.isPlainObject(item);
  }

  /**
   * 类型检查
   * @private
   */
  _checkType(value, expectedType) {
    switch (expectedType) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && !isNaN(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return ObjectUtils.isArray(value);
      case 'object':
        return this._isObject(value);
      default:
        return true;
    }
  }
}