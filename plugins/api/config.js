/**
 * 配置管理API
 * 提供统一的配置文件读写接口
 */
import BotUtil from '../../lib/common/util.js';

// 辅助函数：清理配置数据（与验证逻辑保持一致的类型转换）
function cleanConfigData(data, config) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const cleaned = Array.isArray(data) ? [...data] : { ...data };
  const schema = config?.schema;

  if (schema && schema.fields) {
    for (const [field, fieldSchema] of Object.entries(schema.fields)) {
      // 如果字段不在数据中，根据类型设置默认值
      if (!(field in cleaned)) {
        const expectedType = fieldSchema.type;
        if (expectedType === 'array') {
          cleaned[field] = fieldSchema.default !== undefined ? 
            (Array.isArray(fieldSchema.default) ? [...fieldSchema.default] : []) : [];
        } else if (expectedType === 'boolean') {
          cleaned[field] = fieldSchema.default !== undefined ? fieldSchema.default : false;
        } else if (expectedType === 'number') {
          cleaned[field] = fieldSchema.default !== undefined ? fieldSchema.default : null;
        } else if (expectedType === 'object') {
          cleaned[field] = fieldSchema.default !== undefined ? 
            (typeof fieldSchema.default === 'object' && !Array.isArray(fieldSchema.default) ? 
              JSON.parse(JSON.stringify(fieldSchema.default)) : {}) : {};
        } else {
          cleaned[field] = fieldSchema.default !== undefined ? fieldSchema.default : null;
        }
        continue;
      }
      
      let value = cleaned[field];
      const expectedType = fieldSchema.type;
      
      // 类型转换：确保类型匹配schema定义
      if (expectedType === 'array') {
        // 数组类型：确保是数组
        if (!Array.isArray(value)) {
          // 如果不是数组，转换为空数组
          if (value === null || value === undefined || value === '') {
            cleaned[field] = [];
          } else if (typeof value === 'string') {
            // 字符串尝试解析为数组
            try {
              const parsed = JSON.parse(value);
              cleaned[field] = Array.isArray(parsed) ? parsed : [];
            } catch {
              cleaned[field] = [];
            }
          } else {
            // 其他类型转换为空数组
            cleaned[field] = [];
          }
        } else {
          // 已经是数组，递归处理数组中的对象
          if (fieldSchema.itemType === 'object' && fieldSchema.itemSchema) {
            // 对象数组：递归清理每个对象
            cleaned[field] = value.map(item => {
              if (item && typeof item === 'object' && !Array.isArray(item)) {
                return cleanConfigData(item, { schema: { fields: fieldSchema.itemSchema.fields || {} } });
              }
              return item;
            });
          } else {
            // 标量数组：直接保留
            cleaned[field] = value;
          }
        }
      } else if (expectedType === 'boolean') {
        // 布尔类型：确保是布尔值
        if (typeof value !== 'boolean') {
          if (typeof value === 'string') {
            if (value === 'true' || value === '1' || value === 'on') {
              cleaned[field] = true;
            } else if (value === 'false' || value === '0' || value === 'off' || value === '') {
              cleaned[field] = false;
            } else {
              // 无法转换，使用默认值或false
              cleaned[field] = fieldSchema.default !== undefined ? fieldSchema.default : false;
            }
          } else if (value === null || value === undefined) {
            // null/undefined 使用默认值或false
            cleaned[field] = fieldSchema.default !== undefined ? fieldSchema.default : false;
          } else {
            // 其他类型（如数字）转换为布尔
            cleaned[field] = Boolean(value);
          }
        }
      } else if (expectedType === 'number') {
        // 数字类型：确保是数字或null
        if (typeof value !== 'number') {
          if (typeof value === 'string') {
            const numValue = Number(value);
            if (!isNaN(numValue) && value.trim() !== '') {
              cleaned[field] = numValue;
            } else if (value === '') {
              cleaned[field] = null;
            } else {
              // 无法转换，使用默认值或null
              cleaned[field] = fieldSchema.default !== undefined ? fieldSchema.default : null;
            }
          } else if (value === null || value === undefined || value === '') {
            cleaned[field] = null;
          } else {
            // 其他类型尝试转换为数字
            const numValue = Number(value);
            cleaned[field] = !isNaN(numValue) ? numValue : (fieldSchema.default !== undefined ? fieldSchema.default : null);
          }
        }
      } else if (expectedType === 'object') {
        // 对象类型：递归处理嵌套对象
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          cleaned[field] = cleanConfigData(value, { schema: { fields: fieldSchema.fields || {} } });
        } else if (value === null || value === undefined || value === '') {
          // 空值转换为空对象或null
          cleaned[field] = fieldSchema.default !== undefined ? fieldSchema.default : {};
        }
      }
    }
  }

  return cleaned;
}

