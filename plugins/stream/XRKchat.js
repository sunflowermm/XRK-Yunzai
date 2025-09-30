import path from 'path';
import fs from 'fs';

const _path = process.cwd();
const TEMP_IMAGE_DIR = path.join(_path, 'data/temp/ai_images');

// 表情包映射
const EMOJI_REACTIONS = {
  '开心': ['4', '14', '21', '28', '76', '79', '99', '182', '201', '290'],
  '惊讶': ['26', '32', '97', '180', '268', '289'],
  '伤心': ['5', '9', '106', '111', '173', '174'],
  '大笑': ['4', '12', '28', '101', '182', '281'],
  '害怕': ['26', '27', '41', '96'],
  '喜欢': ['42', '63', '85', '116', '122', '319'],
  '爱心': ['66', '122', '319'],
  '生气': ['8', '23', '39', '86', '179', '265']
};

// 全局存储
const messageHistory = new Map();
const globalAIState = new Map();
let emotionImages = {};

export default class XRKChatStream extends StreamBase {
  constructor() {
    super({
      name: 'XRKChat',
      description: '向日葵AI聊天工作流',
      version: '2.0.0',
      author: 'XRK',
      enabled: true,
      config: {
        maxRetries: 2,
        retryDelay: 500,
        timeout: 5000
      }
    });
    
    this.initRules();
    this.loadEmotionImages();
  }

  /** 加载表情包图片 */
  async loadEmotionImages() {
    const EMOTIONS_DIR = path.join(_path, 'plugins/XRK/config/ai-assistant');
    const EMOTION_TYPES = ['开心', '惊讶', '伤心', '大笑', '害怕', '生气'];
    
    for (const emotion of EMOTION_TYPES) {
      const emotionDir = path.join(EMOTIONS_DIR, emotion);
      try {
        const files = await fs.promises.readdir(emotionDir);
        const imageFiles = files.filter(file => 
          /\.(jpg|jpeg|png|gif)$/i.test(file)
        );
        emotionImages[emotion] = imageFiles.map(file => 
          path.join(emotionDir, file)
        );
      } catch (err) {
        emotionImages[emotion] = [];
      }
    }
  }

  /** 获取随机表情图片 */
  getRandomEmotionImage(emotion) {
    const images = emotionImages[emotion];
    if (!images || images.length === 0) return null;
    return images[Math.floor(Math.random() * images.length)];
  }

  /** 判断是否触发AI */
  async shouldTriggerAI(e, config) {
    // 记录消息历史
    this.recordMessageHistory(e);
    
    // 检查是否在白名单中
    const isInWhitelist = () => {
      if (e.isGroup) {
        const groupWhitelist = (config.ai?.whitelist?.groups || []).map(id => Number(id));
        return groupWhitelist.includes(Number(e.group_id));
      } else {
        const userWhitelist = (config.ai?.whitelist?.users || []).map(id => Number(id));
        return userWhitelist.includes(Number(e.user_id));
      }
    };
    
    // 1. 被@时触发
    if (e.atBot) {
      return isInWhitelist();
    }
    
    // 2. 前缀触发
    const triggerPrefix = config.ai?.triggerPrefix;
    if (triggerPrefix !== undefined && triggerPrefix !== null && triggerPrefix !== '') {
      if (e.msg?.startsWith(triggerPrefix)) {
        return isInWhitelist();
      }
    }
    
    // 3. 全局AI触发
    if (!e.isGroup) return false;
    
    const globalWhitelist = (config.ai?.globalWhitelist || []).map(id => Number(id));
    const groupIdNum = Number(e.group_id);
    
    if (!globalWhitelist.includes(groupIdNum)) {
      return false;
    }
    
    // 全局AI状态管理
    const groupId = e.group_id;
    const state = globalAIState.get(groupId) || { 
      lastTrigger: 0, 
      messageCount: 0,
      lastMessageTime: 0,
      activeUsers: new Set()
    };
    
    const now = Date.now();
    
    // 重置计数
    if (now - state.lastMessageTime > 60000) {
      state.messageCount = 1;
      state.activeUsers.clear();
      state.activeUsers.add(e.user_id);
    } else {
      state.messageCount++;
      state.activeUsers.add(e.user_id);
    }
    state.lastMessageTime = now;
    
    // 触发条件
    const cooldown = (config.ai?.globalAICooldown || 300) * 1000;
    const chance = config.ai?.globalAIChance || 0.05;
    
    const canTrigger = now - state.lastTrigger > cooldown && 
                       (state.messageCount >= 3 && state.activeUsers.size >= 2 || state.messageCount >= 8);
    
    if (canTrigger && Math.random() < chance) {
      state.lastTrigger = now;
      state.messageCount = 0;
      state.activeUsers.clear();
      globalAIState.set(groupId, state);
      logger.info(`[XRK-AI] 全局AI触发 - 群:${groupId}`);
      return true;
    }
    
    globalAIState.set(groupId, state);
    return false;
  }

