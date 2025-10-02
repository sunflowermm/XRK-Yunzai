import path from 'path';
import fs from 'fs';
import AIStream from '../../lib/aistream/base.js';
import BotUtil from '../../lib/common/util.js';

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

/**
 * 聊天工作流 - 提供群聊互动、表情包、各种群功能
 */
export default class ChatStream extends AIStream {
  constructor() {
    super({
      name: 'chat',
      description: '群聊互动工作流',
      version: '1.1.0',
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
    this.messageHistory = new Map();
    this.userCache = new Map();
    
    this.init();
  }

  async init() {
    await this.loadEmotionImages();
    this.registerAllFunctions();
    
    // 定期清理缓存
    setInterval(() => this.cleanupCache(), 300000); // 5分钟
  }

  /**
   * 加载表情包
   */
  async loadEmotionImages() {
    for (const emotion of EMOTION_TYPES) {
      const emotionDir = path.join(EMOTIONS_DIR, emotion);
      try {
        await BotUtil.mkdir(emotionDir);
        const files = await fs.promises.readdir(emotionDir);
        const imageFiles = files.filter(file => 
          /\.(jpg|jpeg|png|gif)$/i.test(file)
        );
        this.emotionImages[emotion] = imageFiles.map(file => 
          path.join(emotionDir, file)
        );
      } catch {
        this.emotionImages[emotion] = [];
      }
    }
    BotUtil.makeLog('info', `表情包加载完成: ${Object.values(this.emotionImages).flat().length}张`, 'ChatStream');
  }

  /**
   * 注册所有功能
   */
  registerAllFunctions() {
    // 1. 表情包功能
    this.registerFunction('emotion', {
      description: '发送表情包',
      prompt: `【表情包】在文字中插入标记来发送表情包（每次最多一个）：
[开心] [惊讶] [伤心] [大笑] [害怕] [生气]`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        
        const emotionRegex = /\[(开心|惊讶|伤心|大笑|害怕|生气)\]/;
        const match = emotionRegex.exec(text);
        if (match) {
          functions.push({ 
            type: 'emotion', 
            params: { emotion: match[1] } 
          });
          cleanText = text.replace(emotionRegex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        const { emotion } = params;
        const image = this.getRandomEmotionImage(emotion);
        if (image && context.e) {
          await context.e.reply(segment.image(image));
          await BotUtil.sleep(300);
        }
      },
      enabled: true
    });

    // 2. @功能
    this.registerFunction('at', {
      description: '@某人',
      prompt: `【@功能】[CQ:at,qq=QQ号] - @某人（确保QQ号在群聊记录中）`,
      parser: (text, context) => {
        // @功能在文本中直接保留CQ码，不单独提取
        return { functions: [], cleanText: text };
      },
      handler: async (params, context) => {},
      enabled: true
    });

    // 3. 戳一戳功能
    this.registerFunction('poke', {
      description: '戳一戳某人',
      prompt: `【戳一戳】[CQ:poke,qq=QQ号] - 戳一戳某人`,
      parser: (text, context) => {
        const functions = [];
        const pokeRegex = /\[CQ:poke,qq=(\d+)\]/g;
        let match;
        let cleanText = text;
        
        while ((match = pokeRegex.exec(text))) {
          functions.push({ 
            type: 'poke', 
            params: { qq: match[1] } 
          });
        }
        
        cleanText = cleanText.replace(pokeRegex, '').trim();
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        const { qq } = params;
        if (context.e?.isGroup) {
          try {
            await context.e.group.pokeMember(qq);
            BotUtil.makeLog('debug', `戳了 ${qq}`, 'ChatStream');
          } catch (error) {
            BotUtil.makeLog('debug', `戳一戳失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true
    });

    // 4. 回复功能
    this.registerFunction('reply', {
      description: '回复某条消息',
      prompt: `【回复】[CQ:reply,id=消息ID] - 回复某条消息`,
      parser: (text, context) => {
        return { functions: [], cleanText: text };
      },
      handler: async (params, context) => {},
      enabled: true
    });

    // 5. 表情回应功能
    this.registerFunction('emojiReaction', {
      description: '给消息添加表情回应',
      prompt: `【表情回应】[回应:消息ID:表情类型] - 给消息添加QQ表情回应
可用表情: 开心/惊讶/伤心/大笑/害怕/喜欢/爱心/生气`,
      parser: (text, context) => {
        const functions = [];
        const regex = /\[回应:([^:]+):([^\]]+)\]/g;
        let match;
        let cleanText = text;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'emojiReaction', 
            params: { msgId: match[1], emojiType: match[2] } 
          });
        }
        
        cleanText = cleanText.replace(regex, '').trim();
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        const { msgId, emojiType } = params;
        if (context.e?.isGroup && EMOJI_REACTIONS[emojiType]) {
          const emojiIds = EMOJI_REACTIONS[emojiType];
          const emojiId = emojiIds[Math.floor(Math.random() * emojiIds.length)];
          try {
            await context.e.group.setEmojiLike(msgId, emojiId);
            BotUtil.makeLog('debug', `表情回应 ${emojiType} -> ${msgId}`, 'ChatStream');
          } catch (error) {
            BotUtil.makeLog('debug', `表情回应失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true
    });

    // 6. 点赞功能
    this.registerFunction('thumbUp', {
      description: '给某人点赞',
      prompt: `【点赞】[点赞:QQ号:次数] - 给某人点赞（1-50次）`,
      parser: (text, context) => {
        const functions = [];
        const regex = /\[点赞:(\d+):(\d+)\]/g;
        let match;
        let cleanText = text;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'thumbUp', 
            params: { qq: match[1], count: parseInt(match[2]) } 
          });
        }
        
        cleanText = cleanText.replace(regex, '').trim();
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        const { qq, count } = params;
        if (context.e?.isGroup) {
          const thumbCount = Math.min(count || 1, 50);
          try {
            await context.e.group.pickMember(qq).thumbUp(thumbCount);
            BotUtil.makeLog('debug', `给 ${qq} 点赞 ${thumbCount}次`, 'ChatStream');
          } catch (error) {
            BotUtil.makeLog('debug', `点赞失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true
    });

    // 7. 签到功能
    this.registerFunction('sign', {
      description: '执行群签到',
      prompt: `【签到】[签到] - 执行群签到`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        
        if (text.includes('[签到]')) {
          functions.push({ type: 'sign', params: {} });
          cleanText = text.replace(/\[签到\]/g, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup) {
          try {
            await context.e.group.sign();
            BotUtil.makeLog('debug', `群签到成功`, 'ChatStream');
          } catch (error) {
            BotUtil.makeLog('debug', `签到失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true
    });

    // 8. 禁言功能
    this.registerFunction('mute', {
      description: '禁言群成员',
      permission: 'admin',
      prompt: `【禁言】[禁言:QQ号:秒数] - 禁言群成员（需要管理员权限）`,
      parser: (text, context) => {
        const functions = [];
        const regex = /\[禁言:(\d+):(\d+)\]/g;
        let match;
        let cleanText = text;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'mute', 
            params: { qq: match[1], duration: parseInt(match[2]) } 
          });
        }
        
        cleanText = cleanText.replace(regex, '').trim();
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        const { qq, duration } = params;
        if (context.e?.isGroup && await this.checkPermission(context.e, 'admin')) {
          try {
            await context.e.group.muteMember(qq, duration);
            BotUtil.makeLog('info', `禁言 ${qq} ${duration}秒`, 'ChatStream');
          } catch (error) {
            BotUtil.makeLog('debug', `禁言失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true
    });

    // 9. 解禁功能
    this.registerFunction('unmute', {
      description: '解除禁言',
      permission: 'admin',
      prompt: `【解禁】[解禁:QQ号] - 解除禁言（需要管理员权限）`,
      parser: (text, context) => {
        const functions = [];
        const regex = /\[解禁:(\d+)\]/g;
        let match;
        let cleanText = text;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'unmute', 
            params: { qq: match[1] } 
          });
        }
        
        cleanText = cleanText.replace(regex, '').trim();
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        const { qq } = params;
        if (context.e?.isGroup && await this.checkPermission(context.e, 'admin')) {
          try {
            await context.e.group.muteMember(qq, 0);
            BotUtil.makeLog('info', `解禁 ${qq}`, 'ChatStream');
          } catch (error) {
            BotUtil.makeLog('debug', `解禁失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true
    });

    // 10. 精华功能
    this.registerFunction('essence', {
      description: '设置精华消息',
      permission: 'admin',
      prompt: `【精华】[精华:消息ID] - 设置精华消息（需要管理员权限）`,
      parser: (text, context) => {
        const functions = [];
        const regex = /\[精华:([^\]]+)\]/g;
        let match;
        let cleanText = text;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'essence', 
            params: { msgId: match[1] } 
          });
        }
        
        cleanText = cleanText.replace(regex, '').trim();
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        const { msgId } = params;
        if (context.e?.isGroup && await this.checkPermission(context.e, 'admin')) {
          try {
            await context.e.group.setEssence(msgId);
            BotUtil.makeLog('info', `设置精华 ${msgId}`, 'ChatStream');
          } catch (error) {
            BotUtil.makeLog('debug', `设置精华失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true
    });

    // 11. 公告功能
    this.registerFunction('notice', {
      description: '发布群公告',
      permission: 'admin',
      prompt: `【公告】[公告:内容] - 发布群公告（需要管理员权限）`,
      parser: (text, context) => {
        const functions = [];
        const regex = /\[公告:([^\]]+)\]/g;
        let match;
        let cleanText = text;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'notice', 
            params: { content: match[1] } 
          });
        }
        
        cleanText = cleanText.replace(regex, '').trim();
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        const { content } = params;
        if (context.e?.isGroup && await this.checkPermission(context.e, 'admin')) {
          try {
            await context.e.group.sendNotice(content);
            BotUtil.makeLog('info', `发布公告: ${content}`, 'ChatStream');
          } catch (error) {
            BotUtil.makeLog('debug', `发布公告失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true
    });
  }

  /**
   * 获取随机表情图片
   */
  getRandomEmotionImage(emotion) {
    const images = this.emotionImages[emotion];
    if (!images || images.length === 0) return null;
    return images[Math.floor(Math.random() * images.length)];
  }

  /**
   * 记录消息历史
   */
  recordMessage(e) {
    if (!e.isGroup) return;
    
    try {
      const groupId = e.group_id;
      if (!this.messageHistory.has(groupId)) {
        this.messageHistory.set(groupId, []);
      }
      
      const history = this.messageHistory.get(groupId);
      let cqMessage = e.raw_message || e.msg || '';
      
      // 处理消息段
      if (e.message && Array.isArray(e.message)) {
        cqMessage = e.message.map(seg => {
          switch (seg.type) {
            case 'text':
              return seg.text;
            case 'image':
              return '[图片]';
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
      
      // 只保留最近30条
      if (history.length > 30) {
        history.shift();
      }
    } catch (error) {
      BotUtil.makeLog('error', `记录消息失败: ${error.message}`, 'ChatStream');
    }
  }

  /**
   * 检查权限
   */
  async checkPermission(e, permission) {
    if (!e.isGroup) return false;
    if (e.isMaster) return true;
    
    const cacheKey = `bot_role_${e.group_id}`;
    let role = this.userCache.get(cacheKey);
    
    if (!role || Date.now() - role.time > 300000) {
      try {
        const member = e.group.pickMember(e.self_id);
        const info = await member.getInfo();
        role = {
          value: info.role === 'owner' ? '群主' : 
                 info.role === 'admin' ? '管理员' : '成员',
          time: Date.now()
        };
        this.userCache.set(cacheKey, role);
      } catch {
        return false;
      }
    }
    
    switch (permission) {
      case 'admin':
        return role.value === '群主' || role.value === '管理员';
      case 'owner':
        return role.value === '群主';
      default:
        return false;
    }
  }

  /**
   * 构建系统提示
   */
  buildSystemPrompt(context) {
    const { e, persona, dateStr, isGlobalTrigger, botRole } = context;
    
    const functionsPrompt = this.buildFunctionsPrompt();
    
    return `【人设设定】
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
${functionsPrompt}

【重要限制】
1. 每次回复最多只能发一个表情包
2. 最多使用一个竖线(|)分隔，也就是最多两条消息
3. @人之前要确认QQ号是否在群聊记录中出现过
4. 不要重复使用相同的功能
5. 管理功能（禁言/解禁/精华/公告）只在你是${botRole}时可用

【注意事项】
${isGlobalTrigger ? '1. 主动发言要有新意，不要重复他人观点\n2. 可以随机戳一戳活跃的成员\n3. 语气要自然，像普通群员一样' : '1. 回复要针对性强，不要答非所问\n2. 被召唤时更要积极互动'}
3. @人时只使用出现在群聊记录中的QQ号
4. 多使用戳一戳和表情回应来增加互动性
${e.isMaster ? '5. 对主人要特别友好和尊重' : ''}`;
  }

  /**
   * 构建聊天上下文
   */
  async buildChatContext(e, question) {
    const messages = [];
    const now = new Date();
    const dateStr = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 ${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
    
    // 获取Bot角色
    let botRole = '成员';
    const cacheKey = `bot_role_${e.group_id}`;
    const cached = this.userCache.get(cacheKey);
    
    if (cached && Date.now() - cached.time < 300000) {
      botRole = cached.value;
    } else if (e.isGroup) {
      try {
        const member = e.group.pickMember(e.self_id);
        const info = await member.getInfo();
        botRole = info.role === 'owner' ? '群主' : 
                 info.role === 'admin' ? '管理员' : '成员';
        this.userCache.set(cacheKey, { value: botRole, time: Date.now() });
      } catch {}
    }
    
    // 判断是否全局触发
    const isGlobalTrigger = question.isGlobalTrigger || false;
    
    // 系统提示
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
    
    // 添加群聊历史
    if (e.isGroup) {
      const history = this.messageHistory.get(e.group_id) || [];
      if (history.length > 0) {
        const recentMessages = isGlobalTrigger ? 
          history.slice(-15) : 
          history.slice(-10);
        
        messages.push({
          role: 'user',
          content: `[群聊记录]\n${recentMessages.map(msg => 
            `${msg.nickname}(${msg.user_id})[${msg.message_id}]: ${msg.message}`
          ).join('\n')}`
        });
      }
    }
    
    // 添加当前问题
    if (!isGlobalTrigger) {
      const userInfo = e.sender?.card || e.sender?.nickname || '未知';
      const content = typeof question === 'string' ? question : question.content || '';
      messages.push({
        role: 'user',
        content: `[当前消息]\n${userInfo}(${e.user_id})[${e.message_id}]: ${content}`
      });
    } else {
      messages.push({
        role: 'user',
        content: '请对当前话题发表你的看法，要自然且有自己的观点。'
      });
    }
    
    return messages;
  }

  /**
   * 处理CQ码为消息段
   */
  async parseCQCodes(text, e) {
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
              if (e.isGroup && paramObj.qq) {
                // 验证用户是否在群聊记录中
                const history = this.messageHistory.get(e.group_id) || [];
                const userExists = history.some(msg => 
                  String(msg.user_id) === String(paramObj.qq)
                );
                if (userExists) {
                  segments.push(segment.at(paramObj.qq));
                }
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

  /**
   * 清理缓存
   */
  cleanupCache() {
    const now = Date.now();
    
    // 清理消息历史
    for (const [groupId, messages] of this.messageHistory.entries()) {
      const filtered = messages.filter(msg => now - msg.time < 1800000); // 30分钟
      if (filtered.length === 0) {
        this.messageHistory.delete(groupId);
      } else {
        this.messageHistory.set(groupId, filtered);
      }
    }
    
    // 清理用户缓存
    for (const [key, data] of this.userCache.entries()) {
      if (now - data.time > 300000) { // 5分钟
        this.userCache.delete(key);
      }
    }
    
    BotUtil.makeLog('debug', `缓存清理完成`, 'ChatStream');
  }
}