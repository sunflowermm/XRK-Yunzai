/**
 * 配置管理API
 * 使用 Bot.ConfigManager 提供配置读写
 */
import cfg from '../../../lib/config/config.js';
import { cleanConfigData, flattenStructure, flattenData, unflattenData, deepMergeConfig, resolveConfigSchema } from '../../../lib/commonconfig/config-utils.js';
import { sanitizeErrorMessage } from '../../../lib/http/utils/helpers.js';

function getConfigManager(Bot) {
  return Bot?.ConfigManager;
}

/** 配置保存后清除 cfg 缓存，确保 LLMFactory 等读取到最新 providers 子配置 */
function invalidateCfgCache(configName) {
  try {
    if (cfg?.clearConfig) cfg.clearConfig(configName);
  } catch (err) {
    Bot.makeLog('debug', `[config] clearConfig 跳过: ${err?.message || err}`, 'ConfigAPI');
  }
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
        try {
          const cm = getConfigManager(Bot);
          if (!cm) return res.status(503).json({ success: false, message: '配置管理器未就绪' });
          const configList = cm.getList();
          
          res.json({
            success: true,
            configs: configList,
            count: configList.length
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '获取配置列表失败',
          });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/config/:name/structure',
      handler: async (req, res, Bot) => {
        try {
          const { name } = req.params;
          const cm = getConfigManager(Bot);
          if (!cm) return res.status(503).json({ success: false, message: '配置管理器未就绪' });
          const config = cm.get(name);

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
          });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/config/:name/read',
      handler: async (req, res, Bot) => {
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

          const config = getConfigManager(Bot).get(configName);

          if (!config) {
            return res.status(404).json({
              success: false,
              message: `配置 ${configName} 不存在`
            });
          }

          let data;
          const isMultiFile = config.configFiles && typeof config.read === 'function';
          if (keyPath) {
            // 如果有 keyPath，读取指定路径的配置值
            if (isMultiFile) {
              try {
                data = await config.read(keyPath);
              } catch (subError) {
                Bot.makeLog('error', `读取子配置失败 [${configName}/${keyPath}]: ${subError.message}`, 'ConfigAPI', subError);
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
            if (isMultiFile) {
              try {
                data = await config.read();
              } catch (error) {
                Bot.makeLog('error', `读取多文件配置列表失败 [${configName}]: ${error.message}`, 'ConfigAPI', error);
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
          Bot.makeLog('error', `读取配置失败 [${errorName}]: ${error.message}`, 'ConfigAPI', error);
          res.status(500).json({
            success: false,
            message: '读取配置失败',
            configName: errorName,
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/:name/write',
      handler: async (req, res, Bot) => {
        let configName = null;
        try {
          configName = req.params && req.params.name;
          const { data, path: keyPath, backup = true, validate = true } = req.body || {};

          Bot.makeLog('debug', `收到配置写入请求 [${configName}] path: ${keyPath || 'none'}`, 'ConfigAPI');

          if (!configName) {
            return res.status(400).json({
              success: false,
              message: '配置名称不能为空'
            });
          }

          const config = getConfigManager(Bot).get(configName);

          if (!config) {
            Bot.makeLog('error', `配置不存在: ${configName}`, 'ConfigAPI');
            return res.status(404).json({
              success: false,
              message: `配置 ${configName} 不存在`
            });
          }

          // 验证数据
          if (data === undefined || data === null) {
            Bot.makeLog('warn', `配置数据为空 [${configName}]`, 'ConfigAPI');
          }

          // 清理数据：将空字符串转换为 null（对于数字字段）
          const cleanedData = cleanConfigData(data, config);

          let result;
          const isMultiFile = config.configFiles && typeof config.write === 'function';
          if (keyPath) {
            // 如果有 keyPath，使用 set 方法设置指定路径的值
            if (isMultiFile) {
              try {
                result = await config.write(keyPath, cleanedData, { backup, validate, silent: true });
              } catch (subError) {
                Bot.makeLog('error', `写入子配置失败 [${configName}/${keyPath}]: ${subError.message}`, 'ConfigAPI', subError);
                throw subError;
              }
            } else if (typeof config.set === 'function') {
              result = await config.set(keyPath, cleanedData, { backup, validate, silent: true });
            } else {
              throw new Error('配置对象不支持 set 方法');
            }
          } else {
            // 没有 keyPath，写入完整配置
            if (isMultiFile) {
              throw new Error('多文件配置需要指定子配置名称（使用 path 参数）');
            } else if (typeof config.write === 'function') {
              result = await config.write(cleanedData, { backup, validate, silent: true });
            } else {
              throw new Error('配置对象不支持 write 方法');
            }
          }

          invalidateCfgCache(configName);

          res.json({
            success: result,
            message: '配置已保存'
          });
        } catch (error) {
          const errorName = configName || (req.params && req.params.name) || 'unknown';
          Bot.makeLog('error', `写入配置失败 [${errorName}]: ${error.message}`, 'ConfigAPI', error);
          res.status(500).json({
            success: false,
            message: '写入配置失败',
            configName: errorName,
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/:name/merge',
      handler: async (req, res, Bot) => {
        try {
          const { name } = req.params;
          const { data, deep = true, backup = true, validate = true } = req.body;

          const config = getConfigManager(Bot).get(name);

          if (!config) {
            return res.status(404).json({
              success: false,
              message: `配置 ${name} 不存在`
            });
          }

          const result = await config.merge(data, { deep, backup, validate });

          invalidateCfgCache(name);

          res.json({
            success: result,
            message: '配置已合并'
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '合并配置失败',
          });
        }
      }
    },

    {
      method: 'DELETE',
      path: '/api/config/:name/delete',
      handler: async (req, res, Bot) => {
        try {
          const { name } = req.params;
          const { path: keyPath, backup = true } = req.body;

          if (!keyPath) {
            return res.status(400).json({
              success: false,
              message: '缺少path参数'
            });
          }

          const config = getConfigManager(Bot).get(name);

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
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/:name/array/append',
      handler: async (req, res, Bot) => {
        try {
          const { name } = req.params;
          const { path: keyPath, value, backup = true, validate = true } = req.body;

          if (!keyPath) {
            return res.status(400).json({
              success: false,
              message: '缺少path参数'
            });
          }

          const config = getConfigManager(Bot).get(name);

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
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/:name/array/remove',
      handler: async (req, res, Bot) => {
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

          const config = getConfigManager(Bot).get(name);

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
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/:name/validate',
      handler: async (req, res, Bot) => {
        try {
          const { name } = req.params;
          const { data } = req.body;

          const config = getConfigManager(Bot).get(name);

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
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/:name/backup',
      handler: async (req, res, Bot) => {
        try {
          const { name } = req.params;
          const config = getConfigManager(Bot).get(name);

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
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/:name/reset',
      handler: async (req, res, Bot) => {
        try {
          const { name } = req.params;
          const { backup = true } = req.body;

          const config = getConfigManager(Bot).get(name);

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
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/clear-cache',
      handler: async (req, res, Bot) => {
        try {
          getConfigManager(Bot).clearAllCache();

          res.json({
            success: true,
            message: '已清除所有配置缓存'
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '清除缓存失败',
          });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/config/:name/flat-structure',
      handler: async (req, res, Bot) => {
        const { name } = req.params;
        const { path: childPath } = req.query || {};
        const cm = getConfigManager(Bot);
        if (!cm) return res.status(503).json({ success: false, message: '配置管理器未就绪' });

        const config = cm.get(name);
        if (!config) {
          return res.json({ success: true, flat: [], message: `配置 ${name} 不存在，已返回空结构` });
        }

        try {
          if (config.configFiles && !childPath) {
            return res.status(400).json({
              success: false,
              message: '多文件配置需要指定子配置路径（path 参数）'
            });
          }
          const structure = config.getStructure();
          let schema = null;
          if (childPath) {
            schema = resolveConfigSchema(structure, childPath);
            if (!schema?.fields || Object.keys(schema.fields).length === 0) {
              return res.json({ success: true, flat: [], message: `子配置 ${childPath} 不存在或无 schema` });
            }
          } else {
            schema = resolveConfigSchema(structure);
            if (!schema?.fields || Object.keys(schema.fields).length === 0) {
              return res.json({ success: true, flat: [], message: `配置 ${name} 的 schema 不存在` });
            }
          }
          const flat = flattenStructure(schema);
          return res.json({ success: true, flat });
        } catch (error) {
          Bot.makeLog('warn', `[config] flat-structure ${name} 异常: ${error.message}`, 'ConfigAPI');
          return res.json({ success: true, flat: [], message: sanitizeErrorMessage(error, '获取结构异常，已返回空') });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/config/:name/flat',
      handler: async (req, res, Bot) => {
        const { name } = req.params;
        const { path: childPath } = req.query || {};
        const cm = getConfigManager(Bot);
        if (!cm) return res.status(503).json({ success: false, message: '配置管理器未就绪' });

        const config = cm.get(name);
        if (!config) {
          return res.status(404).json({ success: false, message: `配置 ${name} 不存在` });
        }

        try {
          let data;
          if (config.configFiles) {
            if (!childPath) {
              return res.status(400).json({ success: false, message: '多文件配置需要指定子配置路径（path 参数）' });
            }
            data = typeof config.read === 'function' ? await config.read(childPath) : {};
          } else {
            data = await config.read();
          }
          const flat = flattenData(data ?? {});
          return res.json({ success: true, flat });
        } catch (error) {
          Bot.makeLog('warn', `[config] flat ${name} 异常: ${error.message}`, 'ConfigAPI');
          return res.json({ success: true, flat: {}, message: sanitizeErrorMessage(error, '读取失败，已返回空数据') });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/config/:name/batch-set',
      handler: async (req, res, Bot) => {
        try {
          const { name } = req.params;
          const { flat, path: childPath, backup = true, validate = true } = req.body;

          if (!flat || typeof flat !== 'object') {
            return res.status(400).json({
              success: false,
              message: '缺少flat参数或格式错误'
            });
          }

          const config = getConfigManager(Bot).get(name);

          if (!config) {
            return res.status(404).json({
              success: false,
              message: `配置 ${name} 不存在`
            });
          }

          if (config.configFiles && !childPath) {
            return res.status(400).json({
              success: false,
              message: '多文件配置需要指定 path 参数'
            });
          }

          // 将扁平化数据还原为嵌套对象
          const data = unflattenData(flat);
          
          const structure = config.getStructure();
          const schema = resolveConfigSchema(structure, childPath || undefined);
          const cleanedData = cleanConfigData(data, { schema });

          // 对于批量更新，先读取现有数据，然后合并，确保必需字段不会丢失
          let finalData = cleanedData;
          if (validate) {
            try {
              let existingData = {};
              if (config.configFiles && childPath) {
                if (typeof config.readStored === 'function') {
                  const all = await config.readStored(false);
                  existingData = all?.[childPath] ?? {};
                } else if (typeof config.read === 'function') {
                  existingData = await config.read(childPath) || {};
                }
              } else if (typeof config.readStored === 'function') {
                existingData = await config.readStored(false) || {};
              } else {
                existingData = await config.read() || {};
              }
              // 仅合并 data 层，避免把 default_config 模板写入 data 文件
              finalData = deepMergeConfig(existingData, cleanedData, schema);
            } catch (e) {
              finalData = cleanedData;
            }
          }

          // 写入配置
          let result;
          if (config.configFiles && childPath) {
            if (typeof config.write === 'function') {
              result = await config.write(childPath, finalData, { backup, validate });
            } else {
              return res.status(400).json({
                success: false,
                message: '多文件配置需要指定子配置路径'
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
          });
        }
      }
    }
  ]
};