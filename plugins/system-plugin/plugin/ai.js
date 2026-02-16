// XRK AI助手插件 - 调用 chat 工作流；需合并时在配置里写 mergeStreams，写哪个合并哪个

import path from 'path';
import fs from 'fs';
import BotUtil from '../../../lib/util.js';

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
    if (Array.isArray(secondaries) && secondaries.length > 0 && Bot.StreamLoader) {
      Bot.StreamLoader.mergeStreams({
        name: CHAT_MERGED_NAME,
        main: 'chat',
        secondary: secondaries,
        prefixSecondary: true
      });
      logger.info(`├─ 🔀 合并工作流: chat + [${secondaries.join(', ')}]`);
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
      if (!fs.existsSync(CONFIG_PATH)) {
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
        await fs.promises.writeFile(CONFIG_PATH, content, 'utf8');
        logger.info(`├─ 📄 配置文件已生成: ${CONFIG_PATH}`);
      }
    } catch (error) {
      logger.error(`初始化配置文件失败: ${error.message}`);
    }
  }

  async loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const yaml = (await import('yaml')).default;
        const content = await fs.promises.readFile(CONFIG_PATH, 'utf8');
        return yaml.parse(content) || {};
      }
    } catch (error) {
      logger.error(`加载配置文件失败: ${error.message}`);
    }
    return {};
  }

  async handleMessage(e) {
    try {
      if (!(await this.shouldTriggerAI(e))) return false;

      if (!this.config) this.config = await this.loadConfig();
      const stream = this.getStream(this.config.mergeStreams?.length ? CHAT_MERGED_NAME : 'chat')
        ?? this.getStream('chat');
      if (!stream) {
        logger.error('chat 工作流未加载');
        return false;
      }

      const isRandom = !e.atBot && !(this.config.prefix && e.msg?.startsWith(this.config.prefix));
      const { content } = await this.processMessageContent(e);

      if (!isRandom && !content) {
        const img = stream.getRandomEmotionImage?.('惊讶');
        if (img) await e.reply(segment.image(img));
        await BotUtil.sleep(300);
        await e.reply('有什么需要帮助的吗？');
        return true;
      }

      const result = await stream.process(e, {
        content: content ?? '',
        text: content ?? '',
        persona: this.config.persona ?? '',
        isGlobalTrigger: isRandom
      }, {});

      if (!result) return isRandom ? false : true;
      return true;
    } catch (err) {
      logger.error(`消息处理错误: ${err.message}`);
      return false;
    }
  }

  async shouldTriggerAI(e) {
    if (!this.config) this.config = await this.loadConfig();

    const isInWhitelist = () => {
      if (e.isGroup) {
        const groupId = String(e.group_id);
        return this.config.groups?.some(g => String(g) === groupId) || false;
      } else {
        const userId = String(e.user_id);
        return this.config.users?.some(u => String(u) === userId) || false;
      }
    };

    if (e.atBot) return isInWhitelist();
    if (this.config.prefix && e.msg?.startsWith(this.config.prefix)) return isInWhitelist();

    if (!e.isGroup) return false;
    if (!isInWhitelist()) return false;

    const groupId = String(e.group_id);
    const now = Date.now();
    const cooldown = (this.config.cooldown || 300) * 1000;
    const chance = this.config.chance || 0.1;

    const lastTrigger = cooldownState.get(groupId) || 0;
    if (now - lastTrigger < cooldown) return false;
    if (Math.random() < chance) {
      cooldownState.set(groupId, now);
      return true;
    }

    return false;
  }

  async processMessageContent(e) {
    const fallback = e.msg || '';
    const message = e.message;
    if (!Array.isArray(message)) return { content: fallback, text: fallback };

    try {
      let content = '';
      if (e.source && typeof e.getReply === 'function') {
        try {
          const reply = await e.getReply();
          if (reply) {
            const name = reply.sender?.card || reply.sender?.nickname || '未知';
            const raw = reply.raw_message?.substring(0, 30) || '';
            content += `[回复${name}的"${raw}..."] `;
          }
        } catch (err) {
          logger.error(`处理回复消息失败: ${err.message}`);
        }
      }
      for (const seg of message) {
        if (seg.type === 'text') content += seg.text || '';
        else if (seg.type === 'at' && seg.qq != e.self_id) {
          try {
            const info = await e.group?.pickMember(seg.qq)?.getInfo();
            content += `@${info?.card || info?.nickname || seg.qq} `;
          } catch {
            content += `@${seg.qq} `;
          }
        } else if (seg.type === 'image') content += '[图片] ';
      }
      if (this.config.prefix) content = content.replace(new RegExp(`^${this.config.prefix}`), '');
      const text = content.trim();
      return { content: text, text };
    } catch (err) {
      logger.error(`处理消息内容失败: ${err.message}`);
      return { content: fallback, text: fallback };
    }
  }
}