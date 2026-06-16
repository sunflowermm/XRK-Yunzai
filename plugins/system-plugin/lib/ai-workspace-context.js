import { AsyncLocalStorage } from 'node:async_hooks';
import { getAistreamConfigOptional } from '../../../lib/utils/aistream-config.js';
import { auditToolUse, formatAuditDetail } from './ai-workspace-audit.js';

const consoleContext = new AsyncLocalStorage();
let mcpAuditHookInstalled = false;

function isAuditEnabled() {
  const cfg = getAistreamConfigOptional();
  return cfg?.workspace?.audit?.enabled !== false;
}

async function recordToolAudit(toolName, { ok = true, detail = '' } = {}) {
  if (!isAuditEnabled()) return;
  const ctx = getAiConsoleContext();
  const workspaceId = ctx.workspaceId;
  if (!workspaceId || !toolName) return;

  const formatted = formatAuditDetail(detail);
  try {
    await auditToolUse(workspaceId, toolName, { ok, detail: formatted });
  } catch (err) {
    Bot.makeLog('debug', `[ai-workspace] 审计写入失败: ${err?.message || err}`, 'AIWorkspace');
  }
}

export function installMcpAuditHook(StreamLoader) {
  if (mcpAuditHookInstalled) return true;

  const server = StreamLoader?.mcpServer;
  if (!server || typeof server.handleToolCall !== 'function') return false;

  const original = server.handleToolCall.bind(server);
  server.handleToolCall = async (request) => {
    const toolName = request?.name;
    try {
      const result = await original(request);
      if (toolName) {
        const ok = !result?.isError;
        const detail = ok ? '' : (result?.content?.[0]?.text || '');
        await recordToolAudit(toolName, { ok, detail });
      }
      return result;
    } catch (err) {
      if (toolName) {
        await recordToolAudit(toolName, { ok: false, detail: err?.message || String(err) });
      }
      throw err;
    }
  };

  mcpAuditHookInstalled = true;
  return true;
}

export function runWithAiConsoleContext(ctx = {}, fn) {
  const parent = consoleContext.getStore() || {};
  const next = { ...parent, ...ctx };
  return consoleContext.run(next, fn);
}

export function getAiConsoleContext() {
  return consoleContext.getStore() || {};
}
