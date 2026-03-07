// XRK AI助手插件 - 调用 chat 工作流；需合并时在配置里写 mergeStreams，写哪个合并哪个

import path from 'path';
import BotUtil from '../../../lib/util.js';
import { FileUtils } from '../../../lib/utils/file-utils.js';

const CONFIG_PATH = path.join(process.cwd(), 'data/ai/config.yaml');
const CHAT_MERGED_NAME = 'chat-merged';
const cooldownState = new Map();

export class XRKAIAssistant extends plugin {
  constructor() {
    super({
      name: 'XRK-AI助手',
      dsc: '智能AI助手，支持群管理、识图、语义检索',
      event: 'message',
      priority: 99999,
      rule: [{ reg: '.*', fnc: 'handleMessage', log: false }]
    });
  }

  async init() {
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('【XRK-AI 助手初始化】');

    await this.initConfig();
    this.config = await this.loadConfig();

    const secondaries = this.config.mergeStreams;
    if (Array.isArray(secondaries) && secondaries.length > 0) {
      const doMerge = () => {
        try {
          const loader = Bot.StreamLoader;
          if (!loader || typeof loader.mergeStreams !== 'function') {
            logger.warn('├─ ⚠️ StreamLoader 未就绪，1秒后重试合并工作流', 'XRK-AI');
            setTimeout(doMerge, 1000);
            return;
          }

          // 如果已经合并过就直接返回，避免重复日志
          const existing = loader.getStream
            ? loader.getStream(CHAT_MERGED_NAME)
            : null;
          if (existing) {
            logger.info(`├─ 🔀 合并工作流已存在: ${CHAT_MERGED_NAME}`);
            return;
          }

          const merged = loader.mergeStreams({
            name: CHAT_MERGED_NAME,
            main: 'chat',
            secondary: secondaries,
            prefixSecondary: true
          });

          if (merged) {
            logger.info(`├─ 🔀 合并工作流: chat + [${secondaries.join(', ')}] -> ${CHAT_MERGED_NAME}`);
          } else {
            logger.warn('├─ ⚠️ 合并工作流失败，请检查配置与工作流名称', 'XRK-AI');
          }
        } catch (err) {
          logger.error(`├─ ⚠️ 合并工作流异常: ${err.message || err}`, 'XRK-AI');
        }
      };

      // 延迟执行，确保 StreamLoader 和各工作流已经完成初始化与注册
      setTimeout(doMerge, 0);
    }

    logger.info(`├─ 📝 人设: 已加载`);
    logger.info(`├─ 📋 白名单群: ${this.config.groups?.length || 0}个`);
    logger.info(`├─ 👤 白名单用户: ${this.config.users?.length || 0}个`);
    logger.info(`├─ ⏱️ 冷却: ${this.config.cooldown ?? 300}秒`);
    logger.info(`├─ 🎲 概率: ${((this.config.chance ?? 0.1) * 100)}%`);
    logger.info('└─ ✅ 初始化完成');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
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
        logger.info(`├─ 📄 配置文件已生成: ${CONFIG_PATH}`);
      }
    } catch (error) {
      logger.error(`初始化配置文件失败: ${error.message}`);
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
      logger.error(`加载配置文件失败: ${error.message}`);
    }
    return {};
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
        // 主人可以清除对话
        const ChatStream = (await import('../stream/chat.js')).default;
        const groupId = e.group_id || e.user_id;
        BotUtil.makeLog('info', `[XRK-AI] 检测到清除对话指令 group=${groupId} user=${e.user_id}`, 'XRK-AI');
        
        try {
          const result = await ChatStream.clearConversation(groupId, { clearEmbedding: true });
          
          // 清除所有相关实例的回复内容记录
          const streamName = this.config?.mergeStreams?.length ? CHAT_MERGED_NAME : 'chat';
          const stream = this.getStream(streamName) ?? this.getStream('chat');
          if (stream && typeof stream.clearReplyContents === 'function') {
            stream.clearReplyContents(groupId);
          }
          
          // 如果使用了合并工作流，也清除主工作流的记录
          if (streamName === CHAT_MERGED_NAME) {
            const mainStream = this.getStream('chat');
            if (mainStream && typeof mainStream.clearReplyContents === 'function') {
              mainStream.clearReplyContents(groupId);
            }
          }
          
          if (result.success) {
            const clearedItems = [];
            if (result.cleared.history) clearedItems.push('聊天记录');
            if (result.cleared.embedding) clearedItems.push('语义记忆');
            if (result.cleared.replyContents) clearedItems.push('回复记录');
            
            await e.reply(`✅ 对话已重置！已清除：${clearedItems.join('、') || '无'}`);
            BotUtil.makeLog('info', `[XRK-AI] 清除对话成功 group=${groupId} cleared=${JSON.stringify(result.cleared)}`, 'XRK-AI');
          } else {
            await e.reply('❌ 清除对话失败，请稍后重试');
          }
        } catch (err) {
          BotUtil.makeLog('error', `[XRK-AI] 清除对话异常: ${err.message}`, 'XRK-AI');
          await e.reply('❌ 清除对话时发生错误');
        }
        return true;
      }

      const trigger = await this.shouldTriggerAI(e);
      BotUtil.makeLog('debug', `[XRK-AI] handleMessage 触发检查 group=${e.group_id} user=${e.user_id} atBot=${e.atBot} trigger=${trigger}`, 'XRK-AI');
      if (!trigger) return false;

      if (!this.config) this.config = await this.loadConfig();
      const streamName = this.config.mergeStreams?.length ? CHAT_MERGED_NAME : 'chat';
      const stream = this.getStream(streamName) ?? this.getStream('chat');
      if (!stream) {
        logger.error('[XRK-AI] chat 工作流未加载');
        return false;
      }
      BotUtil.makeLog('debug', `[XRK-AI] 使用工作流 stream=${streamName} name=${stream?.name}`, 'XRK-AI');

      const isRandom = !e.atBot && !(this.config.prefix && e.msg?.startsWith(this.config.prefix));
      const { content } = await this.processMessageContent(e);
      BotUtil.makeLog('debug', `[XRK-AI] 消息内容 isRandom=${isRandom} contentLen=${content?.length ?? 0} content=${content ?? ''}`, 'XRK-AI');
      if (!isRandom && !content) {
        const img = stream.getRandomEmotionImage?.('惊讶');
        if (img) await e.reply(segment.image(img));
        await BotUtil.sleep(300);
        await e.reply('有什么需要帮助的吗？');
        return true;
      }

      const text = content ?? '';
      BotUtil.makeLog('debug', `[XRK-AI] 调用 stream.process personaLen=${(this.config.persona ?? '').length}`, 'XRK-AI');
      await stream.process(e, {
        content: text,
        text,
        persona: this.config.persona ?? '',
        isGlobalTrigger: isRandom
      }, {});
      BotUtil.makeLog('debug', `[XRK-AI] stream.process 完成`, 'XRK-AI');
      return true;
    } catch (err) {
      logger.error(`[XRK-AI] 消息处理错误: ${err.message}`);
      BotUtil.makeLog('error', `[XRK-AI] handleMessage 异常: ${err.message}`, 'XRK-AI');
      return false;
    }
  }

  async shouldTriggerAI(e) {
    if (!this.config) this.config = await this.loadConfig();

    const isInWhitelist = () => {
      if (e.isGroup) {
        const groupId = String(e.group_id);
        return this.config.groups?.some(g => String(g) === groupId) || false;
      }
      const userId = String(e.user_id);
      return this.config.users?.some(u => String(u) === userId) || false;
    };

    if (e.atBot) {
      const ok = isInWhitelist();
      BotUtil.makeLog('debug', `[XRK-AI] shouldTrigger atBot 白名单=${ok}`, 'XRK-AI');
      return ok;
    }
    if (this.config.prefix && e.msg?.startsWith(this.config.prefix)) {
      const ok = isInWhitelist();
      BotUtil.makeLog('debug', `[XRK-AI] shouldTrigger prefix 白名单=${ok}`, 'XRK-AI');
      return ok;
    }

    if (!e.isGroup) {
      BotUtil.makeLog('debug', '[XRK-AI] shouldTrigger 非群聊 不触发', 'XRK-AI');
      return false;
    }
    if (!isInWhitelist()) {
      BotUtil.makeLog('debug', `[XRK-AI] shouldTrigger 不在白名单 group=${e.group_id}`, 'XRK-AI');
      return false;
    }

    const groupId = String(e.group_id);
    const now = Date.now();
    const cooldown = (this.config.cooldown || 300) * 1000;
    const chance = this.config.chance ?? 0.1;
    const lastTrigger = cooldownState.get(groupId) || 0;
    const inCooldown = now - lastTrigger < cooldown;
    if (inCooldown) {
      BotUtil.makeLog('debug', `[XRK-AI] shouldTrigger 冷却中 group=${groupId} remain=${Math.round((cooldown - (now - lastTrigger)) / 1000)}s`, 'XRK-AI');
      return false;
    }
    const roll = Math.random();
    if (roll < chance) {
      cooldownState.set(groupId, now);
      BotUtil.makeLog('debug', `[XRK-AI] shouldTrigger 随机命中 group=${groupId} roll=${roll.toFixed(3)} chance=${chance}`, 'XRK-AI');
      return true;
    }
    BotUtil.makeLog('debug', `[XRK-AI] shouldTrigger 随机未中 group=${groupId} roll=${roll.toFixed(3)} chance=${chance}`, 'XRK-AI');
    return false;
  }

  async processMessageContent(e) {
    const fallback = e.msg || '';
    const message = e.message;
    if (!Array.isArray(message)) {
      BotUtil.makeLog('debug', `[XRK-AI] processMessageContent 非数组消息 使用 fallback len=${fallback.length}`, 'XRK-AI');
      return { content: fallback, text: fallback };
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
          BotUtil.makeLog('debug', `[XRK-AI] processMessageContent getReply 失败: ${err.message}`, 'XRK-AI');
        }
      }
      for (const seg of message) {
        if (seg.type === 'text') content += seg.text || '';
        else if (seg.type === 'at') {
          const qq = seg.qq ?? seg.user_id ?? seg.data?.qq ?? seg.data?.user_id;
          BotUtil.makeLog('debug', `[XRK-AI] processMessageContent at seg raw: qq=${seg.qq} user_id=${seg.user_id} data.qq=${seg.data?.qq} data.user_id=${seg.data?.user_id} => 提取qq=${qq}`, 'XRK-AI');
          if (qq != null && String(qq).trim() !== '' && String(qq) !== String(e.self_id)) {
            let namePart = '';
            try {
              const info = await e.group?.pickMember(qq)?.getInfo();
              const card = (info?.card ?? '').trim();
              const nickname = (info?.nickname ?? '').trim();
              if (card || nickname) namePart = (card || nickname) + '(' + qq + ')';
              else namePart = String(qq);
              BotUtil.makeLog('debug', `[XRK-AI] processMessageContent at qq=${qq} card=${card || '(空)'} nickname=${nickname || '(空)'} => @${namePart}`, 'XRK-AI');
            } catch (err) {
              namePart = String(qq);
              BotUtil.makeLog('debug', `[XRK-AI] processMessageContent at qq=${qq} getInfo异常 => @${namePart}`, 'XRK-AI');
            }
            content += `@${namePart} `;
          }
        } else if (seg.type === 'image') content += '[图片] ';
      }
      if (this.config.prefix) content = content.replace(new RegExp(`^${this.config.prefix}`), '');
      const text = content.trim();
      BotUtil.makeLog('debug', `[XRK-AI] processMessageContent 完成 segs=${message.length} textLen=${text.length}`, 'XRK-AI');
      return { content: text, text };
    } catch (err) {
      logger.error(`[XRK-AI] 处理消息内容失败: ${err.message}`);
      return { content: fallback, text: fallback };
    }
  }
}