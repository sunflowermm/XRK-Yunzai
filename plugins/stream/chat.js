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

function randomRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 聊天工作流（优化版）
 * 使用静态变量存储共享状态，避免重复初始化
 */
export default class ChatStream extends AIStream {
  static emotionImages = {};
  static messageHistory = new Map();
  static userCache = new Map();
  static cleanupTimer = null;
  static initialized = false;

  constructor() {
    super({
      name: 'chat',
      description: '智能聊天互动工作流（含语义检索）',
      version: '2.1.0',
      author: 'XRK',
      priority: 10,
      config: {
        enabled: true,
        temperature: 0.8,
        maxTokens: 6000,
        topP: 0.9,
        presencePenalty: 0.6,
        frequencyPenalty: 0.6
      },
      embedding: {
        enabled: true,
        provider: 'transformers',
      }
    });
  }

  /**
   * 初始化工作流（只执行一次）
   */
  async init() {
    // 调用父类init
    await super.init();
    
    // 避免重复初始化
    if (ChatStream.initialized) {
      return;
    }
    
    try {
      // 创建临时目录
      await BotUtil.mkdir(TEMP_IMAGE_DIR);
      
      // 加载表情包
      await this.loadEmotionImages();
      
      // 注册所有功能
      this.registerAllFunctions();
      
      // 启动定时清理（只启动一次）
      if (!ChatStream.cleanupTimer) {
        ChatStream.cleanupTimer = setInterval(() => this.cleanupCache(), 300000);
      }
      
      ChatStream.initialized = true;
      BotUtil.makeLog('success', `[${this.name}] 聊天工作流初始化完成`, 'ChatStream');
    } catch (error) {
      BotUtil.makeLog('error', `[${this.name}] 初始化失败: ${error.message}`, 'ChatStream');
      throw error;
    }
  }

  /**
   * 加载表情包图片
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
        ChatStream.emotionImages[emotion] = imageFiles.map(file => 
          path.join(emotionDir, file)
        );
      } catch {
        ChatStream.emotionImages[emotion] = [];
      }
    }
  }

  /**
   * 注册所有功能
   */
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
        
