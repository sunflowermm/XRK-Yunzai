/** chat reply/emotion 等对用户可见工具的 MCP 回执文案 */

export function createUserVisibleTurnState() {
  return {
    hasSentEmotion: false,
    lastEmotionSummary: '',
    hasSentReply: false,
    lastReplySummary: ''
  };
}

export const TOOL_DELIVERED_FOOTER = '已送达。';

export function formatSessionWhere(e) {
  if (e?.group_id) return `群 ${e.group_id}`;
  if (e?.user_id) return `用户 ${e.user_id}(私聊)`;
  return '当前会话';
}

export function formatUserVisibleSentAck(where, summary) {
  const line = String(summary ?? '').trim();
  if (!line) {
    return `你未向${where}发出新的可见内容。\n${TOOL_DELIVERED_FOOTER}`;
  }
  return `你已在${where}发出：${line}。用户在 QQ 里已能看到。\n${TOOL_DELIVERED_FOOTER}`;
}

export function formatUserVisibleDuplicateAck(where, alreadySent, attemptedTool) {
  const prev = String(alreadySent ?? '').trim();
  const tool = String(attemptedTool ?? 'reply').trim();
  return `你已在本次对话中向${where}发出过：${prev || '可见内容'}，用户已看到。本次 ${tool} 未再发送。\n${TOOL_DELIVERED_FOOTER}`;
}

export function formatDeliveredAck(where, sentLines) {
  const items = (Array.isArray(sentLines) ? sentLines : [sentLines]).map((s) => String(s ?? '').trim()).filter(Boolean);
  if (!items.length) {
    return `你未向${where}发出可见文字。\n${TOOL_DELIVERED_FOOTER}`;
  }
  const body = items.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return `你已在${where}发出 ${items.length} 条文字：\n${body}\n用户在 QQ 里已能看到。若无其它待办，本轮结束。\n${TOOL_DELIVERED_FOOTER}`;
}

export function formatEmotionDeliveredAck(where, emotionType, text = '') {
  const t = String(text ?? '').trim();
  const summary = t ? `表情包(${emotionType}) 与附言「${t}」` : `表情包(${emotionType})`;
  const hint = t
    ? '附言已随表情包发出，通常不必再 reply 重复同一句话。'
    : '若用户只要表情，保持无附言即可。';
  return `你已在${where}发出${summary}。用户在 QQ 里已能看到。${hint}\n${TOOL_DELIVERED_FOOTER}`;
}

export function formatEmotionSkippedAck(where, lastSent) {
  return formatUserVisibleDuplicateAck(where, lastSent, 'emotion');
}

export function actionAck(detail) {
  const line = String(detail ?? '').trim();
  if (!line) return TOOL_DELIVERED_FOOTER;
  return `${line}\n${TOOL_DELIVERED_FOOTER}`;
}

export function describeEmotionSent(emotionType, text = '') {
  const t = String(text ?? '').trim();
  return t ? `表情包(${emotionType}) 与附言「${t}」` : `表情包(${emotionType})`;
}

function normalizeVisibleCompare(text) {
  return String(text ?? '')
    .replace(/\[回复:\d+\]/gi, '')
    .replace(/\[at:\d{5,10}\]/gi, '')
    .replace(/[，。！？~、|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 与已发可见内容高度重叠时不再发到 QQ */
export function isOverlappingUserVisible(nextText, prevText) {
  const a = normalizeVisibleCompare(nextText);
  const b = normalizeVisibleCompare(prevText);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const words = (s) => s.split(/\s+/).filter((w) => w.length >= 4);
  const aw = words(a);
  const bw = words(b);
  if (!bw.length) return false;
  let hit = 0;
  for (const w of bw) {
    if (aw.some((x) => x.includes(w) || w.includes(x))) hit++;
  }
  return hit / bw.length >= 0.45;
}
