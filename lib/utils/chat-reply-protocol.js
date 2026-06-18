/**
 * chat.reply 正文协议：文字、[at:QQ]、[回复:ID]。表情包走 emotion 工具，不在此解析。
 */

import { EMOTION_TYPES } from './emotion-categories.js';

export { EMOTION_TYPES } from './emotion-categories.js';

const AT_MARKER = /\[at:(\d{5,10})\]/gi;

const EMOTION_TAG_RE = new RegExp(
  `\\[(${EMOTION_TYPES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\]`
);

/** reply content 校验 */
export function replyContentForbidden(text) {
  const s = String(text ?? '');
  if (EMOTION_TAG_RE.test(s)) return '发表情包请用 emotion 工具，勿在 reply 写 [开心] 等';
  if (/\[CQ:at/i.test(s)) return '禁止 [CQ:at]；群聊@用 [at:数字QQ]';
  const withoutAt = s.replace(AT_MARKER, '');
  if (/@/.test(withoutAt)) return '禁止 @QQ/@昵称；群聊@用 [at:数字QQ]';
  return null;
}

/** [at:QQ] → segment 数组，支持多处、多人 */
export function parseContentToSendSegments(text) {
  const work = String(text ?? '');
  if (!work.trim()) return [];
  const seg = segment;
  const out = [];
  let last = 0;
  let match;
  const re = new RegExp(AT_MARKER.source, 'gi');
  while ((match = re.exec(work)) !== null) {
    if (match.index > last) {
      const chunk = work.slice(last, match.index);
      if (chunk) out.push(chunk);
    }
    out.push(seg.at(match[1]));
    last = match.index + match[0].length;
  }
  if (last < work.length) {
    const chunk = work.slice(last);
    if (chunk) out.push(chunk);
  }
  return out.length ? out : [work];
}

export function segmentsToDisplayText(segments, fallback = '') {
  if (!Array.isArray(segments) || !segments.length) return fallback;
  const parts = segments.map((s) => {
    if (typeof s === 'string') return s;
    if (s?.type === 'at') return `@${s.qq ?? s.data?.qq ?? s.data?.uid ?? ''}`;
    if (s?.type === 'text') return s.text ?? s.data?.text ?? '';
    if (s?.type === 'image') return '[图片]';
    return '';
  });
  const joined = parts.join('').trim();
  return joined || fallback;
}

/** 提取 [回复:ID]，正文转 segment（含 [at:QQ]） */
export function parseReplyContentSegments(text) {
  let replyId = null;
  let work = String(text ?? '');

  const replyShortMatch = work.match(/\[回复:(?:ID:)?(\d+)\]/);
  if (replyShortMatch) {
    replyId = replyShortMatch[1];
    work = work.replace(/\[回复:(?:ID:)?\d+\]/g, '').trim();
  }
  const replyMatch = work.match(/\[CQ:reply,id=(\d+)\]/);
  if (replyMatch) {
    replyId = replyId || replyMatch[1];
    work = work.replace(/\[CQ:reply,id=\d+\]/g, '').trim();
  }

  return { replyId, segments: parseContentToSendSegments(work) };
}

export function contentHasGroupAt(text) {
  return /\[at:\d{5,10}\]/i.test(String(text ?? ''));
}
