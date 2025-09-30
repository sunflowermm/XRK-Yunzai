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
        timeout: 8000,
        // 自定义配置
        maxSegments: 2,        // 最多分段数
        maxEmotions: 1,        // 最多表情包数
        segmentDelay: [800, 1500]  // 段落间延迟范围
      }
    });
    
    this.initRules();
  }

  initRules() {
    // 交互类规则
    this.addRule({
      name: 'at',
      group: 'interaction',
      enabled: true,
      reg: /\[CQ:at,qq=(\d+)\]/gi,
      regPrompt: '[CQ:at,qq=QQ号] - @某人（确保QQ号存在于群聊记录中）',
      priority: 100,
      handler: async (result, context) => {
        const { e } = context;
        if (!e?.isGroup) return null;
        
        const qq = result.params[0];
        const history = context.messageHistory?.get(e.group_id) || [];
        const userExists = history.some(msg => String(msg.user_id) === String(qq));
        
        if (!userExists) return null;
        
        try {
          const member = e.group.pickMember(qq);
          await member.getInfo();
          return { 
            type: 'cq',
            cqType: 'at',
            data: { qq },
            segment: segment.at(qq)
          };
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
        if (!e?.isGroup) return null;
        
        const qq = result.params[0];
        try {
          await e.group.pokeMember(qq);
          return { 
            type: 'action',
            action: 'poke',
            target: qq,
            executed: true
          };
        } catch (error) {
          logger?.error(`[XRKChat] 戳一戳失败: ${error.message}`);
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
        return { 
          type: 'cq',
          cqType: 'reply',
          data: { id: msgId },
          segment: segment.reply(msgId)
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
        if (!e?.isGroup) return null;
        
        const [msgId, emojiType] = result.params;
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
        
        const emojiIds = EMOJI_REACTIONS[emojiType];
        if (!emojiIds) return null;
        
        try {
          const emojiId = emojiIds[Math.floor(Math.random() * emojiIds.length)];
          await e.group.setEmojiLike(msgId, emojiId);
          return { 
            type: 'action',
            action: 'emojiReaction',
            msgId,
            emoji: emojiId,
            executed: true
          };
        } catch (error) {
          logger?.error(`[XRKChat] 表情回应失败: ${error.message}`);
          return null;
        }
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
        if (!e?.isGroup) return null;
        
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
        } catch (error) {
          logger?.error(`[XRKChat] 点赞失败: ${error.message}`);
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
        if (!e?.isGroup) return null;
        
        try {
          await e.group.sign();
          return { 
            type: 'action',
            action: 'sign',
            executed: true
          };
        } catch (error) {
          logger?.error(`[XRKChat] 签到失败: ${error.message}`);
          return null;
        }
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
        return await this.checkPermission(context.e, 'mute');
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
        } catch (error) {
          logger?.error(`[XRKChat] 禁言失败: ${error.message}`);
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
        return await this.checkPermission(context.e, 'mute');
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
        } catch (error) {
          logger?.error(`[XRKChat] 解禁失败: ${error.message}`);
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
        return await this.checkPermission(context.e, 'admin');
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
        } catch (error) {
          logger?.error(`[XRKChat] 设置精华失败: ${error.message}`);
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
        return await this.checkPermission(context.e, 'admin');
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
        } catch (error) {
          logger?.error(`[XRKChat] 发布公告失败: ${error.message}`);
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
      regPrompt: '在文字中插入[开心]、[惊讶]等表情包（每次回复最多一个）',
      priority: 20,
      handler: async (result, context) => {
        const emotion = result.params[0];
        
        if (context.getRandomEmotionImage) {
          const imagePath = context.getRandomEmotionImage(emotion);
          if (imagePath) {
            return { 
              type: 'emotion',
              emotion,
              image: imagePath
            };
          }
        }
        return null;
      }
    });

    // 定时提醒
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
          try {
            await context.createReminder(context.e, [dateStr, timeStr, content]);
            return { 
              type: 'action',
              action: 'reminder',
              date: dateStr,
              time: timeStr,
              content,
              executed: true
            };
          } catch (error) {
            logger?.error(`[XRKChat] 创建提醒失败: ${error.message}`);
            return null;
          }
        }
        return null;
      }
    });
  }

  /**
   * 重写process方法以支持复杂的响应处理
   */
  async process(response, context = {}) {
    try {
      const segments = response.split('|').map(s => s.trim()).filter(s => s).slice(0, this.config.maxSegments);
      
      const processedSegments = [];
      let totalEmotionsSent = 0;
      
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        const segmentText = segments[segmentIndex];
        
        // 解析当前段落
        const parseResult = await this.parseResponse(segmentText, context);
        
        // 处理表情包（全局限制）
        const emotionResults = parseResult.results.filter(r => r.metadata?.group === 'emotion');
        const shouldSendEmotion = totalEmotionsSent < this.config.maxEmotions && emotionResults.length > 0;
        
        // 收集CQ码和文本
        const cqSegments = [];
        const actions = [];
        let cleanedText = parseResult.processedResponse;
        
        // 处理规则结果
        for (const result of parseResult.results) {
          if (!result.handler) continue;
          
          const execResult = await this._executeRule(result, context);
          
          if (execResult.success && execResult.result) {
            const res = execResult.result;
            
            if (res.type === 'cq' && res.segment) {
              cqSegments.push(res.segment);
            } else if (res.type === 'emotion' && shouldSendEmotion) {
              actions.push({ type: 'emotion', data: res });
              totalEmotionsSent++;
            } else if (res.type === 'action' && res.executed) {
              actions.push({ type: 'action', data: res });
            }
          }
        }
        
        processedSegments.push({
          text: cleanedText,
          cqSegments,
          actions,
          index: segmentIndex
        });
      }
      
      return {
        success: true,
        segments: processedSegments,
        original: response,
        metadata: {
          stream: this.name,
          version: this.version,
          segmentCount: segments.length
        }
      };
      
    } catch (error) {
      logger?.error(`[XRKChat] 处理失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 检查权限
   */
  async checkPermission(e, permission) {
    if (!e?.isGroup) return false;
    if (e.isMaster) return true;
    
    const cacheKey = `bot_role_${e.group_id}`;
    let role = null;
    
    try {
      const member = e.group.pickMember(e.self_id);
      const info = await member.getInfo();
      role = info.role === 'owner' ? '群主' : 
             info.role === 'admin' ? '管理员' : '成员';
    } catch {
      role = '成员';
    }
    
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
   * 构建聊天系统提示词
   */
  buildChatSystemPrompt(persona, context = {}) {
    const { e, dateStr, isGlobalTrigger, botRole = '成员' } = context;
    
    let basePrompt = `【人设设定】
${persona}

【身份信息】
名字：${Bot.nickname}
QQ号：${e?.self_id}
${e?.isGroup ? `群名：${e.group?.group_name || '未知'}
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
${e?.isMaster ? '5. 对主人要特别友好和尊重' : ''}`;

    return this.buildSystemPrompt(basePrompt, context);
  }
}