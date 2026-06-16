/**
 * XRK-Yunzai 控制台平台层：鉴权、HTTP 路径、与后端响应/请求格式对齐。
 * 业务页统一通过 fetchApi / API 常量访问后端，api-config 加载时 filterApiConfig 剔除 AGT 专有项。
 */

const STORAGE_KEY = 'apiKey';

/** 控制台业务代码引用的 HTTP 路径（与 plugins/system-plugin/http/* 一致） */
export const API = {
  status: '/api/status',
  systemStatus: '/api/system/status',
  systemOverview: '/api/system/overview',
  aiModels: '/api/ai/models',
  chatCompletions: '/api/v3/chat/completions',
  fileUpload: '/api/file/upload',
  pluginsSummary: '/api/plugins/summary',
  configList: '/api/config/list',
  configPath: (name, suffix) => `/api/config/${encodeURIComponent(name)}/${suffix}`
};

const AGT_ONLY_API_IDS = new Set([
  'device-asr-sessions',
  'device-asr-recordings',
  'device-file',
  'trash-file',
  'mcp-jsonrpc-get',
  'mcp-resources',
  'mcp-resource-read',
  'mcp-prompts',
  'mcp-prompt-get',
  'mcp-connect'
]);

export function isUnsupportedOnYunzai(api) {
  if (!api?.path) return true;
  if (AGT_ONLY_API_IDS.has(api.id)) return true;
  const path = api.path;
  if (path.includes('/asr/')) return true;
  if (path.startsWith('/api/trash')) return true;
  if (path.startsWith('/api/device/file/')) return true;
  if (path.startsWith('/api/mcp/resources')) return true;
  if (path.startsWith('/api/mcp/prompts')) return true;
  if (path === '/api/mcp/connect') return true;
  if (path === '/api/mcp/jsonrpc' && api.method === 'GET') return true;
  return false;
}

function fixPathStrings(value) {
  if (typeof value === 'string') {
    return value.replace(/core\/system-Core/g, 'plugins/system-plugin');
  }
  if (Array.isArray(value)) return value.map(fixPathStrings);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = fixPathStrings(v);
    return out;
  }
  return value;
}

function patchYunzaiApiDefinitions(config) {
  for (const group of config.apiGroups || []) {
    for (const api of group.apis || []) {
      if (api.id === 'v3-chat-completions' && Array.isArray(api.bodyParams)) {
        api.bodyParams = api.bodyParams.filter((p) => p.name !== 'apiKey');
        api.description =
          'OpenAI Chat Completions（鉴权用 X-API-Key 请求头；model 为 LLM 提供商名，留空则用 aistream 默认）';
      }
    }
  }

  if (config.examples?.['v3-chat-completions']) {
    const ex = config.examples['v3-chat-completions'];
    delete ex.apiKey;
    if (typeof ex.stream === 'string') ex.stream = ex.stream === 'true';
  }
  if (config.examples?.['stdin-command']) {
    delete config.examples['stdin-command'].json;
  }
  if (config.examples?.['stdin-event']?.content?.message) {
    config.examples['stdin-event'].content = config.examples['stdin-event'].content.message;
  }
  return config;
}

export function filterApiConfig(config) {
  if (!config?.apiGroups) return config;
  const clone = patchYunzaiApiDefinitions(
    fixPathStrings(JSON.parse(JSON.stringify(config)))
  );
  clone.apiGroups = clone.apiGroups
    .map((group) => ({
      ...group,
      apis: (group.apis || []).filter((api) => !isUnsupportedOnYunzai(api))
    }))
    .filter((group) => group.apis.length > 0);

  if (clone.examples) {
    for (const id of AGT_ONLY_API_IDS) delete clone.examples[id];
  }
  clone._platform = 'yunzai';
  return clone;
}

export function joinApiUrl(serverUrl, path, query = '') {
  const q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
  return `${serverUrl}${path}${q}`;
}

/** 统一带鉴权的 fetch（GET/JSON POST/multipart 上传） */
export async function fetchApi(serverUrl, path, opts = {}) {
  const { method = 'GET', body, query = '', timeout, upload = false } = opts;
  const hasJsonBody = body !== undefined && !(body instanceof FormData);
  const headers = upload
    ? getUploadHeaders()
    : getHeaders({ json: hasJsonBody });
  const init = { method };
  if (Object.keys(headers).length) init.headers = headers;
  if (body !== undefined) {
    init.body =
      body instanceof FormData || typeof body === 'string' ? body : JSON.stringify(body);
  }
  if (timeout) init.signal = AbortSignal.timeout(timeout);
  return fetch(joinApiUrl(serverUrl, path, query), init);
}

