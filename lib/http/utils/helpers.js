import BotUtil from '../../util.js';
import { ObjectUtils } from '../../utils/object-utils.js';

/**
 * HTTP工具函数库
 * 提供常用的HTTP请求处理、响应处理、数据验证等工具函数
 */

/**
 * 安全获取请求优先级
 * @param {Object} api - API实例
 * @returns {number} 优先级值
 */
export function getApiPriority(api) {
  if (api == null || typeof api !== 'object') return 100;
  const priority = api.priority;
  if (priority == null || isNaN(priority)) return 100;
  return Number(priority);
}

/**
 * 验证API实例
 * @param {Object} api - API实例
 * @param {string} key - API键名
 * @returns {boolean} 是否有效
 */
export function validateApiInstance(api, key = 'unknown') {
  if (api == null || typeof api !== 'object') {
    BotUtil.makeLog('warn', `API实例无效: ${key} (非对象)`, 'HttpHelpers');
    return false;
  }

  if (!api.name) api.name = key;
  if (!api.dsc) api.dsc = '暂无描述';
  if (api.priority == null || isNaN(api.priority)) {
    api.priority = 100;
  } else {
    api.priority = Number(api.priority);
  }
  if (api.enable === undefined) api.enable = true;

  if (!ObjectUtils.isArray(api.routes)) {
    if (api.routes) BotUtil.makeLog('warn', `API模块 ${key} 的 routes 不是数组`, 'HttpHelpers');
    api.routes = [];
  }

  return true;
}
