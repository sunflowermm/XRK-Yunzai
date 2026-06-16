import { getUploadedFile, getUploadedFileSync } from './uploadedFiles.js';

/** QQ 号 / 群号：数字字符串转为 number */
export function normalizeTargetId(id) {
  if (id == null || id === '') return id;
  const s = String(id).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }
  return id;
}

export function normalizeMessageType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'friend' || t === 'private') return 'private';
  if (t === 'group') return 'group';
  return t;
}

function normalizeSegment(seg) {
  if (seg == null) return null;
  if (typeof seg === 'string') return seg;
  if (typeof seg !== 'object') return String(seg);
  if (seg.type && seg.data) return seg;
  if (seg.type) {
    const { type, ...rest } = seg;
    return { type, data: rest };
  }
  return seg;
}

async function resolveUploadedFile(id) {
  return getUploadedFileSync(id) ?? await getUploadedFile(id);
}

async function normalizeSegmentWithFiles(seg) {
  if (!seg || typeof seg !== 'object') return normalizeSegment(seg);
  const fileId = seg.file_id ?? seg.data?.file_id;
  if (fileId) {
    const file = await resolveUploadedFile(fileId);
    if (!file) {
      throw Object.assign(new Error(`图片 ${fileId} 不存在或已过期，请先调用上传接口`), { status: 404 });
    }
    return { type: 'image', file: file.path, name: file.name };
  }
  return normalizeSegment(seg);
}

function normalizeSendMessageSync(message) {
  if (message == null) return null;

  if (Array.isArray(message)) return message;

  if (typeof message === 'object') {
    if (message.message != null) return normalizeSendMessageSync(message.message);
    return [message];
  }

  if (typeof message === 'string') {
    const trimmed = message.trim();
    if (!trimmed) return null;
    if (
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
    ) {
      try {
        return normalizeSendMessageSync(JSON.parse(trimmed));
      } catch {
        // 纯文本
      }
    }
    return message;
  }

  const text = String(message).trim();
  return text || null;
}

async function fileToImageSegment(file) {
  if (!file?.path) {
    throw Object.assign(new Error('文件无效'), { status: 400 });
  }
  return { type: 'image', file: file.path, name: file.name };
}

/**
 * 组装发送内容：文本 + 上传 file_id/file_ids + 消息段内 file_id
 * @returns {Promise<string|Array|null>}
 */
export async function buildSendMessage(body = {}) {
  const { message, file_id, file_ids } = body;
  const ids = [];
  if (file_id) ids.push(file_id);
  if (file_ids != null) {
    ids.push(...(Array.isArray(file_ids) ? file_ids : [file_ids]));
  }

  const imageSegs = [];
  for (const id of ids.filter(Boolean)) {
    const file = await resolveUploadedFile(id);
    if (!file) {
      throw Object.assign(new Error(`图片 ${id} 不存在或已过期，请先调用 /api/file/upload 上传`), { status: 404 });
    }
    imageSegs.push(await fileToImageSegment(file));
  }

  const base = normalizeSendMessageSync(message);
  let segments = [];

  if (typeof base === 'string') {
    segments.push(base);
  } else if (Array.isArray(base)) {
    for (const seg of base) {
      segments.push(await normalizeSegmentWithFiles(seg));
    }
    segments = segments.map(normalizeSegment).filter(s => s != null && s !== '');
  }

  segments.push(...imageSegs.map(normalizeSegment));

  if (!segments.length) return null;
  if (segments.length === 1 && typeof segments[0] === 'string') return segments[0];
  return segments;
}

export function resolveSendBot(Bot, bot_id) {
  const online = Bot.uin.filter(u => u != null && u !== '');
  if (!online.length) {
    return { error: '没有已连接的机器人', status: 503 };
  }

  const id = bot_id != null && bot_id !== '' ? bot_id : online[0];
  if (!Bot.uin.includes(id)) {
    return { error: `机器人 ${id} 不存在或未连接`, status: 404 };
  }

  const bot = Bot.bots[id] ?? Bot.bots[String(id)];
  if (!bot) {
    return { error: `机器人 ${id} 实例不可用`, status: 503 };
  }
  if (bot.stat?.online === false) {
    return { error: `机器人 ${id} 当前离线`, status: 503 };
  }

  return { bot, botId: id };
}
