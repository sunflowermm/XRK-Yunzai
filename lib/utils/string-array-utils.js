/**
 * 字符串数组归一化（配置 / workflow / MCP 动态 enum 共用）
 */

/**
 * 合并动态 enum 与已持久化值（老配置里可能仍有已下线项）
 * @param {string[]} base
 * @param {unknown} extra 字符串或字符串数组
 * @returns {string[]}
 */
export function mergeUniqueStrings(base = [], extra) {
  const merged = [...(Array.isArray(base) ? base : [])];
  const seen = new Set(merged);
  const items = Array.isArray(extra) ? extra : (extra != null && extra !== '' ? [extra] : []);
  for (const raw of items) {
    const s = String(raw ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    merged.push(s);
  }
  return merged;
}
