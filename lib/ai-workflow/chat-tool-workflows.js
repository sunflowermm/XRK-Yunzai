/**
 * chat 工具流白名单（对齐 XRK-AGT：勾选即严格，不自动挂 remote-mcp）
 *
 * 优先级：
 * 1. 请求 ALS 的 toolStreamNames（mergeWorkflows / 控制台显式勾选）
 * 2. 合成流 _mergedStreams 自身名单
 * 3. 流自身 name
 */
import AiWorkflowLoader from './loader.js';
import { getWorkflowRequestContext } from './workflow-request-context.js';
import { normalizeStringArray } from '../utils/string-array-utils.js';

export function isChatToolSurface(stream) {
  if (!stream) return false;
  if (stream.name === 'chat' || stream.name === 'chat-merged') return true;
  if (stream.primaryStream === 'chat') return true;
  if (Array.isArray(stream._mergedStreams) && stream._mergedStreams.some((s) => s?.name === 'chat')) {
    return true;
  }
  return typeof stream.name === 'string'
    && (stream.name === 'chat-merged' || stream.name.startsWith('chat-'));
}

export function isRemoteMcpStreamName(name) {
  return String(name ?? '').startsWith('remote-mcp.');
}

/** 可 merge 的实体流 vs 仅工具面名字（remote-mcp.*） */
export function partitionToolStreamNames(names) {
  const mergeable = [];
  const toolOnly = [];
  for (const n of normalizeStringArray(names)) {
    if (isRemoteMcpStreamName(n)) toolOnly.push(n);
    else mergeable.push(n);
  }
  return { mergeable, toolOnly };
}

function streamOwnNames(stream) {
  if (Array.isArray(stream?._mergedStreams) && stream._mergedStreams.length > 0) {
    return stream._mergedStreams.map((s) => s.name).filter(Boolean);
  }
  return [stream?.name].filter(Boolean);
}

/** 供 AIStream / HTTP：只返回显式名单 */
export function resolveToolWorkflowNames(stream) {
  const ctx = getWorkflowRequestContext();
  if (Array.isArray(ctx?.toolStreamNames)) {
    return normalizeStringArray(ctx.toolStreamNames);
  }
  return streamOwnNames(stream);
}

/** 收集 mergeWorkflows 副流上的 buildSystemPrompt，拼入主 chat system。 */
export function collectAuxiliaryWorkflowPrompts(stream, context = {}) {
  if (!stream || !isChatToolSurface(stream)) return '';
  const names = resolveToolWorkflowNames(stream);
  const skip = new Set(['chat', 'chat-merged', stream.name].filter(Boolean));
  const parts = [];

  for (const name of names) {
    if (skip.has(name) || isRemoteMcpStreamName(name) || String(name).startsWith('chat-')) continue;
    const aux = AiWorkflowLoader.getWorkflow(name);
    if (!aux || typeof aux.buildSystemPrompt !== 'function') continue;
    try {
      const out = aux.buildSystemPrompt(context);
      const text = typeof out === 'string' ? out : (out != null ? String(out) : '');
      if (text.trim()) parts.push(`### ${name}\n${text.trim()}`);
    } catch {
      /* ignore */
    }
  }

  if (!parts.length) return '';
  return `\n\n## 可用能力\n\n${parts.join('\n\n')}`;
}
