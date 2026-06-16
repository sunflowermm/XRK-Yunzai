/**
 * HTTP 消息发送工具（/api/message/send 等接口共用）
 */

/** QQ 号 / 群号：数字字符串转为 number，供 OneBot/NapCat 使用 */
export function normalizeTargetId(id) {
  if (id == null || id === '') return id;
  const s = String(id).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }
  return id;
}

/** 解析 NapCat / OneBot 发送失败错误，提取可读说明 */
export function parseAdapterSendError(error) {
  const msg = error?.message || String(error ?? '');
  const errMsgMatch = msg.match(/"errMsg"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
  if (errMsgMatch?.[1]) {
    const text = errMsgMatch[1].replace(/\\n/g, '\n').trim();
    if (text) return text;
  }
  const resultMatch = msg.match(/"result"\s*:\s*(\d+)/);
  if (resultMatch) {
    const code = Number(resultMatch[1]);
    const hints = {
      110: '发送失败：已被移出该群或无权在该群发言',
      120: '发送失败：QQ 拒绝了消息（可能为非好友、无群权限、内容风控或账号受限）',
    };
    if (hints[code]) return hints[code];
    if (code) return `发送失败（QQ 错误码 ${code}）`;
  }
  return msg;
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

/**
 * 标准化发送消息体：纯文本 / JSON 字符串 / 消息段数组 / 单段对象
 * @returns {string|Array|null}
 */
export function normalizeSendMessage(message) {
  if (message == null) return null;

  if (Array.isArray(message)) {
    const segs = message.map(normalizeSegment).filter(s => s != null && s !== '');
    return segs.length ? segs : null;
  }

  if (typeof message === 'object') {
    if (message.message != null) return normalizeSendMessage(message.message);
    const seg = normalizeSegment(message);
    return seg != null ? [seg] : null;
  }

  if (typeof message === 'string') {
    const trimmed = message.trim();
    if (!trimmed) return null;
    if (
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
    ) {
      try {
        return normalizeSendMessage(JSON.parse(trimmed));
      } catch {
        // 非 JSON，按纯文本发送
      }
    }
    return message;
  }

  const text = String(message).trim();
  return text || null;
}

/** 归一化消息类型 */
export function normalizeMessageType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'friend' || t === 'private') return 'private';
  if (t === 'group') return 'group';
  return t;
}

/**
 * 解析目标 Bot 实例
 * @returns {{ bot?: object, botId?: string|number, error?: string, status?: number }}
 */
export function resolveSendBot(Bot, bot_id) {
  const online = Bot.uin.filter(u => u != null && u !== '');
  if (!online.length) {
    return { error: '没有已连接的机器人', status: 503 };
  }

  let id = bot_id != null && bot_id !== '' ? bot_id : online[0];
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

/**
 * 发送前校验目标是否存在（不阻断发送，仅用于更明确的 404）
 */
export function validateSendTarget(Bot, bot, type, targetId) {
  if (type === 'private') {
    const uid = normalizeTargetId(targetId);
    const inGlobal = Bot.fl?.has?.(uid) || Bot.fl?.has?.(targetId);
    const inBot = bot.fl?.has?.(uid) || bot.fl?.has?.(targetId);
    if (!inGlobal && !inBot) {
      return { warn: `好友 ${targetId} 不在缓存列表中，仍将尝试发送` };
    }
  } else if (type === 'group') {
    const gid = normalizeTargetId(targetId);
    const inGlobal = Bot.gl?.has?.(gid) || Bot.gl?.has?.(targetId) || Bot.gl?.has?.(String(targetId));
    const inBot = bot.gl?.has?.(gid) || bot.gl?.has?.(targetId) || bot.gl?.has?.(String(targetId));
    if (!inGlobal && !inBot) {
      return { warn: `群 ${targetId} 不在缓存列表中，仍将尝试发送` };
    }
  }
  return {};
}
