import path from 'node:path';
import BotUtil from '../util.js';
import { FileUtils } from './file-utils.js';

const HTTP_RE = /^https?:\/\//i;

export function isHttpRef(ref) {
  return HTTP_RE.test(String(ref ?? '').trim());
}

/**
 * 入站媒体一次性落盘：仅 get_image → 本地路径 / base64，不返回 HTTP 直链
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
 * 出站 file 仅允许 Buffer / base64 / 本地路径；禁止 HTTP 直链
 */
export async function resolveOutboundFile(file, opts = {}) {
  const size = opts.size ?? 10485760;

  if (Buffer.isBuffer(file)) {
    return BotUtil.Buffer(file, { size, file: opts.file });
  }

  const str = String(file ?? '').trim();
  if (!str) throw new Error('空文件引用');
  if (str.startsWith('base64://')) return str;
  if (isHttpRef(str)) {
    throw new Error('不支持 HTTP 直链，请使用本地文件');
  }

  const localPath = str.replace(/^file:\/\//, '');
  if (await BotUtil.fileExists(localPath)) {
    return BotUtil.Buffer(str, { size, file: opts.file });
  }

  const resolved = await BotUtil.Buffer(str, { size, file: opts.file });
  if (Buffer.isBuffer(resolved) && resolved.length > 0) return resolved;
  if (typeof resolved === 'string' && resolved) return resolved;
  throw new Error(`无法解析本地文件: ${str.slice(0, 120)}`);
}

/**
 * get_image 落盘到目标路径（工作区下载等，不写回 JSON 直链）
 */
export async function copyQqImageToPath(fileRef, absPath, sendApi) {
  if (!sendApi || !fileRef) return false;
  const viaApi = await resolveQqImageViaApi(sendApi, fileRef);
  if (viaApi?.startsWith('file://')) {
    return FileUtils.copyFile(viaApi.replace(/^file:\/\//, ''), absPath);
  }
  if (viaApi?.startsWith('base64://')) {
    return FileUtils.writeFileBuffer(absPath, Buffer.from(viaApi.slice(9), 'base64'));
  }
  return false;
}
