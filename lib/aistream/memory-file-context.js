/**
 * 长期记忆文件（~/.xrk/memory）的路径与按事件筛选，供 MemoryStream 等共用。
 */
import path from 'path';
import os from 'os';

export function getMemoryBaseDir() {
  return path.join(os.homedir(), '.xrk', 'memory');
}

export function userMemoryFile(userId) {
  const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getMemoryBaseDir(), `user_${safe}.json`);
}

/** 按当前事件筛选应参与上下文的记忆（群：本群区域 ∪ 私聊保存且未绑定群的全局条） */
export function filterMemoriesForEvent(m, e) {
  if (!m || typeof m !== 'object') return false;
  const inGroup = !!(e?.group_id);
  const groupId = e?.group_id ?? null;
  if (inGroup && groupId) {
    if (m.scene === 'group' && (m.groupId == null || String(m.groupId) === String(groupId))) {
      return true;
    }
    const noGroupBind = m.groupId == null || m.groupId === '';
    if (m.scene === 'private' && noGroupBind) return true;
    return false;
  }
  const scene = e?.user_id ? 'private' : 'default';
  if (m.scene == null || m.scene === '') return true;
  return m.scene === scene;
}
