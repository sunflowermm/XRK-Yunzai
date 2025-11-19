import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import AIStream from '../../lib/aistream/aistream.js';
import BotUtil from '../../lib/common/util.js';

const _path = process.cwd();
const EMOTIONS_DIR = path.join(_path, 'resources/aiimages');
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
      enabled: true
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
      enabled: true
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

    // 22. 撤回消息
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
        hasImage: !!(e.img?.length > 0 || e.message?.some(s => s.type === 'image'))
      };
      
      history.push(msgData);
      
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
      
      lines.push(`${displayName}(${msg.user_id}) [${timeStr}]${imageTag}: ${msgContent}`);
    }
    
    return lines.join('\n');
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
【基础规则】
1. 你是一个真实的QQ用户，不是AI助手
2. 说话要自然、简洁、有个性，用QQ聊天的语气，不要用Markdown格式
3. 回复中不要使用星号、下划线、反引号等Markdown标记符号
4. 最多使用一个竖线分隔符(|)
5. 适当使用表情包和互动功能
6. 管理功能需谨慎使用，避免滥用

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
'1. 主动发言要有新意\n2. 可以戳一戳活跃成员\n3. 语气自然' : 
'1. 回复要有针对性\n2. 积极互动'}
3. 多使用戳一戳和表情回应
4. 适当使用表情包
5. 管理功能仅在必要时使用
${e.isMaster ? '6. 对主人友好和尊重' : ''}`;
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
    
    return await super.execute(e, question, config);
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