  /** 记录消息历史 */
  recordMessageHistory(e) {
    if (!e.isGroup) return;
    
    try {
      const groupId = e.group_id;
      if (!messageHistory.has(groupId)) {
        messageHistory.set(groupId, []);
      }
      
      const history = messageHistory.get(groupId);
      let cqMessage = e.raw_message || '';
      
      if (e.message && Array.isArray(e.message)) {
        cqMessage = e.message.map(seg => {
          switch (seg.type) {
            case 'text':
              return seg.text;
            case 'image':
              return `[图片]`;
            case 'at':
              return `[CQ:at,qq=${seg.qq}]`;
            case 'reply':
              return `[CQ:reply,id=${seg.id}]`;
            default:
              return '';
          }
        }).join('');
      }
      
      history.push({
        user_id: e.user_id,
        nickname: e.sender?.card || e.sender?.nickname || '未知',
        role: e.sender?.role || 'member',
        message: cqMessage,
        message_id: e.message_id,
        time: Date.now(),
        hasImage: e.img?.length > 0
      });
      
      if (history.length > 30) {
        history.shift();
      }
    } catch (error) {
      logger.error(`[XRK-AI] 记录消息历史失败: ${error.message}`);
    }
  }

  /** 构建AI上下文 */
  async buildAIContext(e, context) {
    const groupId = e.group_id || `private_${e.user_id}`;
    const isGlobalTrigger = !e.atBot && 
      (context.config.ai?.triggerPrefix === undefined || 
       context.config.ai?.triggerPrefix === null || 
       context.config.ai?.triggerPrefix === '' || 
       !e.msg?.startsWith(context.config.ai.triggerPrefix));
    
    // 处理消息内容
    let question = await this.processMessageContent(e, context);
    
    // 构建系统提示
    const botRole = await context.getBotRole();
    const now = new Date();
    const dateStr = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 ${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
    
    const systemPrompt = this.buildChatSystemPrompt(context.persona, {
      e,
      dateStr,
      isGlobalTrigger,
      botRole
    });
    
    // 构建历史消息
    const history = [];
    if (e.isGroup) {
      const historyData = messageHistory.get(e.group_id) || [];
      
      if (isGlobalTrigger) {
        const recentMessages = historyData.slice(-15);
        if (recentMessages.length > 0) {
          history.push({
            role: 'user',
            content: `[群聊记录]\n${recentMessages.map(msg => 
              `${msg.nickname}(${msg.user_id})[${msg.message_id}]: ${msg.message}`
            ).join('\n')}\n\n请对当前话题发表你的看法，要自然且有自己的观点。`
          });
        }
      } else {
        const relevantHistory = historyData.slice(-(context.config.ai?.historyLimit || 10));
        if (relevantHistory.length > 0) {
          history.push({
            role: 'user',
            content: `[群聊记录]\n${relevantHistory.map(msg => 
              `${msg.nickname}(${msg.user_id})[${msg.message_id}]: ${msg.message}`
            ).join('\n')}`
          });
        }
      }
    }
    
    return {
      systemPrompt,
      question,
      history,
      isGlobalTrigger
    };
  }

  /** 处理消息内容 */
  async processMessageContent(e, context) {
    let content = '';
    const message = e.message;
    
    if (!Array.isArray(message)) {
      return e.msg || '';
    }
    
    try {
      // 处理回复
      if (e.source && e.getReply) {
        try {
          const reply = await e.getReply();
          if (reply) {
            const nickname = reply.sender?.card || reply.sender?.nickname || '未知';
            content += `[回复${nickname}的"${reply.raw_message.substring(0, 30)}..."] `;
          }
        } catch {}
      }
      
      // 处理消息段
      for (const seg of message) {
        switch (seg.type) {
          case 'text':
            content += seg.text;
            break;
          case 'at':
            if (seg.qq != e.self_id) {
              try {
                const member = e.group?.pickMember(seg.qq);
                const info = await member?.getInfo();
                const nickname = info?.card || info?.nickname || seg.qq;
                content += `@${nickname} `;
              } catch {
                content += `@${seg.qq} `;
              }
            }
            break;
          case 'image':
            const desc = await this.processImage(seg.url || seg.file, context);
            content += `[图片:${desc}] `;
            break;
        }
      }
      
      // 清理触发前缀
      if (context.config.ai?.triggerPrefix && context.config.ai.triggerPrefix !== '') {
        content = content.replace(new RegExp(`^${context.config.ai.triggerPrefix}`), '');
      }
      
      return content.trim();
    } catch (error) {
      logger.error(`[XRK-AI] 处理消息内容失败: ${error.message}`);
      return e.msg || '';
    }
  }

  /** 处理图片 */
  async processImage(imageUrl, context) {
    if (!imageUrl || !context.config.ai?.visionModel) {
      return '无法识别';
    }
    
    // 简化的图片识别逻辑
    return '图片内容';
  }

  /** 处理AI响应 */
  async processResponse(e, response, context) {
    try {
      // 使用竖线分割响应
      const segments = response.split('|').map(s => s.trim()).filter(s => s).slice(0, 2);
      
      // 统计表情包数量
      let emotionSent = false;
      
      for (let i = 0; i < segments.length; i++) {
        const responseSegment = segments[i];
        
        // 解析响应
        const result = await this.process(responseSegment, { 
          e, 
          ...context,
          getEmotionImage: (emotion) => this.getRandomEmotionImage(emotion)
        });
        
        // 发送表情包
        if (!emotionSent && result.executed) {
          const emotionResult = result.executed.find(r => r.result?.action === 'emotion');
          if (emotionResult && emotionResult.result.image) {
            await e.reply(segment.image(emotionResult.result.image));
            emotionSent = true;
            await Bot.sleep(300);
          }
        }
        
        // 构建消息段
        const msgSegments = [];
        
        // 处理文本和CQ码
        if (result.processedResponse) {
          const parts = result.processedResponse.split(/(\[CQ:[^\]]+\])/);
          for (const part of parts) {
            if (part.startsWith('[CQ:')) {
              const cqSegment = await this.parseCQCode(part, e, context);
              if (cqSegment) {
                msgSegments.push(cqSegment);
              }
            } else if (part) {
              msgSegments.push(part);
            }
          }
        }
        
        // 发送消息
        if (msgSegments.length > 0) {
          await e.reply(msgSegments, Math.random() > 0.5);
        }
        
        // 执行其他功能
        for (const exec of result.executed || []) {
          if (exec.result?.action && exec.result.action !== 'emotion') {
            // 已在handler中执行
          }
        }
        
        // 延迟到下一个segment
        if (i < segments.length - 1) {
          await Bot.sleep(this.randomRange(800, 1500));
        }
      }
    } catch (error) {
      logger.error(`[XRK-AI] 处理AI响应失败: ${error.message}`);
    }
  }

