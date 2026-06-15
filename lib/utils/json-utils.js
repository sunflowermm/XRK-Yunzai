/**
 * JSON 解析工具（流式 NDJSON/SSE 分片安全解析）
 */
export function tryParseJson(text) {
  if (text == null) return null;
  const raw = typeof text === 'string' ? text.trim() : String(text).trim();
  if (!raw || raw === '[DONE]') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
