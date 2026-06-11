import cfg from '../config/config.js';
import { parseByteSize } from './byte-size.js';

/**
 * 从 server.yaml limits 解析上传限制
 * @returns {{ maxBodyBytes: number|null, maxFileBytes: number }}
 */
export function getServerUploadLimits() {
  const limits = cfg?.server?.limits || {};
  const maxFileBytes = parseByteSize(limits.fileSize, 100 * 1024 * 1024);
  const maxBodyBytes = parseByteSize(limits.multipart, null)
    ?? parseByteSize(limits.raw, null)
    ?? (maxFileBytes ? maxFileBytes * 2 : null);
  return { maxBodyBytes, maxFileBytes };
}
