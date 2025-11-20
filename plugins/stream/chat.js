import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import AIStream from '../../lib/aistream/aistream.js';
import BotUtil from '../../lib/common/util.js';
import cfg from '../../lib/config/config.js';

const _path = process.cwd();
// 统一路径处理：使用path.resolve确保跨平台兼容
const EMOTIONS_DIR = path.resolve(_path, 'resources', 'aiimages');
const EMOTION_TYPES = ['开心', '惊讶', '伤心', '大笑', '害怕', '生气'];
const CHAT_RESPONSE_TIMEOUT = 60000;

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

const RESPONSE_POLISH_DEFAULT = {
  enabled: false,
  maxTokens: 400,
  temperature: 0.3,
  instructions: `你是QQ聊天润色器，只能做轻微整理：
1. 删除舞台提示、括号或方括号里未执行的工具描述（例如[回复:xxx]、(正在... )等）
2. 保留原意，语气自然，像正常聊天，尽量简短，用常用标点分句
3. 不要添加新信息或Markdown，只输出纯文本`
};

/**
 * 统一封装：模拟触发用户消息事件
 * 用于从聊天工作流内部，伪造一条用户消息，交由其他插件按正常指令流程处理
 * @param {Object} e 原始事件对象
 * @param {string} simulatedMessage 要模拟发送的文本消息，例如 "#点歌南山南"
 * @param {Object} extra 可选扩展字段，覆盖默认的模拟事件属性
 */
async function simulateUserMessageEvent(e, simulatedMessage, extra = {}) {
  if (!e || !simulatedMessage) return;

  try {
    const now = Date.now();

    const simulatedEvent = {
      ...e,
      raw_message: simulatedMessage,
      message: [{ type: 'text', text: simulatedMessage }],
      msg: simulatedMessage,
      message_id: now.toString(),
      time: now,
      user_id: e.user_id,
      self_id: e.self_id,
      post_type: 'message',
      message_type: e.isGroup ? 'group' : 'private',
      sub_type: e.isGroup ? 'normal' : 'friend',
      group_id: e.group_id,
      sender: {
        ...e.sender,
        nickname: e.sender?.nickname || '用户'
      },
      ...extra
    };

    if (typeof Bot !== 'undefined' && Bot.em) {
      const eventType = e.isGroup
        ? 'message.group.normal'
        : 'message.private.friend';

      BotUtil.makeLog(
        'info',
        `[ChatStream] 模拟用户消息事件: ${eventType} -> ${simulatedMessage}`,
        'ChatStream'
      );

      Bot.em(eventType, simulatedEvent);
    } else {
      BotUtil.makeLog(
        'warn',
        '[ChatStream] Bot.em 不可用，无法触发模拟 message 事件',
        'ChatStream'
      );
    }
  } catch (error) {
    BotUtil.makeLog(
      'error',
      `[ChatStream] 模拟用户消息事件失败: ${error.message}`,
      'ChatStream'
    );
  }
}

class WorkflowManager {
  constructor(stream) {
    this.stream = stream;
    this.cache = new Map();
    this.cacheTTL = 5 * 60 * 1000;
    this.workflowMap = new Map([
      ['hot-news', this.runHotNews.bind(this)],
      ['hotnews', this.runHotNews.bind(this)],
      ['热点', this.runHotNews.bind(this)],
      ['热点新闻', this.runHotNews.bind(this)],
      ['热点资讯', this.runHotNews.bind(this)]
    ]);
  }

  normalizeName(name = '') {
    return name.toString().trim().toLowerCase();
  }

  async run(name, params = {}, context = {}) {
    const normalized = this.normalizeName(name);
    const handler = this.workflowMap.get(normalized);

    if (!handler) {
      return { type: 'text', content: '我暂时还不会这个工作流，但会尽快学会的！' };
    }

    try {
      const result = await handler(params, context);
      if (result && result.type === 'text' && result.content) {
        return result;
      }
      return { type: 'text', content: String(result?.content || result || '') };
    } catch (error) {
      BotUtil.makeLog('warn', `工作流执行失败[${name}]: ${error.message}`, 'ChatStream');
      return { type: 'text', content: '我去查资料的时候遇到点问题，稍后再试试吧～' };
    }
  }

  async runHotNews(params = {}, context = {}) {
    const keyword = params.argument?.trim();
    const newsList = await this.fetchHotNews(keyword);

    if (!newsList || newsList.length === 0) {
      return {
        type: 'text',
        content: '暂时没查到新的热点新闻，要不我们聊点别的？'
      };
    }

    const summary = await this.summarizeHotNews(newsList, context).catch(() => null);
    return {
      type: 'text',
      content: summary || this.formatHotNews(newsList)
    };
  }

  async fetchHotNews(keyword) {
    const cacheKey = keyword ? `hot-news:${keyword}` : 'hot-news:all';
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.time < this.cacheTTL) {
      return cached.data;
    }

