import path from 'path';
import fs from 'fs';
import AIStream from '../../lib/aistream/base.js';

const _path = process.cwd();
const EMOTIONS_DIR = path.join(_path, 'plugins/XRK/config/ai-assistant');
const EMOTION_TYPES = ['开心', '惊讶', '伤心', '大笑', '害怕', '生气'];

// 表情回应映射
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

export default class ChatStream extends AIStream {
  constructor() {
    super({
      name: 'chat',
      description: '智能聊天工作流',
      version: '1.0.0',
      author: 'XRK',
      priority: 10,
      config: {
        enabled: true,
        temperature: 0.8,
        maxTokens: 6000,
        topP: 0.9,
        presencePenalty: 0.6,
        frequencyPenalty: 0.6
      }
    });

    this.emotionImages = {};
    this.scheduledTasks = new Map();
    
    this.init();
  }

  async init() {
    await this.loadEmotionImages();
    this.registerAllFunctions();
  }

  /** 加载表情包 */
  async loadEmotionImages() {
    for (const emotion of EMOTION_TYPES) {
      const emotionDir = path.join(EMOTIONS_DIR, emotion);
      try {
        if (!fs.existsSync(emotionDir)) {
          fs.mkdirSync(emotionDir, { recursive: true });
        }
        const files = await fs.promises.readdir(emotionDir);
        const imageFiles = files.filter(file => /\.(jpg|jpeg|png|gif)$/i.test(file));
        this.emotionImages[emotion] = imageFiles.map(file => path.join(emotionDir, file));
      } catch {
        this.emotionImages[emotion] = [];
      }
    }
  }

  /** 注册所有功能 */
  registerAllFunctions() {
    // 表情包
    this.registerFunction('emotion', {
      description: '发送表情包',
      prompt: `【表情包】在文字中插入标记：[开心] [惊讶] [伤心] [大笑] [害怕] [生气]（每次最多1个）`,
      parser: (text) => {
        const regex = /\[(开心|惊讶|伤心|大笑|害怕|生气)\]/g;
        const functions = [];
        const match = regex.exec(text);
        if (match) {
          functions.push({ type: 'emotion', params: { emotion: match[1] } });
        }
        return { 
          functions, 
          cleanText: text.replace(regex, '').trim() 
        };
      },
      handler: async (params, context) => {
        const image = this.getRandomEmotionImage(params.emotion);
        if (image && context.e) {
          await context.e.reply(segment.image(image));
        }
      }
    });

    // @功能
    this.registerFunction('at', {
      description: '@某人',
      prompt: `[CQ:at,qq=QQ号] - @某人（QQ号必须存在于群聊记录中）`,
      parser: (text) => ({ functions: [], cleanText: text })
    });

    // 戳一戳
    this.registerFunction('poke', {
      description: '戳一戳',
      prompt: `[CQ:poke,qq=QQ号] - 戳一戳某人`,
      parser: (text) => {
        const regex = /\[CQ:poke,qq=(\d+)\]/g;
        const functions = [];
        let match;
        while ((match = regex.exec(text))) {
          functions.push({ type: 'poke', params: { qq: match[1] } });
        }
        return { 
          functions, 
          cleanText: text.replace(regex, '').trim() 
        };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup) {
          try {
            await context.e.group.pokeMember(params.qq);
          } catch (err) {
            logger.debug(`[ChatStream] 戳一戳失败: ${err.message}`);
          }
        }
      }
    });

    // 回复
    this.registerFunction('reply', {
      description: '回复消息',
      prompt: `[CQ:reply,id=消息ID] - 回复某条消息`,
      parser: (text) => ({ functions: [], cleanText: text })
    });