export default {
  name: 'config-manager',
  dsc: '配置管理API - 统一的配置文件读写接口',
  priority: 85,

  routes: [
    {
      method: 'GET',
      path: '/api/config/list',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const configList = global.ConfigManager.getList();
          
          res.json({
            success: true,
            configs: configList,
            count: configList.length
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '获取配置列表失败',
            error: error.message
          });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/config/:name/structure',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const { name } = req.params;
          const config = global.ConfigManager.get(name);

          if (!config) {
            return res.status(404).json({
              success: false,
              message: `配置 ${name} 不存在`
            });
          }

          const structure = config.getStructure();

          res.json({
            success: true,
            structure
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '获取配置结构失败',
            error: error.message
          });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/config/:name/defaults',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const { name } = req.params;
          const { path: keyPath } = req.query || {};
          const config = global.ConfigManager.get(name);

          if (!config) {
            return res.status(404).json({
              success: false,
              message: `配置 ${name} 不存在`
            });
          }

          let defaults = {};
          
          // 辅助函数：从对象中通过路径获取值
          const getValueByPath = (obj, keyPath) => {
            if (!keyPath) return obj;
            const keys = keyPath.split('.');
            let current = obj;
            for (const key of keys) {
              const arrayMatch = key.match(/^(.+?)\[(\d+)\]$/);
              if (arrayMatch) {
                const [, arrayKey, index] = arrayMatch;
                current = current?.[arrayKey]?.[parseInt(index)];
              } else {
                current = current?.[key];
              }
              if (current === undefined) return undefined;
            }
            return current;
          };
          
          if (keyPath) {
            // 获取子配置的默认值
            if (name === 'system') {
              const structure = config.getStructure();
              const subConfig = structure.configs?.[keyPath];
              if (subConfig && subConfig.schema) {
                // 创建临时配置实例来获取默认值
                const ConfigBase = (await import('../../lib/commonconfig/commonconfig.js')).default;
                const tempConfig = Object.create(ConfigBase.prototype);
                tempConfig.schema = subConfig.schema;
                defaults = tempConfig.getDefaults ? tempConfig.getDefaults() : {};
              }
            } else if (typeof config.getDefaults === 'function') {
              // 普通配置：从指定路径获取默认值
              const allDefaults = config.getDefaults();
              defaults = getValueByPath(allDefaults, keyPath) || {};
            }
          } else {
            // 获取完整配置的默认值
            if (name === 'system') {
              // SystemConfig：返回所有子配置的默认值
              const structure = config.getStructure();
              defaults = {};
              const ConfigBase = (await import('../../lib/commonconfig/commonconfig.js')).default;
              for (const [subName, subConfig] of Object.entries(structure.configs || {})) {
                if (subConfig.schema) {
                  const tempConfig = Object.create(ConfigBase.prototype);
                  tempConfig.schema = subConfig.schema;
                  defaults[subName] = tempConfig.getDefaults ? tempConfig.getDefaults() : {};
                }
              }
            } else if (typeof config.getDefaults === 'function') {
              defaults = config.getDefaults();
            }
          }

          res.json({
            success: true,
            defaults
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '获取默认配置失败',
            error: error.message
          });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/config/:name/read',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        let configName = null;
        try {
          configName = req.params?.name;
          const { path: keyPath } = req.query || {};

          if (!configName) {
            return res.status(400).json({
              success: false,
              message: '配置名称不能为空'
            });
          }

          if (!global.ConfigManager) {
            return res.status(503).json({
              success: false,
              message: '配置管理器未初始化'
            });
          }

          const config = global.ConfigManager.get(configName);

          if (!config) {
            return res.status(404).json({
              success: false,
              message: `配置 ${configName} 不存在`
            });
          }

          let data;
          if (keyPath) {
            // 如果有 keyPath，读取指定路径的配置值
            if (configName === 'system' && typeof config.read === 'function') {
              // SystemConfig 的特殊处理：keyPath 是子配置名称
              try {
                data = await config.read(keyPath);
              } catch (subError) {
                BotUtil.makeLog('error', `读取子配置失败 [${configName}/${keyPath}]: ${subError.message}`, 'ConfigAPI', subError);
                throw subError;
              }
            } else if (typeof config.get === 'function') {
              // 普通配置：使用 get 方法读取指定路径的值
            data = await config.get(keyPath);
            } else {
              throw new Error('配置对象不支持 get 方法');
            }
          } else {
            // 没有 keyPath，读取完整配置
            if (configName === 'system' && typeof config.read === 'function') {
              // SystemConfig 的特殊处理：无参数时返回配置列表
              try {
                data = await config.read();
              } catch (error) {
                BotUtil.makeLog('error', `读取 system 配置列表失败: ${error.message}`, 'ConfigAPI', error);
                throw error;
              }
            } else if (typeof config.read === 'function') {
              // 普通配置：读取完整配置
            data = await config.read();
            } else {
              throw new Error('配置对象不支持 read 方法');
            }
          }

          res.json({
            success: true,
            data
          });
        } catch (error) {
          const errorName = configName || 'unknown';
          BotUtil.makeLog('error', `读取配置失败 [${errorName}]: ${error.message}`, 'ConfigAPI', error);
          res.status(500).json({
            success: false,
            message: '读取配置失败',
            error: error.message,
            configName: errorName,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/:name/write',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        let configName = null;
        try {
          configName = req.params?.name;
          const { data, path: keyPath, backup = true, validate = true } = req.body || {};

          BotUtil.makeLog('info', `收到配置写入请求 [${configName}] path: ${keyPath || 'none'}`, 'ConfigAPI');

          if (!configName) {
            return res.status(400).json({
              success: false,
              message: '配置名称不能为空'
            });
          }

          if (!global.ConfigManager) {
            BotUtil.makeLog('error', '配置管理器未初始化', 'ConfigAPI');
            return res.status(503).json({
              success: false,
              message: '配置管理器未初始化'
            });
          }

          const config = global.ConfigManager.get(configName);

          if (!config) {
            BotUtil.makeLog('error', `配置不存在: ${configName}`, 'ConfigAPI');
            return res.status(404).json({
              success: false,
              message: `配置 ${configName} 不存在`
            });
          }

          // 验证数据
          if (data === undefined || data === null) {
            BotUtil.makeLog('warn', `配置数据为空 [${configName}]`, 'ConfigAPI');
          }

          // 清理数据：对于SystemConfig的子配置，需要获取子配置的schema
          let cleanedData;
          if (keyPath && configName === 'system' && typeof config.getStructure === 'function') {
            // SystemConfig的子配置：获取子配置的schema
            const structure = config.getStructure();
            const subConfig = structure.configs?.[keyPath];
            if (subConfig && subConfig.schema) {
              // 创建临时配置对象，使用子配置的schema
              const tempConfig = { schema: subConfig.schema };
              BotUtil.makeLog('info', `清理子配置数据 [${configName}/${keyPath}]，使用子配置schema`, 'ConfigAPI');
              BotUtil.makeLog('debug', `原始数据: ${JSON.stringify(data).substring(0, 500)}`, 'ConfigAPI');
              cleanedData = cleanConfigData(data, tempConfig);
              BotUtil.makeLog('debug', `清理后数据: ${JSON.stringify(cleanedData).substring(0, 500)}`, 'ConfigAPI');
            } else {
              // 如果没有找到子配置schema，使用默认清理
              BotUtil.makeLog('warn', `未找到子配置schema [${configName}/${keyPath}]，使用默认清理`, 'ConfigAPI');
              cleanedData = cleanConfigData(data, config);
            }
          } else {
            // 普通配置：使用配置对象本身的schema
            cleanedData = cleanConfigData(data, config);
          }

          let result;
          if (keyPath) {
            // 如果有 keyPath，使用 set 方法设置指定路径的值
            if (configName === 'system' && typeof config.write === 'function') {
              // SystemConfig 的特殊处理：keyPath 是子配置名称
              try {
                BotUtil.makeLog('info', `写入 SystemConfig 子配置 [${configName}/${keyPath}]`, 'ConfigAPI');
                result = await config.write(keyPath, cleanedData, { backup, validate });
                BotUtil.makeLog('info', `SystemConfig 子配置写入成功 [${configName}/${keyPath}]`, 'ConfigAPI');
              } catch (subError) {
                BotUtil.makeLog('error', `写入子配置失败 [${configName}/${keyPath}]: ${subError.message}`, 'ConfigAPI', subError);
                throw subError;
              }
            } else if (typeof config.set === 'function') {
              BotUtil.makeLog('info', `使用 set 方法写入配置路径 [${configName}/${keyPath}]`, 'ConfigAPI');
              result = await config.set(keyPath, cleanedData, { backup, validate });
            } else {
              throw new Error('配置对象不支持 set 方法');
            }
          } else {
            // 没有 keyPath，写入完整配置
            if (configName === 'system') {
              throw new Error('SystemConfig 需要指定子配置名称（使用 path 参数）');
            } else if (typeof config.write === 'function') {
              BotUtil.makeLog('info', `写入完整配置 [${configName}]`, 'ConfigAPI');
              result = await config.write(cleanedData, { backup, validate });
              BotUtil.makeLog('info', `配置写入成功 [${configName}]`, 'ConfigAPI');
            } else {
              throw new Error('配置对象不支持 write 方法');
            }
          }

          res.json({
            success: result,
            message: '配置已保存'
          });
        } catch (error) {
          const errorName = configName || req.params?.name || 'unknown';
          BotUtil.makeLog('error', `写入配置失败 [${errorName}]: ${error.message}`, 'ConfigAPI', error);
          res.status(500).json({
            success: false,
            message: '写入配置失败',
            error: error.message,
            configName: errorName,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/:name/merge',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const { name } = req.params;
          const { data, deep = true, backup = true, validate = true } = req.body;

          const config = global.ConfigManager.get(name);

          if (!config) {
            return res.status(404).json({
              success: false,
              message: `配置 ${name} 不存在`
            });
          }

          const result = await config.merge(data, { deep, backup, validate });

          res.json({
            success: result,
            message: '配置已合并'
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '合并配置失败',
            error: error.message
          });
        }
      }
    },

    {
      method: 'DELETE',
      path: '/api/config/:name/delete',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const { name } = req.params;
          const { path: keyPath, backup = true } = req.body;

          if (!keyPath) {
            return res.status(400).json({
              success: false,
              message: '缺少path参数'
            });
          }

          const config = global.ConfigManager.get(name);

          if (!config) {
            return res.status(404).json({
              success: false,
              message: `配置 ${name} 不存在`
            });
          }

          const result = await config.delete(keyPath, { backup });

          res.json({
            success: result,
            message: '配置已删除'
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '删除配置失败',
            error: error.message
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/:name/array/append',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const { name } = req.params;
          const { path: keyPath, value, backup = true, validate = true } = req.body;

          if (!keyPath) {
            return res.status(400).json({
              success: false,
              message: '缺少path参数'
            });
          }

          const config = global.ConfigManager.get(name);

          if (!config) {
            return res.status(404).json({
              success: false,
              message: `配置 ${name} 不存在`
            });
          }

          const result = await config.append(keyPath, value, { backup, validate });

          res.json({
            success: result,
            message: '已追加到数组'
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '追加失败',
            error: error.message
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/:name/array/remove',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const { name } = req.params;
          const { path: keyPath, index, backup = true, validate = true } = req.body;

          if (!keyPath) {
            return res.status(400).json({
              success: false,
              message: '缺少path参数'
            });
          }

          if (index === undefined) {
            return res.status(400).json({
              success: false,
              message: '缺少index参数'
            });
          }

          const config = global.ConfigManager.get(name);

          if (!config) {
            return res.status(404).json({
              success: false,
              message: `配置 ${name} 不存在`
            });
          }

          const result = await config.remove(keyPath, index, { backup, validate });

          res.json({
            success: result,
            message: '已从数组移除'
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '移除失败',
            error: error.message
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/:name/validate',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const { name } = req.params;
          const { data } = req.body;

          const config = global.ConfigManager.get(name);

          if (!config) {
            return res.status(404).json({
              success: false,
              message: `配置 ${name} 不存在`
            });
          }

          const validation = await config.validate(data);

          res.json({
            success: true,
            validation
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '验证失败',
            error: error.message
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/:name/backup',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const { name } = req.params;
          const config = global.ConfigManager.get(name);

          if (!config) {
            return res.status(404).json({
              success: false,
              message: `配置 ${name} 不存在`
            });
          }

          const backupPath = await config.backup();

          res.json({
            success: true,
            backupPath,
            message: '配置已备份'
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '备份失败',
            error: error.message
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/:name/reset',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const { name } = req.params;
          const { backup = true } = req.body;

          const config = global.ConfigManager.get(name);

          if (!config) {
            return res.status(404).json({
              success: false,
              message: `配置 ${name} 不存在`
            });
          }

          const result = await config.reset({ backup });

          res.json({
            success: result,
            message: '配置已重置为默认值'
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '重置失败',
            error: error.message
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/clear-cache',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          global.ConfigManager.clearAllCache();

          res.json({
            success: true,
            message: '已清除所有配置缓存'
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '清除缓存失败',
            error: error.message
          });
        }
      }
    }
  ]
};