        const emotionRegex = /\[(开心|惊讶|伤心|大笑|害怕|生气)\]/;
        const match = emotionRegex.exec(text);
        if (match) {
          functions.push({ 
            type: 'emotion', 
            params: { emotion: match[1] }
          });
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
            // 静默处理
          }
        }
      },
      enabled: false
    });

    // 回复功能
    this.registerFunction('reply', {
      description: '回复消息',
      prompt: `[CQ:reply,id=消息ID] - 回复某条消息`,
      parser: (text, context) => {
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
  }

  /**
   * 获取随机表情图片
   */
  getRandomEmotionImage(emotion) {
    const images = ChatStream.emotionImages[emotion];
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
      if (!ChatStream.messageHistory.has(groupId)) {
        ChatStream.messageHistory.set(groupId, []);
      }
      
      const history = ChatStream.messageHistory.get(groupId);
      
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
      
      const msgData = {
        user_id: e.user_id,
        nickname: e.sender?.card || e.sender?.nickname || '未知',
        message: message,
        message_id: e.message_id,
        time: Date.now(),
        hasImage: e.img?.length > 0
      };
      
      history.push(msgData);
      
      if (history.length > 30) {
        history.shift();
      }
      
      if (this.embeddingConfig?.enabled && message && message.length > 5) {
        this.storeMessageWithEmbedding(groupId, msgData).catch(err => {
          BotUtil.makeLog('debug', 
            `存储Embedding失败: ${err.message}`,
            'ChatStream'
          );
        });
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
    const cached = ChatStream.userCache.get(cacheKey);
    
    if (cached && Date.now() - cached.time < 300000) {
      return cached.role;
    }
    
    try {
      const member = e.group.pickMember(e.self_id);
      const info = await member.getInfo();
      const role = info.role === 'owner' ? '群主' : 
                   info.role === 'admin' ? '管理员' : '成员';
      
      ChatStream.userCache.set(cacheKey, { role, time: Date.now() });
      return role;
    } catch {
      return '成员';
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
      tempFilePath = await this.downloadImage(imageUrl);
      const uploadedUrl = await this.uploadImageToAPI(tempFilePath, config);
      
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
      
      const streamPipeline = promisify(pipeline);
      await streamPipeline(response.body, fs.createWriteStream(filePath));
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
    
    if (botRole === '成员') {
      functionsPrompt = functionsPrompt
        .split('\n')
        .filter(line => !line.includes('[禁言') && !line.includes('[解禁') && 
                       !line.includes('[精华') && !line.includes('[公告'))
        .join('\n');
    }

    let embeddingHint = '';
    if (this.embeddingConfig?.enabled) {
      embeddingHint = '\n💡 系统会自动检索相关历史对话，帮助你更好地理解上下文。\n';
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
${embeddingHint}
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
    
    const now = new Date();
    const dateStr = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 ${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
    const botRole = await this.getBotRole(e);
    
    const enrichedQuestion = {
      ...question,
      botRole,
      dateStr
    };
    
    messages.push({
      role: 'system',
      content: this.buildSystemPrompt({ e, question: enrichedQuestion })
    });
    
    if (e.isGroup) {
      const history = ChatStream.messageHistory.get(e.group_id) || [];
      
      if (question?.isGlobalTrigger) {
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
        const recentMessages = history.slice(-10);
        if (recentMessages.length > 0) {
          messages.push({
            role: 'user',
            content: `[群聊记录]\n${recentMessages.map(msg => 
              `${msg.nickname}(${msg.user_id})[${msg.message_id}]: ${msg.message}`
            ).join('\n')}`
          });
        }
        
        const userInfo = e.sender?.card || e.sender?.nickname || '未知';
        let actualQuestion = typeof question === 'string' ? question : 
                            (question?.content || question?.text || '');
        
        if (question?.imageDescriptions?.length > 0) {
          actualQuestion += ' ' + question.imageDescriptions.join(' ');
        }
        
        messages.push({
          role: 'user',
          content: `[当前消息]\n${userInfo}(${e.user_id})[${e.message_id}]: ${actualQuestion}`
        });
      }
    } else {
      const userInfo = e.sender?.nickname || '未知';
      let actualQuestion = typeof question === 'string' ? question : 
                          (question?.content || question?.text || '');
      
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
                const history = ChatStream.messageHistory.get(e.group_id) || [];
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
            default:
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
   * 执行工作流
   */
  async execute(e, question, config) {
    try {
      return await super.execute(e, question, config);
    } catch (error) {
      BotUtil.makeLog('error', `ChatStream执行失败: ${error.message}`, 'ChatStream');
      throw error;
    }
  }

  /**
   * 处理完整的消息发送
   */
  async sendMessages(e, cleanText) {
    if (cleanText.includes('|')) {
      const messages = cleanText.split('|').map(m => m.trim()).filter(m => m);
      
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const segments = await this.parseCQCodes(msg, e);
        
        if (segments.length > 0) {
          await e.reply(segments);
          
          if (i < messages.length - 1) {
            await BotUtil.sleep(randomRange(800, 1500));
          }
        }
      }
    } else if (cleanText) {
      const segments = await this.parseCQCodes(cleanText, e);
      
      if (segments.length > 0) {
        await e.reply(segments);
      }
    }
  }

  /**
   * 清理缓存
   */
  cleanupCache() {
    const now = Date.now();
    
    for (const [groupId, messages] of ChatStream.messageHistory.entries()) {
      const filtered = messages.filter(msg => now - msg.time < 1800000);
      if (filtered.length === 0) {
        ChatStream.messageHistory.delete(groupId);
      } else {
        ChatStream.messageHistory.set(groupId, filtered);
      }
    }
    
    for (const [key, data] of ChatStream.userCache.entries()) {
      if (now - data.time > 300000) {
        ChatStream.userCache.delete(key);
      }
    }
  }

  /**
   * 清理资源
   */
  async cleanup() {
    await super.cleanup();
    
    // 清理定时器
    if (ChatStream.cleanupTimer) {
      clearInterval(ChatStream.cleanupTimer);
      ChatStream.cleanupTimer = null;
    }
    
    ChatStream.initialized = false;
  }
}