    // 表情回应
    this.registerFunction('emojiReaction', {
      description: '表情回应',
      prompt: `[回应:消息ID:表情类型] - 表情回应（类型：开心/惊讶/伤心/大笑/害怕/喜欢/爱心/生气）`,
      parser: (text) => {
        const regex = /\[回应:([^:]+):([^\]]+)\]/g;
        const functions = [];
        let match;
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'emojiReaction', 
            params: { msgId: match[1], emojiType: match[2] } 
          });
        }
        return { 
          functions, 
          cleanText: text.replace(regex, '').trim() 
        };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup && EMOJI_REACTIONS[params.emojiType]) {
          const emojiIds = EMOJI_REACTIONS[params.emojiType];
          const emojiId = emojiIds[Math.floor(Math.random() * emojiIds.length)];
          try {
            await context.e.group.setEmojiLike(params.msgId, emojiId);
          } catch (err) {
            logger.debug(`[ChatStream] 表情回应失败: ${err.message}`);
          }
        }
      }
    });

    // 点赞
    this.registerFunction('thumbUp', {
      description: '点赞',
      prompt: `[点赞:QQ号:次数] - 点赞（1-50次）`,
      parser: (text) => {
        const regex = /\[点赞:(\d+):(\d+)\]/g;
        const functions = [];
        let match;
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'thumbUp', 
            params: { qq: match[1], count: parseInt(match[2]) } 
          });
        }
        return { 
          functions, 
          cleanText: text.replace(regex, '').trim() 
        };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup) {
          const count = Math.min(params.count || 1, 50);
          try {
            await context.e.group.pickMember(params.qq).thumbUp(count);
          } catch (err) {
            logger.debug(`[ChatStream] 点赞失败: ${err.message}`);
          }
        }
      }
    });

    // 签到
    this.registerFunction('sign', {
      description: '群签到',
      prompt: `[签到] - 执行群签到`,
      parser: (text) => {
        const functions = text.includes('[签到]') ? [{ type: 'sign', params: {} }] : [];
        return { 
          functions, 
          cleanText: text.replace(/\[签到\]/g, '').trim() 
        };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup) {
          try {
            await context.e.group.sign();
          } catch (err) {
            logger.debug(`[ChatStream] 签到失败: ${err.message}`);
          }
        }
      }
    });

    // 禁言
    this.registerFunction('mute', {
      description: '禁言成员',
      permission: 'admin',
      prompt: `[禁言:QQ号:秒数] - 禁言`,
      parser: (text) => {
        const regex = /\[禁言:(\d+):(\d+)\]/g;
        const functions = [];
        let match;
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'mute', 
            params: { qq: match[1], duration: parseInt(match[2]) } 
          });
        }
        return { 
          functions, 
          cleanText: text.replace(regex, '').trim() 
        };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup && await this.checkPermission(context.e, 'admin')) {
          try {
            await context.e.group.muteMember(params.qq, params.duration);
          } catch (err) {
            logger.debug(`[ChatStream] 禁言失败: ${err.message}`);
          }
        }
      }
    });

    // 解禁
    this.registerFunction('unmute', {
      description: '解除禁言',
      permission: 'admin',
      prompt: `[解禁:QQ号] - 解除禁言`,
      parser: (text) => {
        const regex = /\[解禁:(\d+)\]/g;
        const functions = [];
        let match;
        while ((match = regex.exec(text))) {
          functions.push({ type: 'unmute', params: { qq: match[1] } });
        }
        return { 
          functions, 
          cleanText: text.replace(regex, '').trim() 
        };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup && await this.checkPermission(context.e, 'admin')) {
          try {
            await context.e.group.muteMember(params.qq, 0);
          } catch (err) {
            logger.debug(`[ChatStream] 解禁失败: ${err.message}`);
          }
        }
      }
    });

    // 精华
    this.registerFunction('essence', {
      description: '设置精华',
      permission: 'admin',
      prompt: `[精华:消息ID] - 设置精华消息`,
      parser: (text) => {
        const regex = /\[精华:([^\]]+)\]/g;
        const functions = [];
        let match;
        while ((match = regex.exec(text))) {
          functions.push({ type: 'essence', params: { msgId: match[1] } });
        }
        return { 
          functions, 
          cleanText: text.replace(regex, '').trim() 
        };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup && await this.checkPermission(context.e, 'admin')) {
          try {
            await context.e.group.setEssence(params.msgId);
          } catch (err) {
            logger.debug(`[ChatStream] 设置精华失败: ${err.message}`);
          }
        }
      }
    });

    // 公告
    this.registerFunction('notice', {
      description: '发布公告',
      permission: 'admin',
      prompt: `[公告:内容] - 发布群公告`,
      parser: (text) => {
        const regex = /\[公告:([^\]]+)\]/g;
        const functions = [];
        let match;
        while ((match = regex.exec(text))) {
          functions.push({ type: 'notice', params: { content: match[1] } });
        }
        return { 
          functions, 
          cleanText: text.replace(regex, '').trim() 
        };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup && await this.checkPermission(context.e, 'admin')) {
          try {
            await context.e.group.sendNotice(params.content);
          } catch (err) {
            logger.debug(`[ChatStream] 发布公告失败: ${err.message}`);
          }
        }
      }
    });

    // 提醒
    this.registerFunction('reminder', {
      description: '定时提醒',
      prompt: `[提醒:年-月-日 时:分:内容] - 设置定时提醒`,
      parser: (text) => {
        const regex = /\[提醒:([^:]+):([^:]+):([^\]]+)\]/g;
        const functions = [];
        let match;
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'reminder', 
            params: { dateStr: match[1], timeStr: match[2], content: match[3] } 
          });
        }
        return { 
          functions, 
          cleanText: text.replace(regex, '').trim() 
        };
      },
      handler: async (params, context) => {
        await this.createReminder(params, context);
      }
    });
  }

  /** 构建系统提示 */
  buildSystemPrompt(context) {
    const { e, persona, dateStr, isGlobalTrigger, botRole } = context;
    
    let prompt = `【人设设定】
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
1. 你是真实QQ用户，不是AI助手
2. 说话自然、简洁、有个性
3. 最多使用一个竖线(|)分隔，即最多两条消息
4. 每条消息简短，像正常聊天
5. 适当使用表情包和互动功能`;

    prompt += this.buildFunctionsPrompt();

    prompt += `

【重要限制】
1. 每次回复最多1个表情包
2. 最多用1个竖线(|)分隔
3. @人前确认QQ号存在于群聊记录
4. 不重复使用相同功能

【注意事项】
${isGlobalTrigger ? 
  '1. 主动发言要有新意\n2. 可随机戳一戳活跃成员\n3. 语气自然' : 
  '1. 回复针对性强\n2. 被召唤时积极互动'}
3. @人只用群聊记录中的QQ号
4. 多用戳一戳和表情回应
${e.isMaster ? '5. 对主人友好尊重' : ''}`;

    return prompt;
  }

  /** 构建聊天上下文 */
  async buildChatContext(e, question) {
    const messages = [];
    const now = new Date();
    const dateStr = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 ${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
    
    const botRole = await this.getBotRole(e);
    const isGlobalTrigger = question.isGlobalTrigger || false;
    
    messages.push({
      role: 'system',
      content: this.buildSystemPrompt({
        e,
        persona: question.persona || '我是AI助手',
        dateStr,
        isGlobalTrigger,
        botRole
      })
    });
    
    if (question.history && question.history.length > 0) {
      const recentMessages = isGlobalTrigger ? 
        question.history.slice(-15) : 
        question.history.slice(-10);
      
      messages.push({
        role: 'user',
        content: `[群聊记录]\n${recentMessages.map(msg => 
          `${msg.nickname}(${msg.user_id})[${msg.message_id}]: ${msg.message}`
        ).join('\n')}`
      });
    }
    
    if (!isGlobalTrigger && question.text) {
      const userInfo = e.sender?.card || e.sender?.nickname || '未知';
      messages.push({
        role: 'user',
        content: `[当前消息]\n${userInfo}(${e.user_id})[${e.message_id}]: ${question.text}`
      });
    } else if (isGlobalTrigger) {
      messages.push({
        role: 'user',
        content: '请对当前话题发表看法，要自然且有自己的观点。'
      });
    }
    
    return messages;
  }

  /** 解析CQ码 */
  async parseCQCodes(text, e, validQQs = []) {
    const segments = [];
    const parts = text.split(/(\[CQ:[^\]]+\])/);
    
    for (const part of parts) {
      if (part.startsWith('[CQ:')) {
        const match = part.match(/\[CQ:(\w+)(?:,([^\]]+))?\]/);
        if (match) {
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
              if (e.isGroup && paramObj.qq && validQQs.includes(paramObj.qq)) {
                segments.push(segment.at(paramObj.qq));
              }
              break;
            case 'reply':
              segments.push(segment.reply(paramObj.id));
              break;
            case 'image':
              segments.push(segment.image(paramObj.file));
              break;
          }
        }
      } else if (part) {
        segments.push(part);
      }
    }
    
    return segments;
  }

  /** 工具方法 */
  getRandomEmotionImage(emotion) {
    const images = this.emotionImages[emotion];
    if (!images || images.length === 0) return null;
    return images[Math.floor(Math.random() * images.length)];
  }

  async getBotRole(e) {
    if (!e.isGroup) return '';
    try {
      const member = e.group.pickMember(e.self_id);
      const info = await member.getInfo();
      return info.role === 'owner' ? '群主' : 
             info.role === 'admin' ? '管理员' : '成员';
    } catch {
      return '成员';
    }
  }

  async checkPermission(e, permission) {
    if (!e.isGroup) return false;
    if (e.isMaster) return true;
    
    const role = await this.getBotRole(e);
    
    switch (permission) {
      case 'admin':
        return role === '群主' || role === '管理员';
      case 'owner':
        return role === '群主';
      default:
        return false;
    }
  }

  async createReminder(params, context) {
    const { e, reminderCallback } = context;
    const { dateStr, timeStr, content } = params;
    
    try {
      const [year, month, day] = dateStr.split('-').map(Number);
      const [hour, minute] = timeStr.split(':').map(Number);
      const reminderTime = new Date(year, month - 1, day, hour, minute, 0);
      
      if (reminderTime <= new Date()) {
        await e.reply('提醒时间必须在未来');
        return;
      }
      
      const task = {
        id: `reminder_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        time: reminderTime.toISOString(),
        content,
        group: e.group_id,
        private: !e.isGroup ? e.user_id : null
      };
      
      if (reminderCallback) {
        await reminderCallback(task);
      }
      
      await e.reply(`已设置提醒：${dateStr} ${timeStr} "${content}"`);
    } catch (err) {
      logger.error(`[ChatStream] 创建提醒失败: ${err.message}`);
      await e.reply('设置提醒失败，请检查格式');
    }
  }
}