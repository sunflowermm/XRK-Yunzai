import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

export default class ApiLoader {
  static apis = new Map();

  static async load() {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    
    try {
      const files = await fs.readdir(__dirname);
      const apiFiles = files.filter(file => 
        file.endsWith('.js') && 
        file !== 'loader.js' &&
        !file.startsWith('.')
      );

      for (const file of apiFiles) {
        try {
          const filePath = path.join(__dirname, file);
          const module = await import(`file://${filePath}`);
          
          if (module.default && typeof module.default === 'object') {
            const apiName = path.basename(file, '.js');
            this.apis.set(apiName, module.default);
            logger.info(`[ApiLoader] 加载模块: ${apiName}`);
          }
        } catch (error) {
          logger.error(`[ApiLoader] 加载模块失败: ${file}`, error);
        }
      }

      return this.apis;
    } catch (error) {
      logger.error('[ApiLoader] 加载API目录失败', error);
      throw error;
    }
  }

  static register(app, bot) {
    // 全局中间件
    app.use((req, res, next) => {
      req.bot = bot;
      next();
    });

    // 注册所有API路由
    for (const [name, api] of this.apis) {
      if (api.routes && Array.isArray(api.routes)) {
        for (const route of api.routes) {
          const { method, path, handler } = route;
          
          if (!method || !path || !handler) continue;

          const lowerMethod = method.toLowerCase();
          if (typeof app[lowerMethod] !== 'function') {
            logger.error(`[ApiLoader] 不支持的HTTP方法: ${method}`);
            continue;
          }

          if (Array.isArray(handler)) {
            app[lowerMethod](path, ...handler);
          } else {
            app[lowerMethod](path, (req, res) => {
              handler(req, res, bot);
            });
          }
        }
      }

      // 调用初始化
      if (typeof api.init === 'function') {
        api.init(app, bot);
      }
    }
  }
}