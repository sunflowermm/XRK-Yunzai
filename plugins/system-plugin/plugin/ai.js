/**
 * XRK AI 助手 — data/ai/config.yaml；@ / 前缀 / 群内随机触发；按需合并工作流
 */
import BotUtil from '../../../lib/util.js';
import {
  handleClearConversation,
  loadAiAssistantConfig,
  logAiInit,
  messageMatchesAiPrefix,
  processMessageContent,
  resolveChatStream,
  resolveEffectiveAiConfig,
  runChatAgent,
  shouldTriggerAI
} from '../lib/ai-assistant-runtime.js';

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

  async init() {
    this.config = await loadAiAssistantConfig();
    logAiInit(this.config);
  }

  async handleMessage(e) {
    try {
      this.config = await loadAiAssistantConfig();

      const msgText = String(e.msg || '').trim();
      const normalized = msgText.startsWith('#') ? msgText.slice(1).trim() : msgText;
      if (normalized === '清空对话') {
        if (!e.isMaster) {
          await e.reply('仅主人可以清空对话哦～');
          return true;
        }
        return handleClearConversation(e);
      }

      if (this.config.enabled === false) return false;

      const effective = resolveEffectiveAiConfig(e, this.config);
      if (effective.enabled === false) return false;

      if (!(await shouldTriggerAI(e, this.config))) return false;

      const stream = resolveChatStream(this, effective.mergeWorkflows);
      if (!stream) {
        Bot.makeLog('error', '[XRK-AI] chat 工作流未加载', 'XRK-AI');
        return false;
      }

      const isRandom = !e.atBot && !messageMatchesAiPrefix(e.msg, effective.prefixes);
      const text = await processMessageContent(e);
      const isGlobalTrigger = isRandom;
      Bot.makeLog('debug', `[XRK-AI] 消息内容 isRandom=${isRandom} len=${text?.length ?? 0} stream=${stream?.name}`, 'XRK-AI');

      if (!isGlobalTrigger && !text) {
        const img = stream.getRandomEmotionImage?.('惊讶');
        if (img) await e.reply(segment.image(img));
        await BotUtil.sleep(300);
        await e.reply('有什么需要帮助的吗？');
        return true;
      }

      await runChatAgent(this, e, {
        text,
        persona: effective.persona ?? '',
        config: this.config,
        isGlobalTrigger
      });
      return true;
    } catch (err) {
      Bot.makeLog('error', `[XRK-AI] handleMessage: ${err.message}`, 'XRK-AI');
      return false;
    }
  }
}
