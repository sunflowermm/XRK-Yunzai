/**
 * 带 TTL 的 LRU 缓存（Map 插入序实现）
 */
export class LRUCache {
  #maxSize;
  #ttlMs;
  /** @type {Map<string, { value: unknown, expiresAt: number }>} */
  #entries = new Map();

  constructor({ maxSize = 100, ttlMs = 300000 } = {}) {
    this.#maxSize = Math.max(1, Number(maxSize) || 100);
    this.#ttlMs = Math.max(0, Number(ttlMs) || 0);
  }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (this.#ttlMs > 0 && entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.#entries.has(key)) this.#entries.delete(key);
    while (this.#entries.size >= this.#maxSize) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    const expiresAt = this.#ttlMs > 0 ? Date.now() + this.#ttlMs : Number.MAX_SAFE_INTEGER;
    this.#entries.set(key, { value, expiresAt });
  }

  delete(key) {
    this.#entries.delete(key);
  }

  clear() {
    this.#entries.clear();
  }

  get size() {
    return this.#entries.size;
  }
}
