/**
 * 设备 HTTP/WebSocket 业务层
 * - REST: 注册、设备列表、单设备、TTS、AI 工作流
 * - 事件链用 Bot.PluginsLoader，工作流用 Bot.StreamLoader
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import BotUtil from '../../../lib/util.js';

const mediaDir = path.join(process.cwd(), 'data', 'media');

/**
 * 获取用于拼装媒体绝对 URL 的 baseUrl（Web 端图片等依赖绝对 URL 才能加载）
 * @param {Object} Bot - Bot 实例
 * @param {string} [fallback] - 当 Bot 未配置 URL 时的回退（如从 WebSocket 请求头解析的 origin）
 */
function getBaseUrl(Bot, fallback = '') {
  const u = Bot?.url ?? (typeof Bot?.getServerUrl === 'function' ? Bot.getServerUrl() : null);
  if (u && String(u).startsWith('http')) return String(u).replace(/\/$/, '');
  if (fallback && String(fallback).startsWith('http')) return String(fallback).replace(/\/$/, '');
  return '';
}

/**
 * 从 WebSocket/HTTP 请求中解析客户端可访问的 baseUrl（用于 device 回复中的媒体链接）
 * 优先 Origin，否则用 Host + 协议拼装，支持反向代理 X-Forwarded-* 头
 */
function getBaseUrlFromRequest(req) {
  if (!req?.headers) return '';
  const origin = req.headers.origin || req.headers.Origin;
  if (origin && /^https?:\/\//i.test(origin)) return origin.replace(/\/$/, '');
  const host = req.headers.host || req.headers['x-forwarded-host'];
  const proto = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
  if (host) return `${proto}://${host}`.replace(/\/$/, '');
  return '';
}

const deviceStore = new Map();
const deviceConnections = new Map();

function send(conn, obj) {
  try {
    if (conn?.send) conn.send(JSON.stringify(obj));
  } catch (e) {
    BotUtil.makeLog('warn', `[Device API] 发送失败: ${e.message}`, 'DeviceAPI');
  }
}

/** 从单条消息中提取纯文本（支持 string、segment 数组、{ message }、{ content }） */
function extractTextFromMessage(msg) {
  if (msg == null) return '';
  if (typeof msg === 'string') return msg.trim();
  if (Array.isArray(msg)) {
    return msg.map(m => (m?.type === 'text' && m?.text != null ? m.text : (m?.data?.text ?? ''))).filter(Boolean).join('\n');
  }
  const raw = msg.message ?? msg.content ?? msg.text ?? msg.data?.content;
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) return raw.map(m => (m?.type === 'text' && m?.text != null ? m.text : (m?.data?.text ?? ''))).filter(Boolean).join('\n');
  if (raw?.text != null) return String(raw.text).trim();
  return '';
}

/**
 * 将 forward/node 转为 { title, description, segments }，供 Web 端以聊天记录形式展示
 * 兼容：{ type:'node', data: [...] }、{ type:'forward', messages: [...] }；首条作为 title，其余为 segments
 */
function forwardToSegments(content) {
  if (!content || typeof content !== 'object') return null;
  const data = content.data ?? content.messages;
  if (!Array.isArray(data) || !data.length) return null;
  const texts = [];
  for (const item of data) {
    const node = item?.data ?? item;
    const text = extractTextFromMessage(node?.message ?? node?.content ?? item?.message ?? item);
    if (text) texts.push(text);
  }
  if (texts.length === 0) return null;
  const title = content.title ?? content.description ?? texts[0] ?? '聊天记录';
  const segments = texts.map(t => ({ type: 'text', text: t }));
  return { title, description: '', segments };
}

/**
 * 标准化回复内容为 segments
 * 兼容：字符串、数组、{ segments }、{ title, description, segments }、forward/node；
 * image/video/record/file 支持 url / file / data（Buffer 或类 Buffer）
 */
function normalizeReplySegments(input) {
  if (input == null) return [];
  if (Array.isArray(input)) {
    return input.map(seg => {
      if (typeof seg === 'string') return { type: 'text', text: seg };
      if (!seg || typeof seg !== 'object') return { type: 'text', text: '' };
      const isMedia = seg.type && ['image', 'video', 'record', 'file'].includes(seg.type);
      const url = seg.url || (isMedia && (seg.file ?? seg.data));
      const text = seg.text != null ? String(seg.text) : (seg.data?.text != null ? String(seg.data.text) : '');
      return { type: seg.type || 'text', text, url, name: seg.name };
    }).filter(seg => seg.type !== 'text' || (seg.text != null && String(seg.text).trim()));
  }
  if (typeof input === 'object' && Array.isArray(input.segments)) return normalizeReplySegments(input.segments);
  if (typeof input === 'object' && input.type && ['text', 'image', 'video', 'record', 'file'].includes(input.type)) {
    const url = input.url || input.file || input.data;
    return [url ? { type: input.type, url, name: input.name } : { type: 'text', text: input.text != null ? String(input.text) : '' }];
  }
  if (typeof input === 'object' && (input.type === 'node' || input.type === 'forward' || Array.isArray(input.data) || Array.isArray(input.messages))) {
    const converted = forwardToSegments(input);
    if (converted) return converted.segments;
  }
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  return [{ type: 'text', text: '' }];
}

