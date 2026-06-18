/**
 * 工具模块统一导出
 * 供 lib 内外部按需引用，避免散落路径
 */

export { FileUtils } from './file-utils.js';
export { FileLoader } from './file-loader.js';
export { ObjectUtils } from './object-utils.js';
export { PluginDirScanner } from './plugin-dir-scanner.js';
export { HotReloadBase } from './hot-reload-base.js';
export { tryParseJson } from './json-utils.js';
export { RedirectManager, CDNManager, ProxyManager, HTTPBusinessLayer } from './http-business.js';
export { BaseTools } from './base-tools.js';
export { LRUCache } from './lru-cache.js';
export { parseByteSize, formatBytes, formatDuration } from './byte-size.js';
export { exec } from './exec-async.js';
export { getDefaultDesktopDirSync } from './user-dirs.js';
export { isPathInside, realpathSyncOrResolve } from './path-guards.js';
export { readTextFileUnderWorkspaceRoot } from './safe-workspace-read.js';
export { InputValidator } from './input-validator.js';
export {
  isHttpRef,
  isEntryMediaRelPath,
  readImageBuffer,
  persistEntryMedia,
  resolveOutboundFile,
  materializeMediaRefToPath,
} from './outbound-media.js';
export { getAistreamConfigOptional } from './aistream-config.js';
export {
  appendAgentWorkspaceToPrompt,
  mergeAgentWorkspaceIntoMessages,
  buildAgentWorkspaceSection,
} from './agent-workspace.js';
export {
  getProjectRoot,
  resolveAgentWorkspaceAbs,
  ensureAgentWorkspaceSync,
  getConfiguredDefaultWorkspaceId,
  resolveWorkspaceIdFromContext,
  resolveWorkspaceAbsFromContext,
} from './agent-workspace-paths.js';
export { getServerUploadLimits } from './upload-limits.js';
export { parseMultipartData } from './multipart-parser.js';
export { mergeUniqueStrings } from './string-array-utils.js';
export {
  contentHasGroupAt,
  EMOTION_TYPES,
  parseContentToSendSegments,
  parseReplyContentSegments,
  replyContentForbidden,
  segmentsToDisplayText
} from './chat-reply-protocol.js';
export {
  EMOTION_CATEGORIES,
  EMOTION_IMAGE_EXTS,
  EMOJI_REACTION_ALIASES,
  EMOJI_REACTION_TYPES,
  formatEmotionTypeList,
  getEmojiReactionIds,
  normalizeEmotionType
} from './emotion-categories.js';
export {
  resolveProjectPath,
  DATA_DIR,
  DATA_MEDIA_DIR,
  DATA_UPLOADS_DIR,
  DATA_TRASH_DIR,
  DATA_AI_CONFIG_REL,
  DATA_DB_DEFAULT_REL,
  DATA_MESSAGE_JSON_DIR,
  DATA_BANNED_WORDS_DIR,
  DATA_BANNED_WORDS_IMAGES_DIR,
  DATA_BANNED_WORDS_CONFIG_DIR,
  APP_ENTRY_REL,
  LOGS_DIR,
  PM2_CONFIG_DIR,
  SERVER_BOTS_DIR,
  DEFAULT_CONFIG_DIR,
} from '../config/config-constants.js';
