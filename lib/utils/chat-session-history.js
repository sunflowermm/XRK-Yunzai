/**
 * 群聊笔录单例（避免 aistream FileUtils.toImportUrl ?t= 热重载拆出多份 Map）。
 */
export const chatSessionHistory = new Map();
