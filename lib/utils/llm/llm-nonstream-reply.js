/**
 * 非流式 LLM + MCP：本轮是否已执行 `*.reply`（工厂 pack）与 AIStream.callAI 解析（unpack）。
 * 链：XRK-AI → stream.process/execute → ChatStream.callAI → AIStream.callAI → LLMFactory.chat → MCP；正文再发由 execute 看 usedReplyTool。
 */
import { MCPToolAdapter } from './mcp-tool-adapter.js';

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

/** 解析各工厂 `chat()` 返回值 */
export function unpackFactoryChatRaw(raw) {
  if (raw == null) return { text: null, usedReplyTool: false };
  if (typeof raw === 'string') return { text: raw, usedReplyTool: false };
  if (typeof raw !== 'object') return { text: String(raw), usedReplyTool: false };
  const usedReplyTool = !!raw.usedReplyTool;
  if (raw.content === undefined && !usedReplyTool) return { text: null, usedReplyTool: false };
  const text = raw.content == null ? '' : String(raw.content);
  return { text, usedReplyTool };
}
