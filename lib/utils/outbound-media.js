import path from 'node:path';
import BotUtil from '../util.js';

const QQ_MULTIMEDIA_RE = /multimedia\.nt\.qq\.com/i;

export function isQqMultimediaUrl(url) {
  return /^https?:\/\//i.test(String(url ?? '')) && QQ_MULTIMEDIA_RE.test(String(url));
}

/**
 * 通过 OneBot get_image 将 QQ 图片引用解析为本地路径或可用 URL
 * @param {(action: string, params?: object) => Promise<any>} sendApi
 * @param {string} fileRef
 */
export async function resolveQqImageViaApi(sendApi, fileRef) {
  if (!sendApi || !fileRef) return null;
  try {
    const result = await sendApi('get_image', { file: fileRef });
    const d = result?.data ?? result ?? {};
    if (d.file && await BotUtil.fileExists(d.file)) {
      return `file://${path.resolve(d.file)}`;
    }
    if (d.url && /^https?:\/\//i.test(String(d.url))) {
      return String(d.url);
    }
    if (d.base64) {
      const raw = String(d.base64).replace(/^base64:\/\//, '');
      return raw ? `base64://${raw}` : null;
    }
  } catch (err) {
    Bot.makeLog('debug', `[resolveQqImageViaApi] ${err.message}`, 'OutboundMedia');
  }
  return null;
}

/**
 * 将出站 segment 的 file 字段解析为 Buffer、base64:// 或 file://，避免把 QQ CDN URL 原样交给 NapCat。
 * @param {string|Buffer} file
 * @param {{ sendApi?: (action: string, params?: object) => Promise<any>, size?: number, file?: boolean }} [opts]
 */
export async function resolveOutboundFile(file, opts = {}) {
  const size = opts.size ?? 10485760;

  if (Buffer.isBuffer(file)) {
    return BotUtil.Buffer(file, { size, file: opts.file });
  }

  const str = String(file ?? '').trim();
  if (!str) throw new Error('空文件引用');
  if (str.startsWith('base64://')) return str;

  const localPath = str.replace(/^file:\/\//, '');
  if (await BotUtil.fileExists(localPath)) {
    return BotUtil.Buffer(str, { size, file: opts.file });
  }

  if (/^https?:\/\//i.test(str)) {
    let source = str;
    if (opts.sendApi && isQqMultimediaUrl(str)) {
      const viaApi = await resolveQqImageViaApi(opts.sendApi, str);
      if (viaApi) source = viaApi;
    }

    if (source.startsWith('base64://') || (source.startsWith('file://') && opts.file)) {
      return source;
    }

    const localFromApi = source.replace(/^file:\/\//, '');
    if (source.startsWith('file://') && await BotUtil.fileExists(localFromApi)) {
      return BotUtil.Buffer(source, { size, file: opts.file });
    }

    const buf = await BotUtil.Buffer(source, { http: false, size, file: opts.file });
    if (Buffer.isBuffer(buf) && buf.length > 0) return buf;
    if (typeof buf === 'string' && buf) return buf;
    throw new Error('下载文件失败: Bad Request');
  }

  const resolved = await BotUtil.Buffer(str, { size, file: opts.file });
  if (Buffer.isBuffer(resolved) && resolved.length > 0) return resolved;
  if (typeof resolved === 'string' && resolved) return resolved;
  throw new Error(`无法解析文件: ${str.slice(0, 120)}`);
}
