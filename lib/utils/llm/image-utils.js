import fetch from 'node-fetch';
import https from 'node:https';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { transformOpenAIStyleVisionMessages } from './message-transform.js';

/**
 * 多模态图片底层工具（各厂商工厂共用）
 * - 拉取 / data URL → Gemini 系 MIME 限制（GIF→PNG 等）
 * - OpenAI Chat：`prepareOpenAIChatVisionMessages`、`ensureMessagesImagesDataUrl`
 * - Gemini：`visionReferenceToGeminiInlineData`
 * - Anthropic：`visionReferenceToAnthropicImageBlock`、`resolveAnthropicBodyImagePlaceholders`
 * - 火山：公网 URL 保持外链，本机/相对/data → 内联：`normalizeVolcengineImageUrl`
 */

const FILE_TYPE_PROBE_BYTES = 4096;

/** Gemini / New API 等常见支持的栅格类型（不含 GIF） */
const GEMINI_SAFE_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

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
    return { mimeType: mime, base64 };
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

/** LLM 工厂配置：`imageFetchRejectUnauthorized === false` 时放宽 HTTPS 证书校验（慎用） */
export function buildImageFetchAgent(config = {}) {
  if (config && config.imageFetchRejectUnauthorized === false) {
    return new https.Agent({ rejectUnauthorized: false });
  }
  return undefined;
}

/** timeout / TLS agent：工厂 chat 与图片拉取共用 */
export function resolveVisionFetchOptions(config = {}, options = {}) {
  return {
    timeoutMs: options.timeoutMs ?? config.timeout ?? 30000,
    agent: Object.hasOwn(options, 'agent') ? options.agent : buildImageFetchAgent(config)
  };
}

/** 判定是否为可访问公网的 http(s) 主机（非 loopback） */
export function isLoopbackHttpUrl(absUrl) {
  try {
    const u = new URL(absUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '0.0.0.0';
  } catch {
    return false;
  }
}

const DATA_URL_CACHE = new Map();

export function getServerPublicUrl() {
  try {
    const base = Bot?.url;
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

/** `{ mimeType, base64 }` → OpenAI `image_url` 用的 data URL */
export function visionPayloadToOpenAiDataUrl(payload) {
  if (!payload?.base64) return '';
  return `data:${payload.mimeType};base64,${payload.base64}`;
}

/**
 * 解析任意图片引用 → Gemini 官方 API `parts.inlineData`
 */
export async function visionReferenceToGeminiInlineData(ref, config = {}, options = {}) {
  const { timeoutMs, agent } = resolveVisionFetchOptions(config, options);
  const payload = await fetchAsBase64(String(ref ?? '').trim(), { timeoutMs, agent });
  if (!payload?.base64) return null;
  return { inlineData: { mimeType: payload.mimeType, data: payload.base64 } };
}

/** Anthropic Messages API：`content` 块 image + base64 source */
export async function visionReferenceToAnthropicImageBlock(ref, config = {}, options = {}) {
  const { timeoutMs, agent } = resolveVisionFetchOptions(config, options);
  const info = await fetchAsBase64(String(ref ?? '').trim(), { timeoutMs, agent });
  if (!info?.base64) return null;
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: info.mimeType || 'image/png',
      data: info.base64
    }
  };
}

/** 将 buildBody 中的 `__image_url__` 占位替换为 Anthropic 真实 image 块（失败则文本占位） */
export async function resolveAnthropicBodyImagePlaceholders(body, config = {}, options = {}) {
  for (const msg of body.messages ?? []) {
    if (!Array.isArray(msg.content)) continue;
    const newBlocks = [];
    for (const b of msg.content) {
      if (b?.type === '__image_url__' && b.url) {
        const imgBlock = await visionReferenceToAnthropicImageBlock(b.url, config, options);
        if (imgBlock) newBlocks.push(imgBlock);
        else newBlocks.push({ type: 'text', text: `[图片:${String(b.url)}]` });
      } else if (b?.type === 'text') {
        newBlocks.push({ type: 'text', text: String(b.text ?? '') });
      }
    }
    msg.content = newBlocks.filter(x => x && (x.type === 'text' ? String(x.text || '').trim() : true));
  }
}

/**
 * 火山多模态：公网 http(s) 且非本机则保持 URL；否则拉取并内联 data URL（含 GIF→PNG）
 */
export async function normalizeVolcengineImageUrl(ref, config = {}, options = {}) {
  const raw = String(ref ?? '').trim();
  if (!raw) return raw;
  const abs = normalizeToAbsoluteUrl(raw);
  if (/^https?:\/\//i.test(abs) && !isLoopbackHttpUrl(abs)) return abs;
  const { timeoutMs, agent } = resolveVisionFetchOptions(config, options);
  const p = await fetchAsBase64(raw, { timeoutMs, agent });
  return p ? visionPayloadToOpenAiDataUrl(p) : abs;
}

/**
 * 下载或解析图片为 `{ mimeType, base64 }`（已做 Gemini 安全栅格处理）
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
    const ft = await fileTypeFromBuffer(buf.subarray(0, Math.min(buf.length, FILE_TYPE_PROBE_BYTES))).catch(() => null);
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
 * OpenAI Chat：结构转换 + 图片内联为 data URL（Bot 侧拉取，避免上游代拉失败）
 */
export async function prepareOpenAIChatVisionMessages(messages, config = {}, options = {}) {
  const { timeoutMs, agent } = resolveVisionFetchOptions(config, options);
  const visionOptions = options.visionOptions && typeof options.visionOptions === 'object' ? options.visionOptions : {};
  const transformed = await transformOpenAIStyleVisionMessages(messages, config, visionOptions);
  await ensureMessagesImagesDataUrl(transformed, { timeoutMs, agent });
  return transformed;
}

/** OpenAI messages：user 内 `image_url` 一律转为内联 data URL */
export async function ensureMessagesImagesDataUrl(messages, { timeoutMs = 30000, agent } = {}) {
  if (!Array.isArray(messages)) return;

  for (const msg of messages) {
    if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue;

    for (const part of msg.content) {
      if (!part || part.type !== 'image_url' || !part.image_url?.url) continue;
      const info = await fetchAsBase64(String(part.image_url.url).trim(), { timeoutMs, agent });
      if (!info?.base64) continue;
      part.image_url.url = visionPayloadToOpenAiDataUrl(info);
    }
  }
}