/** 解析 reply 入参：若为 { title, description, segments } 或 forward/node 则返回统一结构；否则返回 { segments } */
function parseReplyPayload(content) {
  if (content && typeof content === 'object' && Array.isArray(content.segments)) {
    return {
      title: content.title ?? '',
      description: content.description ?? '',
      segments: normalizeReplySegments(content.segments)
    };
  }
  if (content && typeof content === 'object' && (content.type === 'node' || content.type === 'forward' || Array.isArray(content.data) || Array.isArray(content.messages))) {
    const converted = forwardToSegments(content);
    if (converted) return converted;
  }
  return { title: '', description: '', segments: normalizeReplySegments(content) };
}

function mimeFromPath(p) {
  const ext = (typeof p === 'string' && p.includes('.')) ? p.replace(/^.*\./, '').toLowerCase() : '';
  const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav' };
  return map[ext] || 'application/octet-stream';
}

function extFromMime(mime) {
  const map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav' };
  return map[mime] || '.bin';
}

/**
 * 将任意截图/媒体来源统一为 Buffer 或路径字符串（与 lib/renderer/screenshot-utils 逻辑一致，避免「无法解析媒体来源」）
 */
function normalizeMediaSource(url) {
  if (url == null) return null;
  if (Buffer.isBuffer(url)) return url;
  if (typeof url === 'string') return url;
  if (typeof url !== 'object') return null;
  if (url.buffer != null && Buffer.isBuffer(url.buffer)) return url.buffer;
  if (url.buffer instanceof ArrayBuffer) return Buffer.from(url.buffer);
  if (ArrayBuffer.isView(url) || url instanceof ArrayBuffer) return Buffer.from(url);
  if (url.type === 'Buffer' && Array.isArray(url.data)) return Buffer.from(url.data);
  if (url.data != null) {
    const d = url.data;
    if (Buffer.isBuffer(d)) return d;
    if (Array.isArray(d)) return Buffer.from(d);
    if (d instanceof ArrayBuffer || ArrayBuffer.isView(d)) return Buffer.from(d);
  }
  const pathStr = url.path ?? url.file;
  if (typeof pathStr === 'string' && pathStr) return pathStr;
  for (const v of Object.values(url)) {
    if (Buffer.isBuffer(v)) return v;
    if (v?.buffer != null && Buffer.isBuffer(v.buffer)) return Buffer.from(v.buffer);
  }
  return null;
}

/**
 * 将本地路径/ Buffer / 对象媒体 转为 Web 可访问的持久化 URL（写入 data/media）
 */
async function segmentsToWebUrls(segments, Bot, baseUrlOverride) {
  const baseUrl = baseUrlOverride || getBaseUrl(Bot);
  const out = [];
  try {
    await fs.mkdir(mediaDir, { recursive: true });
  } catch (e) {
    BotUtil.makeLog('warn', `[Device] 创建 media 目录失败: ${e.message}`, 'DeviceAPI');
  }
  for (const seg of segments) {
    const s = { ...seg };
    const raw = s.url;
    const isMedia = raw != null && ['image', 'video', 'record', 'file'].includes(s.type);
    const isAlreadyWeb = typeof raw === 'string' && /^https?:\/\//i.test(raw);
    if (isMedia && !isAlreadyWeb) {
      const url = normalizeMediaSource(raw);
      if (url == null) {
        BotUtil.makeLog('warn', `[Device] 无法解析媒体来源，已跳过`, 'DeviceAPI');
        continue;
      }
      try {
        let buf;
        let mime = s.type === 'image' ? 'image/png' : s.type === 'video' ? 'video/mp4' : s.type === 'record' ? 'audio/mpeg' : 'application/octet-stream';
        if (Buffer.isBuffer(url)) {
          buf = url;
          if (buf.length >= 2 && s.type === 'image') {
            const sig = buf.slice(0, 12);
            if (sig[0] === 0xff && sig[1] === 0xd8) mime = 'image/jpeg';
            else if (sig[0] === 0x89 && sig[1] === 0x50) mime = 'image/png';
            else if (sig[0] === 0x52 && sig[2] === 0x49) mime = 'image/webp';
          }
        } else {
          buf = await fs.readFile(url);
          if (s.type === 'image') mime = mimeFromPath(url);
        }
        const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${extFromMime(mime)}`;
        await fs.writeFile(path.join(mediaDir, filename), buf);
        s.url = baseUrl ? `${baseUrl}/media/${filename}` : `/media/${filename}`;
      } catch (e) {
        BotUtil.makeLog('warn', `[Device] 无法转媒体: ${e.message}`, 'DeviceAPI');
        continue;
      }
    } else if (isMedia && typeof raw === 'string' && /^data:/i.test(raw)) {
      const match = raw.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        try {
          const mime = match[1];
          const buf = Buffer.from(match[2], 'base64');
          const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${extFromMime(mime)}`;
          await fs.writeFile(path.join(mediaDir, filename), buf);
          s.url = baseUrl ? `${baseUrl}/media/${filename}` : `/media/${filename}`;
        } catch (e) {
          BotUtil.makeLog('warn', `[Device] data URL 落盘失败: ${e.message}`, 'DeviceAPI');
        }
      }
    }
    out.push(s);
  }
  return out;
}

