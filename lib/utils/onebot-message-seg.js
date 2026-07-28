/**
 * OneBot 消息段：事件/群历史多为扁平；get_msg 可能带 data 嵌套。
 */
export function flattenMessageSeg(seg) {
  if (!seg || typeof seg !== 'object') return seg;
  const data = seg.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return seg;
  const { data: _d, ...rest } = seg;
  return { ...data, ...rest };
}

export function flattenMessageSegs(message) {
  if (!Array.isArray(message)) return [];
  return message.map((s) => flattenMessageSeg(s)).filter(Boolean);
}

export function segText(seg) {
  const s = flattenMessageSeg(seg);
  return s?.text != null ? String(s.text) : '';
}

export function segQq(seg) {
  const s = flattenMessageSeg(seg);
  const qq = s?.qq ?? s?.user_id;
  return qq != null && String(qq).trim() !== '' ? String(qq) : '';
}

export function segReplyId(seg) {
  const s = flattenMessageSeg(seg);
  const id = s?.id;
  return id != null && String(id).trim() !== '' ? String(id).trim() : '';
}

export function segFileName(seg) {
  const s = flattenMessageSeg(seg);
  const name = s?.name ?? s?.file_name ?? s?.file;
  return name != null && String(name).trim() !== '' ? String(name).trim() : '未知';
}
