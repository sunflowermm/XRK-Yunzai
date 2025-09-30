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
        timeout: 5000,
        debug: false
      }
    });
    
    this.initRules();
  }

  initRules() {
    // @某人
    this.addRule({
      name: 'at',
      group: 'interaction',
      enabled: true,
      reg: /\[CQ:at,qq=(\d+)\]/gi,
      regPrompt: '[CQ:at,qq=QQ号] - @某人（确保QQ号存在于群聊记录中）',
      priority: 100,
      handler: async (result, context) => {
        const { e, messageHistory } = context;
        if (!e.isGroup) return null;
        
        const qq = result.params[0];
        
        // 验证QQ号是否在历史记录中
        const history = messageHistory?.get?.(e.group_id) || [];
        const userExists = history.some(msg => String(msg.user_id) === String(qq));
        
        if (userExists) {
          try {
            const member = e.group.pickMember(qq);
            await member.getInfo();
            return { 
              type: 'segment',
              data: segment.at(qq)
            };
          } catch {
            return null;
          }
        }
        return null;
      }
    });

    // 戳一戳
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
          return { 
            type: 'action',
            action: 'poke',
            target: qq,
            executed: true
          };
        } catch {
          return null;
        }
      }
    });

    // 回复消息
    this.addRule({
      name: 'reply',
      group: 'interaction',
      enabled: true,
      reg: /\[CQ:reply,id=([^\]]+)\]/gi,
      regPrompt: '[CQ:reply,id=消息ID] - 回复某条消息',
      priority: 95,
      handler: async (result, context) => {
        const msgId = result.params[0];
        return { 
          type: 'segment',
          data: segment.reply(msgId)
        };
      }
    });

    // 表情回应
    this.addRule({
      name: 'emojiReaction',
      group: 'emotion',
      enabled: true,
      reg: /\[回应:([^:]+):([^\]]+)\]/gi,
      regPrompt: '[回应:消息ID:表情类型] - 给消息添加表情回应',
      priority: 80,
      handler: async (result, context) => {
        const { e } = context;
        if (!e.isGroup) return null;
        
        const [msgId, emojiType] = result.params;
        const emojiMap = {
          '开心': ['4', '14', '21', '28', '76'],
          '惊讶': ['26', '32', '97', '180', '268'],
          '伤心': ['5', '9', '106', '111', '173'],
          '大笑': ['4', '12', '28', '101', '182'],
          '害怕': ['26', '27', '41', '96'],
          '喜欢': ['42', '63', '85', '116', '122'],
          '爱心': ['66', '122', '319'],
          '生气': ['8', '23', '39', '86', '179']
        };
        
        const emojiIds = emojiMap[emojiType];
        if (emojiIds) {
          const emojiId = emojiIds[Math.floor(Math.random() * emojiIds.length)];
          try {
            await e.group.setEmojiLike(msgId, emojiId);
            return { 
              type: 'action',
              action: 'emoji',
              msgId,
              emoji: emojiId,
              executed: true
            };
          } catch {}
        }
        return null;
      }
    });

    // 点赞
    this.addRule({
      name: 'thumbUp',
      group: 'interaction',
      enabled: true,
      reg: /\[点赞:(\d+):(\d+)\]/gi,
      regPrompt: '[点赞:QQ号:次数] - 给某人点赞（1-50次）',
      priority: 70,
      handler: async (result, context) => {
        const { e } = context;
        if (!e.isGroup) return null;
        
        const [qq, count] = result.params;
        const thumbCount = Math.min(parseInt(count) || 1, 50);
        try {
          await e.group.pickMember(qq).thumbUp(thumbCount);
          return { 
            type: 'action',
            action: 'thumbUp',
            target: qq,
            count: thumbCount,
            executed: true
          };
        } catch {
          return null;
        }
      }
    });

    // 签到
    this.addRule({
      name: 'sign',
      group: 'action',
      enabled: true,
      reg: /\[签到\]/gi,
      regPrompt: '[签到] - 执行群签到',
      priority: 60,
      handler: async (result, context) => {
        const { e } = context;
        if (!e.isGroup) return null;
        
        try {
          await e.group.sign();
          return { 
            type: 'action',
            action: 'sign',
            executed: true
          };
        } catch {
          return null;
        }
      }
    });

    // 表情包
    this.addRule({
      name: 'emotion',
      group: 'emotion',
      enabled: true,
      reg: /\[(开心|惊讶|伤心|大笑|害怕|生气)\]/gi,
      regPrompt: '在文字中插入[开心]、[惊讶]等表情包',
      priority: 20,
      handler: async (result, context) => {
        const emotion = result.params[0];
        
        if (context.getEmotionImage) {
          const imagePath = context.getEmotionImage(emotion);
          if (imagePath) {
            return { 
              type: 'emotion',
              emotion: emotion,
              image: imagePath
            };
          }
        }
        return null;
      }
    });

    // 禁言
    this.addRule({
      name: 'mute',
      group: 'admin',
      enabled: true,
      reg: /\[禁言:(\d+):(\d+)\]/gi,
      regPrompt: '[禁言:QQ号:秒数] - 禁言某人（需要管理权限）',
      priority: 50,
      validator: async (match, context) => {
        return await this.checkPermission(context, 'mute');
      },
      handler: async (result, context) => {
        const { e } = context;
        const [qq, seconds] = result.params;
        
        try {
          await e.group.muteMember(qq, parseInt(seconds));
          return { 
            type: 'action',
            action: 'mute',
            target: qq,
            duration: seconds,
            executed: true
          };
        } catch {
          return null;
        }
      }
    });

    // 解禁
    this.addRule({
      name: 'unmute',
      group: 'admin',
      enabled: true,
      reg: /\[解禁:(\d+)\]/gi,
      regPrompt: '[解禁:QQ号] - 解除禁言',
      priority: 50,
      validator: async (match, context) => {
        return await this.checkPermission(context, 'mute');
      },
      handler: async (result, context) => {
        const { e } = context;
        const qq = result.params[0];
        
        try {
          await e.group.muteMember(qq, 0);
          return { 
            type: 'action',
            action: 'unmute',
            target: qq,
            executed: true
          };
        } catch {
          return null;
        }
      }
    });

    // 精华消息
    this.addRule({
      name: 'essence',
      group: 'admin',
      enabled: true,
      reg: /\[精华:([^\]]+)\]/gi,
      regPrompt: '[精华:消息ID] - 设置精华消息（需要管理权限）',
      priority: 40,
      validator: async (match, context) => {
        return await this.checkPermission(context, 'admin');
      },
      handler: async (result, context) => {
        const { e } = context;
        const msgId = result.params[0];
        
        try {
          await e.group.setEssence(msgId);
          return { 
            type: 'action',
            action: 'essence',
            msgId,
            executed: true
          };
        } catch {
          return null;
        }
      }
    });

    // 群公告
    this.addRule({
      name: 'notice',
      group: 'admin',
      enabled: true,
      reg: /\[公告:([^\]]+)\]/gi,
      regPrompt: '[公告:内容] - 发布群公告（需要管理权限）',
      priority: 30,
      validator: async (match, context) => {
        return await this.checkPermission(context, 'admin');
      },
      handler: async (result, context) => {
        const { e } = context;
        const content = result.params[0];
        
        try {
          await e.group.sendNotice(content);
          return { 
            type: 'action',
            action: 'notice',
            content,
            executed: true
          };
        } catch {
          return null;
        }
      }
    });

    // 提醒
    this.addRule({
      name: 'reminder',
      group: 'action',
      enabled: true,
      reg: /\[提醒:(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):([^\]]+)\]/gi,
      regPrompt: '[提醒:年-月-日 时:分:内容] - 设置定时提醒',
      priority: 10,
      handler: async (result, context) => {
        const [dateStr, timeStr, content] = result.params;
        
        if (context.createReminder) {
          const reminderResult = await context.createReminder(context.e, [dateStr, timeStr, content]);
          return { 
            type: 'action',
            action: 'reminder',
            ...reminderResult
          };
        }
        return null;
      }
    });
  }

  /**
   * 检查权限
   */
  async checkPermission(context, permission) {
    const { e, botRole } = context;
    if (!e.isGroup) return false;
    if (e.isMaster) return true;
    
    const role = botRole || await this.getBotRole(e);
    
    switch (permission) {
      case 'mute':
      case 'admin':
        return role === '群主' || role === '管理员';
      case 'owner':
        return role === '群主';
      default:
        return false;
    }
  }

  /**
   * 获取机器人角色
   */
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

  /**
   * 构建聊天系统提示词
   */
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
5. 适当使用表情包和互动功能`;

    return this.buildSystemPrompt(basePrompt, context);
  }

  /**
   * 处理AI响应并发送消息
   */
  async processAndSend(response, context) {
    const { e } = context;
    const parseResult = await this.process(response, context);
    
    if (!parseResult.success) {
      logger?.error('[XRKChat] 工作流处理失败');
      return false;
    }
    
    // 使用竖线分割响应
    const segments = parseResult.processedResponse.split('|')
      .map(s => s.trim())
      .filter(s => s)
      .slice(0, 2);
    
    let emotionSent = false;
    
    for (let i = 0; i < segments.length; i++) {
      const segmentText = segments[i];
      const msgSegments = [];
      let hasContent = false;
      
      // 处理执行结果
      for (const exec of parseResult.executed) {
        const result = exec.result;
        if (!result) continue;
        
        // 处理表情包（只发一次）
        if (result.type === 'emotion' && !emotionSent) {
          await e.reply(segment.image(result.image));
          emotionSent = true;
          await Bot.sleep(300);
        }
        
        // 处理消息段
        if (result.type === 'segment') {
          msgSegments.push(result.data);
          hasContent = true;
        }
      }
      
      // 添加文本内容
      if (segmentText) {
        msgSegments.push(segmentText);
        hasContent = true;
      }
      
      // 发送消息
      if (hasContent && msgSegments.length > 0) {
        await e.reply(msgSegments, Math.random() > 0.5);
      }
      
      // 延迟到下一段
      if (i < segments.length - 1) {
        await Bot.sleep(this.randomRange(800, 1500));
      }
    }
    
    return true;
  }
  
  randomRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}