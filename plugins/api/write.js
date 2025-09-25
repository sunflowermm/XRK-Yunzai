import fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';

/**
 * 判断是否为对象
 */
function isObject(item) {
  return item && typeof item === 'object' && !Array.isArray(item);
}

/**
 * 深度合并对象
 */
function deepMerge(target, source) {
  const output = { ...target };
  
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          output[key] = source[key];
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else {
        output[key] = source[key];
      }
    });
  }
  
  return output;
}

/**
 * 更新嵌套对象的值
 */
function updateNestedValue(obj, path, value) {
  const keys = path.split('.');
  const result = { ...obj };
  let current = result;
  
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!current[key] || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  
  current[keys[keys.length - 1]] = value;
  return result;
}

/**
 * 数据编辑管理API
 * 支持JSON和YAML文件的读写操作
 */
export default {
  name: 'data-editor',
  dsc: '数据编辑管理API - 支持JSON和YAML文件操作',
  priority: 75,

  routes: [
    {
      method: 'GET',
      path: '/api/data/read',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const { filePath, encoding = 'utf8' } = req.query;
          
          if (!filePath) {
            return res.status(400).json({ 
              success: false, 
              message: '缺少文件路径参数' 
            });
          }
          
          const normalizedPath = path.normalize(filePath);
          if (normalizedPath.includes('..')) {
            return res.status(403).json({ 
              success: false, 
              message: '非法路径访问' 
            });
          }
          
          try {
            await fs.access(normalizedPath);
          } catch {
            return res.status(404).json({ 
              success: false, 
              message: '文件不存在' 
            });
          }

          const content = await fs.readFile(normalizedPath, encoding);
          const ext = path.extname(normalizedPath).toLowerCase();
          
          let data;
          let fileType;
          if (ext === '.json') {
            data = JSON.parse(content);
            fileType = 'json';
          } else if (['.yml', '.yaml'].includes(ext)) {
            data = yaml.parse(content);
            fileType = 'yaml';
          } else {
            try {
              data = JSON.parse(content);
              fileType = 'json';
            } catch {
              data = content;
              fileType = 'text';
            }
          }
          
          const stats = await fs.stat(normalizedPath);
          
          res.json({ 
            success: true, 
            data,
            metadata: {
              path: normalizedPath,
              type: fileType,
              size: stats.size,
              modified: stats.mtime,
              created: stats.birthtime
            }
          });
        } catch (error) {
          logger.error('[Data Editor API] 文件读取失败', error);
          
          if (error instanceof SyntaxError || error.name === 'YAMLParseError') {
            return res.status(400).json({ 
              success: false, 
              message: '文件格式错误',
              error: error.message 
            });
          }
          
          res.status(500).json({ 
            success: false, 
            message: '文件读取失败',
            error: error.message 
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/data/write',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        try {
          const { 
            filePath, 
            data, 
            format,
            operation = 'overwrite',
            createIfNotExist = true,
            backup = true,
            encoding = 'utf8',
            options = {}
          } = req.body;

          if (!filePath || data === undefined) {
            return res.status(400).json({ 
              success: false, 
              message: '缺少必要参数' 
            });
          }

          const normalizedPath = path.normalize(filePath);
          if (normalizedPath.includes('..')) {
            return res.status(403).json({ 
              success: false, 
              message: '非法路径访问' 
            });
          }

          const ext = path.extname(normalizedPath).toLowerCase();
          const fileFormat = format || (ext === '.json' ? 'json' : 
                            ['.yml', '.yaml'].includes(ext) ? 'yaml' : 'json');

          let fileExists = true;
          try {
            await fs.access(normalizedPath);
          } catch {
            fileExists = false;
            if (!createIfNotExist) {
              return res.status(404).json({ 
                success: false, 
                message: '文件不存在且不允许创建' 
              });
            }
          }

          let finalData = data;

          if (fileExists && operation !== 'overwrite') {
            const existingContent = await fs.readFile(normalizedPath, encoding);
            let existingData;
            
            try {
              existingData = fileFormat === 'json' 
                ? JSON.parse(existingContent)
                : yaml.parse(existingContent);
            } catch (error) {
              return res.status(400).json({ 
                success: false, 
                message: '现有文件格式错误',
                error: error.message 
              });
            }

            switch (operation) {
              case 'merge':
                if (isObject(existingData) && isObject(data)) {
                  finalData = deepMerge(existingData, data);
                } else {
                  finalData = data;
                }
                break;
                
              case 'append':
                if (Array.isArray(existingData)) {
                  finalData = existingData.concat(Array.isArray(data) ? data : [data]);
                } else {
                  return res.status(400).json({ 
                    success: false, 
                    message: 'append操作仅支持数组' 
                  });
                }
                break;
                
              case 'update':
                if (req.body.path && isObject(existingData)) {
                  finalData = updateNestedValue(existingData, req.body.path, data);
                } else {
                  finalData = data;
                }
                break;
            }
          }

          let backupPath = null;
          if (backup && fileExists) {
            backupPath = `${normalizedPath}.backup.${Date.now()}`;
            await fs.copyFile(normalizedPath, backupPath);
          }

          const dir = path.dirname(normalizedPath);
          await fs.mkdir(dir, { recursive: true });

          let content;
          if (fileFormat === 'json') {
            const indent = options.indent || 2;
            content = JSON.stringify(finalData, null, indent);
          } else {
            const yamlOptions = {
              indent: options.indent || 2,
              ...options
            };
            content = yaml.stringify(finalData, yamlOptions);
          }

          await fs.writeFile(normalizedPath, content, encoding);

          res.json({ 
            success: true, 
            message: `${fileFormat.toUpperCase()}文件写入成功`,
            metadata: {
              path: normalizedPath,
              format: fileFormat,
              operation,
              backup: backupPath
            }
          });
        } catch (error) {
          logger.error('[Data Editor API] 文件写入失败', error);
          res.status(500).json({ 
            success: false, 
            message: '文件写入失败',
            error: error.message 
          });
        }
      }
    }
  ],

  init(app, Bot) {
    logger.info('[Data Editor API] 数据编辑API已加载');
    logger.info('[Data Editor API] 支持的功能：JSON/YAML 文件读写操作');
  }
};