  /** 解析CQ码 */
  async parseCQCode(cqCode, e, context) {
    const match = cqCode.match(/\[CQ:(\w+)(?:,([^\]]+))?\]/);
    if (!match) return null;
    
    const [, type, params] = match;
    const paramObj = {};
    
    if (params) {
      params.split(',').forEach(p => {
        const [key, value] = p.split('=');
        paramObj[key] = value;
      });
    }
    
    switch (type) {
      case 'at':
        return segment.at(paramObj.qq);
      case 'reply':
        return segment.reply(paramObj.id);
      case 'image':
        return segment.image(paramObj.file);
      default:
        return null;
    }
  }

  /** 随机数生成 */
  randomRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /** 初始化规则 */
  initRules() {
    // 继续使用之前定义的所有规则
    this.addRule({
      name: 'at',
      group: 'interaction',
      enabled: true,
      reg: /\[CQ:at,qq=(\d+)\]/gi,
      regPrompt: '[CQ:at,qq=QQ号] - @某人',
      priority: 100,
      handler: async (result, context) => {
        const { e } = context;
        if (!e.isGroup) return null;
        
        const qq = result.params[0];
        try {
          const member = e.group.pickMember(qq);
          await member.getInfo();
          return { type: 'at', qq };
        } catch {
          return null;
        }
      }
    });

    this.addRule({
      name: 'poke',
      group: 'interaction',
      enabled: true,
      reg: /\[CQ:poke,qq=(\d+)\]/gi,
      regPrompt: '[CQ:poke,qq=QQ号] - 戳一戳某人',
      priority: 90,
      handler: async (result, context) => {
        const { e } = context;
        if (!e.isGroup) return null;
        
        const qq = result.params[0];
        try {
          await e.group.pokeMember(qq);
          return { action: 'poke', target: qq };
        } catch {
          return null;
        }
      }
    });

    this.addRule({
      name: 'reply',
      group: 'interaction',
      enabled: true,
      reg: /\[CQ:reply,id=([^\]]+)\]/gi,
      regPrompt: '[CQ:reply,id=消息ID] - 回复消息',
      priority: 95,
      handler: async (result, context) => {
        const msgId = result.params[0];
        return { type: 'reply', id: msgId };
      }
    });

    this.addRule({
      name: 'emojiReaction',
      group: 'emotion',
      enabled: true,
      reg: /\[回应:([^:]+):([^\]]+)\]/gi,
      regPrompt: '[回应:消息ID:表情类型] - 表情回应',
      priority: 80,
      handler: async (result, context) => {
        const { e } = context;
        if (!e.isGroup) return null;
        
        const [msgId, emojiType] = result.params;
        const emojiIds = EMOJI_REACTIONS[emojiType];
        if (emojiIds) {
          const emojiId = emojiIds[Math.floor(Math.random() * emojiIds.length)];
          await e.group.setEmojiLike(msgId, emojiId);
          return { action: 'emoji', msgId, emoji: emojiId };
        }
        return null;
      }
    });

    this.addRule({
      name: 'emotion',
      group: 'emotion',
      enabled: true,
      reg: /\[(开心|惊讶|伤心|大笑|害怕|生气)\]/gi,
      regPrompt: '表情包标记',
      priority: 20,
      handler: async (result, context) => {
        const emotion = result.params[0];
        
        if (context.getEmotionImage) {
          const imagePath = context.getEmotionImage(emotion);
          if (imagePath) {
            return { action: 'emotion', type: emotion, image: imagePath };
          }
        }
        return null;
      }
    });

    this.addRule({
      name: 'sign',
      group: 'action',
      enabled: true,
      reg: /\[签到\]/gi,
      regPrompt: '[签到] - 群签到',
      priority: 60,
      handler: async (result, context) => {
        const { e } = context;
        if (!e.isGroup) return null;
        
        await e.group.sign();
        return { action: 'sign' };
      }
    });
  }

  /** 构建聊天系统提示词 */
  buildChatSystemPrompt(persona, context = {}) {
    const { e, dateStr, isGlobalTrigger } = context;
    const botRole = context.botRole || '成员';
    
    let basePrompt = `【人设设定】
${persona}

【身份信息】
名字：${Bot.nickname}
QQ号：${e.self_id}
${e.isGroup ? `群名：${e.group?.group_name || '未知'}
群号：${e.group_id}
身份：${botRole}` : ''}

【时间信息】
当前时间：${dateStr}

【触发方式】
${isGlobalTrigger ? '观察群聊后主动发言' : '被召唤回复'}

【基础规则】
1. 你是一个真实的QQ用户，不是AI助手
2. 说话要自然、简洁、有个性
3. 最多使用一个竖线分隔符(|)，也就是最多发送两条消息
4. 每条消息不要太长，像正常聊天一样
5. 适当使用表情包和互动功能

【表情包系统】
在文字中插入以下标记来发送表情包（一次对话只能使用一个表情包）：
[开心] [惊讶] [伤心] [大笑] [害怕] [生气]

【重要限制】
1. 每次回复最多只能发一个表情包
2. 最多使用一个竖线(|)分隔
3. @人之前要确认QQ号是否在群聊记录中出现过
4. 不要重复使用相同的功能`;

    return this.buildSystemPrompt(basePrompt, context);
  }
}