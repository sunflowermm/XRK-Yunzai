import fs from 'fs';
import path from 'path';

const _path = process.cwd();

/**
 * 向日葵聊天工作流
 * 处理AI聊天和消息互动
 */
export default class XRKChatStream extends StreamBase {
  constructor() {
    super({
      name: 'XRKChat',
      description: '向日葵AI聊天工作流',
      version: '2.0.0',
      author: 'XRK',
      enabled: true
    });
    
    // 初始化配置
    this.personas = {};
    this.emotionImages = {};
    this.groupPersonas = new Map();
    this.globalAIState = new Map();
    
    // 目录路径
    this.PERSONAS_DIR = path.join(_path, 'plugins/XRK/config/ai-assistant/personas');
    this.EMOTIONS_DIR = path.join(_path, 'plugins/XRK/config/ai-assistant');
    
    // 表情类型
    this.EMOTION_TYPES = ['开心', '惊讶', '伤心', '大笑', '害怕', '生气'];
    
    // 表情回应映射
    this.EMOJI_REACTIONS = {
      '开心': ['4', '14', '21', '28', '76', '79', '99', '182', '201', '290'],
      '惊讶': ['26', '32', '97', '180', '268', '289'],
      '伤心': ['5', '9', '106', '111', '173', '174'],
      '大笑': ['4', '12', '28', '101', '182', '281'],
      '害怕': ['26', '27', '41', '96'],
      '生气': ['8', '23', '39', '86', '179', '265']
    };
  }

  /**
   * 初始化
   */
  async init() {
    super.init();
    await this.loadPersonas();
    await this.loadEmotionImages();
    
    // 定期清理缓存
    setInterval(() => this.cleanupCache(), 300000);
  }

