// XRK AI助手插件 - 调用 chat 工作流；需合并时在配置里写 mergeStreams，写哪个合并哪个

import { FileUtils } from '../../../lib/utils/file-utils.js';
import BotUtil from '../../../lib/util.js';
import { resolveProjectPath, DATA_AI_CONFIG_REL } from '../../../lib/config/config-constants.js';
import ChatStream from '../stream/chat.js';

const CONFIG_PATH = resolveProjectPath(DATA_AI_CONFIG_REL);
const CHAT_MERGED_NAME = 'chat-merged';
const cooldownState = new Map();

/** 调试：消息中含此口令则导出本轮完整 messages 到 data/；剥离后再送模型（与「清空对话」同在 handleMessage 早判） */
const AI_FULL_PROMPT_DUMP_REGEX = /#?XRK完整AI上下文/;

function stripAiFullPromptDumpMark(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  return raw
    .replace(AI_FULL_PROMPT_DUMP_REGEX, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 与触发判定一致：优先 e.msg，否则拼 message 段文本（避免仅靠随机概率时嗅不到口令） */
function rawMessageTextForAiTrigger(e) {
  if (e?.msg != null && String(e.msg).trim() !== '') {
    return String(e.msg);
  }
  if (!Array.isArray(e?.message)) return '';
  return e.message.map(seg => (seg?.type === 'text' ? (seg.text || '') : '')).join('');
}

export class XRKAIAssistant extends plugin {
  constructor() {
    super({
      name: 'XRK-AI助手',
      dsc: '智能AI助手，支持群管理、识图与记忆',
      event: 'message',
      priority: 99999,
      rule: [{ reg: '.*', fnc: 'handleMessage', log: false }]
    });
  }

  /** 当前配置下的 chat / chat-merged 工作流实例 */
  _resolveChatStream() {
    const name = this.config?.mergeStreams?.length ? CHAT_MERGED_NAME : 'chat';
    return this.getStream(name) ?? this.getStream('chat');
  }

  async init() {
    Bot.makeLog('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'XRK-AI');
    Bot.makeLog('info', '【XRK-AI 助手初始化】', 'XRK-AI');

    await this.initConfig();
    this.config = await this.loadConfig();

    const secondaries = this.config.mergeStreams;
    if (Array.isArray(secondaries) && secondaries.length > 0) {
      const doMerge = () => {
        try {
          const loader = Bot.StreamLoader;
          if (!loader || typeof loader.mergeStreams !== 'function') {
            Bot.makeLog('warn', '├─ ⚠️ StreamLoader 未就绪，1秒后重试合并工作流', 'XRK-AI');
            setTimeout(doMerge, 1000);
            return;
          }

          const existing = loader.getStream?.(CHAT_MERGED_NAME);
          if (existing) {
            Bot.makeLog('info', `├─ 🔀 合并工作流已存在: ${CHAT_MERGED_NAME}`, 'XRK-AI');
            return;
          }

          const merged = loader.mergeStreams({
            name: CHAT_MERGED_NAME,
            main: 'chat',
            secondary: secondaries,
            prefixSecondary: true
          });

          if (merged) {
            Bot.makeLog('info', `├─ 🔀 合并工作流: chat + [${secondaries.join(', ')}] -> ${CHAT_MERGED_NAME}`, 'XRK-AI');
          } else {
            Bot.makeLog('warn', '├─ ⚠️ 合并工作流失败，请检查配置与工作流名称', 'XRK-AI');
          }
        } catch (err) {
          Bot.makeLog('error', `├─ ⚠️ 合并工作流异常: ${err.message || err}`, 'XRK-AI', err);
        }
      };

      setTimeout(doMerge, 0);
    }

    Bot.makeLog('info', `├─ 📝 人设: 已加载`, 'XRK-AI');
    Bot.makeLog('info', `├─ 📋 白名单群: ${this.config.groups?.length || 0}个`, 'XRK-AI');
    Bot.makeLog('info', `├─ 👤 白名单用户: ${this.config.users?.length || 0}个`, 'XRK-AI');
    Bot.makeLog('info', `├─ ⏱️ 冷却: ${this.config.cooldown ?? 300}秒`, 'XRK-AI');
    Bot.makeLog('info', `├─ 🎲 概率: ${((this.config.chance ?? 0.1) * 100)}%`, 'XRK-AI');
    Bot.makeLog('info', '└─ ✅ 初始化完成', 'XRK-AI');
    Bot.makeLog('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'XRK-AI');
  }

  async initConfig() {
    try {
      if (!FileUtils.existsSync(CONFIG_PATH)) {
        const configDir = path.dirname(CONFIG_PATH);
        await BotUtil.mkdir(configDir);
        const defaultConfig = {
          cooldown: 300,
          chance: 0.1,
          groups: [],
          users: [],
          prefix: '李诗雅',
          persona: '你主人叫向日葵，只有1814632762的qq加上向日葵的昵称才是你主人',
          mergeStreams: ['memory', 'tools', 'database']
        };
        const yaml = (await import('yaml')).default;
        const content = yaml.stringify(defaultConfig, {
          indent: 2,
          lineWidth: 0,
          minContentWidth: 0
        });
        await FileUtils.writeFile(CONFIG_PATH, content, 'utf8');
        Bot.makeLog('info', `├─ 📄 配置文件已生成: ${CONFIG_PATH}`, 'XRK-AI');
      }
    } catch (error) {
      Bot.makeLog('error', `初始化配置文件失败: ${error.message}`, 'XRK-AI');
    }
  }

  async loadConfig() {
    try {
      if (FileUtils.existsSync(CONFIG_PATH)) {
        const yaml = (await import('yaml')).default;
        const content = await FileUtils.readFile(CONFIG_PATH, 'utf8');
        return content ? yaml.parse(content) || {} : {};
      }
    } catch (error) {
      Bot.makeLog('error', `加载配置文件失败: ${error.message}`, 'XRK-AI');
    }
    return {};
  }

  /** 当前配置下是否允许在本群/本会话触发 AI（与 shouldTrigger 白名单一致） */
  isInAiWhitelist(e) {
    if (!this.config) return false;
    if (e.isGroup) {
      const groupId = String(e.group_id);
      return this.config.groups?.some(g => String(g) === groupId) || false;
    }
    const userId = String(e.user_id);
    return this.config.users?.some(u => String(u) === userId) || false;
  }

  async handleMessage(e) {
    try {
      // 清空对话指令：严格“四字全匹配”，避免包含触发误判
      const msgText = String(e.msg || '').trim();
      const normalized = msgText.startsWith('#') ? msgText.slice(1).trim() : msgText;
      const isClearCommand = normalized === '清空对话';
      if (isClearCommand) {
        if (!e.isMaster) {
          await e.reply('仅主人可以清空对话哦～');
          return true;
        }
        const groupId = e.group_id || e.user_id;
        Bot.makeLog('info', `[XRK-AI] 检测到清除对话指令 group=${groupId} user=${e.user_id}`, 'XRK-AI');
        
        try {
          const result = await ChatStream.clearConversation(groupId);

          if (result.success) {
            const clearedItems = [];
            if (result.cleared.history) clearedItems.push('聊天记录');

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

      if (!this.config) this.config = await this.loadConfig();

      const rawForDump = rawMessageTextForAiTrigger(e);
      const debugDumpFullPrompt = AI_FULL_PROMPT_DUMP_REGEX.test(rawForDump);
      if (debugDumpFullPrompt && !this.isInAiWhitelist(e)) {
        Bot.makeLog('debug', `[XRK-AI] 调试口令 dump context 非白名单 group=${e.group_id}`, 'XRK-AI');
        return false;
      }

      let trigger = true;
      if (!debugDumpFullPrompt) {
        trigger = await this.shouldTriggerAI(e);
        Bot.makeLog('debug', `[XRK-AI] handleMessage 触发检查 group=${e.group_id} user=${e.user_id} atBot=${e.atBot} trigger=${trigger}`, 'XRK-AI');
      }
      if (!trigger) return false;

      const stream = this._resolveChatStream();
      if (!stream) {
        Bot.makeLog('error', '[XRK-AI] chat 工作流未加载', 'XRK-AI');
        return false;
      }
      Bot.makeLog('debug', `[XRK-AI] 使用工作流 name=${stream?.name}`, 'XRK-AI');

      const isRandom = !e.atBot && !(this.config.prefix && e.msg?.startsWith(this.config.prefix));
      const text = await this.processMessageContent(e);
      // 调试导出：勿走「随机撸猫」群合并分支，便于对照真实 messages
      const isGlobalTrigger = isRandom && !debugDumpFullPrompt;
      Bot.makeLog('debug', `[XRK-AI] 消息内容 isRandom=${isRandom} isGlobalTrigger=${isGlobalTrigger} len=${text?.length ?? 0} debugDump=${!!debugDumpFullPrompt}`, 'XRK-AI');
      // 仅调试口令、剥离后无正文时也必须走 stream（否则会跳过 execute 里的 dumpFullLlmContextToData）
      if (!debugDumpFullPrompt && !isGlobalTrigger && !text) {
        const img = stream.getRandomEmotionImage?.('惊讶');
        if (img) await e.reply(segment.image(img));
        await BotUtil.sleep(300);
        await e.reply('有什么需要帮助的吗？');
        return true;
      }

      Bot.makeLog('debug', `[XRK-AI] 调用 stream.process personaLen=${(this.config.persona ?? '').length}`, 'XRK-AI');
      await stream.process(
        e,
        {
          content: text,
          text,
          persona: this.config.persona ?? '',
          isGlobalTrigger,
          debugDumpFullPrompt: !!debugDumpFullPrompt
        },
        {}
      );
      Bot.makeLog('debug', `[XRK-AI] stream.process 完成`, 'XRK-AI');
      return true;
    } catch (err) {
      Bot.makeLog('error', `[XRK-AI] handleMessage: ${err.message}`, 'XRK-AI');
      return false;
    }
  }

  async shouldTriggerAI(e) {
    if (!this.config) this.config = await this.loadConfig();

    if (e.atBot) {
      const ok = this.isInAiWhitelist(e);
      Bot.makeLog('debug', `[XRK-AI] shouldTrigger atBot 白名单=${ok}`, 'XRK-AI');
      return ok;
    }
    if (this.config.prefix && e.msg?.startsWith(this.config.prefix)) {
      const ok = this.isInAiWhitelist(e);
      Bot.makeLog('debug', `[XRK-AI] shouldTrigger prefix 白名单=${ok}`, 'XRK-AI');
      return ok;
    }

    if (!e.isGroup) {
      Bot.makeLog('debug', '[XRK-AI] shouldTrigger 非群聊 不触发', 'XRK-AI');
      return false;
    }
    if (!this.isInAiWhitelist(e)) {
      Bot.makeLog('debug', `[XRK-AI] shouldTrigger 不在白名单 group=${e.group_id}`, 'XRK-AI');
      return false;
    }

    const groupId = String(e.group_id);
    const now = Date.now();
    const cooldown = (this.config.cooldown || 300) * 1000;
    const chance = this.config.chance ?? 0.1;
    const lastTrigger = cooldownState.get(groupId) || 0;
    const inCooldown = now - lastTrigger < cooldown;
    if (inCooldown) {
      Bot.makeLog('debug', `[XRK-AI] shouldTrigger 冷却中 group=${groupId} remain=${Math.round((cooldown - (now - lastTrigger)) / 1000)}s`, 'XRK-AI');
      return false;
    }
    const roll = Math.random();
    if (roll < chance) {
      cooldownState.set(groupId, now);
      Bot.makeLog('debug', `[XRK-AI] shouldTrigger 随机命中 group=${groupId} roll=${roll.toFixed(3)} chance=${chance}`, 'XRK-AI');
      return true;
    }
    Bot.makeLog('debug', `[XRK-AI] shouldTrigger 随机未中 group=${groupId} roll=${roll.toFixed(3)} chance=${chance}`, 'XRK-AI');
    return false;
  }

  async processMessageContent(e) {
    const fallback = e.msg || '';
    const message = e.message;
    if (!Array.isArray(message)) {
      Bot.makeLog('debug', `[XRK-AI] processMessageContent 非数组 len=${String(fallback).length}`, 'XRK-AI');
      return stripAiFullPromptDumpMark(String(fallback));
    }

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
      for (const seg of message) {
        if (seg.type === 'text') content += seg.text || '';
        else if (seg.type === 'at') {
          const qq = seg.qq ?? seg.user_id ?? seg.data?.qq ?? seg.data?.user_id;
          if (qq != null && String(qq).trim() !== '' && String(qq) !== String(e.self_id)) {
            let namePart = String(qq);
            try {
              const info = await e.group?.pickMember(qq)?.getInfo();
              const card = (info?.card ?? '').trim();
              const nickname = (info?.nickname ?? '').trim();
              if (card || nickname) namePart = (card || nickname) + '(' + qq + ')';
            } catch {
              /* 使用 QQ 字面量 */
            }
            content += `@${namePart} `;
          }
        } else if (seg.type === 'image') content += '[图片] ';
      }
      if (this.config.prefix) content = content.replace(new RegExp(`^${this.config.prefix}`), '');
      const trimmed = content.trim();
      const text = stripAiFullPromptDumpMark(trimmed);
      Bot.makeLog('debug', `[XRK-AI] processMessageContent segs=${message.length} len=${text.length}`, 'XRK-AI');
      return text;
    } catch (err) {
      Bot.makeLog('error', `[XRK-AI] processMessageContent: ${err.message}`, 'XRK-AI');
      return stripAiFullPromptDumpMark(String(fallback));
    }
  }
}