/**
 * Agent 会话 revision：用于工作流结果缓存与会话态（群历史、记忆）的一致性。
 * 参考 LangGraph / OpenAI Agents 等：可变上下文用 monotonic revision，而非缓存整轮 Agent 输出。
 */

/** @type {Map<string, number>} */
const revisions = new Map();

/** 有 MCP/函数副作用、默认禁止结果缓存的工作流名 */
export const STATEFUL_STREAM_NAMES = new Set([
  'chat',
  'chat-merged',
  'tools',
  'browser',
  'desktop',
  'memory',
  'web',
]);

/**
 * @param {object|null|undefined} e
 * @returns {string}
 */
export function buildAgentSessionKey(e) {
  if (!e || typeof e !== 'object') return 'global';
  const selfId = e.self_id != null ? String(e.self_id) : 'unknown';
  if (e.group_id != null && e.group_id !== '') {
    return `g:${selfId}:${String(e.group_id)}`;
  }
  if (e.user_id != null && e.user_id !== '') {
    return `p:${selfId}:${String(e.user_id)}`;
  }
  if (e.device_id != null && e.device_id !== '') {
    return `d:${selfId}:${String(e.device_id)}`;
  }
  return `global:${selfId}`;
}

/**
 * @param {string} sessionKey
 * @returns {number}
 */
export function getAgentSessionRevision(sessionKey) {
  if (!sessionKey) return 0;
  return revisions.get(sessionKey) ?? 0;
}

/**
 * 会话态变更（新消息、Bot 回复、工具摘要、清空对话、记忆写入）时调用。
 * @param {string} sessionKey
 * @returns {number} 新 revision
 */
export function bumpAgentSessionRevision(sessionKey) {
  if (!sessionKey) return 0;
  const next = (revisions.get(sessionKey) ?? 0) + 1;
  revisions.set(sessionKey, next);
  return next;
}

/**
 * @param {object|null|undefined} e
 * @returns {number}
 */
export function bumpAgentSessionForEvent(e) {
  return bumpAgentSessionRevision(buildAgentSessionKey(e));
}

export function resetAgentSessionRevisions() {
  revisions.clear();
}

/**
 * @param {object|null|undefined} stream
 * @returns {boolean}
 */
export function isSideEffectStream(stream) {
  if (!stream) return true;
  if (STATEFUL_STREAM_NAMES.has(stream.name)) return true;
  if ((stream.mcpTools?.size ?? 0) > 0) return true;
  if ((stream.functions?.size ?? 0) > 0) return true;
  return false;
}