  /**
   * 初始化规则
   */
  initRules() {
    // @某人
    this.addRule({
      name: 'at',
      group: 'interaction',
      reg: /\[CQ:at,qq=(\d+)\]/gi,
      regPrompt: '[CQ:at,qq=QQ号] - @某人',
      priority: 100,
      handler: async (result, context) => {
        const { e } = context;
        if (!e.isGroup) return null;
        
        const qq = result.params[0];
        const history = this.messageHistory.get(e.group_id) || [];
        const userExists = history.some(msg => String(msg.user_id) === String(qq));
        
        if (userExists) {
          try {
            const member = e.group.pickMember(qq);
            await member.getInfo();
            return { type: 'at', qq, segments: [segment.at(qq)] };
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
      reg: /\[CQ:poke,qq=(\d+)\]/gi,
      regPrompt: '[CQ:poke,qq=QQ号] - 戳一戳某人',
      priority: 90,
      handler: async (result, context) => {
        const { e } = context;
        if (!e.isGroup) return null;
        
        const qq = result.params[0];
        await e.group.pokeMember(qq);
        return { action: 'poke', target: qq };
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
        const msgId = result.params[0];
        return { type: 'reply', id: msgId, segments: [segment.reply(msgId)] };
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
      regPrompt: '[点赞:QQ号:次数] - 给某人点赞',
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
        if (!e.isGroup) return null;
        
        await e.group.sign();
        return { action: 'sign' };
      }
    });

    // 禁言
    this.addRule({
      name: 'mute',
      group: 'admin',
      reg: /\[禁言:(\d+):(\d+)\]/gi,
      regPrompt: '[禁言:QQ号:秒数] - 禁言',
      priority: 50,
      validator: async (match, context) => {
        return await this.checkPermission(context.e, 'mute');
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
        return await this.checkPermission(context.e, 'mute');
      },
      handler: async (result, context) => {
        const { e } = context;
        const qq = result.params[0];
        
        await e.group.muteMember(qq, 0);
        return { action: 'unmute', target: qq };
      }
    });

    // 表情包
    this.addRule({
      name: 'emotion',
      group: 'emotion',
      reg: /\[(开心|惊讶|伤心|大笑|害怕|生气)\]/gi,
      regPrompt: '插入[开心]、[惊讶]等表情包',
      priority: 20,
      handler: async (result, context) => {
        const emotion = result.params[0];
        const imagePath = this.getRandomEmotionImage(emotion);
        if (imagePath) {
          return { 
            action: 'emotion', 
            type: emotion, 
            segments: [segment.image(imagePath)]
          };
        }
        return null;
      }
    });
  }

  /**
   * 处理消息
   */
  async processMessage(e, config) {
    try {
      // 设置AI配置
      this.config.ai = config.ai;
      
      // 判断触发类型
      const triggerType = this.getTriggerType(e, config);
      if (!triggerType) return null;
      
      // 处理消息内容
      const question = await this.processMessageContent(e);
      
      // 如果是主动触发但没有内容
      if (triggerType === 'direct' && !question && !e.img?.length) {
        const emotionImage = this.getRandomEmotionImage('惊讶');
        if (emotionImage) {
          await e.reply(segment.image(emotionImage));
        }
        await e.reply('有什么需要帮助的吗？');
        return { handled: true };
      }
      
      // 构建系统提示
      const systemPrompt = await this.buildSystemPrompt(e, config, triggerType);
      
      // 构建聊天上下文
      const messages = await this.buildChatContext(e, systemPrompt, question, {
        includeHistory: true,
        historyCount: triggerType === 'global' ? 15 : 10
      });
      
      // 调用AI
      const response = await this.callAI(messages, config.ai);
      if (!response) {
        if (triggerType === 'global') return null;
        return { handled: true, error: 'AI响应失败' };
      }
      
      // 处理AI响应
      await this.handleAIResponse(e, response);
      
      return { handled: true, success: true };
      
    } catch (error) {
      logger.error(`[XRKChat] 消息处理失败: ${error.message}`);
      return { handled: false, error: error.message };
    }
  }

  /**
   * 获取触发类型
   */
  getTriggerType(e, config) {
    // 被@时触发
    if (e.atBot) {
      const isInWhitelist = this.checkWhitelist(e, config);
      return isInWhitelist ? 'direct' : null;
    }
    
    // 前缀触发
    const triggerPrefix = config.ai?.triggerPrefix;
    if (triggerPrefix && e.msg?.startsWith(triggerPrefix)) {
      const isInWhitelist = this.checkWhitelist(e, config);
      return isInWhitelist ? 'direct' : null;
    }
    
    // 全局AI触发
    if (e.isGroup) {
      const globalWhitelist = (config.ai?.globalWhitelist || []).map(id => Number(id));
      if (globalWhitelist.includes(Number(e.group_id))) {
        return this.checkGlobalTrigger(e, config) ? 'global' : null;
      }
    }
    
    return null;
  }

  /**
   * 检查白名单
   */
  checkWhitelist(e, config) {
    if (e.isGroup) {
      const groupWhitelist = (config.ai?.whitelist?.groups || []).map(id => Number(id));
      return groupWhitelist.includes(Number(e.group_id));
    } else {
      const userWhitelist = (config.ai?.whitelist?.users || []).map(id => Number(id));
      return userWhitelist.includes(Number(e.user_id));
    }
  }

  /**
   * 检查全局触发条件
   */
  checkGlobalTrigger(e, config) {
    const groupId = e.group_id;
    const state = this.globalAIState.get(groupId) || { 
      lastTrigger: 0, 
      messageCount: 0,
      lastMessageTime: 0,
      activeUsers: new Set()
    };
    
    const now = Date.now();
    
    // 更新状态
    if (now - state.lastMessageTime > 60000) {
      state.messageCount = 1;
      state.activeUsers.clear();
      state.activeUsers.add(e.user_id);
    } else {
      state.messageCount++;
      state.activeUsers.add(e.user_id);
    }
    state.lastMessageTime = now;
    
    // 检查触发条件
    const cooldown = (config.ai?.globalAICooldown || 300) * 1000;
    const chance = config.ai?.globalAIChance || 0.05;
    
    const canTrigger = now - state.lastTrigger > cooldown && 
                       (state.messageCount >= 3 && state.activeUsers.size >= 2 || state.messageCount >= 8);
    
    if (canTrigger && Math.random() < chance) {
      state.lastTrigger = now;
      state.messageCount = 0;
      state.activeUsers.clear();
      this.globalAIState.set(groupId, state);
      logger.info(`[XRKChat] 全局AI触发 - 群:${groupId}`);
      return true;
    }
    
    this.globalAIState.set(groupId, state);
    return false;
  }

  /**
   * 处理消息内容
   */
  async processMessageContent(e) {
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
            content += '[图片] ';
            break;
        }
      }
      
      // 清理触发前缀
      const prefix = this.config.ai?.triggerPrefix;
      if (prefix && content.startsWith(prefix)) {
        content = content.substring(prefix.length);
      }
      
      return content.trim();
    } catch (error) {
      logger.error(`[XRKChat] 处理消息内容失败: ${error.message}`);
      return e.msg || '';
    }
  }

