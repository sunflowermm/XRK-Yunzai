import fetch from 'node-fetch';
import https from 'node:https';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { transformMessagesWithVision } from './message-transform.js';

/**
 * Gemini / 部分 OpenAI 兼容网关不支持的图片类型（如 GIF），需在 Bot 侧转为 PNG/JPEG
 * @see New API 报错 supported types 列表中的 image/*
 */
const GEMINI_SAFE_IMAGE_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

export function normalizeVisionImageMime(mimeType) {
  const base = String(mimeType || 'image/png').split(';')[0].trim().toLowerCase();
  return base === 'image/jpg' ? 'image/jpeg' : base;
}

/**
 * @param {{ mimeType: string, base64: string }} payload
 * @returns {Promise<{ mimeType: string, base64: string }>}
 */
export async function ensureGeminiCompatibleImagePayload({ mimeType, base64 }) {
  const mime = normalizeVisionImageMime(mimeType);
  if (GEMINI_SAFE_IMAGE_MIMES.has(mime)) {
    const outMime = mime === 'image/jpg' ? 'image/jpeg' : mime;
    return { mimeType: outMime, base64 };
  }
  let buf;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch {
    return { mimeType: 'image/png', base64 };
  }
  if (!buf?.length) return { mimeType: mime || 'image/png', base64 };
  try {
    const pngBuf = await sharp(buf).png().toBuffer();
    return { mimeType: 'image/png', base64: pngBuf.toString('base64') };
  } catch {
    try {
      const jpegBuf = await sharp(buf).jpeg({ quality: 88 }).toBuffer();
      return { mimeType: 'image/jpeg', base64: jpegBuf.toString('base64') };
    } catch {
      return { mimeType: mime, base64 };
    }
  }
}

/**
 * 图片 / 多模态辅助工具（与 XRK-AGT 对齐）
 * - 统一将相对路径 / 内部 URL 转成可 fetch 的绝对 URL
 * - 统一下载图片并转为 base64
 * - 可选：在 OpenAI 风格 messages 上，把 image_url.url 统一转为 data URL
 * - 供 OpenAI 兼容 / New API 等：避免上游代拉图片 URL 时 TLS 或出网失败
 */

/**
 * 为图片拉取构建 node-fetch 的 agent（如 CDN 证书与域名不匹配时可临时关闭校验，慎用）
 * @param {Object} config - LLM 工厂配置，识别 imageFetchRejectUnauthorized === false
 */
export function buildImageFetchAgent(config = {}) {
  if (config && config.imageFetchRejectUnauthorized === false) {
    return new https.Agent({ rejectUnauthorized: false });
  }
  return undefined;
}

const DATA_URL_CACHE = new Map();

export function getServerPublicUrl() {
  try {
    const base = globalThis.Bot?.url;
    return base ? String(base).replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

export function normalizeToAbsoluteUrl(url) {
  const u = String(url ?? '').trim();
  if (!u) return '';
  if (u.startsWith('data:')) return u;
  if (/^https?:\/\//i.test(u)) return u;

  const base = getServerPublicUrl();
  if (base && u.startsWith('/')) return `${base}${u}`;
  return u;
}

export function parseDataUrl(dataUrl) {
  const raw = String(dataUrl ?? '').trim();
  const m = raw.match(/^data:([^;]+);base64,(.*)$/i);
  if (!m) return null;
  return { mimeType: m[1], base64: m[2] };
}

/**
 * 下载图片并返回 { mimeType, base64 }
 */
export async function fetchAsBase64(url, { timeoutMs = 30000, agent } = {}) {
  const raw = String(url ?? '').trim();
  if (!raw) return null;

  if (raw.startsWith('data:')) {
    const parsed = parseDataUrl(raw);
    if (!parsed?.base64) return null;
    return ensureGeminiCompatibleImagePayload({
      mimeType: parsed.mimeType,
      base64: parsed.base64
    });
  }

  const abs = normalizeToAbsoluteUrl(raw);
  if (!/^https?:\/\//i.test(abs)) return null;

  const cacheKey = agent ? `${abs}\0insecure` : abs;
  const now = Date.now();
  const cached = DATA_URL_CACHE.get(cacheKey);
  if (cached && (now - cached.ts) < 5 * 60 * 1000) {
    return { mimeType: cached.mimeType, base64: cached.base64 };
  }

  const fetchOpts = { signal: AbortSignal.timeout(timeoutMs) };
  if (agent) fetchOpts.agent = agent;
  const resp = await fetch(abs, fetchOpts);
  if (!resp.ok) return null;

  const buf = Buffer.from(await resp.arrayBuffer());
  let mimeType = normalizeVisionImageMime(resp.headers.get('content-type') || '');
  if (!mimeType.startsWith('image/')) {
    const ft = await fileTypeFromBuffer(buf.subarray(0, Math.min(buf.length, 4096))).catch(() => null);
    if (ft?.mime?.startsWith('image/')) mimeType = normalizeVisionImageMime(ft.mime);
    else mimeType = 'image/png';
  }

  const payload = await ensureGeminiCompatibleImagePayload({
    mimeType,
    base64: buf.toString('base64')
  });

  DATA_URL_CACHE.set(cacheKey, { ts: now, mimeType: payload.mimeType, base64: payload.base64 });
  return payload;
}

/**
 * OpenAI Chat 多模态：转换消息并把 http(s) 图片内联为 data URL（Bot 侧拉取，减轻上游代拉失败）
 * @param {Object} [options] timeoutMs；visionOptions 透传 transformMessagesWithVision；agent 可覆盖
 */
export async function prepareOpenAIChatVisionMessages(messages, config = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? config.timeout ?? 30000;
  const visionOptions = options.visionOptions && typeof options.visionOptions === 'object' ? options.visionOptions : {};
  const transformed = await transformMessagesWithVision(messages, config, { mode: 'openai', ...visionOptions });
  const agent = options.agent ?? buildImageFetchAgent(config);
  await ensureMessagesImagesDataUrl(transformed, { timeoutMs, agent });
  return transformed;
}

/**
 * 在 OpenAI 风格 messages 上，把 user 消息中的 image_url.url 统一转成 data URL
 */
export async function ensureMessagesImagesDataUrl(messages, { timeoutMs = 30000, agent } = {}) {
  if (!Array.isArray(messages)) return;

  for (const msg of messages) {
    if (!msg || msg.role !== 'user') continue;
    if (!Array.isArray(msg.content)) continue;

    for (const part of msg.content) {
      if (!part || part.type !== 'image_url' || !part.image_url?.url) continue;
      const u = String(part.image_url.url).trim();

      if (u.startsWith('data:')) {
        const parsed = parseDataUrl(u);
        if (!parsed?.base64) continue;
        const payload = await ensureGeminiCompatibleImagePayload({
          mimeType: parsed.mimeType,
          base64: parsed.base64
        });
        part.image_url.url = `data:${payload.mimeType};base64,${payload.base64}`;
        continue;
      }

      const info = await fetchAsBase64(u, { timeoutMs, agent });
      if (!info || !info.base64) continue;

      part.image_url.url = `data:${info.mimeType};base64,${info.base64}`;
    }
  }
}