/**
 * 构建回复 payload（parseReplyPayload + segmentsToWebUrls + 统一字段），供 sendReply / reply 共用
 * baseUrl 优先用设备注册时从请求头解析的 origin，保证 Web 端媒体为绝对 URL 可加载
 */
async function buildReplyPayload(content, deviceId, Bot) {
  const { title, description, segments } = parseReplyPayload(content);
  const device = deviceStore.get(deviceId);
  const baseUrl = device?.baseUrl || getBaseUrl(Bot);
  let webSegments = await segmentsToWebUrls(segments, Bot, baseUrl);
  const isMedia = t => ['image', 'video', 'record', 'file'].includes(t);
  webSegments = webSegments.filter(s => s.type !== 'text' || (s.text != null && String(s.text).trim()));
  webSegments = webSegments.filter(s => !isMedia(s.type) || (typeof s.url === 'string' && s.url));
  const textOut = webSegments.map(s => (s.type === 'text' ? s.text : '')).filter(Boolean).join('\n');
  const payload = {
    type: 'reply',
    device_id: deviceId,
    timestamp: Date.now(),
    message_id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    text: textOut,
    segments: webSegments.length ? webSegments : [{ type: 'text', text: textOut || '' }]
  };
  if (title) payload.title = title;
  if (description) payload.description = description;
  return payload;
}

