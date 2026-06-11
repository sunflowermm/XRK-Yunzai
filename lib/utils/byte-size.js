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
