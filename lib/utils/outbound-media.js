import path from 'node:path';
import BotUtil from '../util.js';
import { FileUtils } from './file-utils.js';

const HTTP_RE = /^https?:\/\//i;
const QQ_CDN_RE = /multimedia\.nt\.qq\.com/i;

export function isHttpRef(ref) {
  return HTTP_RE.test(String(ref ?? '').trim());
}

/** QQ 图床 CDN（含 .com.cn），不宜持久化、不宜原样交给 NapCat 拉取 */
export function isQqEphemeralRef(ref) {
  return isHttpRef(ref) && QQ_CDN_RE.test(String(ref));
}

async function readLocalBuffer(ref) {
  const p = String(ref ?? '').replace(/^file:\/\//, '').trim();
  if (!p || isHttpRef(p)) return null;
  if (!(await BotUtil.fileExists(p))) return null;
  const buf = await FileUtils.readFileBuffer(p);
  return buf?.length ? buf : null;
}

async function bufferFromApiResult(viaApi) {
  if (!viaApi) return null;
  if (viaApi.startsWith('base64://')) {
    return Buffer.from(viaApi.slice(9), 'base64');
  }
  return readLocalBuffer(viaApi);
}

/** NapCat get_image → file:// 或 base64:// */
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
    Bot.makeLog('debug', `[get_image] ${fileRef} → ${err.message}`, 'OutboundMedia');
  }
  return null;
}

/**
 * 读图片 Buffer：本地 → get_image(file) → get_image(url) → 非 QQ 外链 fetch
 * @param {{ file?: string, url?: string }} refs NapCat 入站：file=HASH.jpg + url=CDN
 */
export async function readImageBuffer(refs, sendApi) {
  const f = String(refs?.file ?? '').trim();
  const u = String(refs?.url ?? '').trim();

  if (f.startsWith('base64://')) {
    return Buffer.from(f.slice(9), 'base64');
  }

  const local = (await readLocalBuffer(f)) || (await readLocalBuffer(u));
  if (local) return local;

  if (!sendApi) return null;

  for (const ref of [f, u]) {
    if (!ref) continue;
    const buf = await bufferFromApiResult(await resolveQqImageViaApi(sendApi, ref));
    if (buf?.length) return buf;
  }

  const external = [f, u].find((r) => isHttpRef(r) && !isQqEphemeralRef(r));
  if (!external) return null;

  const fetched = await BotUtil.Buffer(external, { http: false });
  return Buffer.isBuffer(fetched) && fetched.length ? fetched : null;
}

/** 持久化 / 词条落盘 */
export async function readPersistableMediaBuffer(ref, sendApi) {
  const refs = typeof ref === 'object' && ref !== null ? ref : { file: ref };
  return readImageBuffer(refs, sendApi);
}

/** 出站 segment.file */
export async function resolveOutboundFile(file, opts = {}) {
  const size = opts.size ?? 10485760;
  const { sendApi } = opts;

  if (Buffer.isBuffer(file)) {
    return BotUtil.Buffer(file, { size, file: opts.file });
  }

  const str = String(file ?? '').trim();
  if (!str) throw new Error('空文件引用');
  if (str.startsWith('base64://')) return str;

  const refs = isHttpRef(str) ? { url: str } : { file: str };
  const buf = await readImageBuffer(refs, sendApi);
  if (buf?.length) {
    return BotUtil.Buffer(buf, { size, file: opts.file });
  }

  if (isHttpRef(str)) {
    if (isQqEphemeralRef(str)) {
      throw new Error('QQ 临时图链无法解析，请用 get_image 或本地文件');
    }
    return str;
  }

  if (await readLocalBuffer(str)) {
    return BotUtil.Buffer(str, { size, file: opts.file });
  }

  throw new Error(`无法解析文件: ${str.slice(0, 120)}`);
}

/** 落盘到绝对路径 */
export async function materializeMediaRefToPath(refs, absPath, sendApi) {
  const seg = typeof refs === 'object' && refs !== null && !Buffer.isBuffer(refs)
    ? refs
    : { file: refs };
  const buf = await readImageBuffer(seg, sendApi);
  if (!buf?.length) return false;
  return FileUtils.writeFileBuffer(absPath, buf);
}

export const copyQqImageToPath = materializeMediaRefToPath;
