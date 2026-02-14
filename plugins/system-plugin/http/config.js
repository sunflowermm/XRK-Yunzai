/**
 * 配置管理API
 * 提供统一的配置文件读写接口
 */
import BotUtil from '../../../lib/util.js';
import { cleanConfigData, flattenStructure, flattenData, unflattenData } from '../../../lib/commonconfig/config-utils.js';

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
      path: '/api/config/:name/read',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        let configName = null;
        try {
          configName = req.params && req.params.name;
          const { path: keyPath } = req.query || {};

          if (!configName) {
            return res.status(400).json({
              success: false,
              message: '配置名称不能为空'
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
          configName = req.params && req.params.name;
          const { data, path: keyPath, backup = true, validate = true } = req.body || {};

          BotUtil.makeLog('debug', `收到配置写入请求 [${configName}] path: ${keyPath || 'none'}`, 'ConfigAPI');

          if (!configName) {
            return res.status(400).json({
              success: false,
              message: '配置名称不能为空'
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

          // 清理数据：将空字符串转换为 null（对于数字字段）
          const cleanedData = cleanConfigData(data, config);

          let result;
          if (keyPath) {
            // 如果有 keyPath，使用 set 方法设置指定路径的值
            if (configName === 'system' && typeof config.write === 'function') {
              // SystemConfig 的特殊处理：keyPath 是子配置名称
              try {
                result = await config.write(keyPath, cleanedData, { backup, validate, silent: true });
              } catch (subError) {
                BotUtil.makeLog('error', `写入子配置失败 [${configName}/${keyPath}]: ${subError.message}`, 'ConfigAPI', subError);
                throw subError;
              }
            } else if (typeof config.set === 'function') {
              result = await config.set(keyPath, cleanedData, { backup, validate, silent: true });
            } else {
              throw new Error('配置对象不支持 set 方法');
            }
          } else {
            // 没有 keyPath，写入完整配置
            if (configName === 'system') {
              throw new Error('SystemConfig 需要指定子配置名称（使用 path 参数）');
            } else if (typeof config.write === 'function') {
              result = await config.write(cleanedData, { backup, validate, silent: true });
            } else {
              throw new Error('配置对象不支持 write 方法');
            }
          }

          res.json({
            success: result,
            message: '配置已保存'
          });
        } catch (error) {
          const errorName = configName || (req.params && req.params.name) || 'unknown';
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
    },

    {
      method: 'GET',
      path: '/api/config/:name/flat-structure',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const { name } = req.params;
          const { path: childPath } = req.query || {};
          const config = global.ConfigManager?.get?.(name);

          // 为了避免前端频繁 404，这里对不存在的配置/子配置返回空结构而不是 404
          if (!config) {
            return res.json({
              success: true,
              flat: [],
              message: `配置 ${name} 不存在，已返回空结构`
            });
          }

          let schema = null;
          
          // 处理 system 配置的子配置
          if (name === 'system' && childPath) {
            const structure = config.getStructure();
            const childConfig = structure.configs && structure.configs[childPath];
            if (childConfig) {
              // 优先使用 schema，如果没有则从 fields 构建
              if (childConfig.schema && childConfig.schema.fields) {
                schema = childConfig.schema;
              } else if (childConfig.fields) {
                schema = { fields: childConfig.fields };
              } else {
                return res.json({
                  success: true,
                  flat: [],
                  message: `子配置 ${childPath} 的 schema 不存在，已返回空结构`
                });
              }
            } else {
              return res.json({
                success: true,
                flat: [],
                message: `子配置 ${childPath} 不存在，已返回空结构`
              });
            }
          } else {
            // 普通配置直接使用 schema
            const structure = config.getStructure();
            if (structure.schema && structure.schema.fields) {
              schema = structure.schema;
            } else if (structure.fields) {
              schema = { fields: structure.fields };
            } else {
              return res.json({
                success: true,
                flat: [],
                message: `配置 ${name} 的 schema 不存在，已返回空结构`
              });
            }
          }

          const flat = flattenStructure(schema);

          res.json({
            success: true,
            flat
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '获取扁平化结构失败',
            error: error.message
          });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/config/:name/flat',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const { name } = req.params;
          const { path: childPath } = req.query || {};
          const config = global.ConfigManager.get(name);

          if (!config) {
            return res.status(404).json({
              success: false,
              message: `配置 ${name} 不存在`
            });
          }

          // 处理 system 配置的子配置
          let data;
          if (name === 'system' && childPath) {
            if (typeof config.read === 'function') {
              data = await config.read(childPath);
            } else {
              return res.status(400).json({
                success: false,
                message: 'SystemConfig 需要指定子配置路径'
              });
            }
          } else {
            data = await config.read();
          }

          const flat = flattenData(data);

          res.json({
            success: true,
            flat
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '获取扁平化数据失败',
            error: error.message
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/:name/batch-set',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const { name } = req.params;
          const { flat, path: childPath, backup = true, validate = true } = req.body;

          if (!flat || typeof flat !== 'object') {
            return res.status(400).json({
              success: false,
              message: '缺少flat参数或格式错误'
            });
          }

          const config = global.ConfigManager.get(name);

          if (!config) {
            return res.status(404).json({
              success: false,
              message: `配置 ${name} 不存在`
            });
          }

          // 将扁平化数据还原为嵌套对象
          const data = unflattenData(flat);
          
          // 获取 schema 用于数据清理
          let schema = null;
          if (name === 'system' && childPath) {
            const structure = config.getStructure();
            const childConfig = structure.configs && structure.configs[childPath];
            schema = childConfig && childConfig.schema || { fields: childConfig && childConfig.fields || {} };
          } else {
            const structure = config.getStructure();
            schema = structure.schema || { fields: structure.fields || {} };
          }
          
          // 清理数据
          const cleanedData = cleanConfigData(data, { schema });

          // 对于批量更新，先读取现有数据，然后合并，确保必需字段不会丢失
          let finalData = cleanedData;
          if (validate) {
            try {
              // 读取现有配置
              let existingData = {};
              if (name === 'system' && childPath) {
                if (typeof config.read === 'function') {
                  existingData = await config.read(childPath) || {};
                }
              } else {
                existingData = await config.read() || {};
              }
              
              // 深度合并：新数据覆盖现有数据，但保留现有数据的其他字段
          const { deepMergeConfig } = await import('../../../lib/commonconfig/config-utils.js');
              finalData = deepMergeConfig(existingData, cleanedData, schema);
            } catch (e) {
              // 如果读取失败，使用新数据（可能是首次创建）
              finalData = cleanedData;
            }
          }

          // 写入配置
          let result;
          if (name === 'system' && childPath) {
            if (typeof config.write === 'function') {
              result = await config.write(childPath, finalData, { backup, validate });
            } else {
              return res.status(400).json({
                success: false,
                message: 'SystemConfig 需要指定子配置路径'
              });
            }
          } else {
            result = await config.write(finalData, { backup, validate, silent: true });
          }

          res.json({
            success: result,
            message: '配置已批量更新'
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '批量设置失败',
            error: error.message
          });
        }
      }
    }
  ]
};