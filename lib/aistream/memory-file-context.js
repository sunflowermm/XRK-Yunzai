/**
 * 长期记忆文件（~/.xrk/memory）的加载与筛选，供 ChatStream / MemoryStream 共用。
 */
import path from 'path';
import os from 'os';
import { FileUtils } from '../utils/file-utils.js';

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

export function scoreMemoryForQuery(m, query, e) {
  const kw = (query || '').toLowerCase();
  if (!kw) return 0;
  const text = (m.content || '').toLowerCase();
  if (!text) return 0;
  if (text === kw) return 100;
  if (text.includes(kw)) return 80 + Math.min(20, kw.length);
  const set = new Set(text);
  let overlap = 0;
  for (const ch of kw) if (set.has(ch)) overlap++;
  let score = (overlap / Math.max(1, kw.length)) * 60;
  const gid = e?.group_id ?? null;
  if (gid && m.groupId && String(m.groupId) === String(gid)) {
    score += 15;
  }
  return score;
}

export async function loadFilteredMemoriesForEvent(e) {
  const userId = e?.user_id || e?.user?.id || 'default';
  const raw = await FileUtils.readFile(userMemoryFile(userId));
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter(m => filterMemoriesForEvent(m, e));
  } catch {
    return [];
  }
}
