import { DEFAULT_CONFIG_DIR, SERVER_BOTS_DIR } from './config/config-constants.js';

/**
 * 应用基础目录列表（唯一来源，供 app.js / debug.js 等使用）
 * 启动时创建，避免各模块重复 mkdir
 */
export const BASE_DIRS = [
  './logs',
  './config',
  `./${DEFAULT_CONFIG_DIR}`,
  './config/pm2',
  './data',
  `./${SERVER_BOTS_DIR}`,
  './data/uploads',
  './data/media',
  './resources',
  './resources/aiimages',
  './temp',
  './temp/html',
  './www',
  './www/media',
  './www/stdin'
];
