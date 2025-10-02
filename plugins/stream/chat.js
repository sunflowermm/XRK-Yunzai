import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { promisify } from 'util';
import { pipeline } from 'stream';
import AIStream from '../../lib/aistream/base.js';
import BotUtil from '../../lib/common/util.js';

const _path = process.cwd();
const EMOTIONS_DIR = path.join(_path, 'plugins/XRK/config/ai-assistant');
const TEMP_IMAGE_DIR = path.join(_path, 'data/temp/ai_images');
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

// 工具函数：生成随机范围数字
function randomRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 聊天工作流 - 提供完整的群聊互动功能
 */
export default class ChatStream extends AIStream {
  constructor() {
    super({
      name: 'chat',
      description: '智能聊天互动工作流',
      version: '2.0.1',
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
    await BotUtil.mkdir(TEMP_IMAGE_DIR);
    await this.loadEmotionImages();
    this.registerAllFunctions();
    
    // 定期清理缓存
    setInterval(() => this.cleanupCache(), 300000); // 5分钟
  }

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
  }

  registerAllFunctions() {
    // 表情包功能
    this.registerFunction('emotion', {
      description: '发送表情包',
      prompt: `【表情包系统】
在文字中插入以下标记来发送表情包（一次对话只能使用一个表情包）：
[开心] [惊讶] [伤心] [大笑] [害怕] [生气]
重要：每次回复最多只能使用一个表情包标记！`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        
        // 只匹配第一个表情包
        const emotionRegex = /\[(开心|惊讶|伤心|大笑|害怕|生气)\]/;
        const match = emotionRegex.exec(text);
        if (match) {
          functions.push({ 
            type: 'emotion', 
            params: { emotion: match[1] }
          });
          // 删除所有表情标记
          cleanText = text.replace(/\[(开心|惊讶|伤心|大笑|害怕|生气)\]/g, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        const image = this.getRandomEmotionImage(params.emotion);
        if (image && context.e) {
          await context.e.reply(segment.image(image));
          await BotUtil.sleep(300);
        }
      },
      enabled: true
    });

    // @功能
    this.registerFunction('at', {
      description: '@某人',
      prompt: `[CQ:at,qq=QQ号] - @某人（确保QQ号存在于群聊记录中）`,
      parser: (text, context) => {
        // @功能直接在文本中保留，不需要解析
        return { functions: [], cleanText: text };
      },
      enabled: true
    });

    // 戳一戳功能
    this.registerFunction('poke', {
      description: '戳一戳某人',
      prompt: `[CQ:poke,qq=QQ号] - 戳一戳某人`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const pokeRegex = /\[CQ:poke,qq=(\d+)\]/g;
        let match;
        
        while ((match = pokeRegex.exec(text))) {
          functions.push({ 
            type: 'poke', 
            params: { qq: match[1] }
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(pokeRegex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup) {
          try {
            await context.e.group.pokeMember(params.qq);
            await BotUtil.sleep(300);
          } catch (error) {
            // 静默处理错误
          }
        }
      },
      enabled: true
    });

    // 回复功能
    this.registerFunction('reply', {
      description: '回复消息',
      prompt: `[CQ:reply,id=消息ID] - 回复某条消息`,
      parser: (text, context) => {
        // 回复功能在文本中保留
        return { functions: [], cleanText: text };
      },
      enabled: true
    });

    // 表情回应功能
    this.registerFunction('emojiReaction', {
      description: '给消息添加表情回应',
      prompt: `[回应:消息ID:表情类型] - 给消息添加表情回应（表情类型：开心/惊讶/伤心/大笑/害怕/喜欢/爱心/生气）`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[回应:([^:]+):([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'emojiReaction', 
            params: { msgId: match[1], emojiType: match[2] }
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup && EMOJI_REACTIONS[params.emojiType]) {
          const emojiIds = EMOJI_REACTIONS[params.emojiType];
          const emojiId = emojiIds[Math.floor(Math.random() * emojiIds.length)];
          try {
            await context.e.group.setEmojiLike(params.msgId, emojiId);
            await BotUtil.sleep(200);
          } catch (error) {
            // 静默处理
          }
        }
      },
      enabled: true
    });

    // 点赞功能
    this.registerFunction('thumbUp', {
      description: '给某人点赞',
      prompt: `[点赞:QQ号:次数] - 给某人点赞（1-50次）`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[点赞:(\d+):(\d+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'thumbUp', 
            params: { qq: match[1], count: match[2] }
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup) {
          const thumbCount = Math.min(parseInt(params.count) || 1, 50);
          try {
            const member = context.e.group.pickMember(params.qq);
            await member.thumbUp(thumbCount);
            await BotUtil.sleep(300);
          } catch (error) {
            // 静默处理
          }
        }
      },
      enabled: true
    });

    // 签到功能
    this.registerFunction('sign', {
      description: '执行群签到',
      prompt: `[签到] - 执行群签到`,
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
            await BotUtil.sleep(300);
          } catch (error) {
            // 静默处理
          }
        }
      },
      enabled: true
    });

    // 禁言功能
    this.registerFunction('mute', {
      description: '禁言群成员',
      prompt: `[禁言:QQ号:秒数] - 禁言某人`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[禁言:(\d+):(\d+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'mute', 
            params: { qq: match[1], duration: match[2] }
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup) {
          try {
            const member = context.e.group.pickMember(params.qq);
            await member.mute(parseInt(params.duration));
            await BotUtil.sleep(300);
          } catch (error) {
            BotUtil.makeLog('debug', `禁言失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true,
      permission: 'admin'
    });

    // 解禁功能
    this.registerFunction('unmute', {
      description: '解除禁言',
      prompt: `[解禁:QQ号] - 解除禁言`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[解禁:(\d+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'unmute', 
            params: { qq: match[1] }
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup) {
          try {
            const member = context.e.group.pickMember(params.qq);
            await member.mute(0);
            await BotUtil.sleep(300);
          } catch (error) {
            BotUtil.makeLog('debug', `解禁失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true,
      permission: 'admin'
    });

    // 精华功能
    this.registerFunction('essence', {
      description: '设置精华消息',
      prompt: `[精华:消息ID] - 设置精华消息`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[精华:([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'essence', 
            params: { msgId: match[1] }
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup) {
          try {
            await context.e.group.setEssence(params.msgId);
            await BotUtil.sleep(300);
          } catch (error) {
            BotUtil.makeLog('debug', `设置精华失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true,
      permission: 'admin'
    });

    // 公告功能
    this.registerFunction('notice', {
      description: '发布群公告',
      prompt: `[公告:内容] - 发布群公告`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[公告:([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'notice', 
            params: { content: match[1] }
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup) {
          try {
            await context.e.group.sendNotice(params.content);
            await BotUtil.sleep(300);
          } catch (error) {
            BotUtil.makeLog('debug', `发布公告失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true,
      permission: 'admin'
    });

    // 提醒功能
    this.registerFunction('reminder', {
      description: '设置定时提醒',
      prompt: `[提醒:年-月-日 时:分:内容] - 设置定时提醒`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[提醒:([^:]+):([^:]+):([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'reminder', 
            params: { dateStr: match[1], timeStr: match[2], content: match[3] }
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        // 提醒功能需要在插件层面实现
        if (context.onReminder) {
          await context.onReminder(params, context);
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
      
      // 构建消息内容
      let message = e.raw_message || e.msg || '';
      if (e.message && Array.isArray(e.message)) {
        message = e.message.map(seg => {
          switch (seg.type) {
            case 'text': return seg.text;
            case 'image': return '[图片]';
            case 'at': return `[CQ:at,qq=${seg.qq}]`;
            case 'reply': return `[CQ:reply,id=${seg.id}]`;
            default: return '';
          }
        }).join('');
      }
      
      history.push({
        user_id: e.user_id,
        nickname: e.sender?.card || e.sender?.nickname || '未知',
        message: message,
        message_id: e.message_id,
        time: Date.now(),
        hasImage: e.img?.length > 0
      });
      
      // 保持历史记录在30条以内
      if (history.length > 30) {
        history.shift();
      }
    } catch (error) {
      // 静默处理错误
    }
  }

  /**
   * 获取Bot角色
   */
  async getBotRole(e) {
    if (!e.isGroup) return '成员';
    
    const cacheKey = `bot_role_${e.group_id}`;
    const cached = this.userCache.get(cacheKey);
    
    // 5分钟缓存
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
   * 检查权限 - 重写基类方法
   */
  async checkPermission(permission, context) {
    const { e } = context;
    if (!e?.isGroup) return false;
    if (e.isMaster) return true;

    const botRole = await this.getBotRole(e);
    
    switch (permission) {
      case 'admin':
      case 'mute':
        return botRole === '群主' || botRole === '管理员';
      case 'owner':
        return botRole === '群主';
      default:
        return true;
    }
  }

  /**
   * 处理图片识别
   */
  async processImage(imageUrl, config) {
    if (!imageUrl || !config?.visionModel) {
      return '无法识别';
    }
    
    let tempFilePath = null;
    try {
      // 下载图片
      tempFilePath = await this.downloadImage(imageUrl);
      
      // 上传到API
      const uploadedUrl = await this.uploadImageToAPI(tempFilePath, config);
      
      // 识图
      const messages = [
        {
          role: 'system',
          content: '请详细描述这张图片的内容，包括主要对象、场景、颜色、氛围等'
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: uploadedUrl }
            }
          ]
        }
      ];
      
      const result = await this.callAI(messages, {
        ...config,
        model: config.visionModel
      });
      
      return result || '识图失败';
      
    } catch (error) {
      BotUtil.makeLog('error', `图片处理失败: ${error.message}`, 'ChatStream');
      return '图片处理失败';
    } finally {
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch {}
      }
    }
  }

  /**
   * 下载图片
   */
  async downloadImage(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`下载失败: ${response.statusText}`);
      
      const filename = `temp_${Date.now()}_${Math.random().toString(36).substring(7)}.png`;
      const filePath = path.join(TEMP_IMAGE_DIR, filename);
      
      await promisify(pipeline)(response.body, fs.createWriteStream(filePath));
      return filePath;
    } catch (error) {
      throw new Error(`图片下载失败: ${error.message}`);
    }
  }

  /**
   * 上传图片到API
   */
  async uploadImageToAPI(filePath, config) {
    if (!config?.fileUploadUrl) {
      throw new Error('未配置文件上传URL');
    }
    
    try {
      const form = new FormData();
      const fileBuffer = await fs.promises.readFile(filePath);
      form.append('file', fileBuffer, {
        filename: path.basename(filePath),
        contentType: 'image/png'
      });
      
      const response = await fetch(config.fileUploadUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          ...form.getHeaders()
        },
        body: form
      });
      
      if (!response.ok) {
        throw new Error(`上传失败: ${response.statusText}`);
      }
      
      const result = await response.json();
      return result.data?.url || result.url;
    } catch (error) {
      throw new Error(`图片上传失败: ${error.message}`);
    }
  }

  /**
   * 构建系统提示
   */
  buildSystemPrompt(context) {
    const { e, question } = context;
    const persona = question?.persona || '我是AI助手';
    const isGlobalTrigger = question?.isGlobalTrigger || false;
    const botRole = question?.botRole || '成员';
    const dateStr = question?.dateStr || new Date().toLocaleString('zh-CN');
    
    let functionsPrompt = this.buildFunctionsPrompt();
    
    // 根据权限过滤功能提示
    if (botRole === '成员') {
      functionsPrompt = functionsPrompt
        .split('\n')
        .filter(line => !line.includes('[禁言') && !line.includes('[解禁') && 
                       !line.includes('[精华') && !line.includes('[公告'))
        .join('\n');
    }

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
2. 说话要自然、简洁、有个性，符合人设
3. 最多使用一个竖线分隔符(|)，也就是最多发送两条消息
4. 每条消息不要太长，像正常聊天一样
5. 适当使用表情包和互动功能增加趣味性

${functionsPrompt}

【重要限制】
1. 每次回复最多只能发一个表情包
2. 最多使用一个竖线(|)分隔，也就是最多两条消息
3. @人之前要确认QQ号是否在群聊记录中出现过
4. 不要重复使用相同的功能

【注意事项】
${isGlobalTrigger ? 
`1. 主动发言要有新意，不要重复他人观点
2. 可以随机戳一戳活跃的成员增加互动
3. 语气要自然，像普通群员一样参与讨论` : 
`1. 回复要针对性强，不要答非所问
2. 被召唤时更要积极互动，体现出活力`}
3. @人时只使用出现在群聊记录中的QQ号
4. 多使用戳一戳和表情回应来增加互动性
5. 适当使用表情包来表达情绪
${e.isMaster ? '6. 对主人要特别友好和尊重' : ''}`;
  }

  /**
   * 构建聊天上下文
   */
  async buildChatContext(e, question) {
    const messages = [];
    
    // 准备基础信息
    const now = new Date();
    const dateStr = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 ${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
    const botRole = await this.getBotRole(e);
    
    // 传递额外信息给系统提示
    const enrichedQuestion = {
      ...question,
      botRole,
      dateStr
    };
    
    // 构建系统提示
    messages.push({
      role: 'system',
      content: this.buildSystemPrompt({ e, question: enrichedQuestion })
    });
    
    // 添加群聊历史
    if (e.isGroup) {
      const history = this.messageHistory.get(e.group_id) || [];
      
      if (question?.isGlobalTrigger) {
        // 全局触发时提供更多历史
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
        const recentMessages = history.slice(-10);
        if (recentMessages.length > 0) {
          messages.push({
            role: 'user',
            content: `[群聊记录]\n${recentMessages.map(msg => 
              `${msg.nickname}(${msg.user_id})[${msg.message_id}]: ${msg.message}`
            ).join('\n')}`
          });
        }
        
        // 当前消息（包含图片识别结果）
        const userInfo = e.sender?.card || e.sender?.nickname || '未知';
        let actualQuestion = typeof question === 'string' ? question : 
                            (question?.content || question?.text || '');
        
        // 如果有图片，添加图片描述
        if (question?.imageDescriptions?.length > 0) {
          actualQuestion += ' ' + question.imageDescriptions.join(' ');
        }
        
        messages.push({
          role: 'user',
          content: `[当前消息]\n${userInfo}(${e.user_id})[${e.message_id}]: ${actualQuestion}`
        });
      }
    } else {
      // 私聊
      const userInfo = e.sender?.nickname || '未知';
      let actualQuestion = typeof question === 'string' ? question : 
                          (question?.content || question?.text || '');
      
      // 如果有图片，添加图片描述
      if (question?.imageDescriptions?.length > 0) {
        actualQuestion += ' ' + question.imageDescriptions.join(' ');
      }
      
      messages.push({
        role: 'user',
        content: `${userInfo}(${e.user_id}): ${actualQuestion}`
      });
    }
    
    return messages;
  }

  /**
   * 清理文本中的所有功能标记
   */
  cleanFunctionMarkers(text) {
    let cleanText = text;
    
    // 移除所有功能标记
    const markers = [
      /\[(开心|惊讶|伤心|大笑|害怕|生气)\]/g,  // 表情包
      /\[CQ:poke,qq=\d+\]/g,  // 戳一戳
      /\[回应:[^:]+:[^\]]+\]/g,  // 表情回应
      /\[点赞:\d+:\d+\]/g,  // 点赞
      /\[签到\]/g,  // 签到
      /\[禁言:\d+:\d+\]/g,  // 禁言
      /\[解禁:\d+\]/g,  // 解禁
      /\[精华:[^\]]+\]/g,  // 精华
      /\[公告:[^\]]+\]/g,  // 公告
      /\[提醒:[^:]+:[^:]+:[^\]]+\]/g  // 提醒
    ];
    
    markers.forEach(marker => {
      cleanText = cleanText.replace(marker, '');
    });
    
    return cleanText.trim();
  }

  /**
   * 解析CQ码
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
                // 验证QQ号是否在历史记录中
                const history = this.messageHistory.get(e.group_id) || [];
                const userExists = history.some(msg => 
                  String(msg.user_id) === String(paramObj.qq)
                );
                
                if (userExists || e.isMaster) {
                  segments.push(segment.at(paramObj.qq));
                }
              }
              break;
            case 'reply':
              if (paramObj.id) {
                segments.push(segment.reply(paramObj.id));
              }
              break;
            case 'image':
              if (paramObj.file) {
                segments.push(segment.image(paramObj.file));
              }
              break;
            case 'poke':
              // 戳一戳在handler中处理
              break;
            default:
              // 忽略未知CQ码
              break;
          }
        }
      } else if (part.trim()) {
        segments.push(part);
      }
    }
    
    return segments;
  }

  /**
   * 执行工作流 - 重写基类方法以添加功能标记清理
   */
  async execute(e, question, config) {
    try {
      // 构建上下文
      const context = { e, question, config };
      
      // 构建消息
      const messages = await this.buildChatContext(e, question);
      
      // 调用AI
      let response = await this.callAI(messages, config);
      
      if (!response) {
        return null;
      }
      
      // 解析并执行功能
      const { functions, cleanText } = await this.parseFunctions(response, context);
      
      // 清理所有功能标记
      let finalText = this.cleanFunctionMarkers(cleanText);
      
      // 执行功能
      for (const func of functions) {
        await this.executeFunction(func.type, func.params, context);
      }
      
      // 处理多条消息（用 | 分隔）
      if (finalText.includes('|')) {
        const messages = finalText.split('|').map(m => m.trim()).filter(m => m);
        
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          
          // 解析CQ码
          const segments = await this.parseCQCodes(msg, e);
          
          if (segments.length > 0) {
            await e.reply(segments);
            
            // 消息之间延迟
            if (i < messages.length - 1) {
              await BotUtil.sleep(randomRange(800, 1500));
            }
          }
        }
      } else if (finalText) {
        // 单条消息
        const segments = await this.parseCQCodes(finalText, e);
        
        if (segments.length > 0) {
          await e.reply(segments);
        }
      }
      
      return finalText;
      
    } catch (error) {
      BotUtil.makeLog('error', `ChatStream执行失败: ${error.message}`, 'ChatStream');
      throw error;
    }
  }

  /**
   * 清理缓存
   */
  cleanupCache() {
    const now = Date.now();
    
    // 清理消息历史
    for (const [groupId, messages] of this.messageHistory.entries()) {
      const filtered = messages.filter(msg => now - msg.time < 1800000); // 保留30分钟
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
  }
}