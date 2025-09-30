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

// 工具函数
function randomRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

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
        timeout: 10000,
        debug: false
      }
    });
    
    this.initRules();
  }

  initRules() {
    // @某人规则
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
        
        // 验证QQ号是否在历史记录中
        const history = context.messageHistory || [];
        const userExists = history.some(msg => String(msg.user_id) === String(qq));
        
        if (userExists) {
          try {
            const member = e.group.pickMember(qq);
            await member.getInfo();
            await e.reply(segment.at(qq), false);
            return { type: 'at', qq };
          } catch {
            return null;
          }
        }
        return null;
      }
    });

    // 戳一戳规则
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

    // 回复消息规则
    this.addRule({
      name: 'reply',
      group: 'interaction',
      enabled: true,
      reg: /\[CQ:reply,id=([^\]]+)\]/gi,
      regPrompt: '[CQ:reply,id=消息ID] - 回复某条消息',
      priority: 95,
      handler: async (result, context) => {
        const msgId = result.params[0];
        const { e } = context;
        await e.reply(segment.reply(msgId), false);
        return { type: 'reply', id: msgId };
      }
    });

    // 表情回应规则
    this.addRule({
      name: 'emojiReaction',
      group: 'emotion',
      enabled: true,
      reg: /\[回应:([^:]+):([^\]]+)\]/gi,
      regPrompt: '[回应:消息ID:表情类型] - 给消息添加表情回应（开心/惊讶/伤心/大笑/害怕/生气）',
      priority: 80,
      handler: async (result, context) => {
        const { e } = context;
        if (!e.isGroup) return null;
        
        const [msgId, emojiType] = result.params;
        const emojiIds = EMOJI_REACTIONS[emojiType];
        
        if (emojiIds) {
          const emojiId = emojiIds[Math.floor(Math.random() * emojiIds.length)];
          try {
            await e.group.setEmojiLike(msgId, emojiId);
            return { action: 'emoji', msgId, emoji: emojiId };
          } catch {
            return null;
          }
        }
        return null;
      }
    });

    // 点赞规则
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
          return { action: 'thumbUp', target: qq, count: thumbCount };
        } catch {
          return null;
        }
      }
    });

    // 签到规则
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
          return { action: 'sign' };
        } catch {
          return null;
        }
      }
    });

    // 禁言规则
    this.addRule({
      name: 'mute',
      group: 'admin',
      enabled: true,
      reg: /\[禁言:(\d+):(\d+)\]/gi,
      regPrompt: '[禁言:QQ号:秒数] - 禁言某人（需要管理权限）',
      priority: 50,
      validator: async (match, context) => {
        const role = await context.getBotRole();
        return role === '群主' || role === '管理员';
      },
      handler: async (result, context) => {
        const { e } = context;
        const [qq, seconds] = result.params;
        
        try {
          await e.group.muteMember(qq, parseInt(seconds));
          return { action: 'mute', target: qq, duration: seconds };
        } catch {
          return null;
        }
      }
    });

    // 解禁规则
    this.addRule({
      name: 'unmute',
      group: 'admin',
      enabled: true,
      reg: /\[解禁:(\d+)\]/gi,
      regPrompt: '[解禁:QQ号] - 解除禁言',
      priority: 50,
      validator: async (match, context) => {
        const role = await context.getBotRole();
        return role === '群主' || role === '管理员';
      },
      handler: async (result, context) => {
        const { e } = context;
        const qq = result.params[0];
        
        try {
          await e.group.muteMember(qq, 0);
          return { action: 'unmute', target: qq };
        } catch {
          return null;
        }
      }
    });

    // 精华消息规则
    this.addRule({
      name: 'essence',
      group: 'admin',
      enabled: true,
      reg: /\[精华:([^\]]+)\]/gi,
      regPrompt: '[精华:消息ID] - 设置精华消息（需要管理权限）',
      priority: 40,
      validator: async (match, context) => {
        const role = await context.getBotRole();
        return role === '群主' || role === '管理员';
      },
      handler: async (result, context) => {
        const { e } = context;
        const msgId = result.params[0];
        
        try {
          await e.group.setEssence(msgId);
          return { action: 'essence', msgId };
        } catch {
          return null;
        }
      }
    });

    // 发布公告规则
    this.addRule({
      name: 'notice',
      group: 'admin',
      enabled: true,
      reg: /\[公告:([^\]]+)\]/gi,
      regPrompt: '[公告:内容] - 发布群公告（需要管理权限）',
      priority: 30,
      validator: async (match, context) => {
        const role = await context.getBotRole();
        return role === '群主' || role === '管理员';
      },
      handler: async (result, context) => {
        const { e } = context;
        const content = result.params[0];
        
        try {
          await e.group.sendNotice(content);
          return { action: 'notice', content };
        } catch {
          return null;
        }
      }
    });

    // 表情包规则
    this.addRule({
      name: 'emotion',
      group: 'emotion',
      enabled: true,
      reg: /\[(开心|惊讶|伤心|大笑|害怕|生气)\]/gi,
      regPrompt: '在文字中插入[开心]、[惊讶]、[伤心]、[大笑]、[害怕]、[生气]等表情包（每次回复最多一个）',
      priority: 20,
      handler: async (result, context) => {
        const emotion = result.params[0];
        const { e, getEmotionImage } = context;
        
        if (getEmotionImage) {
          const imagePath = getEmotionImage(emotion);
          if (imagePath) {
            await e.reply(segment.image(imagePath));
            await Bot.sleep(300);
            return { action: 'emotion', type: emotion };
          }
        }
        return null;
      }
    });
  }

  /**
   * 重写process方法以处理完整的AI响应流程
   */
  async process(response, context = {}) {
    try {
      const { e } = context;
      
      // 使用竖线分割响应，最多两段
      const segments = response.split('|').map(s => s.trim()).filter(s => s).slice(0, 2);
      
      // 统计总的表情包数量，确保只发一个
      let emotionSent = false;
      
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        
        // 解析当前段落
        const parseResult = await this.parseResponse(segment, context);
        
        // 处理表情包（只发第一个）
        if (!emotionSent) {
          const emotionResult = parseResult.results.find(r => r.rule === 'emotion');
          if (emotionResult && emotionResult.handler) {
            await emotionResult.handler(emotionResult, context);
            emotionSent = true;
          }
        }
        
        // 发送清理后的文本
        if (parseResult.processedResponse) {
          // 处理CQ码
          const processedText = await this._processCQCodes(parseResult.processedResponse, context);
          if (processedText) {
            await e.reply(processedText, Math.random() > 0.5);
          }
        }
        
        // 执行其他功能（排除表情包）
        const otherResults = parseResult.results.filter(r => r.rule !== 'emotion');
        for (const result of otherResults) {
          if (result.handler && typeof result.handler === 'function') {
            await result.handler(result, context);
          }
        }
        
        // 延迟到下一个segment
        if (i < segments.length - 1) {
          await Bot.sleep(randomRange(800, 1500));
        }
      }
      
      return {
        success: true,
        processedResponse: response,
        original: response
      };
      
    } catch (error) {
      logger?.error(`[XRKChat] 处理失败: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 处理文本中的CQ码
   */
  async _processCQCodes(text, context) {
    const { e } = context;
    let processed = text;
    
    // 处理@
    processed = processed.replace(/\[CQ:at,qq=(\d+)\]/gi, (match, qq) => {
      return `[CQ:at,qq=${qq}]`;
    });
    
    // 处理回复
    processed = processed.replace(/\[CQ:reply,id=([^\]]+)\]/gi, (match, id) => {
      return `[CQ:reply,id=${id}]`;
    });
    
    return processed;
  }

  /**
   * 构建聊天系统提示
   */
  buildChatSystemPrompt(persona, context = {}) {
    const { e, dateStr, isGlobalTrigger, getBotRole, config } = context;
    const botRolePromise = getBotRole ? getBotRole() : Promise.resolve('成员');
    
    return (async () => {
      const botRole = await botRolePromise;
      
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

      // 构建消息上下文
      const messages = [];
      
      messages.push({
        role: 'system',
        content: this.buildSystemPrompt(basePrompt, context)
      });
      
      // 添加群聊历史
      if (e.isGroup && context.messageHistory) {
        const history = context.messageHistory;
        
        if (isGlobalTrigger) {
          // 全局触发时，提供更多历史
          const recentMessages = history.slice(-15);
          if (recentMessages.length > 0) {
            messages.push({
              role: 'user',
              content: `[群聊记录]\n${recentMessages.map(msg => 
                `${msg.nickname}(${msg.user_id})[${msg.message_id}]: ${msg.message}`
              ).join('\n')}\n\n请对当前话题发表你的看法，要自然且有自己的观点。`
            });
          }
        } else {
          // 主动触发时
          const relevantHistory = history.slice(-(config?.ai?.historyLimit || 10));
          
          if (relevantHistory.length > 0) {
            messages.push({
              role: 'user',
              content: `[群聊记录]\n${relevantHistory.map(msg => 
                `${msg.nickname}(${msg.user_id})[${msg.message_id}]: ${msg.message}`
              ).join('\n')}`
            });
          }
          
          const userInfo = e.sender?.card || e.sender?.nickname || '未知';
          messages.push({
            role: 'user',
            content: `[当前消息]\n${userInfo}(${e.user_id})[${e.message_id}]: ${context.question}`
          });
        }
      } else if (!e.isGroup) {
        // 私聊
        const userInfo = e.sender?.nickname || '未知';
        messages.push({
          role: 'user',
          content: `${userInfo}(${e.user_id}): ${context.question}`
        });
      }
      
      return messages;
    })();
  }
}