export default {
  name: 'device',
  dsc: '设备管理 REST + WebSocket /device',
  priority: 85,

  routes: [
    {
      method: 'POST',
      path: '/api/device/register',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        const { device_id, device_type, device_name, capabilities } = req.body || {};
        if (!device_id || !device_type) {
          return res.status(400).json({ success: false, message: '缺少 device_id 或 device_type' });
        }
        const id = String(device_id).trim();
        const name = String(device_name || id);
        const device = {
          device_id: id,
          device_type: String(device_type || 'unknown'),
          device_name: name,
          capabilities: Array.isArray(capabilities) ? capabilities : [],
          registeredAt: Date.now()
        };
        deviceStore.set(id, device);
        res.json({ success: true, device_id: id, device });
      }
    },
    {
      method: 'GET',
      path: '/api/devices',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        const list = Array.from(deviceStore.values());
        res.json({ success: true, devices: list, count: list.length });
      }
    },
    {
      method: 'GET',
      path: '/api/device/:deviceId',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        const device = deviceStore.get(req.params.deviceId);
        if (!device) return res.status(404).json({ success: false, message: '设备不存在' });
        res.json({ success: true, device });
      }
    },
    {
      method: 'POST',
      path: '/api/device/:deviceId/ai',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        const deviceId = req.params.deviceId;
        const { text, workflow = 'device' } = req.body || {};
        const stream = Bot.StreamLoader.getStream(workflow);
        if (!stream || typeof stream.execute !== 'function') {
          return res.status(400).json({ success: false, message: `工作流不存在或不支持执行: ${workflow}` });
        }
        try {
          const persona = (req.body.persona || '').toString().trim();
          const result = await stream.execute(deviceId, (text || '').toString().trim(), {}, persona);
          if (result == null) return res.json({ success: false, message: '执行无结果' });
          const segments = result.text ? [{ type: 'text', text: result.text }] : [];
          return res.json({ success: true, text: result.text || '', emotion: result.emotion || null, segments });
        } catch (e) {
          BotUtil.makeLog('error', `[Device API] AI 执行失败: ${e.message}`, 'DeviceAPI');
          return res.status(500).json({ success: false, message: e.message });
        }
      }
    },
    {
      method: 'POST',
      path: '/api/device/tts',
      handler: async (req, res, Bot) => {
        const { device_id, text } = req.body || {};
        if (device_id && text) {
          const conn = deviceConnections.get(String(device_id));
          if (conn) send(conn, { type: 'command', command: 'tts_text', parameters: { text: String(text) } });
        }
        return res.json({ success: true });
      }
    }
  ],

  ws: {
    device: [(conn, req, Bot) => {
      let deviceId = null;

      conn.on('message', async (raw) => {
        try {
          const data = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(raw.toString());
          const type = data?.type;
          const did = type === 'register' ? (data?.device_id || data?.user_id || '').toString().trim() || `dev_${Date.now()}` : deviceId;

          if (!type) {
            send(conn, { type: 'error', message: '消息格式错误：缺少 type 字段' });
            return;
          }
          if (type !== 'register' && (!deviceId || !deviceStore.has(deviceId))) {
            send(conn, { type: 'error', message: '设备未注册，请先发送 register' });
            return;
          }

          if (type === 'register') {
            const id = did;
            const name = String(data.device_name || id);
            deviceId = id;
            deviceConnections.set(id, conn);
            conn.device_id = id;
            const device = {
              device_id: id,
              device_type: String(data.device_type || 'unknown'),
              device_name: name,
              capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
              registeredAt: Date.now(),
              baseUrl: getBaseUrlFromRequest(req)
            };
            deviceStore.set(id, device);
            if (Bot?.bots) Bot.bots[id] = { device_type: 'web', online: true, nickname: name, info: { device_name: name } };
            send(conn, { type: 'register_response', success: true, device: { device_id: id, device_type: device.device_type, device_name: device.device_name } });
            Bot.em('connect.device', { self_id: id, adapter: 'device', device_id: id, sendReply: async (content) => {
              const payload = await buildReplyPayload(content, id, Bot);
              send(conn, payload);
            } });
            return;
          }

          if (type === 'heartbeat') {
            send(conn, { type: 'heartbeat_response', timestamp: Date.now() });
            return;
          }

          if (type === 'message') {
            const text = (data.text || '').toString().trim();
            const message = Array.isArray(data.message) && data.message.length > 0 ? data.message : (text ? [{ type: 'text', text }] : []);
            if (!message.length) {
              send(conn, { type: 'typing', typing: false });
              return;
            }
            const deviceInfo = deviceStore.get(deviceId) || {};
            const now = Math.floor(Date.now() / 1000);
            const eventId = `device_message_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
            const user_id = data.user_id || data.userId || deviceId;
            const sender = data.sender || { nickname: data.nickname || 'Web', card: data.nickname || 'Web' };
            const meta = data.meta || {};
            const event = {
              post_type: 'device',
              adapter: 'device',
              event_type: 'message',
              device_id: deviceId,
              device_type: deviceInfo.device_type || 'web',
              device_name: deviceInfo.device_name || 'Web',
              message,
              event_data: { message, text, sender, user_id, channel: data.channel || 'web-chat', meta, isMaster: data.isMaster === true },
              self_id: deviceId,
              user_id,
              isMaster: data.isMaster === true || (data.device_type === 'web' && user_id),
              time: now,
              event_id: eventId,
              message_id: eventId,
              reply: async (segmentsOrText) => {
                const payload = await buildReplyPayload(segmentsOrText, deviceId, Bot);
                send(conn, payload);
                return { message_id: null, time: Date.now() / 1000 };
              }
            };

            try {
              send(conn, { type: 'typing', typing: true });
              await Bot.PluginsLoader.deal(event);
              send(conn, { type: 'typing', typing: false });
            } catch (e) {
              BotUtil.makeLog('error', `[Device] 事件链异常: ${e.message}`, 'DeviceAPI', e);
              send(conn, { type: 'typing', typing: false });
              send(conn, { type: 'error', message: e.message || '执行失败' });
            }
            return;
          }

          BotUtil.makeLog('warn', `[Device WS] 未知消息类型: ${type}`, deviceId);
        } catch (e) {
          BotUtil.makeLog('debug', `[Device WS] 消息解析失败: ${e.message}`, 'DeviceAPI');
          send(conn, { type: 'error', message: e.message || '解析失败' });
        }
      });

      conn.on('close', () => {
        if (deviceId) {
          if (Bot?.bots) delete Bot.bots[deviceId];
          deviceConnections.delete(deviceId);
        }
      });
    }]
  }
};