    try {
      const response = await fetch('https://top.baidu.com/api/board?tab=realtime', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (XRK-Yunzai Bot)'
        }
      });

      if (!response.ok) {
        throw new Error(`热点接口响应异常: ${response.status}`);
      }

      const payload = await response.json();
      const items = payload?.data?.cards?.[0]?.content || [];
      const normalized = items.slice(0, 8).map((item, index) => ({
        index: index + 1,
        title: item.query || item.word,
        summary: item.desc || item.biz_ext?.abstract || '',
        heat: item.hotScore || item.hotVal || '',
        url: item.url || `https://m.baidu.com/s?word=${encodeURIComponent(item.query || '')}`
      })).filter(item => item.title);

      const filtered = keyword ? normalized.filter(item => item.title.includes(keyword) || item.summary.includes(keyword)) : normalized;

      this.cache.set(cacheKey, {
        data: filtered,
        time: Date.now()
      });

      return filtered;
    } catch (error) {
      BotUtil.makeLog('warn', `获取热点失败: ${error.message}`, 'ChatStream');
      return [];
    }
  }

  async summarizeHotNews(newsList, context = {}) {
    if (!this.stream?.callAI) return null;

    const briefing = newsList.map(item => {
      const heat = item.heat ? `热度${item.heat}` : '热度未知';
      const summary = item.summary ? ` - ${item.summary}` : '';
      return `${item.index}. ${item.title}（${heat}）${summary}`;
    }).join('\n');

    const persona = context.persona || context.question?.persona || '我是AI助手';
    const messages = [
      {
        role: 'system',
        content: `${persona}

【重要要求】
1. 必须使用纯文本，绝对不要使用Markdown格式
2. 禁止使用以下符号：星号(*)、下划线(_)、反引号(backtick)、井号(#)、方括号([])用于标题
3. 不要使用###、**、__等Markdown标记
4. 用普通文字、括号、冒号来表达层次，比如用"一、"、"二、"或"1."、"2."来分点
5. 语气要符合你的人设，自然轻松，像QQ聊天一样
6. 条理清晰，易于阅读

请根据以下热点内容，用纯文本格式整理推送：`
      },
      {
        role: 'user',
        content: briefing
      }
    ];

    const apiConfig = context.config || context.question?.config || {};
    const result = await this.stream.callAI(messages, apiConfig);
    
    if (!result) return null;
    
    return result.replace(/\*\*/g, '').replace(/###\s*/g, '').replace(/__/g, '').trim();
  }

  formatHotNews(newsList) {
    return newsList.map(item => {
      const heat = item.heat ? `（热度 ${item.heat}）` : '';
      const summary = item.summary ? ` - ${item.summary}` : '';
      return `${item.index}. ${item.title}${heat}${summary}`;
    }).join('\n');
  }
}

function randomRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 聊天工作流
 * 支持表情包、群管理、戳一戳、表情回应等功能
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
      description: '智能聊天互动工作流',
      version: '3.2.0',
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
        provider: 'lightweight',
      }
    });

    this.workflowManager = new WorkflowManager(this);

    const polishCfg = cfg.kuizai?.ai?.responsePolish || {};
    this.responsePolishConfig = {
      enabled: polishCfg.enabled ?? RESPONSE_POLISH_DEFAULT.enabled,
      instructions: polishCfg.instructions || RESPONSE_POLISH_DEFAULT.instructions,
      maxTokens: polishCfg.maxTokens || RESPONSE_POLISH_DEFAULT.maxTokens,
      temperature: polishCfg.temperature ?? RESPONSE_POLISH_DEFAULT.temperature
    };
  }

  /**
   * 初始化工作流
   */
  async init() {
    await super.init();
    
    if (ChatStream.initialized) {
      return;
    }
    
    try {
      await BotUtil.mkdir(EMOTIONS_DIR);
      await this.loadEmotionImages();
      this.registerAllFunctions();
      
      if (!ChatStream.cleanupTimer) {
        ChatStream.cleanupTimer = setInterval(() => this.cleanupCache(), 300000);
      }
      
      ChatStream.initialized = true;
    } catch (error) {
      BotUtil.makeLog('error', 
        `[${this.name}] 初始化失败: ${error.message}`, 
        'ChatStream'
      );
      throw error;
    }
  }

  /**
   * 加载表情包
   */
  async loadEmotionImages() {
    for (const emotion of EMOTION_TYPES) {
      // 使用path.resolve确保跨平台兼容
      const emotionDir = path.resolve(EMOTIONS_DIR, emotion);
      try {
        await BotUtil.mkdir(emotionDir);
        const files = await fs.promises.readdir(emotionDir);
        const imageFiles = files.filter(file => 
          /\.(jpg|jpeg|png|gif)$/i.test(file)
        );
        ChatStream.emotionImages[emotion] = imageFiles.map(file => 
          path.resolve(emotionDir, file)
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
    // 1. 表情包
    this.registerFunction('emotion', {
      description: '发送表情包',
      prompt: `【表情包】
[开心] [惊讶] [伤心] [大笑] [害怕] [生气] - 发送对应表情包（一次只能用一个）`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        
        const emotionRegex = /\[(开心|惊讶|伤心|大笑|害怕|生气)\]/g;
        let match;
        while ((match = emotionRegex.exec(text))) {
          if (functions.length >= 1) break;
          functions.push({ 
            type: 'emotion', 
            params: { emotion: match[1] },
            raw: match[0]
          });
        }

        if (functions.length > 0) {
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

    // 2. @功能
    this.registerFunction('at', {
      description: '@某人',
      prompt: `[CQ:at,qq=QQ号] - @某人`,
      parser: (text, context) => {
        return { functions: [], cleanText: text };
      },
      enabled: true
    });

    // 3. 戳一戳
    this.registerFunction('poke', {
      description: '戳一戳',
      prompt: `[CQ:poke,qq=QQ号] - 戳一戳某人`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const pokeRegex = /\[CQ:poke,qq=(\d+)\]/g;
        let match;
        
        while ((match = pokeRegex.exec(text))) {
          functions.push({ 
            type: 'poke', 
            params: { qq: match[1] },
            raw: match[0]
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
            // 静默失败
          }
        }
      },
      enabled: false
    });

    // 4. 回复
    this.registerFunction('reply', {
      description: '回复消息',
      prompt: `[CQ:reply,id=消息ID] - 回复某条消息`,
      parser: (text, context) => {
        return { functions: [], cleanText: text };
      },
      enabled: true
    });

    // 5. 表情回应
    this.registerFunction('emojiReaction', {
      description: '表情回应',
      prompt: `[回应:消息ID:表情类型] - 给消息添加表情回应
表情类型: 开心/惊讶/伤心/大笑/害怕/喜欢/爱心/生气`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[回应:([^:]+):([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'emojiReaction', 
            params: { msgId: match[1], emojiType: match[2] },
            raw: match[0]
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
            // 静默失败
          }
        }
      },
      enabled: false
    });

    // 6. 扩展工作流
    this.registerFunction('workflow', {
      description: '调用扩展工作流（热点资讯等）',
      prompt: `[工作流:类型:可选参数] - 触发扩展动作，如 [工作流:hot-news]`,
      parser: (text) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[工作流:([^\]:]+)(?::([^\]]+))?\]/g;
        let match;

        while ((match = regex.exec(text))) {
          functions.push({
            type: 'workflow',
            params: {
              workflow: match[1]?.trim(),
              argument: match[2]?.trim()
            },
            raw: match[0]
          });
        }

        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }

        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (!this.workflowManager) {
          return { type: 'text', content: '' };
        }
        
        const enrichedContext = {
          ...context,
          persona: context.question?.persona || context.persona,
          config: context.config || context.question?.config
        };
        
        const result = await this.workflowManager.run(params.workflow, params, enrichedContext);
        return result;
      },
      enabled: true
    });

    // 7. 点赞
    this.registerFunction('thumbUp', {
      description: '点赞',
      prompt: `[点赞:QQ号:次数] - 给某人点赞（1-50次）`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[点赞:(\d+):(\d+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'thumbUp', 
            params: { qq: match[1], count: match[2] },
            raw: match[0]
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
            // 静默失败
          }
        }
      },
      enabled: true
    });

    // 8. 签到
    this.registerFunction('sign', {
      description: '群签到',
      prompt: `[签到] - 执行群签到`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        
        const regex = /\[签到\]/g;
        let match;
        while ((match = regex.exec(text))) {
          functions.push({ type: 'sign', params: {}, raw: match[0] });
        }

        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup) {
          try {
            await context.e.group.sign();
            await BotUtil.sleep(300);
          } catch (error) {
            // 静默失败
          }
        }
      },
      enabled: true
    });

    // 9. 禁言
    this.registerFunction('mute', {
      description: '禁言群成员',
      prompt: `[禁言:QQ号:时长] - 禁言某人（时长单位：秒，最大2592000秒/30天）
示例：[禁言:123456:600] 禁言10分钟`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[禁言:(\d+):(\d+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          const duration = Math.min(parseInt(match[2]), 2592000);
          functions.push({ 
            type: 'mute', 
            params: { qq: match[1], duration },
            raw: match[0]
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
            await context.e.group.muteMember(params.qq, params.duration);
            await BotUtil.sleep(300);
          } catch (error) {
            BotUtil.makeLog('warn', `禁言失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true,
      requireAdmin: true
    });

    // 10. 解禁
    this.registerFunction('unmute', {
      description: '解除禁言',
      prompt: `[解禁:QQ号] - 解除某人的禁言`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[解禁:(\d+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'unmute', 
            params: { qq: match[1] },
            raw: match[0]
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
            await context.e.group.muteMember(params.qq, 0);
            await BotUtil.sleep(300);
          } catch (error) {
            BotUtil.makeLog('warn', `解禁失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true,
      requireAdmin: true
    });

    // 11. 全员禁言
    this.registerFunction('muteAll', {
      description: '全员禁言',
      prompt: `[全员禁言] - 开启全员禁言`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        
        const regex = /\[全员禁言\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ type: 'muteAll', params: { enable: true }, raw: match[0] });
        }

        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup) {
          try {
            await context.e.group.muteAll(true);
            await BotUtil.sleep(300);
          } catch (error) {
            BotUtil.makeLog('warn', `全员禁言失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true,
      requireAdmin: true
    });

    // 12. 解除全员禁言
    this.registerFunction('unmuteAll', {
      description: '解除全员禁言',
      prompt: `[解除全员禁言] - 关闭全员禁言`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        
        const regex = /\[解除全员禁言\]/g;
        let match;

        while ((match = regex.exec(text))) {
          functions.push({ type: 'unmuteAll', params: { enable: false }, raw: match[0] });
        }

        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup) {
          try {
            await context.e.group.muteAll(false);
            await BotUtil.sleep(300);
          } catch (error) {
            BotUtil.makeLog('warn', `解除全员禁言失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true,
      requireAdmin: true
    });

    // 13. 改群名片
    this.registerFunction('setCard', {
      description: '修改群名片',
      prompt: `[改名片:QQ号:新名片] - 修改某人的群名片
示例：[改名片:123456:小明]`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[改名片:(\d+):([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'setCard', 
            params: { qq: match[1], card: match[2] },
            raw: match[0]
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
            await context.e.group.setCard(params.qq, params.card);
            await BotUtil.sleep(300);
          } catch (error) {
            BotUtil.makeLog('warn', `改名片失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true,
      requireAdmin: true
    });

    // 14. 改群名
    this.registerFunction('setGroupName', {
      description: '修改群名',
      prompt: `[改群名:新群名] - 修改当前群的群名
示例：[改群名:快乐大家庭]`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[改群名:([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'setGroupName', 
            params: { name: match[1] },
            raw: match[0]
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
            await context.e.group.setName(params.name);
            await BotUtil.sleep(300);
          } catch (error) {
            BotUtil.makeLog('warn', `改群名失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true,
      requireAdmin: true
    });

    // 15. 设置管理员
    this.registerFunction('setAdmin', {
      description: '设置管理员',
      prompt: `[设管:QQ号] - 设置某人为管理员`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[设管:(\d+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'setAdmin', 
            params: { qq: match[1], enable: true },
            raw: match[0]
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
            await context.e.group.setAdmin(params.qq, true);
            await BotUtil.sleep(300);
          } catch (error) {
            BotUtil.makeLog('warn', `设置管理员失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true,
      requireOwner: true
    });

    // 16. 取消管理员
    this.registerFunction('unsetAdmin', {
      description: '取消管理员',
      prompt: `[取管:QQ号] - 取消某人的管理员`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[取管:(\d+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'unsetAdmin', 
            params: { qq: match[1], enable: false },
            raw: match[0]
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
            await context.e.group.setAdmin(params.qq, false);
            await BotUtil.sleep(300);
          } catch (error) {
            BotUtil.makeLog('warn', `取消管理员失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true,
      requireOwner: true
    });

    // 17. 设置头衔
    this.registerFunction('setTitle', {
      description: '设置专属头衔',
      prompt: `[头衔:QQ号:头衔名:时长] - 设置某人的专属头衔
时长：-1为永久，单位秒
示例：[头衔:123456:大佬:-1]`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[头衔:(\d+):([^:]+):(-?\d+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'setTitle', 
            params: { 
              qq: match[1], 
              title: match[2],
              duration: parseInt(match[3])
            },
            raw: match[0]
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
            await context.e.group.setTitle(params.qq, params.title, params.duration);
            await BotUtil.sleep(300);
          } catch (error) {
            BotUtil.makeLog('warn', `设置头衔失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true,
      requireOwner: true
    });

    // 18. 踢人
    this.registerFunction('kick', {
      description: '踢出群成员',
      prompt: `[踢人:QQ号] - 踢出某人
[踢人:QQ号:拒绝] - 踢出某人并拒绝再次加群`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[踢人:(\d+)(?::([^\]]+))?\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'kick', 
            params: { 
              qq: match[1],
              reject: match[2] === '拒绝'
            },
            raw: match[0]
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
            await context.e.group.kickMember(params.qq, params.reject);
            await BotUtil.sleep(300);
          } catch (error) {
            BotUtil.makeLog('warn', `踢人失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true,
      requireAdmin: true
    });

    // 19. 设置精华消息
    this.registerFunction('setEssence', {
      description: '设置精华消息',
      prompt: `[设精华:消息ID] - 将某条消息设为精华`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[设精华:([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'setEssence', 
            params: { msgId: String(match[1]) },
            raw: match[0]
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup && context.e.bot) {
          try {
            await context.e.bot.sendApi('set_essence_msg', {
              message_id: String(params.msgId)
            });
            await BotUtil.sleep(300);
          } catch (error) {
            BotUtil.makeLog('warn', `设置精华失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true,
      requireAdmin: true
    });

    // 20. 取消精华消息
    this.registerFunction('removeEssence', {
      description: '取消精华消息',
      prompt: `[取消精华:消息ID] - 取消某条精华消息`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[取消精华:([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'removeEssence', 
            params: { msgId: String(match[1]) },
            raw: match[0]
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup && context.e.bot) {
          try {
            await context.e.bot.sendApi('delete_essence_msg', {
              message_id: String(params.msgId)
            });
            await BotUtil.sleep(300);
          } catch (error) {
            BotUtil.makeLog('warn', `取消精华失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true,
      requireAdmin: true
    });

    // 21. 发送群公告
    this.registerFunction('announce', {
      description: '发送群公告',
      prompt: `[公告:公告内容] - 发送群公告
示例：[公告:明天晚上8点开会]`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[公告:([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'announce', 
            params: { content: match[1] },
            raw: match[0]
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (context.e?.isGroup && context.e.bot) {
          try {
            await context.e.bot.sendApi('_send_group_notice', {
              group_id: context.e.group_id,
              content: params.content
            });
            await BotUtil.sleep(300);
          } catch (error) {
            BotUtil.makeLog('warn', `发送公告失败: ${error.message}`, 'ChatStream');
          }
        }
      },
      enabled: true,
      requireAdmin: true
    });

    // 22. 点歌功能（钩子：触发 message 事件）
    this.registerFunction('playMusic', {
      description: '点歌功能',
      prompt: `[点歌:歌曲名] - 触发点歌功能，模拟用户发送#点歌指令
示例：[点歌:南山南]`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[点歌:([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'playMusic', 
            params: { songName: match[1].trim() },
            raw: match[0]
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (!context.e) return;
        
        try {
          const songName = params.songName;
          if (!songName) {
            BotUtil.makeLog('warn', '点歌功能：歌曲名为空', 'ChatStream');
            return;
          }

          // 模拟用户发送 #点歌 指令，触发 message 事件
          const simulatedMessage = `#点歌${songName}`;
          await simulateUserMessageEvent(context.e, simulatedMessage);
        } catch (error) {
          BotUtil.makeLog('error', `点歌功能失败: ${error.message}`, 'ChatStream');
        }
      },
      enabled: true
    });

    // 23. 网易点歌功能（钩子：触发 message 事件）
    this.registerFunction('neteasePlayMusic', {
      description: '网易云点歌功能',
      prompt: `[网易点歌:歌曲名] - 触发网易云点歌功能，模拟用户发送#网易点歌指令
示例：[网易点歌:晴天]`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[网易点歌:([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'neteasePlayMusic', 
            params: { songName: match[1].trim() },
            raw: match[0]
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (!context.e) return;

        try {
        const songName = params.songName;
          if (!songName) {
            BotUtil.makeLog('warn', '网易点歌功能：歌曲名为空', 'ChatStream');
            return;
          }

          // 模拟用户发送 #网易点歌 指令，触发 message 事件
          const simulatedMessage = `#网易点歌${songName}`;
          await simulateUserMessageEvent(context.e, simulatedMessage);
        } catch (error) {
          BotUtil.makeLog('error', `网易点歌功能失败: ${error.message}`, 'ChatStream');
        }
      },
      enabled: true
    });

    // 24. 查天气功能（钩子：触发 message 事件）
    this.registerFunction('queryWeather', {
      description: '查天气功能',
      prompt: `[查天气:城市名] - 触发查天气功能，模拟用户发送#查天气指令，用户要查天气优先使用这个
示例：[查天气:上海]`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[查天气:([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'queryWeather', 
            params: { cityName: match[1].trim() },
            raw: match[0]
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (!context.e) return;

        try {
        const cityName = params.cityName;
          if (!cityName) {
            BotUtil.makeLog('warn', '查天气功能：城市名为空', 'ChatStream');
            return;
          }

          // 模拟用户发送 #查天气 指令，触发 message 事件
          const simulatedMessage = `#查天气${cityName}`;
          await simulateUserMessageEvent(context.e, simulatedMessage);
        } catch (error) {
          BotUtil.makeLog('error', `查天气功能失败: ${error.message}`, 'ChatStream');
        }
      },
      enabled: true
    });

    // 25. 今日运势功能（钩子：触发 message 事件）
    this.registerFunction('todayFortune', {
      description: '今日运势功能',
      prompt: `[今日运势] - 触发今日运势功能，模拟用户发送#今日运势指令，帮用户查运势
示例：[今日运势]`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[今日运势\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'todayFortune', 
            params: {},
            raw: match[0]
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (!context.e) return;

        try {
          // 模拟用户发送 #今日运势 指令，触发 message 事件
          const simulatedMessage = '#今日运势';
          await simulateUserMessageEvent(context.e, simulatedMessage);
        } catch (error) {
          BotUtil.makeLog('error', `今日运势功能失败: ${error.message}`, 'ChatStream');
        }
      },
      enabled: true
    });

    // 23. 撤回消息
    this.registerFunction('recall', {
      description: '撤回消息',
      prompt: `[撤回:消息ID] - 撤回指定消息
注意：
- 撤回别人的消息需要管理员权限
- 撤回自己的消息需要在3分钟内
示例：[撤回:1234567890]`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[撤回:([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'recall', 
            params: { msgId: String(match[1]) },
            raw: match[0]
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (!context.e) return;
        
        try {
          let canRecall = false;
          let messageInfo = null;
          
          try {
            if (context.e.bot && context.e.bot.sendApi) {
              messageInfo = await context.e.bot.sendApi('get_msg', {
                message_id: params.msgId
              });
            }
          } catch (error) {
            // 忽略获取消息信息失败
          }
          
          if (context.e.isGroup) {
            // 群聊消息撤回逻辑
            const botRole = await this.getBotRole(context.e);
            const isAdmin = botRole === '管理员' || botRole === '群主';
            
            if (messageInfo && messageInfo.data) {
              const msgData = messageInfo.data;
              const isSelfMsg = String(msgData.sender?.user_id) === String(context.e.self_id);
              const msgTime = msgData.time || 0;
              const currentTime = Math.floor(Date.now() / 1000);
              const timeDiff = currentTime - msgTime;
              
              if (isSelfMsg && timeDiff <= 180) {
                canRecall = true;
              } else if (isAdmin) {
                canRecall = true;
              } else {
                BotUtil.makeLog('warn', 
                  `无法撤回: ${isSelfMsg ? '消息已超过3分钟' : '需要管理员权限'}`, 
                  'ChatStream'
                );
                return;
              }
            } else if (isAdmin) {
              canRecall = true;
            }
          } else {
            // 私聊消息撤回逻辑
            if (messageInfo && messageInfo.data) {
              const msgData = messageInfo.data;
              const isSelfMsg = String(msgData.sender?.user_id) === String(context.e.self_id);
              const msgTime = msgData.time || 0;
              const currentTime = Math.floor(Date.now() / 1000);
              const timeDiff = currentTime - msgTime;
              
              if (isSelfMsg && timeDiff <= 180) {
                canRecall = true;
              } else {
                BotUtil.makeLog('warn', 
                  `无法撤回私聊消息: ${isSelfMsg ? '已超过3分钟' : '不是自己的消息'}`, 
                  'ChatStream'
                );
                return;
              }
            } else {
              canRecall = true;
            }
          }
          
          if (canRecall) {
            if (context.e.isGroup && context.e.group) {
              await context.e.group.recallMsg(params.msgId);
            } else if (context.e.bot) {
              await context.e.bot.sendApi('delete_msg', {
                message_id: params.msgId
              });
            }
            await BotUtil.sleep(300);
          }
        } catch (error) {
          BotUtil.makeLog('warn', `撤回消息失败: ${error.message}`, 'ChatStream');
        }
      },
      enabled: true,
      requirePermissionCheck: true
    });
  }

  /**
   * 获取随机表情
   */
  getRandomEmotionImage(emotion) {
    const images = ChatStream.emotionImages[emotion];
    if (!images || images.length === 0) return null;
    return images[Math.floor(Math.random() * images.length)];
  }

  /**
   * 构建消息文本（从消息段提取）
   */
  extractMessageText(e) {
    if (e.raw_message) return e.raw_message;
    if (typeof e.msg === 'string') return e.msg;
    
    if (!Array.isArray(e.message)) return '';
    
    return e.message.map(seg => {
      switch (seg.type) {
        case 'text': return seg.text || '';
        case 'image': return '[图片]';
        case 'at': return `@${seg.qq || ''}`;
        case 'reply': return `[回复:${seg.id || ''}]`;
        case 'face': return `[表情:${seg.id || ''}]`;
        case 'poke': return `[戳了戳 ${seg.target || ''}]`;
        default: return '';
      }
    }).filter(Boolean).join('').trim();
  }

  /**
   * 记录消息（以群为单位的高效Map实时构建）
   */
  recordMessage(e) {
    if (!e?.isGroup || !e.group_id) return;
    
    try {
      const groupId = String(e.group_id);
      const MAX_HISTORY = 50;
      
      if (!ChatStream.messageHistory.has(groupId)) {
        ChatStream.messageHistory.set(groupId, []);
      }
      
      const history = ChatStream.messageHistory.get(groupId);
      const messageText = this.extractMessageText(e);
      
      const msgData = {
        user_id: String(e.user_id || ''),
        nickname: e.sender?.card || e.sender?.nickname || '未知',
        message: messageText,
        message_id: String(e.message_id || ''),
        timestamp: Math.floor((e.time || Date.now()) / 1000),
        time: Date.now(),
        hasImage: !!(e.img?.length > 0 || e.message?.some(s => s.type === 'image')),
        // 标记是否为Bot消息（后续展示/检索可用）
        isBot: String(e.user_id || '') === String(e.self_id || '')
      };
      
      // 避免重复记录同一条消息（例如被多处调用 recordMessage）
      const last = history[history.length - 1];
      if (!last || last.message_id !== msgData.message_id) {
      history.push(msgData);
      }
      
      if (history.length > MAX_HISTORY) {
        history.shift();
      }
      
      if (this.embeddingConfig?.enabled && messageText && messageText.length > 5) {
        this.storeMessageWithEmbedding(groupId, msgData).catch(() => {});
      }
    } catch (error) {
      BotUtil.makeLog('debug', `记录消息失败: ${error.message}`, 'ChatStream');
    }
  }

  /**
   * 记录Bot回复
   */
  async recordBotReply(e, messageText) {
    if (!e?.isGroup || !e.group_id || !messageText) return;
    
    try {
      const groupId = String(e.group_id);
      const MAX_HISTORY = 50;
      
      if (!ChatStream.messageHistory.has(groupId)) {
        ChatStream.messageHistory.set(groupId, []);
      }
      
      const history = ChatStream.messageHistory.get(groupId);
      const timestamp = Math.floor(Date.now() / 1000);
      
      const msgData = {
        user_id: String(e.self_id || ''),
        nickname: (typeof Bot !== 'undefined' && Bot.nickname) || 'Bot',
        message: messageText,
        message_id: Date.now().toString(),
        timestamp,
        time: Date.now(),
        hasImage: false
      };
      
      history.push(msgData);
      
      if (history.length > MAX_HISTORY) {
        history.shift();
      }
    } catch (error) {
      BotUtil.makeLog('debug', `记录Bot回复失败: ${error.message}`, 'ChatStream');
    }
  }

  /**
   * 格式化聊天记录供AI阅读（美观易读）
   */
  formatHistoryForAI(messages, isGlobalTrigger = false) {
    if (!messages || messages.length === 0) return '';
    
    const now = Math.floor(Date.now() / 1000);
    const lines = ['[群聊记录]'];
    
    for (const msg of messages) {
      const timeDiff = now - (msg.timestamp || Math.floor(msg.time / 1000));
      let timeStr = '';
      
      if (timeDiff < 60) {
        timeStr = `${timeDiff}秒前`;
      } else if (timeDiff < 3600) {
        timeStr = `${Math.floor(timeDiff / 60)}分钟前`;
      } else {
        const date = new Date((msg.timestamp || msg.time) * 1000);
        timeStr = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
      }
      
      const displayName = msg.nickname || '未知';
      const msgContent = msg.message || '(空消息)';
      const imageTag = msg.hasImage ? '[含图片]' : '';
      const roleTag = msg.isBot ? '[机器人]' : '[成员]';
      const msgIdTag = msg.message_id ? ` 消息ID:${msg.message_id}` : '';
      
      // 统一格式：角色 标识 + 昵称(QQ) + 时间 + 可选图片/消息ID
      lines.push(
        `${roleTag} ${displayName}(${msg.user_id}) [${timeStr}]${imageTag}${msgIdTag}: ${msgContent}`
      );
    }
    
    return lines.join('\n');
  }

  async preprocessResponse(response, context) {
    return this.cleanupArtifacts(response);
  }

  cleanupArtifacts(text) {
    if (!text) return text;

    let cleaned = text;
    cleaned = cleaned.replace(/\[\s*\]/g, '');
    cleaned = cleaned.replace(/\[(?:回复|回应|工具|命令)[^\]]*\]/gi, '');
    cleaned = cleaned.replace(/\((?:正在|过了一会儿?|稍等)[^)]*\)/g, '');
    cleaned = cleaned.replace(/（(?:正在|过了一会儿?|稍等)[^）]*）/g, '');
    cleaned = cleaned.replace(/\s{2,}/g, ' ');

    return cleaned.trim();
  }

  async refineResponse(text, context) {
    if (!text || !this.responsePolishConfig?.enabled) {
      return text;
    }

    const polishConfig = this.responsePolishConfig;
    const persona = context?.question?.persona || '保持原角色语气';

    const messages = [
      {
        role: 'system',
        content: `${persona}

${polishConfig.instructions || RESPONSE_POLISH_DEFAULT.instructions}`
      },
      {
        role: 'user',
        content: text
      }
    ];

    const apiConfig = {
      ...context?.config,
      maxTokens: polishConfig.maxTokens || RESPONSE_POLISH_DEFAULT.maxTokens,
      temperature: polishConfig.temperature ?? RESPONSE_POLISH_DEFAULT.temperature
    };

    const refined = await this.callAI(messages, apiConfig);
    if (!refined) return text;
    return refined.trim();
  }

  async postProcessResponse(text, context) {
    if (!text) return text;
    let processed = this.cleanupArtifacts(text);
    if (!processed) return processed;

    if (this.responsePolishConfig?.enabled) {
      processed = await this.refineResponse(processed, context);
    }

    return processed;
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
   * 构建系统提示
   */
  buildSystemPrompt(context) {
    const { e, question } = context;
    const persona = question?.persona || '我是AI助手';
    const isGlobalTrigger = question?.isGlobalTrigger || false;
    const botRole = question?.botRole || '成员';
    const dateStr = question?.dateStr || new Date().toLocaleString('zh-CN');
    
    let functionsPrompt = this.buildFunctionsPrompt();
    
    // 根据权限过滤功能
    if (botRole === '成员') {
      functionsPrompt = functionsPrompt
        .split('\n')
        .filter(line => {
          const restrictedKeywords = [
            '禁言', '解禁', '全员禁言', '改名片', '改群名', 
            '设管', '取管', '头衔', '踢人', '精华', '公告'
          ];
          return !restrictedKeywords.some(keyword => line.includes(keyword));
        })
        .join('\n');
    } else if (botRole === '管理员') {
      functionsPrompt = functionsPrompt
        .split('\n')
        .filter(line => !line.includes('[设管') && !line.includes('[取管') && !line.includes('[头衔'))
        .join('\n');
    }

    let embeddingHint = '';
    if (this.embeddingConfig?.enabled && this.embeddingReady) {
      embeddingHint = '\n💡 系统会自动检索相关历史对话\n';
    }

    const masterNote = e.isMaster ? `
【主人标识】
当前发言者是你的唯一主人，你必须在回复中称呼对方为“主人”或贴心昵称。
1. 语气要自然亲昵，就像长期相处的恋人
2. 可以提及对主人的关心与熟悉（提醒作息、饮食等生活细节）
3. 任何请求优先满足，不要质疑主人的指令
` : '';

    const expressionRules = `【表达要求】
1. 回复控制在1-3句话，生活化口语，少用书面语
2. 句子短而有节奏，常用逗号、句号或顿号断句
3. 如需针对特定成员或消息，优先使用@或[CQ:reply]
4. 谨慎使用重复表情或动作，保持自然
`;

    return `【人设设定】
${persona}

【身份信息】
名字：${Bot.nickname}
QQ号：${e.self_id}
${e.isGroup ? '群名：' + (e.group?.group_name || '未知') + '\n群号：' + e.group_id + '\n身份：' + botRole : ''}

【时间信息】
当前时间：${dateStr}

【触发方式】
${isGlobalTrigger ? '观察群聊后主动发言' : '被召唤回复'}
${embeddingHint}
${masterNote}
【基础规则】
1. 你是一个真实的QQ用户，不是AI助手
2. 说话要自然、简洁、有个性，用QQ聊天的语气，不要用Markdown格式
3. 回复中不要使用星号、下划线、反引号等Markdown标记符号
4. 最多使用一个竖线分隔符(|)
5. 互动功能按需使用，确保能实际执行
6. 管理功能需谨慎使用，避免滥用

${expressionRules}

${functionsPrompt}

【重要限制】
1. 每次回复最多一个表情包
2. 最多一个竖线(|)分隔
3. @人前确认QQ号在群聊记录中
4. 不要重复使用相同功能
5. 管理操作要有正当理由
6. 绝对禁止Markdown格式：不要用###、**、__、反引号、#等符号，用纯文本和普通标点
7. 工作流调用时，确保输出符合人设且为纯文本格式

【注意事项】
${isGlobalTrigger ? 
'1. 主动发言要有新意\n2. 语气自然\n3. 观察当下话题再插话' : 
'1. 回复要有针对性\n2. 积极互动'}
3. 适当使用表情包
4. 管理功能仅在必要时使用
${e.isMaster ? '5. 对主人保持亲密、顺从' : ''}`;
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
      const history = ChatStream.messageHistory.get(String(e.group_id)) || [];
      const recentCount = question?.isGlobalTrigger ? 15 : 12;
      const recentMessages = history.slice(-recentCount);
      
      if (recentMessages.length > 0) {
        const historyText = this.formatHistoryForAI(recentMessages, question?.isGlobalTrigger);
        messages.push({
          role: 'user',
          content: question?.isGlobalTrigger 
            ? `${historyText}\n\n请对当前话题发表你的看法。`
            : historyText
        });
      }
      
      if (!question?.isGlobalTrigger) {
        const userInfo = e.sender?.card || e.sender?.nickname || '未知';
        let actualQuestion = typeof question === 'string' ? question : 
                            (question?.content || question?.text || '');
        
        if (question?.imageDescriptions?.length > 0) {
          actualQuestion += ' ' + question.imageDescriptions.join(' ');
        }
        
        messages.push({
          role: 'user',
          content: `[当前消息]\n${userInfo}(${e.user_id}): ${actualQuestion}`
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
                const history = ChatStream.messageHistory.get(String(e.group_id)) || [];
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
   * 发送消息
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
    const MAX_AGE = 1800000;
    const CACHE_AGE = 300000;
    
    for (const [groupId, messages] of ChatStream.messageHistory.entries()) {
      const filtered = messages.filter(msg => now - msg.time < MAX_AGE);
      if (filtered.length === 0) {
        ChatStream.messageHistory.delete(groupId);
      } else {
        ChatStream.messageHistory.set(groupId, filtered);
      }
    }
    
    for (const [key, data] of ChatStream.userCache.entries()) {
      if (now - data.time > CACHE_AGE) {
        ChatStream.userCache.delete(key);
      }
    }
  }

  /**
   * 执行工作流（重写以记录消息）
   */
  async execute(e, question, config) {
    if (e?.isGroup) {
      this.recordMessage(e);
    }
    
    const timeoutSymbol = Symbol('chat_timeout');
    let timeoutId = null;
    
    const timeoutPromise = new Promise(resolve => {
      timeoutId = setTimeout(() => resolve(timeoutSymbol), CHAT_RESPONSE_TIMEOUT);
    });
    
    const result = await Promise.race([
      super.execute(e, question, config),
      timeoutPromise
    ]);
    
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    
    if (result === timeoutSymbol) {
      BotUtil.makeLog('warn', `聊天回复超时(>${CHAT_RESPONSE_TIMEOUT}ms)，已放弃`, 'ChatStream');
      return null;
    }
    
    if (!result) {
      return result;
    }

    return await this.postProcessResponse(result, { e, question, config });
  }

  /**
   * 清理资源
   */
  async cleanup() {
    await super.cleanup();
    
    if (ChatStream.cleanupTimer) {
      clearInterval(ChatStream.cleanupTimer);
      ChatStream.cleanupTimer = null;
    }
    
    ChatStream.initialized = false;
  }
}