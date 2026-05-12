/**
 * 非流式 chat() + MCP 多轮工具：是否已调用 `*.reply` 的标记与返回值形态（供 LLM 工厂与 AIStream）。
 */
import { MCPToolAdapter } from './mcp-tool-adapter.js';

function markReplyIfName(tracker, name) {
  if (tracker.usedReplyTool) return;
  if (MCPToolAdapter.isReplySendOpenAiOrMcpName(name)) tracker.usedReplyTool = true;
}

/** @returns {{ usedReplyTool: boolean }} */
export function createLlmChatReplyTracker() {
  return { usedReplyTool: false };
}

export function noteLlmChatToolCallsForReply(tracker, toolCalls) {
  if (!tracker || !Array.isArray(toolCalls)) return;
  for (let i = 0; i < toolCalls.length; i++) {
    markReplyIfName(tracker, toolCalls[i]?.function?.name);
    if (tracker.usedReplyTool) return;
  }
}

export function noteLlmChatFunctionCallNamesForReply(tracker, names) {
  if (!tracker || !Array.isArray(names)) return;
  for (let i = 0; i < names.length; i++) {
    markReplyIfName(tracker, names[i]);
    if (tracker.usedReplyTool) return;
  }
}

/**
 * 未调用 reply → 返回 string；已调用 → `{ content, usedReplyTool: true }`
 */
export function finalizeLlmChatNonStreamContent(tracker, content) {
  const c = content == null ? '' : String(content);
  return tracker?.usedReplyTool ? { content: c, usedReplyTool: true } : c;
}

/** AIStream 解析各工厂 chat() 返回值 */
export function normalizeLlmClientChatReturn(raw) {
  if (raw == null) return { text: null, usedReplyTool: false };
  if (typeof raw === 'string') return { text: raw, usedReplyTool: false };
  if (typeof raw !== 'object') return { text: String(raw), usedReplyTool: false };
  const usedReplyTool = !!raw.usedReplyTool;
  if (raw.content === undefined && !usedReplyTool) return { text: null, usedReplyTool: false };
  const text = raw.content == null ? '' : String(raw.content);
  return { text, usedReplyTool };
}
