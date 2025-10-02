import path from 'path';
import fs from 'fs';
import BaseStream from '../../lib/aistream/base.js';
import BotUtil from '../../lib/common/util.js';

const PERSONAS_DIR = path.join(process.cwd(), 'plugins/XRK/config/ai-assistant/personas');
const EMOTIONS_DIR = path.join(process.cwd(), 'plugins/XRK/config/ai-assistant');

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

export default class ChatStream extends BaseStream {
  constructor() {
    super({
      name: 'chat',
      description: '智能聊天工作流，支持表情、互动、群管理等功能',
      version: '2.0.0',
      author: 'XRK'
    });
    
    this.emotionImages = {};
    this.personas = {};
    this.currentPersona = 'assistant';
  }

  init() {
    this.registerFeature('emotion', {
      name: '表情包',
      description: '发送表情包图片',
      enabled: true,
      prompt: `【表情包系统】
在文字中插入以下标记来发送表情包（一次对话只能使用一个表情包）：
[开心] [惊讶] [伤心] [大笑] [害怕] [生气]
重要：每次回复最多只能使用一个表情包标记！`,
      pattern: '\\[(开心|惊讶|伤心|大笑|害怕|生气)\\]',
      priority: 200
    });

    this.registerFeature('at', {
      name: '@提及',
      description: '@某人',
      enabled: true,
      prompt: '[CQ:at,qq=QQ号] - @某人（确保QQ号存在）',
      pattern: '\\[CQ:at,qq=(\\d+)\\]',
      priority: 150
    });

    this.registerFeature('poke', {
      name: '戳一戳',
      description: '戳一戳某人',
      enabled: true,
      prompt: '[CQ:poke,qq=QQ号] - 戳一戳某人',
      pattern: '\\[CQ:poke,qq=(\\d+)\\]',
      priority: 140
    });

    this.registerFeature('reply', {
      name: '消息回复',
      description: '回复某条消息',
      enabled: true,
      prompt: '[CQ:reply,id=消息ID] - 回复某条消息',
      pattern: '\\[CQ:reply,id=([^\\]]+)\\]',
      priority: 160
    });

    this.registerFeature('emojiReaction', {
      name: '表情回应',
      description: '给消息添加表情回应',
      enabled: true,
      prompt: '[回应:消息ID:表情类型] - 给消息添加表情回应',
      pattern: '\\[回应:([^:]+):([^\\]]+)\\]',
      priority: 130
    });

    this.registerFeature('thumbUp', {
      name: '点赞',
      description: '给某人点赞',
      enabled: true,
      prompt: '[点赞:QQ号:次数] - 给某人点赞（1-50次）',
      pattern: '\\[点赞:(\\d+):(\\d+)\\]',
      priority: 120
    });

    this.registerFeature('sign', {
      name: '签到',
      description: '群签到',
      enabled: true,
      prompt: '[签到] - 执行群签到',
      pattern: '\\[签到\\]',
      priority: 110
    });

    this.registerFeature('mute', {
      name: '禁言',
      description: '禁言群成员',
      enabled: true,
      prompt: '[禁言:QQ号:秒数] - 禁言',
      pattern: '\\[禁言:(\\d+):(\\d+)\\]',
      priority: 100
    });

    this.registerFeature('unmute', {
      name: '解禁',
      description: '解除禁言',
      enabled: true,
      prompt: '[解禁:QQ号] - 解除禁言',
      pattern: '\\[解禁:(\\d+)\\]',
      priority: 100
    });

    this.registerFeature('reminder', {
      name: '定时提醒',
      description: '设置定时提醒',
      enabled: true,
      prompt: '[提醒:年-月-日 时:分:内容] - 设置定时提醒',
      pattern: '\\[提醒:([^:]+):([^:]+):([^\\]]+)\\]',
      priority: 90
    });

    this.loadResources();
  }

  async loadResources() {
    await this.loadEmotionImages();
    await this.loadPersonas();
  }

  async loadEmotionImages() {
    const emotions = ['开心', '惊讶', '伤心', '大笑', '害怕', '生气'];
    
    for (const emotion of emotions) {
      const emotionDir = path.join(EMOTIONS_DIR, emotion);
      const files = await fs.promises.readdir(emotionDir);
      const imageFiles = files.filter(file => 
        /\.(jpg|jpeg|png|gif)$/i.test(file)
      );
      this.emotionImages[emotion] = imageFiles.map(file => 
        path.join(emotionDir, file)
      );
    }
  }

  async loadPersonas() {
    await BotUtil.mkdir(PERSONAS_DIR);
    
    const defaultPersonaPath = path.join(PERSONAS_DIR, 'assistant.txt');
    if (!fs.existsSync(defaultPersonaPath)) {
      await fs.promises.writeFile(defaultPersonaPath, `我是${Bot.nickname}，一个智能AI助手。
我会认真观察群聊，适时发表评论和互动。
喜欢用表情回应别人的消息，也会戳一戳活跃气氛。
对不同的人有不同的态度，记得每个人的名字。
会根据聊天氛围选择合适的表情和互动方式。`);
    }
    
    const files = await BotUtil.glob(path.join(PERSONAS_DIR, '*.txt'));
    for (const file of files) {
      const name = path.basename(file, '.txt');
      this.personas[name] = await fs.promises.readFile(file, 'utf8');
    }
  }

