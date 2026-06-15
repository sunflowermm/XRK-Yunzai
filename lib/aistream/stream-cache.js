import crypto from 'node:crypto';
import { getAistreamConfigOptional } from '../utils/aistream-config.js';
import { LRUCache } from '../utils/lru-cache.js';
import { ObjectUtils } from '../utils/object-utils.js';

let resultCache = null;

function getCacheConfig() {
  return getAistreamConfigOptional().cache ?? {};
}

function ensureCache() {
  const cacheCfg = getCacheConfig();
  if (!cacheCfg.enabled) {
    resultCache = null;
    return null;
  }
  const ttlSec = Number(cacheCfg.ttl) || 300;
  const maxSize = Number(cacheCfg.maxSize) || 100;
  if (!resultCache || resultCache._ttlSec !== ttlSec || resultCache._maxSize !== maxSize) {
    resultCache = Object.assign(
      new LRUCache({ maxSize, ttlMs: ttlSec * 1000 }),
      { _ttlSec: ttlSec, _maxSize: maxSize }
    );
  }
  return resultCache;
}

/**
 * 是否应对本次工作流执行启用结果缓存
 */
export function shouldCacheStreamResult(stream, e, question, config = {}) {
  const cacheCfg = getCacheConfig();
  if (!cacheCfg.enabled) return false;
  if (config?.cache === false) return false;
  if (config?.stream === true) return false;
  if (stream?.config?.cache === false) return false;
  if (question == null || (typeof question === 'string' && !question.trim())) return false;
  return true;
}

/**
 * 构建工作流结果缓存键
 */
export function buildStreamCacheKey(streamName, e, question, config = {}) {
  const questionKey = typeof question === 'string'
    ? question
    : JSON.stringify(question ?? '');
  const contextKey = {
    user_id: e?.user_id ?? null,
    group_id: e?.group_id ?? null,
    self_id: e?.self_id ?? null,
  };
  const stableConfig = ObjectUtils.isPlainObject(config) ? { ...config } : {};
  delete stableConfig.cache;
  delete stableConfig._cacheBust;
  delete stableConfig.stream;
  const payload = JSON.stringify({
    streamName,
    question: questionKey,
    context: contextKey,
    config: stableConfig,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function getStreamResultCache() {
  return ensureCache();
}

export function clearStreamResultCache() {
  if (resultCache) resultCache.clear();
}
