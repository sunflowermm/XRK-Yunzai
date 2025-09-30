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
    
    this.emotionImages = {};
    this.EMOTION_TYPES = ['开心', '惊讶', '伤心', '大笑', '害怕', '生气'];
    this.EMOJI_REACTIONS = {
      '开心': ['4', '14', '21', '28', '76', '79', '99', '182', '201', '290'],
      '惊讶': ['26', '32', '97', '180', '268', '289'],
      '伤心': ['5', '9', '106', '111', '173', '174'],
      '大笑': ['4', '12', '28', '101', '182', '281'],
      '害怕': ['26', '27', '41', '96'],
      '喜欢': ['42', '63', '85', '116', '122', '319'],
      '爱心': ['66', '122', '319'],
      '生气': ['8', '23', '39', '86', '179', '265']
    };
  }

  initRules() {
    // @某人
    this.addRule({
      name: 'at',
      group: 'interaction',
      reg: /\[CQ:at,qq=(\d+)\]/gi,
      regPrompt: '[CQ:at,qq=QQ号] - @某人（确保QQ号存在）',
      priority: 100,
      handler: async (result, context) => {
        const { e } = context;
        if (!e.isGroup) return null;
        
        const qq = result.params[0];
        const history = context.messageHistory || [];
        const userExists = history.some(msg => String(msg.user_id) === String(qq));
        
        if (userExists) {
          try {
            const member = e.group.pickMember(qq);
            await member.getInfo();
            return { type: 'at', qq, segment: segment.at(qq) };
          } catch {}
        }
        return null;
      }
    });

    // 戳一戳
    this.addRule({
      name: 'poke',
      group: 'interaction',
      reg: /\[CQ:poke,qq=(\d+)\]/gi,
      regPrompt: '[CQ:poke,qq=QQ号] - 戳一戳某人',
      priority: 90,
      handler: async (result, context) => {
        const { e } = context;
        if (!e.isGroup) return null;
        
        try {
          await e.group.pokeMember(result.params[0]);
          return { action: 'poke', target: result.params[0] };
        } catch {}
        return null;
      }
    });

    // 回复消息
    this.addRule({
      name: 'reply',
      group: 'interaction',
      reg: /\[CQ:reply,id=([^\]]+)\]/gi,
      regPrompt: '[CQ:reply,id=消息ID] - 回复某条消息',
      priority: 95,
      handler: async (result, context) => {
        return { type: 'reply', segment: segment.reply(result.params[0]) };
      }
    });

    // 表情回应
    this.addRule({
      name: 'emojiReaction',
      group: 'emotion',
      reg: /\[回应:([^:]+):([^\]]+)\]/gi,
      regPrompt: '[回应:消息ID:表情类型] - 给消息添加表情回应',
      priority: 80,
      handler: async (result, context) => {
        const { e } = context;
        if (!e.isGroup) return null;
        
        const [msgId, emojiType] = result.params;
        const emojiIds = this.EMOJI_REACTIONS[emojiType];
        
        if (emojiIds) {
          const emojiId = emojiIds[Math.floor(Math.random() * emojiIds.length)];
          await e.group.setEmojiLike(msgId, emojiId);
          return { action: 'emoji', msgId, emoji: emojiId };
        }
        return null;
      }
    });

    // 点赞
    this.addRule({
      name: 'thumbUp',
      group: 'interaction',
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

    // 签到
    this.addRule({
      name: 'sign',
      group: 'action',
      reg: /\[签到\]/gi,
      regPrompt: '[签到] - 执行群签到',
      priority: 60,
      handler: async (result, context) => {
        const { e } = context;
        if (e.isGroup) {
          await e.group.sign();
          return { action: 'sign' };
        }
        return null;
      }
    });

    // 禁言
    this.addRule({
      name: 'mute',
      group: 'admin',
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

    // 解禁
    this.addRule({
      name: 'unmute',
      group: 'admin',
      reg: /\[解禁:(\d+)\]/gi,
      regPrompt: '[解禁:QQ号] - 解除禁言',
      priority: 50,
      validator: async (match, context) => {
        const botRole = await this.getBotRole(context.e);
        return botRole === '群主' || botRole === '管理员';
      },
      handler: async (result, context) => {
        const { e } = context;
        await e.group.muteMember(result.params[0], 0);
        return { action: 'unmute', target: result.params[0] };
      }
    });

    // 精华消息
    this.addRule({
      name: 'essence',
      group: 'admin',
      reg: /\[精华:([^\]]+)\]/gi,
      regPrompt: '[精华:消息ID] - 设置精华消息（需要管理权限）',
      priority: 40,
      validator: async (match, context) => {
        const botRole = await this.getBotRole(context.e);
        return botRole === '群主' || botRole === '管理员';
      },
      handler: async (result, context) => {
        const { e } = context;
        await e.group.setEssence(result.params[0]);
        return { action: 'essence', msgId: result.params[0] };
      }
    });

    // 群公告
    this.addRule({
      name: 'notice',
      group: 'admin',
      reg: /\[公告:([^\]]+)\]/gi,
      regPrompt: '[公告:内容] - 发布群公告（需要管理权限）',
      priority: 30,
      validator: async (match, context) => {
        const botRole = await this.getBotRole(context.e);
        return botRole === '群主' || botRole === '管理员';
      },
      handler: async (result, context) => {
        const { e } = context;
        await e.group.sendNotice(result.params[0]);
        return { action: 'notice', content: result.params[0] };
      }
    });

    // 表情包
    this.addRule({
      name: 'emotion',
      group: 'emotion',
      reg: /\[(开心|惊讶|伤心|大笑|害怕|生气)\]/gi,
      regPrompt: '在文字中插入[开心]、[惊讶]等表情包（每次最多一个）',
      priority: 20,
      handler: async (result, context) => {
        const emotion = result.params[0];
        const imagePath = this.getRandomEmotionImage(emotion, context);
        
        if (imagePath) {
          return { action: 'emotion', type: emotion, image: imagePath };
        }
        return null;
      }
    });
  }

  // ========== 核心方法重写 ==========

  async shouldTrigger(e, context) {
    const { config } = context;
    
    // 检查白名单
    const isInWhitelist = () => {
      if (e.isGroup) {
        const groupWhitelist = (config.ai?.whitelist?.groups || []).map(id => Number(id));
        return groupWhitelist.includes(Number(e.group_id));
      } else {
        const userWhitelist = (config.ai?.whitelist?.users || []).map(id => Number(id));
        return userWhitelist.includes(Number(e.user_id));
      }
    };
    
    // 1. @触发
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
    
    // 全局AI状态检查
    const state = context.globalAIState || { 
      lastTrigger: 0, 
      messageCount: 0,
      lastMessageTime: 0,
      activeUsers: new Set()
    };
    
    const now = Date.now();
    
    if (now - state.lastMessageTime > 60000) {
      state.messageCount = 1;
      state.activeUsers.clear();
      state.activeUsers.add(e.user_id);
    } else {
      state.messageCount++;
      state.activeUsers.add(e.user_id);
    }
    state.lastMessageTime = now;
    
    const cooldown = (config.ai?.globalAICooldown || 300) * 1000;
    const chance = config.ai?.globalAIChance || 0.05;
    
    const canTrigger = now - state.lastTrigger > cooldown && 
                       (state.messageCount >= 3 && state.activeUsers.size >= 2 || state.messageCount >= 8);
    
    if (canTrigger && Math.random() < chance) {
      state.lastTrigger = now;
      state.messageCount = 0;
      state.activeUsers.clear();
      
      // 更新状态
      if (context.updateGlobalAIState) {
        context.updateGlobalAIState(e.group_id, state);
      }
      
      logger.info(`[XRKChat] 全局AI触发 - 群:${e.group_id}`);
      return true;
    }
    
    // 更新状态
    if (context.updateGlobalAIState) {
      context.updateGlobalAIState(e.group_id, state);
    }
    
    return false;
  }

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
            if (context.processImage) {
              const desc = await context.processImage(seg.url || seg.file);
              content += `[图片:${desc}] `;
            }
            break;
        }
      }
      
      // 清理触发前缀
      const { config } = context;
      if (config.ai?.triggerPrefix && config.ai.triggerPrefix !== '') {
        content = content.replace(new RegExp(`^${config.ai.triggerPrefix}`), '');
      }
      
      return content.trim();
    } catch (error) {
      logger.error(`[XRKChat] 处理消息内容失败: ${error.message}`);
      return e.msg || '';
    }
  }

  buildSystemPrompt(persona, context) {
    const { e, dateStr, isGlobalTrigger, botRole } = context;
    
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
1. 你是一个真实的QQ用户，不是AI助手
2. 说话要自然、简洁、有个性
3. 最多使用一个竖线分隔符(|)，也就是最多发送两条消息
4. 每条消息不要太长，像正常聊天一样
5. 适当使用表情包和互动功能

【表情包系统】
在文字中插入以下标记来发送表情包（一次对话只能使用一个表情包）：
[开心] [惊讶] [伤心] [大笑] [害怕] [生气]
重要：每次回复最多只能使用一个表情包标记！

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

    return super.buildSystemPrompt(prompt, context);
  }

  async buildChatContext(e, question, context) {
    const messages = [];
    const systemPrompt = this.buildSystemPrompt(context.persona || '', context);
    
    messages.push({ role: 'system', content: systemPrompt });
    
    if (e.isGroup && context.messageHistory) {
      const history = context.messageHistory;
      
      if (context.isGlobalTrigger) {
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
        const currentIndex = history.findIndex(msg => msg.message_id === e.message_id);
        let relevantHistory = [];
        
        if (currentIndex > 0) {
          const historyCount = Math.min(context.config.ai?.historyLimit || 10, currentIndex);
          relevantHistory = history.slice(Math.max(0, currentIndex - historyCount), currentIndex);
        } else if (currentIndex === -1 && history.length > 0) {
          relevantHistory = history.slice(-(context.config.ai?.historyLimit || 10));
        }
        
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
          content: `[当前消息]\n${userInfo}(${e.user_id})[${e.message_id}]: ${question}`
        });
      }
    } else if (!e.isGroup) {
      const userInfo = e.sender?.nickname || '未知';
      messages.push({
        role: 'user',
        content: `${userInfo}(${e.user_id}): ${question}`
      });
    }
    
    return messages;
  }

  async sendResponse(e, text, executeResult, context) {
    try {
      // 使用竖线分割响应，最多两段
      const segments = text.split('|').map(s => s.trim()).filter(s => s).slice(0, 2);
      
      // 统计总的表情包数量，确保只发一个
      let emotionSent = false;
      let allExecutedResults = [];
      
      // 收集所有已执行的情感结果
      for (const exec of executeResult.executed) {
        if (exec.result && exec.result.action === 'emotion') {
          allExecutedResults.push(exec.result);
        }
      }
      
      for (let i = 0; i < segments.length; i++) {
        const textSegment = segments[i];
        
        // 只发送第一个表情包
        if (!emotionSent && allExecutedResults.length > 0) {
          const emotionResult = allExecutedResults[0];
          if (emotionResult.image) {
            await e.reply(segment.image(emotionResult.image));
            emotionSent = true;
            await Bot.sleep(300);
          }
        }
        
        // 构建消息段
        const msgSegments = [];
        
        // 添加CQ码对应的segment
        for (const exec of executeResult.executed) {
          if (exec.result && exec.result.segment) {
            msgSegments.push(exec.result.segment);
          }
        }
        
        // 添加文本
        if (textSegment) {
          msgSegments.push(textSegment);
        }
        
        // 发送消息
        if (msgSegments.length > 0) {
          await e.reply(msgSegments, Math.random() > 0.5);
        }
        
        // 延迟到下一个segment
        if (i < segments.length - 1) {
          await Bot.sleep(this.randomRange(800, 1500));
        }
      }
    } catch (error) {
      logger.error(`[XRKChat] 发送响应失败: ${error.message}`);
    }
  }

  // ========== 工具方法 ==========

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

  getRandomEmotionImage(emotion, context) {
    const images = context.emotionImages?.[emotion] || [];
    if (images.length === 0) return null;
    return images[Math.floor(Math.random() * images.length)];
  }

  randomRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}