  async buildSystemPrompt(context, options = {}) {
    const e = context.e;
    const persona = this.personas[this.currentPersona] || this.personas.assistant || '我是AI助手';
    const isGlobalTrigger = context.isGlobalTrigger || false;
    const botRole = await this.getBotRole(e);
    
    const now = new Date();
    const dateStr = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 ${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
    
    const enabledFeatures = this.getEnabledFeatures();
    const featurePrompts = enabledFeatures
      .filter(f => f.prompt)
      .map(f => f.prompt)
      .join('\n');
    
    const adminFeatures = botRole !== '成员' ? `[禁言:QQ号:秒数] - 禁言
[解禁:QQ号] - 解除禁言
[精华:消息ID] - 设置精华消息
[公告:内容] - 发布群公告` : '';
    
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

${featurePrompts}

【互动功能】
${adminFeatures}

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
  }

  async getBotRole(e) {
    if (!e.isGroup) return '';
    
    const member = e.group.pickMember(e.self_id);
    const info = await member.getInfo();
    return info.role === 'owner' ? '群主' : 
           info.role === 'admin' ? '管理员' : '成员';
  }

  async buildMessages(context, options = {}) {
    const e = context.e;
    const systemPrompt = await this.buildSystemPrompt(context, options);
    const messages = [{ role: 'system', content: systemPrompt }];
    
    if (e.isGroup && context.history) {
      const historyText = context.history.map(msg => 
        `${msg.nickname}(${msg.user_id})[${msg.message_id}]: ${msg.message}`
      ).join('\n');
      
      messages.push({
        role: 'user',
        content: context.isGlobalTrigger ? 
          `[群聊记录]\n${historyText}\n\n请对当前话题发表你的看法，要自然且有自己的观点。` :
          `[群聊记录]\n${historyText}\n\n[当前消息]\n${context.question}`
      });
    } else {
      messages.push({
        role: 'user',
        content: context.question || ''
      });
    }
    
    return messages;
  }

  async parseResponse(response, context) {
    const results = {
      text: [],
      functions: [],
      segments: [],
      emotions: []
    };

    const segments = response.split('|').map(s => s.trim()).filter(s => s).slice(0, 2);
    results.segments = segments;
    
    let emotionFound = false;
    
    for (const segment of segments) {
      const functions = await this.extractFunctions(segment, context);
      
      let cleanText = segment;
      for (const func of functions) {
        if (func.name === 'emotion' && !emotionFound) {
          results.emotions.push(func.params[0]);
          emotionFound = true;
        }
        cleanText = cleanText.replace(func.raw, '');
      }
      
      results.functions.push(...functions.filter(f => f.name !== 'emotion'));
      
      if (cleanText.trim()) {
        results.text.push(cleanText.trim());
      }
    }
    
    return results;
  }

  async sendResponse(context, parsed) {
    const e = context.e;
    
    if (parsed.emotions.length > 0) {
      const emotionImage = this.getRandomEmotionImage(parsed.emotions[0]);
      if (emotionImage) {
        await e.reply(segment.image(emotionImage));
        await Bot.sleep(300);
      }
    }
    
    for (let i = 0; i < parsed.text.length; i++) {
      const msgSegments = await this.parseCQCodes(parsed.text[i], e);
      if (msgSegments.length > 0) {
        await e.reply(msgSegments, Math.random() > 0.5);
      }
      
      if (i < parsed.text.length - 1) {
        await Bot.sleep(Math.random() * 1000 + 500);
      }
    }
    
    for (const func of parsed.functions) {
      if (func.name !== 'emotion') {
        await this.executeFunction(func);
      }
    }
  }

  getRandomEmotionImage(emotion) {
    const images = this.emotionImages[emotion];
    if (!images || images.length === 0) return null;
    return images[Math.floor(Math.random() * images.length)];
  }

  async parseCQCodes(text, e) {
    const segments = [];
    const parts = text.split(/(\[CQ:[^\]]+\])/);
    
    for (const part of parts) {
      if (part.startsWith('[CQ:')) {
        const cqSegment = await this.parseSingleCQCode(part, e);
        if (cqSegment) {
          segments.push(cqSegment);
        }
      } else if (part) {
        segments.push(part);
      }
    }
    
    return segments;
  }

  async parseSingleCQCode(cqCode, e) {
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

  async handleemotion(params, context) {
    // 表情包已在sendResponse中处理
  }

  async handlepoke(params, context) {
    const [qq] = params;
    if (context.e.isGroup) {
      await context.e.group.pokeMember(qq);
    }
  }

  async handleemojiReaction(params, context) {
    const [msgId, emojiType] = params;
    if (msgId && EMOJI_REACTIONS[emojiType]) {
      const emojiIds = EMOJI_REACTIONS[emojiType];
      const emojiId = emojiIds[Math.floor(Math.random() * emojiIds.length)];
      await context.e.group.setEmojiLike(msgId, emojiId);
    }
  }

  async handlethumbUp(params, context) {
    const [qq, count] = params;
    if (context.e.isGroup) {
      const thumbCount = Math.min(parseInt(count) || 1, 50);
      await context.e.group.pickMember(qq).thumbUp(thumbCount);
    }
  }

  async handlesign(params, context) {
    if (context.e.isGroup) {
      await context.e.group.sign();
    }
  }

  async handlemute(params, context) {
    const [qq, seconds] = params;
    const botRole = await this.getBotRole(context.e);
    if ((botRole === '群主' || botRole === '管理员') && context.e.isGroup) {
      await context.e.group.muteMember(qq, parseInt(seconds));
    }
  }

  async handleunmute(params, context) {
    const [qq] = params;
    const botRole = await this.getBotRole(context.e);
    if ((botRole === '群主' || botRole === '管理员') && context.e.isGroup) {
      await context.e.group.muteMember(qq, 0);
    }
  }
}