/**
 * 合并转发「伪造聊天记录」：供 #制造消息 插件与 chat.forgeForward MCP 共用
 */
import moment from 'moment';

export const FABRICATOR_HELP = `📝 制造消息

【单条】QQ|昵称|内容|时间(可选)
【多条】用 || 分隔

QQ：数字 / me|我 / bot|机器人
时间：-5分钟、刚刚、昨天、14:30、2024-01-01 12:00:00（可省略=现在）
内容：[图片:URL] [图:URL] [视频:URL]，换行用 \\n`;

/**
 * @param {string} qq
 * @param {{ userId?: string|number, botUin?: string|number }} ctx
 */
export function parseFabricatorQQ(qq, ctx = {}) {
  const raw = String(qq ?? '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const keywords = {
    me: ctx.userId,
    我: ctx.userId,
    bot: ctx.botUin,
    机器人: ctx.botUin
  };
  if (keywords[lower] != null && String(keywords[lower]).trim() !== '') {
    return String(keywords[lower]);
  }
  if (/^\d+$/.test(raw)) return raw;
  return null;
}

/** @param {string|undefined} timeStr */
export function parseFabricatorTime(timeStr) {
  const t = String(timeStr ?? '').trim();
  if (!t) return Math.floor(Date.now() / 1000);

  const patterns = [
    { regex: /^-(\d+)秒?$/i, unit: 'seconds' },
    { regex: /^-(\d+)分(钟)?$/i, unit: 'minutes' },
    { regex: /^-(\d+)(小)?时$/i, unit: 'hours' },
    { regex: /^-(\d+)天$/i, unit: 'days' },
    { regex: /^刚刚$/i, value: 0 },
    { regex: /^昨天$/i, value: -1, unit: 'days' },
    { regex: /^前天$/i, value: -2, unit: 'days' }
  ];

  for (const pattern of patterns) {
    const match = t.match(pattern.regex);
    if (match) {
      const value = pattern.value !== undefined ? pattern.value : -parseInt(match[1], 10);
      const unit = pattern.unit || 'seconds';
      return moment().add(value, unit).unix();
    }
  }

  const parsedTime = moment(
    t,
    [
      'YYYY-MM-DD HH:mm:ss',
      'YYYY-MM-DD HH:mm',
      'YYYY/MM/DD HH:mm:ss',
      'YYYY/MM/DD HH:mm',
      'MM-DD HH:mm',
      'MM/DD HH:mm',
      'HH:mm:ss',
      'HH:mm'
    ],
    true
  );

  if (parsedTime.isValid()) {
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) {
      return moment(`${moment().format('YYYY-MM-DD')} ${t}`).unix();
    }
    return parsedTime.unix();
  }

  return Math.floor(Date.now() / 1000);
}

/** @param {string} content */
export function processFabricatorContent(content) {
  let text = String(content ?? '');
  text = text.replace(/\\n/g, '\n');

  const segments = [];
  const imageRegex = /\[图(?:片)?:([^\]]+)\]/g;
  const videoRegex = /\[视频:([^\]]+)\]/g;

  let match;
  while ((match = imageRegex.exec(text)) !== null) {
    segments.push({ start: match.index, end: match.index + match[0].length, type: 'image', value: match[1] });
  }
  while ((match = videoRegex.exec(text)) !== null) {
    segments.push({ start: match.index, end: match.index + match[0].length, type: 'video', value: match[1] });
  }

  if (segments.length === 0) return text;

  segments.sort((a, b) => a.start - b.start);
  const processedContent = [];
  let lastEnd = 0;

  const pushTextLines = (chunk) => {
    if (!chunk) return;
    const lines = chunk.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) processedContent.push(lines[i]);
      if (i < lines.length - 1) processedContent.push('\n');
    }
  };

  for (const seg of segments) {
    if (seg.start > lastEnd) pushTextLines(text.substring(lastEnd, seg.start));
    if (seg.type === 'image') processedContent.push(segment.image(seg.value));
    else if (seg.type === 'video') processedContent.push(segment.video(seg.value));
    lastEnd = seg.end;
  }
  if (lastEnd < text.length) pushTextLines(text.substring(lastEnd));

  return processedContent.length > 0 ? processedContent : text;
}

/**
 * @param {string} line qq|昵称|内容|时间
 * @param {number} index
 * @param {{ userId?: string|number, botUin?: string|number }} ctx
 */
export function parseFabricatorLine(line, index, ctx) {
  const parts = String(line ?? '')
    .split('|')
    .map((p) => p.trim());
  if (parts.length < 3) {
    throw new Error(`第${index + 1}条格式错误，需 QQ|昵称|内容|时间(可选)`);
  }
  const [qq, nickname, content, timeStr] = parts;
  const user_id = parseFabricatorQQ(qq, ctx);
  if (!user_id) throw new Error(`第${index + 1}条 QQ 无效: ${qq}`);
  return {
    message: processFabricatorContent(content),
    nickname: nickname || '匿名用户',
    user_id: String(user_id),
    time: parseFabricatorTime(timeStr)
  };
}

/**
 * @param {Array<{qq:string,nickname:string,content:string,time?:string}>|string} input
 * @param {{ userId?: string|number, botUin?: string|number }} ctx
 */
export function buildFabricatorMsgList(input, ctx) {
  if (Array.isArray(input)) {
    if (input.length === 0) throw new Error('messages 不能为空');
    return input.map((item, i) => {
      const user_id = parseFabricatorQQ(item?.qq, ctx);
      if (!user_id) throw new Error(`第${i + 1}条 QQ 无效: ${item?.qq}`);
      const content = item?.content;
      if (content == null || String(content).trim() === '') {
        throw new Error(`第${i + 1}条内容不能为空`);
      }
      return {
        message: processFabricatorContent(String(content)),
        nickname: String(item?.nickname ?? '匿名用户'),
        user_id: String(user_id),
        time: parseFabricatorTime(item?.time)
      };
    });
  }

  const batch = String(input ?? '').trim();
  if (!batch) throw new Error('batch 不能为空');
  const lines = batch.split('||').map((m) => m.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('未检测到有效消息');
  return lines.map((line, i) => parseFabricatorLine(line, i, ctx));
}

/** @param {object} e 事件 */
export function fabricatorContextFromEvent(e) {
  return {
    userId: e?.user_id ?? e?.userId,
    botUin: e?.self_id ?? e?.bot?.uin ?? e?.bot?.self_id ?? globalThis.Bot?.uin
  };
}

/**
 * @param {object} e
 * @param {ReturnType<typeof buildFabricatorMsgList>} msgList
 */
export async function makeFabricatorForwardMsg(e, msgList) {
  const msgs = msgList.map((msg) => ({
    message: msg.message,
    nickname: msg.nickname,
    user_id: String(msg.user_id),
    time: msg.time
  }));

  if (e?.group?.makeForwardMsg) return e.group.makeForwardMsg(msgs);
  if (e?.friend?.makeForwardMsg) return e.friend.makeForwardMsg(msgs);
  if (typeof e?.makeForwardMsg === 'function') return e.makeForwardMsg(msgs);
  if (typeof globalThis.Bot?.makeForwardMsg === 'function') return Bot.makeForwardMsg(msgs);
  return null;
}
