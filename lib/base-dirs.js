import {
  DEFAULT_CONFIG_DIR,
  SERVER_BOTS_DIR,
  DATA_DIR,
  DATA_UPLOADS_DIR,
  DATA_MEDIA_DIR,
  TEMP_DIR,
  TEMP_HTML_DIR,
  WWW_DIR,
  WWW_MEDIA_DIR,
  WWW_STDIN_DIR,
  RESOURCES_DIR,
  RESOURCES_AIIMAGES_DIR,
  DATA_MESSAGE_JSON_DIR,
  DATA_BANNED_WORDS_DIR,
  DATA_BANNED_WORDS_IMAGES_DIR,
  DATA_BANNED_WORDS_CONFIG_DIR,
  LOGS_DIR,
  PM2_CONFIG_DIR,
} from './config/config-constants.js';

/**
 * 应用基础目录列表（唯一来源，供 app.js / debug.js 等使用）
 * 启动时创建，避免各模块重复 mkdir
 */
export const BASE_DIRS = [
  `./${LOGS_DIR}`,
  './config',
  `./${DEFAULT_CONFIG_DIR}`,
  `./${PM2_CONFIG_DIR}`,
  `./${DATA_DIR}`,
  `./${SERVER_BOTS_DIR}`,
  `./${DATA_UPLOADS_DIR}`,
  `./${DATA_MEDIA_DIR}`,
  `./${RESOURCES_DIR}`,
  `./${RESOURCES_AIIMAGES_DIR}`,
  `./${TEMP_DIR}`,
  `./${TEMP_HTML_DIR}`,
  `./${WWW_DIR}`,
  `./${WWW_MEDIA_DIR}`,
  `./${DATA_MESSAGE_JSON_DIR}`,
  `./${DATA_BANNED_WORDS_DIR}`,
  `./${DATA_BANNED_WORDS_IMAGES_DIR}`,
  `./${DATA_BANNED_WORDS_CONFIG_DIR}`,
  `./${WWW_STDIN_DIR}`,
];
