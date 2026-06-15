/**
 * 解析人类可读的字节大小（如 10mb、100MB、1g）
 * @param {string|number|null|undefined} input
 * @param {number|null} fallback
 * @returns {number|null}
 */
export function parseByteSize(input, fallback = null) {
  if (typeof input === 'number' && Number.isFinite(input) && input >= 0) {
    return Math.floor(input);
  }
  const str = String(input ?? '').trim().toLowerCase();
  if (!str) return fallback;
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/.exec(str);
  if (!match) return fallback;
  const value = parseFloat(match[1]);
  const unit = match[2] || 'b';
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  return Math.floor(value * (mult[unit] || 1));
}

/**
 * 格式化字节数为人类可读字符串
 * @param {number} bytes
 * @param {{ spaced?: boolean }} [options]
 */
export function formatBytes(bytes, options = {}) {
  const spaced = options.spaced !== false;
  if (!bytes || bytes === 0) return spaced ? '0 B' : '0B';
  const k = 1024;
  const sizes = spaced ? ['B', 'KB', 'MB', 'GB', 'TB'] : ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  const value = (bytes / k ** i).toFixed(2);
  return spaced ? `${value} ${sizes[i]}` : `${value}${sizes[i]}`;
}

/**
 * 格式化秒数为中文时长
 * @param {number} seconds
 */
export function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const parts = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分钟`);
  if (secs > 0 && days === 0 && hours === 0) parts.push(`${secs}秒`);
  return parts.length ? parts.join('') : '0秒';
}
