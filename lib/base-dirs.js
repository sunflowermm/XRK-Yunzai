/**
 * 应用基础目录列表（唯一来源，供 app.js / debug.js 等使用）
 * 启动时创建，避免各模块重复 mkdir
 */
export const BASE_DIRS = [
  './logs',
  './config',
  './config/default_config',
  './config/pm2',
  './data',
  './data/bots',
  './data/backups',
  './data/server_bots',
  './data/importsJson',
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
