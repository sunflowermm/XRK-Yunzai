export default class XRKChatStream extends StreamBase {
  constructor() {
    super({
      name: 'XRKChat',
      description: '向日葵AI聊天工作流',
      version: '1.0.0',
      author: 'XRK',
      enabled: true,
      config: {
        maxRetries: 2,
        retryDelay: 500,
        timeout: 5000
      }
    });
  }

  initRules() {
    this.addRule({
      name: 'at',
      group: 'interaction',
      enabled: true,
      reg: /\[CQ:at,qq=(\d+)\]/gi,
      regPrompt: '[CQ:at,qq=QQ号] - @某人（确保QQ号存在于群聊记录中）',
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
      regPrompt: '[CQ:reply,id=消息ID] - 回复某条消息',
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
          '生气': ['8', '23', '39', '86', '179']
        };
        
        const emojiIds = emojiMap[emojiType];
        if (emojiIds) {
          const emojiId = emojiIds[Math.floor(Math.random() * emojiIds.length)];
          await e.group.setEmojiLike(msgId, emojiId);
          return { action: 'emoji', msgId, emoji: emojiId };
        }
        return null;
      }
    });

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
        await e.group.pickMember(qq).thumbUp(thumbCount);
        return { action: 'thumbUp', target: qq, count: thumbCount };
      }
    });

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
        
        await e.group.sign();
        return { action: 'sign' };
      }
    });

    this.addRule({
      name: 'mute',
      group: 'admin',
      enabled: true,
      reg: /\[禁言:(\d+):(\d+)\]/gi,
      regPrompt: '[禁言:QQ号:秒数] - 禁言某人（需要管理权限）',
      priority: 50,
      validator: async (match, context) => {
        const botRole = await this.getBotRole(context.e);
        return botRole === '群主' || botRole === '管理员';
      },
      handler: async (result, context) => {
        const { e } = context;
        const [qq, seconds] = result.params;
        
        await e.group.muteMember(qq, parseInt(seconds));
        return { action: 'mute', target: qq, duration: seconds };
      }
    });

    this.addRule({
      name: 'unmute',
      group: 'admin',
      enabled: true,
      reg: /\[解禁:(\d+)\]/gi,
      regPrompt: '[解禁:QQ号] - 解除禁言',
      priority: 50,
      validator: async (match, context) => {
        const botRole = await this.getBotRole(context.e);
        return botRole === '群主' || botRole === '管理员';
      },
      handler: async (result, context) => {
        const { e } = context;
        const qq = result.params[0];
        
        await e.group.muteMember(qq, 0);
        return { action: 'unmute', target: qq };
      }
    });

    this.addRule({
      name: 'essence',
      group: 'admin',
      enabled: true,
      reg: /\[精华:([^\]]+)\]/gi,
      regPrompt: '[精华:消息ID] - 设置精华消息（需要管理权限）',
      priority: 40,
      validator: async (match, context) => {
        const botRole = await this.getBotRole(context.e);
        return botRole === '群主' || botRole === '管理员';
      },
      handler: async (result, context) => {
        const { e } = context;
        const msgId = result.params[0];
        
        await e.group.setEssence(msgId);
        return { action: 'essence', msgId };
      }
    });

    this.addRule({
      name: 'notice',
      group: 'admin',
      enabled: true,
      reg: /\[公告:([^\]]+)\]/gi,
      regPrompt: '[公告:内容] - 发布群公告（需要管理权限）',
      priority: 30,
      validator: async (match, context) => {
        const botRole = await this.getBotRole(context.e);
        return botRole === '群主' || botRole === '管理员';
      },
      handler: async (result, context) => {
        const { e } = context;
        const content = result.params[0];
        
        await e.group.sendNotice(content);
        return { action: 'notice', content };
      }
    });

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
            return { action: 'emotion', type: emotion, image: imagePath };
          }
        }
        return null;
      }
    });

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
          return await context.createReminder(context.e, [dateStr, timeStr, content]);
        }
        return null;
      }
    });
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

【重要限制】
1. 每次回复最多只能发一个表情包
2. 最多使用一个竖线(|)分隔，也就是最多两条消息
3. @人之前要确认QQ号是否在群聊记录中出现过
4. 不要重复使用相同的功能

【注意事项】
${isGlobalTrigger ? '1. 主动发言要有新意，不要重复他人观点\n2. 可以随机戳一戳活跃的成员\n3. 语气要自然，像普通群员一样' : '1. 回复要针对性强，不要答非所问\n2. 被召唤时更要积极互动'}
3. @人时只使用出现在群聊记录中的QQ号
4. 多使用戳一戳和表情回应来增加互动性
${e.isMaster ? '5. 对主人要特别友好和尊重' : ''}`;

    return this.buildSystemPrompt(basePrompt, context);
  }
}