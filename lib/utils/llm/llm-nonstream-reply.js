/**
 * 非流式 LLM + MCP：reply 追踪、工具轮次耗尽、callAI 解析。
 */
import { MCPToolAdapter } from './mcp-tool-adapter.js';

export const TOOL_ROUNDS_EXHAUSTED_USER_TEXT =
  '本轮工具调用次数已达上限，任务还没收尾。你可以再说「继续」，或把需求拆小一点。';

/** 注入非流式补救轮：要求模型改用 reply 发出用户可见内容 */
export const REPLY_RECOVERY_NUDGE =
  '【系统·仅你可见】上一轮未调用 reply 工具，群用户看不见 assistant 正文。请在本轮用 reply 发出要对用户说的话（可用 | 分句）；勿粘贴 JSON/工具日志/Markdown 标题。若无需长篇，reply 一句即可。';

export function createReplyTrack() {
  return { usedReplyTool: false };
}

/** `tool_calls`（Chat）或 Responses `function_call`：读 `function.name` 或 `name` */
export function noteReplyFromModelCalls(track, items) {
  if (!track || !Array.isArray(items)) return;
  for (let i = 0; i < items.length; i++) {
    if (track.usedReplyTool) return;
    const name = items[i]?.function?.name ?? items[i]?.name;
    if (MCPToolAdapter.isReplySendOpenAiOrMcpName(name)) track.usedReplyTool = true;
  }
}

export function packNonStreamReturn(track, assistantText) {
  const t = assistantText == null ? '' : String(assistantText);
  return track?.usedReplyTool ? { content: t, usedReplyTool: true } : t;
}

/** 工具轮次用尽：由 chat.execute 向用户发送固定提示（非 tool JSON） */
export function packToolRoundsExhausted(track) {
  return {
    content: TOOL_ROUNDS_EXHAUSTED_USER_TEXT,
    toolRoundsExhausted: true,
    usedReplyTool: !!track?.usedReplyTool
  };
}

/** 解析各工厂 `chat()` 返回值 */
export function unpackFactoryChatRaw(raw) {
  if (raw == null) return { text: null, usedReplyTool: false, toolRoundsExhausted: false };
  if (typeof raw === 'string') {
    return { text: raw, usedReplyTool: false, toolRoundsExhausted: false };
  }
  if (typeof raw !== 'object') {
    return { text: String(raw), usedReplyTool: false, toolRoundsExhausted: false };
  }
  const usedReplyTool = !!raw.usedReplyTool;
  const toolRoundsExhausted = !!raw.toolRoundsExhausted;
  if (toolRoundsExhausted) {
    const text = raw.content != null ? String(raw.content) : TOOL_ROUNDS_EXHAUSTED_USER_TEXT;
    return { text, usedReplyTool, toolRoundsExhausted: true };
  }
  if (raw.content === undefined && !usedReplyTool) {
    return { text: null, usedReplyTool: false, toolRoundsExhausted: false };
  }
  const text = raw.content == null ? '' : String(raw.content);
  return { text, usedReplyTool, toolRoundsExhausted: false };
}