/** GET /api/ai/models → { success, data: { profiles, workflows, defaultProfile, enabled } } */
export function parseAiModelsResponse(json) {
  if (!json?.success) {
    throw new Error(json?.message || 'LLM 接口返回异常');
  }
  const payload = json.data;
  if (!payload || typeof payload !== 'object') {
    throw new Error('LLM 接口缺少 data 字段');
  }
  return {
    enabled: payload.enabled !== false,
    defaultProfile: payload.defaultProfile ?? '',
    profiles: payload.profiles ?? [],
    workflows: payload.workflows ?? []
  };
}

/** POST /api/file/upload → { success, file_url } 或 { success, files: [{ file_url }] } */
export function parseFileUploadUrls(json) {
  if (!json?.success) return [];
  const urls = [];
  if (json.file_url) urls.push(json.file_url);
  if (Array.isArray(json.files)) {
    for (const f of json.files) {
      if (f?.file_url) urls.push(f.file_url);
    }
  }
  return urls;
}

export function historyItemToChatMessage(item) {
  if (!item?.role) return null;
  if (Array.isArray(item.segments) && item.segments.length) {
    const parts = [];
    for (const seg of item.segments) {
      if (!seg) continue;
      if (seg.type === 'text' && seg.text) parts.push({ type: 'text', text: seg.text });
      else if (seg.type === 'image' && seg.url) {
        parts.push({ type: 'image_url', image_url: { url: seg.url } });
      } else if (seg.type === 'reply' && seg.text) {
        parts.push({ type: 'text', text: `[回复] ${seg.text}` });
      }
    }
    if (!parts.length && item.text) return { role: item.role, content: item.text };
    if (parts.length === 1 && parts[0].type === 'text') {
      return { role: item.role, content: parts[0].text };
    }
    if (parts.length) return { role: item.role, content: parts };
  }
  if (item.text) return { role: item.role, content: item.text };
  return null;
}

export function buildChatMessagesFromHistory(history, { excludeSystem = true } = {}) {
  return (history || [])
    .filter((m) => m?.role && (m.text || m.segments?.length))
    .filter((m) => !excludeSystem || m.role !== 'system')
    .map(historyItemToChatMessage)
    .filter(Boolean);
}

export function normalizeDebugRequestBody(apiId, body) {
  if (!body || typeof body !== 'object') return body;
  const next = { ...body };
  if (apiId === 'v3-chat-completions') {
    delete next.apiKey;
    delete next.api_key;
    if ('stream' in next && typeof next.stream === 'string') {
      next.stream = next.stream === 'true' || next.stream === '1';
    }
  }
  if (apiId === 'stdin-event' && next.content?.message) {
    next.content = next.content.message;
  }
  if (apiId === 'message-send') {
    if (next.target_id != null && next.target_id !== '') {
      next.target_id = String(next.target_id).trim();
    }
    if (typeof next.message === 'string') {
      const trimmed = next.message.trim();
      if (
        (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
        (trimmed.startsWith('{') && trimmed.endsWith('}'))
      ) {
        try {
          next.message = JSON.parse(trimmed);
        } catch {
          // 保持纯文本
        }
      }
    }
  }
  return next;
}

export function getApiKey() {
  const key = localStorage.getItem(STORAGE_KEY);
  return key?.trim() ? key.trim() : '';
}

export function setApiKey(key) {
  localStorage.setItem(STORAGE_KEY, String(key ?? '').trim());
}

export function getHeaders({ json = true } = {}) {
  const headers = {};
  if (json) headers['Content-Type'] = 'application/json';
  const key = getApiKey();
  if (key) headers['X-API-Key'] = key;
  return headers;
}

export function getUploadHeaders() {
  const key = getApiKey();
  return key ? { 'X-API-Key': key } : {};
}

export function buildDeviceWsUrl(serverUrl) {
  const apiKey = getApiKey();
  const protocol = serverUrl.startsWith('https') ? 'wss' : 'ws';
  const host = serverUrl.replace(/^https?:\/\//, '');
  return `${protocol}://${host}/device${apiKey ? `?api_key=${encodeURIComponent(apiKey)}` : ''}`;
}
