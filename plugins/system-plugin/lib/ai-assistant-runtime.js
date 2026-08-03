/**
 * AI 助手运行时 — 读 ai_config、触发判定、按需 merge chat
 */
import { flattenMessageSegs, segQq, segText } from '../../../lib/utils/onebot-message-seg.js';
import { normalizeStringArray } from '../../../lib/utils/string-array-utils.js';
import { partitionToolStreamNames } from '../../../lib/ai-workflow/chat-tool-workflows.js';
import ChatStream from '../workflow/chat.js';

const cooldownState = new Map();

function resolveAiConfigInstance() {
  try {
    const cm = globalThis.ConfigManager || Bot?.ConfigManager;
    if (!cm?.get) return null;
    const direct = cm.get('ai_config') || cm.get('system-plugin_ai_config');
    if (direct) return direct;
    if (typeof cm.getAll === 'function') {
      for (const [key, inst] of cm.getAll()) {
        if (key === 'ai_config' || String(key).endsWith('_ai_config') || String(key).endsWith('/ai_config')) {
          return inst;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function findGroupOverride(config, groupId) {
  const gid = String(groupId ?? '');
  if (!gid || !Array.isArray(config?.groupOverrides)) return null;
  return config.groupOverrides.find((row) => String(row?.groupId ?? '') === gid) || null;
}

/**
 * 全局默认 + 群覆盖。
 * 有群覆盖行时 mergeWorkflows 整表替换；llmProvider/prefixes/chance/cooldown/enabled 有值才盖。
 */
export function resolveEffectiveAiConfig(e, config) {
  const base = config && typeof config === 'object' ? config : {};
  const effective = {
    ...base,
    prefixes: normalizeStringArray(base.prefixes),
    mergeWorkflows: normalizeStringArray(base.mergeWorkflows),
    llmProvider: base.llmProvider != null ? String(base.llmProvider).trim() : '',
    cooldown: base.cooldown ?? 300,
    chance: base.chance ?? 0.1,
    enabled: base.enabled !== false
  };

  if (!e?.isGroup) return effective;
  const ov = findGroupOverride(base, e.group_id);
  if (!ov) return effective;

  if (typeof ov.enabled === 'boolean') effective.enabled = ov.enabled;
  if (Array.isArray(ov.prefixes) && ov.prefixes.length) {
    effective.prefixes = normalizeStringArray(ov.prefixes);
  }
  if (typeof ov.chance === 'number' && Number.isFinite(ov.chance)) {
    effective.chance = ov.chance;
  }
  if (typeof ov.cooldown === 'number' && Number.isFinite(ov.cooldown)) {
    effective.cooldown = ov.cooldown;
  }
  const ovProvider = ov.llmProvider != null ? String(ov.llmProvider).trim() : '';
  if (ovProvider) effective.llmProvider = ovProvider;
  effective.mergeWorkflows = normalizeStringArray(ov.mergeWorkflows);
  return effective;
}

export function messageMatchesAiPrefix(msg, prefixes) {
  const text = String(msg ?? '');
  if (!text) return false;
  for (const p of normalizeStringArray(prefixes)) {
    if (p && text.startsWith(p)) return true;
  }
  return false;
}

export async function loadAiAssistantConfig() {
  const inst = resolveAiConfigInstance();
  if (inst && typeof inst.read === 'function') return inst.read(true);
  const { default: AIConfig } = await import('../commonconfig/ai_config.js');
  return new AIConfig().read(true);
}

/** @param {object} plugin @param {string[]} [mergeList] 仅实体工作流名，勿含 remote-mcp.* */
export function resolveChatStream(plugin, mergeList) {
  const { mergeable } = partitionToolStreamNames(mergeList);
  const loader = Bot?.AiWorkflowLoader;
  const get = (name) => plugin?.getWorkflow?.(name) ?? loader?.getWorkflow?.(name) ?? null;

  if (!mergeable.length) return get('chat');

  const mergedName = `chat-merged:${mergeable.join('+')}`;
  const existing = get(mergedName);
  if (existing) return existing;

  if (loader && typeof loader.mergeWorkflows === 'function') {
    const merged = loader.mergeWorkflows({
      name: mergedName,
      main: 'chat',
      secondary: mergeable,
      prefixSecondary: true
    });
    if (merged) return merged;
  }
  return get('chat');
}

export function isInAiWhitelist(e, config) {
  if (!config) return false;
  if (e.isGroup) {
    const groups = config.groups;
    if (!Array.isArray(groups) || groups.length === 0) return true;
    return groups.some((g) => String(g) === String(e.group_id));
  }
  const users = config.users;
  if (!Array.isArray(users) || users.length === 0) return false;
  return users.some((u) => String(u) === String(e.user_id));
}

export async function shouldTriggerAI(e, config) {
  if (!config) return false;
  const effective = resolveEffectiveAiConfig(e, config);
  if (effective.enabled === false) return false;

  if (e.atBot) return isInAiWhitelist(e, config);
  if (messageMatchesAiPrefix(e.msg, effective.prefixes)) {
    return isInAiWhitelist(e, config);
  }
  if (!e.isGroup || !isInAiWhitelist(e, config)) return false;

  const groupId = String(e.group_id);
  const now = Date.now();
  const last = cooldownState.get(groupId) || 0;
  if (now - last < (effective.cooldown ?? 300) * 1000) return false;
  if (Math.random() < (effective.chance ?? 0.1)) {
    cooldownState.set(groupId, now);
    return true;
  }
  return false;
}

export async function processMessageContent(e) {
  const fallback = e.msg || '';
  const message = e.message;
  if (!Array.isArray(message)) return String(fallback);

  try {
    let content = '';
    if (e.source && typeof e.getReply === 'function') {
      try {
        const reply = await e.getReply();
        if (reply) {
          const name = reply.sender?.card || reply.sender?.nickname || '未知';
          const raw = reply.raw_message || '';
          content += `[回复${name}的"${raw}"] `;
        }
      } catch (err) {
        Bot.makeLog('debug', `[XRK-AI] processMessageContent getReply 失败: ${err.message}`, 'XRK-AI');
      }
    }
    for (const seg of flattenMessageSegs(message)) {
      if (seg.type === 'text') content += segText(seg);
      else if (seg.type === 'at') {
        const qqStr = segQq(seg);
        if (!qqStr) continue;
        if (qqStr === String(e.self_id) || qqStr === 'all') {
          content += `@机器人(${e.self_id}) `;
          continue;
        }
        let namePart = qqStr;
        try {
          const info = await e.group?.pickMember(qqStr)?.getInfo();
          const card = (info?.card ?? '').trim();
          const nickname = (info?.nickname ?? '').trim();
          if (card || nickname) namePart = (card || nickname) + '(' + qqStr + ')';
        } catch {
          /* 使用 QQ 字面量 */
        }
        content += `@${namePart} `;
      } else if (seg.type === 'image' || seg.type === 'mface') content += '[图片] ';
      else if (seg.type === 'video') content += '[视频] ';
      else if (seg.type === 'record' || seg.type === 'audio') content += '[语音] ';
      else if (seg.type === 'file') content += '[文件] ';
    }
    return content.trim();
  } catch (err) {
    Bot.makeLog('error', `[XRK-AI] processMessageContent: ${err.message}`, 'XRK-AI');
    return String(fallback);
  }
}

export async function runChatAgent(plugin, e, {
  text,
  persona = '',
  config,
  isGlobalTrigger = false
} = {}) {
  const effective = resolveEffectiveAiConfig(e, config);
  const { mergeable, toolOnly } = partitionToolStreamNames(effective.mergeWorkflows);
  const stream = resolveChatStream(plugin, mergeable);
  if (!stream) {
    Bot.makeLog('error', '[XRK-AI] chat 工作流未加载', 'XRK-AI');
    return false;
  }

  const apiConfig = {
    // 勾选即严格：仅 chat + 已选副流 + 已选 remote-mcp.*，不自动挂其它 MCP
    toolStreamNames: ['chat', ...mergeable, ...toolOnly]
  };
  if (effective.llmProvider) apiConfig.provider = effective.llmProvider;

  await Bot.AiWorkflowLoader.executeWorkflow(
    stream,
    e,
    {
      content: text,
      text,
      persona,
      isGlobalTrigger
    },
    apiConfig
  );
  return true;
}

export async function handleClearConversation(e) {
  const groupId = e.group_id || e.user_id;
  Bot.makeLog('info', `[XRK-AI] 检测到清除对话指令 group=${groupId} user=${e.user_id}`, 'XRK-AI');
  try {
    const result = await ChatStream.clearConversation(e.group_id || e.user_id, { e });
    if (result.success) {
      const clearedItems = [];
      if (result.cleared.history) clearedItems.push('聊天记录');
      if (result.cleared.memory) clearedItems.push('Redis 记忆');
      await e.reply(`✅ 对话已重置！已清除：${clearedItems.join('、') || '无'}`);
      Bot.makeLog('info', `[XRK-AI] 清除对话成功 group=${groupId} cleared=${JSON.stringify(result.cleared)}`, 'XRK-AI');
    } else {
      await e.reply('❌ 清除对话失败，请稍后重试');
    }
  } catch (err) {
    Bot.makeLog('error', `[XRK-AI] 清除对话异常: ${err.message}`, 'XRK-AI');
    await e.reply('❌ 清除对话时发生错误');
  }
  return true;
}

export function logAiInit(config) {
  const prefixes = normalizeStringArray(config?.prefixes);
  const overrides = Array.isArray(config?.groupOverrides) ? config.groupOverrides.length : 0;
  const provider = config?.llmProvider != null ? String(config.llmProvider).trim() : '';
  Bot.makeLog('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'XRK-AI');
  Bot.makeLog('info', '【XRK-AI 助手初始化】', 'XRK-AI');
  Bot.makeLog('info', `├─ 启用: ${config?.enabled !== false}`, 'XRK-AI');
  Bot.makeLog('info', `├─ 前缀: [${prefixes.join(',') || '无'}]`, 'XRK-AI');
  Bot.makeLog('info', `├─ 白名单群: ${config?.groups?.length || 0}个（空=不限制）`, 'XRK-AI');
  Bot.makeLog('info', `├─ 白名单用户: ${config?.users?.length || 0}个`, 'XRK-AI');
  Bot.makeLog('info', `├─ 群覆盖: ${overrides}`, 'XRK-AI');
  Bot.makeLog('info', `├─ llm: ${provider || 'ai-workflow'}`, 'XRK-AI');
  Bot.makeLog('info', `├─ merge: [${normalizeStringArray(config?.mergeWorkflows).join(',')}]`, 'XRK-AI');
  Bot.makeLog('info', `├─ 冷却: ${config?.cooldown ?? 300}秒 · 概率: ${((config?.chance ?? 0.1) * 100)}%`, 'XRK-AI');
  Bot.makeLog('info', '└─ ✅ 初始化完成', 'XRK-AI');
  Bot.makeLog('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'XRK-AI');
}
