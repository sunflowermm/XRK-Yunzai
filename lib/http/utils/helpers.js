const ADAPTER_NOISE = /EventChecker Failed|NTEvent serviceAndMethod|ListenerName:|NodeIKernel|serviceAndMethod:/;

/**
 * 将底层适配器错误转为用户可读文案，不暴露 NapCat/OneBot 内部结构
 */
export function sanitizeErrorMessage(error, fallback = '操作失败') {
  const raw = typeof error === 'string' ? error : (error?.message || '');
  if (!raw) return fallback;

  const errMsgMatch = raw.match(/"errMsg"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
  if (errMsgMatch?.[1]?.trim()) {
    return errMsgMatch[1].replace(/\\n/g, '\n').trim();
  }

  const resultMatch = raw.match(/"result"\s*:\s*(\d+)/);
  if (resultMatch) {
    const code = Number(resultMatch[1]);
    const hints = {
      110: '发送失败：已被移出该群或无权在该群发言',
      120: '发送失败：QQ 拒绝了消息（可能为非好友、无群权限、内容风控或账号受限）',
    };
    if (hints[code]) return hints[code];
    if (code) return `${fallback}（错误码 ${code}）`;
  }

  if (ADAPTER_NOISE.test(raw)) return fallback;
  if (/请求超时|Timeout/i.test(raw)) return '请求超时，请稍后重试';

  if (raw.length <= 120 && !raw.includes('\n') && !ADAPTER_NOISE.test(raw)) {
    return raw;
  }
  return fallback;
}

/** 统一失败响应：仅返回 message，详细错误写日志 */
export function respondFail(res, status, message, logTag, error) {
  if (logTag && error) {
    Bot.makeLog('warn', `[${logTag}] ${error?.message || error}`, logTag, error);
  }
  return res.status(status).json({ success: false, message });
}

/**
 * HTTP 工具函数库（与 XRK-AGT 对齐）
 */

/**
 * 安全获取请求优先级
 * @param {Object} api - API实例
 * @returns {number} 优先级值
 */
export function getApiPriority(api) {
  if (!api || typeof api !== 'object') return 100;
  const priority = api.priority;
  if (priority == null || isNaN(priority)) return 100;
  return Number(priority);
}

/**
 * 验证API实例（与 XRK-AGT 对齐）
 */
export function validateApiInstance(api, key = 'unknown') {
  if (!api || typeof api !== 'object') {
    Bot.makeLog('warn', `API实例无效: ${key}`, 'HttpHelpers');
    return false;
  }
  if (!api.name) api.name = key;
  if (!api.dsc) api.dsc = '暂无描述';
  api.priority = (api.priority != null && !isNaN(api.priority)) ? Number(api.priority) : 100;
  if (api.enable === undefined) api.enable = true;
  if (!Array.isArray(api.routes)) {
    if (api.routes) Bot.makeLog('warn', `API模块 ${key} 的 routes 不是数组`, 'HttpHelpers');
    api.routes = [];
  }
  return true;
}