  /**
   * 构建系统提示
   */
  async buildSystemPrompt(e, config, triggerType) {
    const persona = this.getCurrentPersona(e);
    const botRole = await this.getBotRole(e);
    const now = new Date();
    const dateStr = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 ${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
    
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
${triggerType === 'global' ? '观察群聊后主动发言' : '被召唤回复'}

【基础规则】
1. 你是一个真实的QQ用户，不是AI助手
2. 说话要自然、简洁、有个性
3. 最多使用一个竖线分隔符(|)，也就是最多发送两条消息
4. 每条消息不要太长，像正常聊天一样
5. 适当使用表情包和互动功能

【表情包系统】
在文字中插入以下标记来发送表情包（一次对话只能使用一个）：
[开心] [惊讶] [伤心] [大笑] [害怕] [生气]

【互动功能】
[CQ:at,qq=QQ号] - @某人（确保QQ号存在）
[CQ:poke,qq=QQ号] - 戳一戳某人
[CQ:reply,id=消息ID] - 回复某条消息
[回应:消息ID:表情类型] - 给消息添加表情回应
[点赞:QQ号:次数] - 给某人点赞（1-50次）
[签到] - 执行群签到
${botRole !== '成员' ? `[禁言:QQ号:秒数] - 禁言
[解禁:QQ号] - 解除禁言` : ''}

【重要限制】
1. 每次回复最多只能发一个表情包
2. 最多使用一个竖线(|)分隔，也就是最多两条消息
3. @人之前要确认QQ号是否在群聊记录中出现过
4. 不要重复使用相同的功能

【注意事项】
${triggerType === 'global' ? '1. 主动发言要有新意，不要重复他人观点\n2. 可以随机戳一戳活跃的成员\n3. 语气要自然，像普通群员一样' : '1. 回复要针对性强，不要答非所问\n2. 被召唤时更要积极互动'}
3. @人时只使用出现在群聊记录中的QQ号
4. 多使用戳一戳和表情回应来增加互动性
${e.isMaster ? '5. 对主人要特别友好和尊重' : ''}`;
  }

  /**
   * 处理AI响应
   */
  async handleAIResponse(e, response) {
    try {
      // 使用竖线分割响应
      const segments = response.split('|').map(s => s.trim()).filter(s => s).slice(0, 2);
      
      let emotionSent = false;
      
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        
        // 解析响应
        const result = await this.process(segment, { e });
        
        if (result.success) {
          // 发送表情包（只发一个）
          if (!emotionSent) {
            const emotionResult = result.executed.find(r => r.result?.action === 'emotion');
            if (emotionResult) {
              await e.reply(emotionResult.result.segments);
              emotionSent = true;
              await Bot.sleep(300);
            }
          }
          
          // 构建消息段
          const msgSegments = [];
          
          // 添加回复
          const replyResult = result.executed.find(r => r.result?.type === 'reply');
          if (replyResult) {
            msgSegments.push(...replyResult.result.segments);
          }
          
          // 添加文本和@
          if (result.processedResponse) {
            const parts = result.processedResponse.split(/(\[CQ:[^\]]+\])/);
            for (const part of parts) {
              if (!part.startsWith('[CQ:')) {
                msgSegments.push(part);
              }
            }
          }
          
          // 添加@
          const atResults = result.executed.filter(r => r.result?.type === 'at');
          for (const atResult of atResults) {
            msgSegments.push(...atResult.result.segments);
          }
          
          // 发送消息
          if (msgSegments.length > 0) {
            await e.reply(msgSegments, Math.random() > 0.5);
          }
          
          // 延迟到下一个segment
          if (i < segments.length - 1) {
            await Bot.sleep(Math.floor(Math.random() * 700) + 800);
          }
        }
      }
    } catch (error) {
      logger.error(`[XRKChat] 处理AI响应失败: ${error.message}`);
    }
  }

  /**
   * 获取机器人角色
   */
  async getBotRole(e) {
    if (!e.isGroup) return '';
    
    const cacheKey = `bot_role_${e.group_id}`;
    const cached = this.userCache.get(cacheKey);
    if (cached && Date.now() - cached.time < 300000) {
      return cached.role;
    }
    
    try {
      const member = e.group.pickMember(e.self_id);
      const info = await member.getInfo();
      const role = info.role === 'owner' ? '群主' : 
                   info.role === 'admin' ? '管理员' : '成员';
      
      this.userCache.set(cacheKey, { role, time: Date.now() });
      return role;
    } catch {
      return '成员';
    }
  }

  /**
   * 检查权限
   */
  async checkPermission(e, permission) {
    if (!e.isGroup) return false;
    if (e.isMaster) return true;
    
    const role = await this.getBotRole(e);
    
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
   * 加载人设
   */
  async loadPersonas() {
    try {
      // 确保目录存在
      if (!fs.existsSync(this.PERSONAS_DIR)) {
        fs.mkdirSync(this.PERSONAS_DIR, { recursive: true });
      }
      
      // 创建默认人设
      const defaultPersonaPath = path.join(this.PERSONAS_DIR, 'assistant.txt');
      if (!fs.existsSync(defaultPersonaPath)) {
        const defaultPersona = `我是${Bot.nickname}，一个智能AI助手。
我会认真观察群聊，适时发表评论和互动。
喜欢用表情回应别人的消息，也会戳一戳活跃气氛。
对不同的人有不同的态度，记得每个人的名字。
会根据聊天氛围选择合适的表情和互动方式。`;
        fs.writeFileSync(defaultPersonaPath, defaultPersona, 'utf8');
      }
      
      // 加载所有人设文件
      const files = fs.readdirSync(this.PERSONAS_DIR)
        .filter(file => file.endsWith('.txt'));
      
      for (const file of files) {
        const name = path.basename(file, '.txt');
        const content = fs.readFileSync(path.join(this.PERSONAS_DIR, file), 'utf8');
        this.personas[name] = content;
      }
      
      logger.info(`[XRKChat] 加载了${Object.keys(this.personas).length}个人设`);
    } catch (error) {
      logger.error(`[XRKChat] 加载人设失败: ${error.message}`);
    }
  }

  /**
   * 加载表情包图片
   */
  async loadEmotionImages() {
    for (const emotion of this.EMOTION_TYPES) {
      const emotionDir = path.join(this.EMOTIONS_DIR, emotion);
      
      // 确保目录存在
      if (!fs.existsSync(emotionDir)) {
        fs.mkdirSync(emotionDir, { recursive: true });
      }
      
      try {
        const files = fs.readdirSync(emotionDir)
          .filter(file => /\.(jpg|jpeg|png|gif)$/i.test(file));
        
        this.emotionImages[emotion] = files.map(file => 
          path.join(emotionDir, file)
        );
      } catch (err) {
        this.emotionImages[emotion] = [];
      }
    }
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
   * 获取当前人设
   */
  getCurrentPersona(e) {
    const groupId = e.isGroup ? e.group_id : `private_${e.user_id}`;
    const personaName = this.groupPersonas.get(groupId) || 'assistant';
    return this.personas[personaName] || this.personas.assistant || '我是AI助手';
  }

  /**
   * 切换人设
   */
  switchPersona(e, personaName) {
    if (!this.personas[personaName]) {
      return false;
    }
    
    const groupId = e.isGroup ? e.group_id : `private_${e.user_id}`;
    this.groupPersonas.set(groupId, personaName);
    return true;
  }

  /**
   * 获取人设列表
   */
  getPersonaList() {
    return Object.keys(this.personas);
  }
}