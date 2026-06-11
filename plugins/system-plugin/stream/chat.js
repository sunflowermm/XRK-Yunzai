import path from 'path';
import AIStream from '../../../lib/aistream/aistream.js';
import BotUtil from '../../../lib/util.js';
import { FileUtils } from '../../../lib/utils/file-utils.js';
import LLMFactory from '../../../lib/factory/llm/LLMFactory.js';
import { prepareOpenAIChatVisionMessages } from '../../../lib/utils/llm/image-utils.js';
import { resolveProjectPath, RESOURCES_AIIMAGES_DIR, DATA_DIR } from '../../../lib/config/config-constants.js';
const EMOTIONS_DIR = resolveProjectPath(RESOURCES_AIIMAGES_DIR);
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

/** 聊天工作流：群管/互动/表情/消息管理，MCP 工具 at、poke、emojiReaction、mute、setCard、recall 等 */
export default class ChatStream extends AIStream {
  static emotionImages = {};
  static messageHistory = new Map();
  static cleanupTimer = null;

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
        frequencyPenalty: 0.6,
        /** 多工具同轮时顺序执行，降低「reply 与远程 MCP 抢跑」导致的重复铺垫 */
        parallel_tool_calls: false,
        /** 未调 `*.reply` 时转发最后一轮正文；已调则不再 send（见 `unpackFactoryChatRaw` / `packNonStreamReturn`） */
        forwardAssistantText: true
      }
    });
  }

  /**
   * 初始化工作流
   */
  async init() {
    await super.init();
    
    try {
      await this.loadEmotionImages();
      this.registerAllFunctions();
      
      if (!ChatStream.cleanupTimer) {
        ChatStream.cleanupTimer = setInterval(() => this.cleanupCache(), 300000);
      }
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
        const files = FileUtils.existsSync(emotionDir) ? FileUtils.readDirSync(emotionDir) : [];
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

  _requireGroup(context) {
    if (!context.e?.isGroup) {
      return { success: false, error: '非群聊环境' };
    }
    return null;
  }

  async _wrapHandler(fn, delay = 300) {
    try {
      const result = await fn();
      if (delay > 0) await BotUtil.sleep(delay);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 查询类工具统一返回格式：明确「已获取」+「请根据 data 回复、无需再次调用」，避免 AI 循环调用
   * @param {string} description - 如「群扩展信息」「群成员列表」
   * @param {*} data - 查询结果，会序列化后附在 raw 中（过长会截断）
   */
  _queryToolRaw(description, data) {
    const MAX_DATA_LEN = 4000;
    const dataStr = data != null ? (typeof data === 'string' ? data : JSON.stringify(data)) : '{}';
    const truncated = dataStr.length > MAX_DATA_LEN ? dataStr.slice(0, MAX_DATA_LEN) + '\n...[已截断]' : dataStr;
    return `已获取${description}。根据 data 回复，勿再调用。\n\ndata:\n${truncated}`;
  }

  /** 带上下文的查询工具返回：群聊带群号，私聊带用户，再附 data */
  _queryToolRawDetail(description, data, e) {
    const MAX_DATA_LEN = 4000;
    const dataStr = data != null ? (typeof data === 'string' ? data : JSON.stringify(data)) : '{}';
    const truncated = dataStr.length > MAX_DATA_LEN ? dataStr.slice(0, MAX_DATA_LEN) + '\n...[已截断]' : dataStr;
    const head = e?.isGroup && e?.group_id
      ? `你已在群 ${e.group_id} 获取${description}。根据 data 回复，勿再调用。`
      : e?.user_id
        ? `你已获取与 ${e.user_id}(私聊) 相关的${description}。根据 data 回复，勿再调用。`
        : `你已获取${description}。根据 data 回复，勿再调用。`;
    return `${head}\n\ndata:\n${truncated}`;
  }

  registerAllFunctions() {
    this.registerMCPTool('at', {
      description: '群聊@成员，可选附带文字。用户可见。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: {
          qq: { type: 'number', description: '群成员QQ号（必填，数字）' },
          text: { type: 'string', description: '可选，与@同条发出' }
        },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;

        const qq = String(args.qq || '').trim();
        if (!qq) return { success: false, error: 'QQ号不能为空' };

        const text = String(args.text ?? '').trim();
        return this._wrapHandler(async () => {
          const seg = global.segment || segment;
          if (text) {
            await context.e.reply([seg.at(qq), ' ', text]);
          } else {
            await context.e.reply([seg.at(qq)]);
          }
          const sentContent = text ? `@${qq} ${text}` : `@${qq}`;
          this.recordAIResponse(context.e, sentContent);
          const gid = context.e?.group_id;
          const detail = gid ? `你已在群 ${gid} @了 ${qq}${text ? ' 并发送：' + text : ''}` : `你已@了 ${qq}${text ? ' 并发送：' + text : ''}`;
          return { success: true, raw: `${detail}。无话可说则空返回。` };
        }, 200);
      },
      enabled: true
    });

    this.registerMCPTool('poke', {
      description: '戳一戳对方。群聊戳成员，私聊戳好友。qq 不填则当前说话人。用户可见。',
      inputSchema: {
        type: 'object',
        properties: {
          qq: { type: 'number', description: '要戳的QQ号，5-10位数字' }
        },
        required: []
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        if (!e) return { success: false, error: '无会话上下文' };
        let targetQq = String(args.qq ?? e?.user_id ?? '').trim();
        if (!targetQq) return { success: false, error: '无法确定要戳的QQ号' };
        if (!/^\d{5,10}$/.test(targetQq)) return { success: false, error: 'qq 须为 5-10 位数字' };
        const qqNum = parseInt(targetQq, 10);
        if (qqNum > 0xFFFFFFFF || qqNum < 1) return { success: false, error: 'qq 超出有效范围' };
        targetQq = String(qqNum);
        return this._wrapHandler(async () => {
          if (e.isGroup && e.group?.pokeMember) {
            await e.group.pokeMember(targetQq);
          } else if (e.bot?.sendApi) {
            await e.bot.sendApi('send_poke', { user_id: qqNum });
          } else if (e.friend?.poke && String(e.user_id) === targetQq) {
            await e.friend.poke();
          } else {
            return { success: false, error: '当前环境不支持戳一戳' };
          }
          const where = e.isGroup && e.group_id ? `群 ${e.group_id}` : '私聊';
          return { success: true, raw: `你已对 ${targetQq} 戳一戳（当前会话：${where}）。无话可说则空返回。` };
        });
      },
      enabled: true
    });

    this.registerMCPTool('reply', {
      description: '发送消息到当前会话，用户可见。content 用纯文本 + 文本协议（| 分句、[开心]、[CQ:at]、[回复:id]、[图片内容:]）；勿 Markdown；若全是 Markdown 壳则无法发出。',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'number', description: '可选，引用该消息ID（数字）' },
          content: { type: 'string', description: '必填。支持|分句、[开心]等、[CQ:at,qq=]、[回复:id]' }
        },
        required: ['content']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        if (!e?.reply) return { success: false, error: '当前环境无法发送消息' };
        const content = String(args.content ?? '').trim();
        if (!content) return { success: false, error: 'content 不能为空' };
        return this._wrapHandler(async () => {
          const filteredContent = this.stripMarkdownForOutgoing(content);
          if (!filteredContent) {
            return {
              success: false,
              error: '清理 Markdown 后无可发送正文（请勿用标题/代码块/表格等作为主要回复），请用纯文本并遵守文本协议再调用 reply'
            };
          }
          const { totalSent, allSentContent } = await this._processAndSendTextProtocol(e, filteredContent, {
            messageId: args.messageId,
            recordToHistory: true,
            updateReplyContents: true
          });
          const lines = allSentContent.map((c, i) => `${i + 1}. ${c}`).join('\n');
          const where = e.group_id ? `群 ${e.group_id}` : `用户 ${e.user_id}(私聊)`;
          const detail = `你已在${where}发送以下内容（共${totalSent}条）：\n${lines}`;
          return { success: true, raw: `${detail}。无话可说则空返回。` };
        });
      },
      enabled: true
    });

    this.registerMCPTool('emojiReaction', {
      description: '对群消息表情回应。emojiType：开心、惊讶、伤心、大笑、害怕、喜欢、爱心、生气。msgId 不填则最近一条他人消息。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: {
          msgId: { type: 'number', description: '可选，不填则最近一条' },
          emojiType: { type: 'string', description: '必填', enum: ['开心', '惊讶', '伤心', '大笑', '害怕', '喜欢', '爱心', '生气'] }
        },
        required: ['emojiType']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        BotUtil.makeLog(
          'debug',
          `[chat.emojiReaction] 调用上下文: hasE=${Boolean(e)}, isGroup=${e?.isGroup}, message_type=${e?.message_type}, group_id=${e?.group_id}, user_id=${e?.user_id}`,
          'ChatStream'
        );
        if (!e?.isGroup) {
          return { success: false, error: '非群聊环境' };
        }

        // 兼容英文枚举到内部中文映射
        const typeMap = {
          like: '喜欢',
          love: '爱心',
          laugh: '大笑',
          wow: '惊讶',
          sad: '伤心',
          angry: '生气'
        };
        let emojiType = args.emojiType;
        if (emojiType && typeMap[emojiType]) {
          emojiType = typeMap[emojiType];
        }

        if (!EMOJI_REACTIONS[emojiType]) {
          return { success: false, error: '无效表情类型' };
        }

        const emojiIds = EMOJI_REACTIONS[emojiType];
        if (!emojiIds || emojiIds.length === 0) {
          return { success: false, error: '表情类型无可用表情ID' };
        }

        // 如果没有传 msgId，则尝试使用最近一条他人消息的 ID
        let msgId = String(args.msgId ?? '').trim();
        if (!msgId && e.group_id) {
          const history = ChatStream.messageHistory.get(e.group_id) || [];
          const lastOtherMsg = [...history].reverse().find(
            m => String(m.user_id) !== String(e.self_id) && m.message_id
          );
          if (lastOtherMsg) {
            msgId = String(lastOtherMsg.message_id);
          }
        }

        if (!msgId) {
          return { success: false, error: '找不到可回应的消息ID' };
        }

        const emojiId = Number(emojiIds[Math.floor(Math.random() * emojiIds.length)]);

        try {
          const group = e.group;
          if (group && typeof group.setEmojiLike === 'function') {
            const result = await group.setEmojiLike(msgId, emojiId, true);
            if (result !== undefined) {
              await BotUtil.sleep(200);
              const gid = e.group_id;
              return { success: true, raw: `你已在群 ${gid} 对消息 ${msgId} 发送了 ${emojiType} 表情回应。无话可说则空返回。` };
            }
          }
          return { success: false, error: '表情回应功能不可用' };
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('emotion', {
      description: '发表情包，可选文字同条发出。emotionType：开心、惊讶、伤心、大笑、害怕、生气。用户可见。一轮最多一次。',
      inputSchema: {
        type: 'object',
        properties: {
          emotionType: { type: 'string', description: '必填', enum: ['开心', '惊讶', '伤心', '大笑', '害怕', '生气'] },
          text: { type: 'string', description: '可选' }
        },
        required: ['emotionType']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        if (!e?.reply) return { success: false, error: '当前环境无法发送' };
        const t = String(args.emotionType || '').trim();
        if (!EMOTION_TYPES.includes(t)) return { success: false, error: '无效表情类型' };
        
        // ⚠️ 重要：检查是否已发送过表情包
        if (this._hasSentEmotionThisTurn) {
          BotUtil.makeLog('debug', `[ChatStream] emotion 工具调用被跳过（本轮已发送过表情包） emotionType=${t}`, 'ChatStream');
          // 这里不要返回 error：LLM 很容易把 error 当成“需要重试”，导致刷屏式重复 tool_calls
          // 改为“成功但跳过”，并明确告知不要再调用
          return { success: true, raw: '本轮已发过表情包，未重复发送。无话可说则空返回。' };
        }
        const image = this.getRandomEmotionImage(t);
        if (!image) return { success: false, error: '该表情暂无可用图片' };
        const text = String(args.text ?? '').trim();
        return this._wrapHandler(async () => {
          const seg = global.segment || segment;
          if (text) {
            await e.reply([seg.image(image), text]);
          } else {
            await e.reply(seg.image(image));
          }
          // 标记已发送表情包
          this._hasSentEmotionThisTurn = true;
          // 记录到历史
          const sentText = text || '';
          this.recordAIResponse(e, sentText || '');
          const where = e.group_id ? `群 ${e.group_id}` : `用户 ${e.user_id}(私聊)`;
          const part = sentText ? `表情包(${t})及文字：${sentText}` : `表情包(${t})`;
          return { success: true, raw: `你已在${where}发送${part}。无话可说则空返回。` };
        });
      },
      enabled: true
    });

    this.registerMCPTool('thumbUp', {
      description: '给群成员点赞。qq 必填，count 1-50。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: {
          qq: { type: 'number', description: '成员QQ号（数字）' },
          count: { type: 'number', description: '1-50', default: 1 }
        },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        const thumbCount = Math.min(parseInt(args.count) || 1, 50);
          const member = context.e.group?.pickMember(args.qq);
        if (!member || typeof member.thumbUp !== 'function') {
          return { success: false, error: '点赞功能不可用' };
        }

        return this._wrapHandler(async () => {
          await member.thumbUp(thumbCount);
          const gid = context.e.group_id;
          return { success: true, raw: `你已成功在群 ${gid} 给 ${args.qq} 点赞 ${thumbCount} 下。无话可说则空返回。` };
        });
      },
      enabled: true
    });

    this.registerMCPTool('sign', {
      description: '群签到。仅群聊。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.sign();
          const gid = context.e.group_id;
          return { success: true, raw: `你已在群 ${gid} 签到成功。无话可说则空返回。` };
        });
      },
      enabled: true
    });

    this.registerMCPTool('mute', {
      description: '禁言群成员。qq、duration(秒)必填。需管理/群主。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { qq: { type: 'number' }, duration: { type: 'number' } },
        required: ['qq', 'duration']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.muteMember(args.qq, args.duration);
          const gid = context.e.group_id;
          return { success: true, raw: `你已成功在群 ${gid} 禁言 ${args.qq} ${args.duration} 秒。无话可说则空返回。` };
        });
      },
      enabled: true
    });

    this.registerMCPTool('unmute', {
      description: '解除禁言。qq 必填。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { qq: { type: 'number' } },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.muteMember(args.qq, 0);
          const gid = context.e.group_id;
          return { success: true, raw: `你已成功在群 ${gid} 解除 ${args.qq} 的禁言。无话可说则空返回。` };
        });
      },
      enabled: true
    });

    this.registerMCPTool('muteAll', {
      description: '全员禁言。仅群聊。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.muteAll(true);
          const gid = context.e.group_id;
          return { success: true, raw: `你已成功在群 ${gid} 开启全员禁言。无话可说则空返回。` };
        });
      },
      enabled: true
    });

    this.registerMCPTool('unmuteAll', {
      description: '解除全员禁言。仅群聊。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.muteAll(false);
          const gid = context.e.group_id;
          return { success: true, raw: `你已成功在群 ${gid} 解除全员禁言。无话可说则空返回。` };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setCard', {
      description: '修改群名片。card 必填；qq 不填则改自己。需管理/群主。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { qq: { type: 'number' }, card: { type: 'string' } },
        required: ['card']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
          const e = context.e;
          let targetQq = String(args.qq || '').trim();
          if (!targetQq) {
            targetQq = String(e.self_id || e.bot?.uin || '').trim() || String(e.user_id || '').trim();
          }
          if (!targetQq) {
            return { success: false, error: '无法确定要修改名片的成员QQ号' };
          }

        return this._wrapHandler(async () => {
          await context.e.group.setCard(targetQq, args.card);
          const gid = context.e.group_id;
          const selfId = String(context.e.self_id || context.e.bot?.uin || '');
          const who = targetQq === selfId ? '自己' : targetQq;
          return { success: true, raw: `你已成功在群 ${gid} 将 ${who} 的名片改为「${args.card}」。无话可说则空返回。` };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setGroupName', {
      description: '修改群名。name 必填。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.setName(args.name);
          const gid = context.e.group_id;
          return { success: true, raw: `你已成功将群 ${gid} 的群名改为「${args.name}」。无话可说则空返回。` };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setAdmin', {
      description: '设置管理员。qq 必填。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { qq: { type: 'number' } },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.setAdmin(args.qq, true);
          const gid = context.e.group_id;
          return { success: true, raw: `你已成功在群 ${gid} 设置 ${args.qq} 为管理员。无话可说则空返回。` };
        });
      },
      enabled: true
    });

    this.registerMCPTool('unsetAdmin', {
      description: '取消管理员。qq 必填。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { qq: { type: 'number' } },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.setAdmin(args.qq, false);
          const gid = context.e.group_id;
          return { success: true, raw: `你已成功在群 ${gid} 取消 ${args.qq} 的管理员。无话可说则空返回。` };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setTitle', {
      description: '设置专属头衔。qq、title 必填；duration 秒，默认-1。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { qq: { type: 'number' }, title: { type: 'string' }, duration: { type: 'number', default: -1 } },
        required: ['qq', 'title']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.setTitle(args.qq, args.title, args.duration || -1);
          const gid = context.e.group_id;
          const dur = args.duration && args.duration > 0 ? `，持续 ${args.duration} 秒` : '';
          return { success: true, raw: `你已成功在群 ${gid} 为 ${args.qq} 设置专属头衔「${args.title}」${dur}。无话可说则空返回。` };
        });
      },
      enabled: true
    });

    this.registerMCPTool('kick', {
      description: '踢出群成员。qq 必填；reject 是否拒绝再申请。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { qq: { type: 'number' }, reject: { type: 'boolean', default: false } },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.kickMember(args.qq, args.reject || false);
          const gid = context.e.group_id;
          const extra = args.reject ? ' 并拒绝其再次申请' : '';
          return { success: true, raw: `你已成功在群 ${gid} 踢出 ${args.qq}${extra}。无话可说则空返回。` };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setEssence', {
      description: '设置精华消息。msgId 必填。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { msgId: { type: 'number' } },
        required: ['msgId']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        const msgId = String(args.msgId ?? '').trim();
        if (!msgId) {
          return { success: false, error: '消息ID不能为空' };
        }
        
        return this._wrapHandler(async () => {
          const group = context.e.group;
          const gid = context.e.group_id;
          if (group && typeof group.setEssenceMessage === 'function') {
            await group.setEssenceMessage(msgId);
            return { success: true, raw: `你已成功在群 ${gid} 将消息 ${msgId} 设为精华。无话可说则空返回。` };
          } else if (context.e.bot?.sendApi) {
            await context.e.bot.sendApi('set_essence_msg', { message_id: msgId });
            return { success: true, raw: `你已成功在群 ${gid} 将消息 ${msgId} 设为精华。无话可说则空返回。` };
          }
          return { success: false, error: 'API不可用' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('removeEssence', {
      description: '取消精华消息。msgId 必填。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { msgId: { type: 'number' } },
        required: ['msgId']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        const msgId = String(args.msgId ?? '').trim();
        if (!msgId) {
          return { success: false, error: '消息ID不能为空' };
        }
        
        return this._wrapHandler(async () => {
          const group = context.e.group;
          const gid = context.e.group_id;
          if (group && typeof group.removeEssenceMessage === 'function') {
            await group.removeEssenceMessage(msgId);
            return { success: true, raw: `你已成功在群 ${gid} 取消消息 ${msgId} 的精华。无话可说则空返回。` };
          }
          return { success: false, error: 'API不可用' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('announce', {
      description: '发送群公告。content 必填；image 可选。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { content: { type: 'string' }, image: { type: 'string' } },
        required: ['content']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        const content = String(args.content ?? '').trim();
        if (!content) {
          return { success: false, error: '公告内容不能为空' };
        }
        
        return this._wrapHandler(async () => {
          const group = context.e.group;
          const image = args.image ? String(args.image).trim() : undefined;
          
          const gid = context.e.group_id;
          if (group && typeof group.sendNotice === 'function') {
            const result = await group.sendNotice(content, image ? { image } : {});
            if (result !== undefined) {
              return { success: true, raw: `你已成功在群 ${gid} 发送公告${image ? '（含图）' : ''}。无话可说则空返回。` };
            }
          } else if (context.e.bot?.sendApi) {
            const apiParams = { group_id: context.e.group_id, content };
            if (image) apiParams.image = image;
            const result = await context.e.bot.sendApi('_send_group_notice', apiParams);
            if (result?.status === 'ok') {
              return { success: true, raw: `你已成功在群 ${gid} 发送公告${image ? '（含图）' : ''}。无话可说则空返回。` };
            }
          }
          return { success: false, error: 'API不可用' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('recall', {
      description: '撤回消息。msgId 必填。自己消息 3 分钟内或管理可撤。',
      inputSchema: {
        type: 'object',
        properties: { msgId: { type: 'number' } },
        required: ['msgId']
      },
      handler: async (args = {}, context = {}) => {
        if (!context.e) {
          return { success: false, error: '事件对象不存在' };
        }
        
        try {
          let canRecall = false;
          let messageInfo = null;
          
          if (context.e.bot && context.e.bot.sendApi) {
            try {
              messageInfo = await context.e.bot.sendApi('get_msg', { message_id: args.msgId });
            } catch {
              // 忽略获取消息信息失败
            }
          }
          
          if (context.e.isGroup) {
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
                return { success: false, error: isSelfMsg ? '消息已超过3分钟' : '需要管理员权限' };
              }
            } else if (isAdmin) {
              canRecall = true;
            }
          } else {
            if (messageInfo && messageInfo.data) {
              const msgData = messageInfo.data;
              const isSelfMsg = String(msgData.sender?.user_id) === String(context.e.self_id);
              const msgTime = msgData.time || 0;
              const currentTime = Math.floor(Date.now() / 1000);
              const timeDiff = currentTime - msgTime;
              
              if (isSelfMsg && timeDiff <= 180) {
                canRecall = true;
              } else {
                return { success: false, error: isSelfMsg ? '已超过3分钟' : '不是自己的消息' };
              }
            } else {
              canRecall = true;
            }
          }
          
          if (!canRecall) {
            return { success: false, error: '无法撤回消息' };
          }

          return this._wrapHandler(async () => {
            if (context.e.isGroup && context.e.group) {
              await context.e.group.recallMsg(args.msgId);
              const gid = context.e.group_id;
              return { success: true, raw: `你已成功在群 ${gid} 撤回消息 ${args.msgId}。无话可说则空返回。` };
            } else if (context.e.bot) {
              await context.e.bot.sendApi('delete_msg', { message_id: args.msgId });
              const uid = context.e.user_id;
              return { success: true, raw: `你已成功在与 ${uid} 的私聊中撤回消息 ${args.msgId}。无话可说则空返回。` };
            }
            return { success: false, error: '无法撤回' };
          });
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('getGroupInfoEx', {
      description: '获取群扩展信息。仅群聊。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          const group = context.e.group;
          if (group && typeof group.getInfoEx === 'function') {
            const info = await group.getInfoEx();
            BotUtil.makeLog('debug', `获取群信息ex成功: ${JSON.stringify(info)}`, 'ChatStream');
            const raw = this._queryToolRawDetail('群扩展信息', info, context.e);
            const result = { success: true, data: info, raw };
            return result;
          }
          const result = { success: false, error: 'API不可用' };
          return result;
        }, 0).catch(error => {
          BotUtil.makeLog('warn', `获取群信息ex失败: ${error.message}`, 'ChatStream');
          const result = { success: false, error: error.message };
          return result;
        });
      },
      enabled: true
    });

    this.registerMCPTool('getAtAllRemain', {
      description: '获取@全体剩余次数。仅群聊。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          const group = context.e.group;
          if (group && typeof group.getAtAllRemain === 'function') {
            const remain = await group.getAtAllRemain();
            BotUtil.makeLog('debug', `@全体成员剩余次数: ${JSON.stringify(remain)}`, 'ChatStream');
            const raw = this._queryToolRawDetail('@全体剩余次数', remain, context.e);
            const result = { success: true, data: remain, raw };
            return result;
          }
          const result = { success: false, error: 'API不可用' };
          return result;
        }, 0).catch(error => {
          BotUtil.makeLog('warn', `获取@全体剩余次数失败: ${error.message}`, 'ChatStream');
          const result = { success: false, error: error.message };
          return result;
        });
      },
      enabled: true
    });

    this.registerMCPTool('getBanList', {
      description: '获取禁言成员列表。仅群聊。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          const group = context.e.group;
          if (group && typeof group.getBanList === 'function') {
            const banList = await group.getBanList();
            BotUtil.makeLog('debug', `群禁言列表: ${JSON.stringify(banList)}`, 'ChatStream');
            const raw = this._queryToolRawDetail('禁言列表', banList, context.e);
            const result = { success: true, data: banList, raw };
            return result;
          }
          const result = { success: false, error: 'API不可用' };
          return result;
        }, 0).catch(error => {
          BotUtil.makeLog('warn', `获取禁言列表失败: ${error.message}`, 'ChatStream');
          const result = { success: false, error: error.message };
          return result;
        });
      },
      enabled: true
    });

    this.registerMCPTool('setGroupTodo', {
      description: '设置群代办。msgId 必填。需管理/群主。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { msgId: { type: 'number' } },
        required: ['msgId']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        const msgId = String(args.msgId ?? '').trim();
        if (!msgId) {
          return { success: false, error: '消息ID不能为空' };
        }
        
        return this._wrapHandler(async () => {
          const e = context.e;
          const botRole = await this.getBotRole(e);
          const isAdmin = botRole === '管理员' || botRole === '群主';
          if (!isAdmin) {
            return { success: false, error: '需要管理员或群主权限才能设置群代办' };
          }

          if (e.bot?.sendApi) {
            const result = await e.bot.sendApi('set_group_todo', {
              group_id: e.group_id,
              message_id: msgId
            });
            if (result !== undefined) {
              const gid = e.group_id;
              return { success: true, raw: `你已成功在群 ${gid} 将消息 ${msgId} 设为群代办。无话可说则空返回。` };
            }
          }
          return { success: false, error: 'API不可用' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('getFriendList', {
      description: '获取好友列表（QQ、昵称、备注）。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const e = context.e;
        const bot = e?.bot;
        if (!bot || typeof bot.getFriendMap !== 'function') {
          return { success: false, error: '当前适配器不支持获取好友列表' };
        }

        try {
          const map = await bot.getFriendMap();
          const friends = [];
          if (map && typeof map.forEach === 'function') {
            map.forEach((info, uid) => {
              if (!uid) return;
              const qq = String(uid);
              const nickname = info?.nickname || '';
              const remark = info?.remark || '';
              friends.push({ qq, nickname, remark });
            });
          }

          const raw = this._queryToolRaw(`好友列表（共 ${friends.length} 人）`, { friends });
          const result = { success: true, data: { friends }, raw };
          return result;
        } catch (error) {
          const result = { success: false, error: error.message };
          return result;
        }
      },
      enabled: true
    });

    this.registerMCPTool('getGroupMembers', {
      description: '获取群成员列表（QQ、昵称、名片、角色）。仅群聊。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;

        const group = context.e.group;
        if (!group) {
          return { success: false, error: '群对象不存在' };
        }

        try {
          let memberMap = null;
          if (typeof group.getMemberMap === 'function') {
            memberMap = await group.getMemberMap();
          }

          const members = [];

          if (memberMap?.forEach) {
            memberMap.forEach((info, uid) => {
              if (!uid) return;
              const qq = String(uid);
              const role = info?.role || 'member';
              const is_owner = role === 'owner';
              const is_admin = role === 'admin' || role === 'owner';
              members.push({
                qq,
                nickname: info?.nickname || '',
                card: info?.card || '',
                role,
                is_owner,
                is_admin
              });
            });
          } else if (typeof group.getMemberArray === 'function') {
            const arr = await group.getMemberArray();
            for (const info of Array.isArray(arr) ? arr : []) {
              if (!info || info.user_id === undefined) continue;
              const qq = String(info.user_id);
              const role = info?.role || 'member';
              const is_owner = role === 'owner';
              const is_admin = role === 'admin' || role === 'owner';
              members.push({
                qq,
                nickname: info?.nickname || '',
                card: info?.card || '',
                role,
                is_owner,
                is_admin
              });
            }
          } else {
            return { success: false, error: '当前适配器不支持获取群成员列表' };
          }

          const raw = this._queryToolRawDetail('群成员列表', { members }, context.e);
          const result = { success: true, data: { members }, raw };
          return result;
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('getGroupInfo', {
      description: '获取群基础信息（群名、群号、成员数等）。仅群聊。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;

        const e = context.e;
        const group = e.group;
        if (!group) {
          return { success: false, error: '群对象不存在' };
        }

        try {
          let info = null;
          if (typeof group.getInfo === 'function') {
            info = await group.getInfo();
          } else if (e.bot?.sendApi) {
            const result = await e.bot.sendApi('get_group_info', { group_id: e.group_id });
            info = result?.data || null;
          }

          if (!info) {
            return { success: false, error: '无法获取群信息' };
          }

          const raw = this._queryToolRawDetail('群基础信息', info, e);
          const result = { success: true, data: info, raw };
          return result;
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('getMemberInfo', {
      description: '获取群成员信息。qq 必填。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { qq: { type: 'number' } },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;

        const e = context.e;
        const qq = String(args.qq ?? '').trim();
        if (!qq) {
          return { success: false, error: 'QQ号不能为空' };
        }

        try {
          const group = e.group;
          let info = null;
          if (group && typeof group.pickMember === 'function') {
            const member = group.pickMember(qq);
            if (member && typeof member.getInfo === 'function') {
              info = await member.getInfo();
            }
          }
          if (!info && e.bot?.sendApi) {
            const result = await e.bot.sendApi('get_group_member_info', {
              group_id: e.group_id,
              user_id: qq
            });
            info = result?.data || null;
          }

          if (!info) {
            return { success: false, error: '无法获取成员信息' };
          }

          const raw = this._queryToolRawDetail(`成员 ${qq} 的信息`, info, e);
          const result = { success: true, data: info, raw };
          return result;
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('getFriendInfo', {
      description: '获取好友信息。qq 必填。',
      inputSchema: {
        type: 'object',
        properties: { qq: { type: 'number' } },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        const qq = String(args.qq ?? '').trim();
        if (!qq) {
          return { success: false, error: 'QQ号不能为空' };
        }

        try {
          const bot = e?.bot;
          let info = null;
          if (bot && typeof bot.pickFriend === 'function') {
            const friend = bot.pickFriend(qq);
            if (friend && typeof friend.getInfo === 'function') {
              info = await friend.getInfo();
            }
          }
          if (!info && bot?.sendApi) {
            const result = await bot.sendApi('get_stranger_info', { user_id: qq });
            info = result?.data || null;
          }

          if (!info) {
            return { success: false, error: '无法获取好友信息' };
          }

          const raw = this._queryToolRaw(`好友 ${qq} 的信息`, info);
          const result = { success: true, data: info, raw };
          return result;
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('getMessageImages', {
      description: '获取消息中的图片URL列表。messageId 必填（见记录[ID:xxx]，数字）。无描述时可先本工具再 recognizeImage。',
      inputSchema: {
        type: 'object',
        properties: { messageId: { type: 'number' } },
        required: ['messageId']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        if (!e) {
          return { success: false, error: '事件对象不存在' };
        }

        const msgId = String(args.messageId ?? '').trim();
        if (!msgId) {
          return { success: false, error: '消息ID不能为空' };
        }

        try {
          let messageData = null;
          
          // 方法1：通过 bot.sendApi 获取消息
          if (e.bot?.sendApi) {
            try {
              const result = await e.bot.sendApi('get_msg', { message_id: msgId });
              messageData = result?.data || null;
            } catch (err) {
              BotUtil.makeLog('debug', `[ChatStream] getMessageImages get_msg API失败: ${err?.message}`, 'ChatStream');
            }
          }
          
          // 方法2：通过适配器的 getMsg 方法
          if (!messageData && e.bot?.adapter?.getMsg) {
            try {
              messageData = await e.bot.adapter.getMsg(e, msgId);
            } catch (err) {
              BotUtil.makeLog('debug', `[ChatStream] getMessageImages adapter.getMsg失败: ${err?.message}`, 'ChatStream');
            }
          }

          if (!messageData) {
            return { success: false, error: '无法获取消息，消息可能不存在或已过期' };
          }

          // 提取图片URL
          const images = [];
          const message = messageData.message;
          
          if (Array.isArray(message)) {
            for (const seg of message) {
              if (seg && seg.type === 'image') {
                const url = seg.url || seg.data?.url || seg.data?.file || seg.file;
                if (url) {
                  images.push(url);
                }
              }
            }
          } else if (messageData.raw_message) {
            // 尝试从 raw_message 中提取图片URL（CQ码格式）
            const cqImageRegex = /\[CQ:image,file=([^\]]+)\]/g;
            let match;
            while ((match = cqImageRegex.exec(messageData.raw_message)) !== null) {
              const fileParam = match[1];
              // 尝试提取url参数
              const urlMatch = fileParam.match(/url=([^,]+)/);
              if (urlMatch) {
                images.push(urlMatch[1]);
              }
            }
          }

          if (images.length === 0) {
            return { success: false, error: '该消息中没有图片' };
          }

          const data = {
              messageId: msgId,
              images,
              imageCount: images.length,
              sender: messageData.sender?.nickname || messageData.sender?.user_id || '未知',
              time: messageData.time || Date.now()
            };
          const raw = this._queryToolRaw(`消息 ${msgId} 的图片URL列表（共 ${images.length} 张）`, data);
          const result = { success: true, data, raw };
          BotUtil.makeLog('debug', `[ChatStream] getMessageImages 成功获取消息图片 messageId=${msgId} imageCount=${images.length} images=${images.join(',')}`, 'ChatStream');
          return result;
        } catch (error) {
          BotUtil.makeLog('error', `[ChatStream] getMessageImages 异常: ${error.message}`, 'ChatStream');
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('recognizeImage', {
      description: '识别图片内容返回描述。imageUrl 必填；prompt 可选。常与 getMessageImages 配合。',
      inputSchema: {
        type: 'object',
        properties: { imageUrl: { type: 'string' }, prompt: { type: 'string' } },
        required: ['imageUrl']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        if (!e) {
          return { success: false, error: '事件对象不存在' };
        }

        const imageUrl = String(args.imageUrl ?? '').trim();
        if (!imageUrl) {
          return { success: false, error: '图片URL不能为空' };
        }

        const prompt = String(args.prompt ?? '').trim() || '请详细描述这张图片的内容，包括主要对象、场景、文字（如果有）、颜色、风格等。';

        try {
          // 构造多模态消息格式：{ text, images }
          // 工厂会自动通过 transformMessagesWithVision 转换为 OpenAI 风格的 content 数组
          const recognitionMessages = [
            {
              role: 'system',
              content: '你是一个专业的图片识别助手。请根据用户提供的图片，详细描述图片的内容。'
            },
            {
              role: 'user',
              content: {
                text: prompt,
                images: [imageUrl] // 图片URL，工厂会自动处理转换
              }
            }
          ];

          // 调用AI识别（使用当前工作流的配置）
          const config = this.resolveLLMConfig({});
          const llm = await this.callAI(recognitionMessages, config);

          if (llm == null || !String(llm.text ?? '').trim()) {
            return { success: false, error: 'AI识别失败，未返回结果' };
          }

          const recognitionResult = llm.text.trim();

          const data = {
              imageUrl,
              description: recognitionResult.trim(),
              prompt
            };
          const raw = this._queryToolRaw('该图片的识别结果', data);
          const result = { success: true, data, raw };
          BotUtil.makeLog('debug', `[ChatStream] recognizeImage 成功识别图片 imageUrl=${imageUrl} descriptionLen=${recognitionResult.trim().length}`, 'ChatStream');
          return result;
        } catch (error) {
          BotUtil.makeLog('error', `[ChatStream] recognizeImage 异常: ${error.message}`, 'ChatStream');
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });
  }

  getRandomEmotionImage(emotion) {
    const images = ChatStream.emotionImages[emotion];
    if (!images || images.length === 0) return null;
    return images[Math.floor(Math.random() * images.length)];
  }

  recordMessage(e) {
    if (!e) return;
    
    try {
      const groupId = e.group_id || e.groupId || null;
      const userId = e.user_id || e.userId || e.user?.id || null;

      let message = '';
      if (e.message && Array.isArray(e.message)) {
        // 优先使用结构化 message 段
        message = this._segmentsToPlainText(e.message);
      } else if (e.raw_message) {
        message = this._normalizeMessageText(e.raw_message);
      } else if (e.msg) {
        message = this._normalizeMessageText(e.msg);
      } else if (e.content) {
        const t = typeof e.content === 'string' ? e.content : e.content.text || '';
        message = this._normalizeMessageText(t);
      }

      const nickname = e.sender?.card || e.sender?.nickname || 
                      e.user?.name || e.user?.nickname || 
                      e.from?.name || '未知';

      let messageId = e.message_id || e.real_id || e.messageId || e.id || e.source?.id;
      if (!messageId && e.message && Array.isArray(e.message)) {
        const replySeg = e.message.find(seg => seg.type === 'reply');
        if (replySeg && replySeg.id) {
          messageId = replySeg.id;
        }
      }
      if (!messageId) messageId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      else messageId = String(messageId);

      // 统一提取图片信息（避免重复逻辑）
      const hasImage = !!(e.img?.length > 0 || (Array.isArray(e.message) && e.message.some(seg => seg.type === 'image')));
      const imageCount = hasImage && Array.isArray(e.message) 
        ? e.message.filter(seg => seg.type === 'image').length 
        : 0;

      // 确保 user_id 始终存在，QQ号是唯一标识
      const finalUserId = userId || e.user_id || e.userId || e.user?.id || '未知QQ';
      const msgData = {
        user_id: finalUserId,
        nickname: nickname || '未知用户',
        message: message || '',
        message_id: messageId,
        time: e.time || Date.now(),
        platform: e.platform || 'onebot',
        hasImage,
        imageCount: imageCount > 0 ? imageCount : undefined
      };

      if (groupId && e.isGroup !== false) {
        if (!ChatStream.messageHistory.has(groupId)) {
          ChatStream.messageHistory.set(groupId, []);
        }
        const history = ChatStream.messageHistory.get(groupId);
        history.push(msgData);
        if (history.length > 50) {
          ChatStream.messageHistory.set(groupId, history.slice(-50));
        }
      }

      BotUtil.makeLog('debug', `[ChatStream] recordMessage group=${groupId} userId=${userId} msgLen=${(message || '').length} messageId=${messageId}`, 'ChatStream');
    } catch (err) {
      BotUtil.makeLog('debug', `[ChatStream] recordMessage 异常: ${err?.message}`, 'ChatStream');
    }
  }

  getBotRole(e) {
    if (!e.isGroup) return '成员';
    const member = e.group?.pickMember(e.self_id);
    const roleValue = member?.role;
    return roleValue === 'owner' ? '群主' : 
           roleValue === 'admin' ? '管理员' : '成员';
  }

  recordAIResponse(e, text) {
    if (!text?.trim()) return;
    BotUtil.makeLog('debug', `[ChatStream] recordAIResponse group=${e?.group_id} textLen=${text.length} text=${text}`, 'ChatStream');
    
    // 提取图片内容标记（不会被用户看见，仅记录到历史）
    const { imageContent, text: cleanText } = this.parseImageContentMark(text);
    
    const msgData = {
      user_id: e.self_id,
      nickname: e.bot?.nickname || e.bot?.info?.nickname || e.bot?.name || 'Bot',
      message: cleanText || text, // 记录清理后的文本（不含图片内容标记）
      message_id: Date.now().toString(),
      time: Date.now(),
      platform: 'onebot',
      hasImage: false,
      isBot: true,
      imageContentMark: imageContent || undefined // 图片内容标记（如果存在）
    };
    if (e?.isGroup && e.group_id) {
      const history = ChatStream.messageHistory.get(e.group_id) || [];
      history.push(msgData);
      if (history.length > 50) ChatStream.messageHistory.set(e.group_id, history.slice(-50));
    }
    if (imageContent) {
      BotUtil.makeLog('debug', `[ChatStream] recordAIResponse 提取图片内容标记: ${imageContent}`, 'ChatStream');
    }
  }

  async _buildMemoryContext(e) {
    try {
      const redisSummary = await this.buildMemorySummary(e);
      if (!redisSummary?.trim()) return null;
      return `【会话记忆】\n${redisSummary.trim()}`;
    } catch (err) {
      BotUtil.makeLog('debug', `[ChatStream] buildMemorySummary 失败: ${err?.message}`, 'ChatStream');
      return null;
    }
  }

  /**
   * 记录工具调用结果到聊天记录
   */
  recordToolCallResult(e, toolName, result) {
    if (!e?.isGroup || !e.group_id) return;

    try {
      const groupId = String(e.group_id);
      const history = ChatStream.messageHistory.get(groupId) || [];
      
      // 完整的结果文本（用于日志）
      const fullResultText = result?.success && result?.data
        ? JSON.stringify(result.data)
        : (result?.error || '已完成');
      
      // 存储到历史记录的结果文本（限制长度，避免历史记录过大）
      const MAX_STORED_RESULT_LENGTH = 2000;
      const resultText = fullResultText.length > MAX_STORED_RESULT_LENGTH
        ? fullResultText.slice(0, MAX_STORED_RESULT_LENGTH) + `...[截断 ${fullResultText.length} 字符]`
        : fullResultText;
      
      // 工具调用记录：只记录结果，不暴露工具名格式，避免AI误解
      const msgData = {
        user_id: e.self_id,
        nickname: e.bot?.nickname || e.bot?.info?.nickname || e.bot?.name || 'Bot',
        message: resultText, // 存储截断后的结果文本
        message_id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        time: Date.now(),
        platform: 'onebot',
        hasImage: false,
        isBot: true,
        isTool: true,
        toolName,
        toolResult: result
      };

      history.push(msgData);
      if (history.length > 50) {
        ChatStream.messageHistory.set(groupId, history.slice(-50));
      }

      // 日志输出完整内容
      BotUtil.makeLog('debug', `[ChatStream] recordToolCallResult tool=${toolName} group=${groupId} resultLen=${fullResultText.length} result=${fullResultText}`, 'ChatStream');
    } catch (err) {
      BotUtil.makeLog('debug', `[ChatStream] recordToolCallResult 异常: ${err?.message}`, 'ChatStream');
    }
  }

  /**
   * 将消息段数组解析为可读文本（供 AI 查看聊天记录内容）
   */
  _segmentsToPlainText(segments) {
    if (!Array.isArray(segments)) return '';
    const parts = [];
    for (const seg of segments) {
      if (!seg || typeof seg !== 'object') continue;
      switch (seg.type) {
        case 'text':
          parts.push(seg.text || '');
          break;
        case 'image':
          parts.push('[图片]');
          break;
        case 'face':
          parts.push('[表情]');
          break;
        case 'reply':
          parts.push(`[回复:${seg.id || seg.data?.id || ''}]`);
          break;
        case 'at':
          parts.push(`@${this._atSegmentToDisplay(seg)}`);
          break;
        // OneBot 转发/节点消息：尽量展开节点文本
        case 'node': {
          const name = seg.data?.name || seg.data?.nickname || '';
          const innerSegs = Array.isArray(seg.data?.content)
            ? seg.data.content
            : (Array.isArray(seg.data?.message) ? seg.data.message : []);
          const innerText = innerSegs.length ? this._segmentsToPlainText(innerSegs) : '';
          const label = name ? `转发:${name}` : '转发消息';
          parts.push(innerText ? `[${label}] ${innerText}` : `[${label}]`);
          break;
        }
        default:
          // 其它类型暂不特殊处理
          break;
      }
    }
    return this._normalizeMessageText(parts.join(''));
  }

  /**
   * 归一化聊天文本：压缩无意义 CQ 块（如转发）、多余空白等，便于 AI 阅读
   */
  _normalizeMessageText(text) {
    if (!text || typeof text !== 'string') return text || '';
    let clean = text;
    // 把整段或嵌入的转发 CQ 简化为「[转发消息]」
    clean = clean.replace(/\[CQ:forward,[^\]]*]/g, '[转发消息]');
    // 未来如有其它复杂 CQ 类型（如合并转发、文件等），可以在这里按需追加规则
    // 压缩多余空白
    clean = clean.replace(/\s+/g, ' ').trim();
    return clean;
  }

  async buildSystemPrompt(context) {
    const { e, question } = context;
    const persona =
      question?.persona ||
      '你是群里一起聊天的伙伴：像真人一样接话——听得懂玩笑和气氛，该正经说清、该闲聊就短打，别像客服稿或说明书。';
    const botRole = question?.botRole || this.getBotRole(e);
    const dateStr = question?.dateStr || new Date().toLocaleString('zh-CN');
    const botName = e.bot?.nickname || e.bot?.info?.nickname || e.bot?.name || 'Bot';
    const isMaster = e.isMaster === true;
    const masterNote = isMaster ? '\n主人指令优先、少反驳。' : '';

    const lines = [
      `# ${botName}`,
      `${botName}｜QQ ${e.self_id}｜群 ${e.group_id}｜身份 ${botRole}｜${dateStr}`,
      persona + masterNote,
      '',
      '## 可见性与输出',
      '- 用户仅能看到工具发出的内容（reply / at / emotion / poke 等）；**assistant 直连正文对用户不可见**。',
      '- 要让用户看到的内容必须出现在 **reply** 里；正文只适合简短自问自答式推理。',
      '- **工具（占卜/MCP）返回后的下一轮**：必须把口语解读写进 **reply**（可用 `|` 分多条）；若只在正文里写长篇解读、不调 reply，群里就只会停在占卜前那一两句铺垫。',
      '- 工具若表明已送达，勿再用 reply/at 重复实质相同的话。',
      '',
      '## 上下文说明',
      '- 群聊记录格式：昵称(QQ)[消息ID]；「【我】」为你已发内容，勿复读。',
      '- 下文「文件记忆」「会话记忆」为摘要，可引用，勿整段照搬。',
      '',
      '## 说话方式（人性化）',
      '- 同时看「群聊记录」与「当前消息」：谁在什么语境下说话（玩笑、吐槽、求助），你就用什么口吻接，别自说自话。',
      '- 有人 @ 你、点名或明确问你，优先对准那句话答；否则可以顺着话题插一句，不必强行总结全文。',
      '- 少用汇报腔（「综上所述」「三点如下」）、少用万能客服句（「很高兴为您服务」）；长短跟话题走，能说人话别说套话。',
      '- 人设与记忆当底色自然带出来，不要像在读清单。',
      '',
      '## 文本协议（reply 的 content）',
      '- 分句：`|` 或 `｜` 分段发送。',
      '- 表情：`[开心][惊讶][伤心][大笑][害怕][生气]`（每轮至多一处）。引用：`[回复:消息ID]`。@人：`[CQ:at,qq=QQ]`。仅记录：`[图片内容:描述]`。',
      '- **勿写 Markdown**（#标题、**粗体**、代码块、表格等）。用户可见内容会先剥离 Markdown；若剥完后没有可读正文则该条不会发出。',
      '- 勿在 content 里伪造「工具名+括号参数」式的伪调用。',
      '',
      '## 工具',
      '- 具体名称与参数以接口下发的 tools 为准；含对外发送、群资料与成员、图片、群管与表情回应等。',
      '',
      '## 外部工具（占卜 / 远程 MCP）',
      '- **先工具后发言**：需要远程 MCP（占卜、数据库等）时，**本轮应先只调用工具**，看到返回后再用 reply；**禁止在同一轮里既 reply「帮你占卜」「三牌阵」等铺垫又调占卜**，否则用户会先收到重复空话且牌面未到。',
      '- **一问一局**：同一话题占卜类工具 **只调用一次**，除非用户明确要求再来一局。',
      '- **结果忠实**：解读必须与工具返回文本中的 **牌名、阵位、正/逆位** 一致，只可翻译成口语；**禁止凭空虚构另一副牌或与其它轮次结果混用**。',
      '- **少废话**：勿用多条 reply 重复同一寓意（如反复「勉为其难帮你占卜」「就选三牌阵」）；铺垫一句即可。',
      '- 勿把工具返回的长篇 Markdown **仅**粘贴进 assistant 正文；给用户看的解读只能走 **reply**。',
      '',
      '## 约束',
      '- 勿 Markdown；勿在正文里手写 poke/at 调用语法；勿无必要刷屏复读（用户明确要求除外）。',
      '- 勿依赖固定开场白或复读上一句自己的回复；用户可见的话一律走 reply，语气要像群里真人。'
    ];
    return lines.join('\n');
  }

  /**
   * 从事件中提取图片（统一提取逻辑）
   * @param {Object} e - 事件对象
   * @returns {Promise<{images: string[], replyImages: string[]}>}
   */
  async _extractImagesFromEvent(e) {
    const images = [];
    const replyImages = [];

    if (e && Array.isArray(e.message)) {
      let inReplyRegion = false;
      for (const seg of e.message) {
        if (seg.type === 'reply') {
          inReplyRegion = true;
          continue;
        }
        if (seg.type === 'image') {
          const url = seg.url || seg.data?.url || seg.data?.file;
          if (!url) continue;
          if (inReplyRegion) {
            replyImages.push(url);
          } else {
            images.push(url);
          }
        }
      }
    }

    // 被回复消息中的图片一并交给工厂多模态处理
    if (e?.source && typeof e.getReply === 'function') {
      try {
        const reply = await e.getReply();
        if (reply && Array.isArray(reply.message)) {
          for (const seg of reply.message) {
            if (seg.type === 'image') {
              const url = seg.url || seg.data?.url || seg.data?.file;
              if (url) replyImages.push(url);
            }
          }
        }
      } catch (err) {
        BotUtil.makeLog('debug', `[ChatStream] _extractImagesFromEvent 获取被回复图片失败: ${err?.message}`, 'ChatStream');
      }
    }

    return { images, replyImages };
  }

  async buildChatContext(e, question) {
    if (Array.isArray(question)) {
      return question;
    }

    const messages = [];
    messages.push({
      role: 'system',
      content: await this.buildSystemPrompt({ e, question })
    });

    // 基础文本
    const text = typeof question === 'string'
      ? question
      : (question?.content ?? question?.text ?? '');

    // 提取图片（统一提取逻辑）
    const { images, replyImages } = await this._extractImagesFromEvent(e);

    const triggerFlags = {
      isGlobalTrigger: !!question?.isGlobalTrigger,
      debugDumpFullPrompt: !!question?.debugDumpFullPrompt
    };

    // 若无图片，则仍然用纯文本；附带触发标记供 mergeMessageHistory 使用（勿仅靠纯字符串否则丢失）
    if (images.length === 0 && replyImages.length === 0) {
      messages.push({
        role: 'user',
        content: { text, ...triggerFlags }
      });
    } else {
      messages.push({
        role: 'user',
        content: {
          text: text || '',
          images,
          replyImages,
          ...triggerFlags
        }
      });
    }

    return messages;
  }

  extractQueryFromMessages(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          return msg.content;
        } else if (msg.content?.text) {
          return msg.content.text;
        }
      }
    }
    return '';
  }

  /**
   * 构建增强上下文：在基础 messages 上追加 Redis 会话记忆摘要（若有）
   */
  async buildEnhancedContext(e, query, messages) {
    const baseMessages = typeof super.buildEnhancedContext === 'function'
      ? await super.buildEnhancedContext(e, query, messages)
      : messages;

    const memText = await this._buildMemoryContext(e);
    if (!memText) return baseMessages;

    const enhanced = [...baseMessages];
    const head = enhanced[0];
    if (head?.role === 'system') {
      const cur = head.content;
      const merged = typeof cur === 'string'
        ? `${cur}\n\n${memText}`
        : `${typeof cur === 'object' && cur != null ? JSON.stringify(cur) : String(cur)}\n\n${memText}`;
      enhanced[0] = { ...head, content: merged };
    } else {
      enhanced.unshift({ role: 'system', content: memText });
    }

    return enhanced;
  }

  async syncHistoryFromAdapter(e) {
    if (!e?.isGroup) return;
    const groupId = e.group_id;
    if (!groupId) return;

    const group = e.group;
    const getter =
      (group && typeof group.getChatHistory === 'function' && group.getChatHistory) ||
      (typeof e.getChatHistory === 'function' && e.getChatHistory) ||
      null;
    if (!getter) return;

    try {
      let rawHistory;
      try {
        rawHistory = await getter(undefined, 50, true);
      } catch {
        rawHistory = await getter(50);
      }

      const history = ChatStream.messageHistory.get(groupId) || [];
      const existingIds = new Set(history.map(h => String(h.message_id)));
      const newMessages = [];
      
      for (const msg of Array.isArray(rawHistory) ? rawHistory : []) {
        if (!msg || typeof msg !== 'object') continue;
        const mid = msg.real_id || msg.message_id || msg.message_seq;
        if (!mid) continue;
        const idStr = String(mid);
        
        // 检查是否已存在（避免重复添加）
        if (existingIds.has(idStr)) continue;

        const sender = msg.sender || {};
        const segments = Array.isArray(msg.message) ? msg.message : [];

        // 统一的消息文本提取逻辑：优先用结构化 message 段，还原出可读聊天内容
        let text = '';
        if (segments.length > 0) {
          text = this._segmentsToPlainText(segments);
        } else {
          text = this._normalizeMessageText(msg.raw_message || '');
        }

        const nickname = sender.card || sender.nickname || '未知用户';
        const hasImage = segments.some(seg => seg?.type === 'image');
        // 确保 user_id 始终存在，QQ号是唯一标识
        const userId = msg.user_id ?? sender.user_id ?? '未知QQ';
        
        newMessages.push({
          user_id: userId,
          nickname,
          message: text || '',
          message_id: idStr,
          time: msg.time || Date.now(),
          platform: 'onebot',
          hasImage
        });
        existingIds.add(idStr); // 添加到已存在集合，避免重复
      }

      if (newMessages.length > 0) {
        const merged = history.concat(newMessages);
        const limited = merged.length > 50 ? merged.slice(-50) : merged;
        ChatStream.messageHistory.set(groupId, limited);

      }
    } catch (error) {
      BotUtil.makeLog(
        'debug',
        `[ChatStream.syncHistoryFromAdapter] 获取聊天记录失败: ${error.message}`,
        'ChatStream'
      );
    }
  }

  /**
   * 从 at 消息段解析出展示内容（优先 QQ，兼容 data.qq/data.user_id，昵称为空时也能解析出 QQ）
   * @param {Object} seg - at 类型消息段（可能为 { type:'at', qq } 或 { type:'at', data: { qq } }）
   * @returns {string} 展示用字符串，如 QQ 号或「未知用户」
   */
  _atSegmentToDisplay(seg) {
    if (!seg || seg.type !== 'at') return '未知用户';
    const qq = seg.qq ?? seg.user_id ?? seg.data?.qq ?? seg.data?.user_id;
    return (qq != null && String(qq).trim() !== '') ? String(qq).trim() : '未知用户';
  }

  /**
   * 格式化历史消息为文本（统一格式化逻辑）
   * 自己发过的回复标为【我】，便于模型识别「已回复过、勿重复」
   * @param {Object} msg - 消息对象
   * @returns {string} 格式化后的文本
   */
  _formatHistoryMessage(msg) {
    const msgId = msg.message_id || msg.real_id || '未知';
    const imageTag = msg.hasImage ? '[含图片]' : '';
    const toolLabel = msg.isTool && msg.toolName ? String(msg.toolName) : '';
    const toolTag = msg.isTool ? (toolLabel ? `[工具·${toolLabel}]` : '[工具]') : '';
    const tags = [imageTag, toolTag].filter(Boolean).join(' ');
    if (msg.isBot) {
      const content = this._normalizeMessageText((msg.message || '').replace(/\n/g, ' '));
      return `${tags ? tags + ' ' : ''}【我】${content}`;
    }
    const userId = msg.user_id || msg.userId || '未知QQ';
    const nickname = msg.nickname || '未知用户';
    const content = this._normalizeMessageText(msg.message || '');
    return `${tags ? tags + ' ' : ''}${nickname}(${userId})[ID:${msgId}]: ${content}`;
  }

  async mergeMessageHistory(messages, e) {
    if (!e?.isGroup || messages.length < 2) return messages;

    await this.syncHistoryFromAdapter(e);

    const userMessage = messages[messages.length - 1];
    const isGlobalTrigger = userMessage.content?.isGlobalTrigger || false;
    const debugDumpFullPrompt = userMessage.content?.debugDumpFullPrompt || false;
    const history = ChatStream.messageHistory.get(e.group_id) || [];
    const historyLimit = debugDumpFullPrompt ? 50 : (isGlobalTrigger ? 15 : 10);
    const historyHeader = debugDumpFullPrompt
      ? `[群聊·最近${historyLimit}条]`
      : '[群聊记录]';

    const mergedMessages = [messages[0]];
    const currentMsgId = e.message_id || e.real_id || e.messageId || e.id || e.source?.id || '未知';
    const currentUserNickname = e.sender?.card || e.sender?.nickname || e.user?.name || '用户';
    const currentContent = typeof userMessage.content === 'string'
      ? userMessage.content
      : (userMessage.content?.text ?? '');

    const filteredHistory = history.filter(msg =>
      String(msg.message_id) !== String(currentMsgId)
    );
    const recentMessages = filteredHistory.slice(-historyLimit);

    if (recentMessages.length > 0) {
      const historyText = `${historyHeader}\n${recentMessages.map(msg => this._formatHistoryMessage(msg)).join('\n')}`;
      mergedMessages.push({
        role: 'user',
        content: isGlobalTrigger
          ? `${historyText}\n\n请像群里真人一样接一两句：对准气氛或某条发言，可吐槽玩梗；勿全文总结、勿逐条点评。`
          : historyText
      });
    }

    if (!isGlobalTrigger) {
      const showCurrentLine =
        currentMsgId !== '未知' && (Boolean(currentContent) || debugDumpFullPrompt);
      const hasMedia =
        typeof userMessage.content === 'object' &&
        userMessage.content !== null &&
        (((userMessage.content.images || []).length > 0) ||
          ((userMessage.content.replyImages || []).length > 0));
      const lineBody =
        (currentContent && String(currentContent).trim())
          ? currentContent
          : (hasMedia ? '[附图]' : '[无文本]');
      if (showCurrentLine) {
        if (typeof userMessage.content === 'object' && userMessage.content !== null) {
          const content = userMessage.content;
          const baseText = content.text || content.content || lineBody;
          mergedMessages.push({
            role: 'user',
            content: {
              text: `[当前消息]\n${currentUserNickname}(${e.user_id})[ID:${currentMsgId}]: ${baseText}`,
              images: content.images || [],
              replyImages: content.replyImages || []
            }
          });
        } else {
          mergedMessages.push({
            role: 'user',
            content: `[当前消息]\n${currentUserNickname}(${e.user_id})[ID:${currentMsgId}]: ${currentContent || lineBody}`
          });
        }
      } else if (currentContent) {
        const content = userMessage.content;
        if (typeof content === 'object' && content.text) {
          mergedMessages.push({
            role: 'user',
            content: {
              text: content.text,
              images: content.images || [],
              replyImages: content.replyImages || []
            }
          });
        } else {
          mergedMessages.push(userMessage);
        }
      }
    }
    return mergedMessages;
  }

  /**
   * 除去用户 content 上的内部标记，避免进入真实 API 请求体。
   */
  static stripInternalMessageFlags(messages) {
    if (!Array.isArray(messages)) return messages;
    return messages.map((msg) => {
      if (msg.role !== 'user' || msg.content == null || typeof msg.content !== 'object' || Array.isArray(msg.content)) {
        return msg;
      }
      if (msg.content.debugDumpFullPrompt === undefined && msg.content.isGlobalTrigger === undefined) {
        return msg;
      }
      const { debugDumpFullPrompt: _d, isGlobalTrigger: _g, ...content } = msg.content;
      return { ...msg, content };
    });
  }

  /**
   * 调试：在请求 LLM 前将首轮 POST 请求体（及组装 messages）写入 data/ai_llm_request_*.json。
   */
  async callAI(messages, apiConfig = {}) {
    const { debugDumpFullPrompt, _debugDumpEvent: dumpEvent, ...rest } = apiConfig;
    const forApi = ChatStream.stripInternalMessageFlags(messages);

    if (debugDumpFullPrompt && dumpEvent && Array.isArray(forApi) && forApi.length > 0) {
      try {
        const r = await ChatStream.dumpLlmRequestSnapshot(this, dumpEvent, forApi, rest);
        BotUtil.makeLog(
          r.success ? 'info' : 'warn',
          r.success
            ? `[ChatStream] 已导出 LLM 请求体: ${r.path}`
            : `[ChatStream] 请求体导出失败: ${r.error || '未知'}`,
          'ChatStream'
        );
      } catch (err) {
        BotUtil.makeLog('error', `[ChatStream] 请求体导出异常: ${err?.message}`, 'ChatStream');
      }
    }

    return super.callAI(forApi, rest);
  }

  async execute(e, messages, config) {
    let debugDumpFullPrompt = false;
    if (!Array.isArray(messages) && messages && typeof messages === 'object') {
      debugDumpFullPrompt = !!messages.debugDumpFullPrompt;
    }

    try {
      // 记录当前消息（统一记录逻辑）
      if (e) this.recordMessage(e);

      if (!Array.isArray(messages)) {
        messages = await this.buildChatContext(e, messages);
      }

      messages = await this.mergeMessageHistory(messages, e);

      const query = Array.isArray(messages) ? this.extractQueryFromMessages(messages) : messages;
      messages = await this.buildEnhancedContext(e, query, messages);

      if (Bot.StreamLoader) Bot.StreamLoader.currentEvent = e || null;
      this._hasSentEmotionThisTurn = false;

      const llm = await this.callAI(messages, {
        ...config,
        debugDumpFullPrompt,
        _debugDumpEvent: e
      });
      if (llm == null) return null;

      let text = String(llm.text ?? '').trim();
      if (text) {
        text = this.stripMarkdownForOutgoing(text);
      }

      if (this.config.forwardAssistantText !== false && text && e?.reply && !llm.usedReplyTool) {
        await this.sendMessages(e, text);
      }

      return text || '';
    } catch (error) {
      BotUtil.makeLog('error', `[ChatStream] execute 失败: ${error.message}`, 'ChatStream');
      return null;
    } finally {
      this._hasSentEmotionThisTurn = false;
      if (Bot.StreamLoader?.currentEvent === e) Bot.StreamLoader.currentEvent = null;
    }
  }

  /**
   * 文本协议处理与发送：分句（| 或 ｜）、表情、CQ、图片内容标记；限制一轮一次表情包。
   * @returns {Promise<{totalSent: number, allSentContent: string[]}>}
   */
  async _processAndSendTextProtocol(e, content, options = {}) {
    const { messageId, recordToHistory = true, updateReplyContents = true, skipEmotionCheck = false } = options;
    if (!e?.reply || !content?.trim()) {
      return { totalSent: 0, allSentContent: [] };
    }

    // 分句：半角 | 与全角 ｜ 均作为分隔符，每条单独发送
    const messages = content.split(/[|｜]/).map(m => m.trim()).filter(Boolean);
    if (messages.length === 0) {
      return { totalSent: 0, allSentContent: [] };
    }

    const seg = global.segment || segment;
    let totalSent = 0;
    const allSentContent = [];
    let hasEmotionInThisContent = false; // 检查当前内容中是否有表情包

    for (let i = 0; i < messages.length; i++) {
      let msg = messages[i];
      if (!msg) continue;

      // 提取图片内容标记（不会被用户看见）
      const { imageContent, text: afterImageMark } = this.parseImageContentMark(msg);
      msg = afterImageMark;

      // 提取表情标记
      const { emotion, text: afterEmotion } = this.parseTextProtocolEmotion(msg);
      msg = afterEmotion;

      // 解析CQ码和回复标记
      const { replyId, segments: parsedSegments } = this.parseCQToSegments(msg, e);
      let segments = parsedSegments;

      // ⚠️ 重要：处理表情包 - 一次聊天最好只发一次表情包
      if (emotion) {
        if (!skipEmotionCheck && this._hasSentEmotionThisTurn) {
          BotUtil.makeLog('debug', `[ChatStream] _processAndSendTextProtocol 跳过重复表情包 emotion=${emotion}`, 'ChatStream');
          hasEmotionInThisContent = true;
        } else {
          // 首次发送表情包，允许发送
          const image = this.getRandomEmotionImage(emotion);
          if (image) {
            segments = segments.length > 0 ? [seg.image(image), ...segments] : [seg.image(image)];
            if (!skipEmotionCheck) {
              this._hasSentEmotionThisTurn = true;
            }
            hasEmotionInThisContent = true;
          }
        }
      }

      // 确定回复ID：优先使用content中的[回复:消息ID]，其次使用messageId参数
      const finalReplyId = replyId || messageId;

      // 发送消息（图片内容标记已被移除，用户看不到）
      const sentContent = segments.length > 0 
        ? segments.map(s => s.type === 'text' ? s.text : '').join('') 
        : msg;
      
      if (finalReplyId) {
        const replySegment = seg.reply(finalReplyId);
        await e.reply(segments.length > 0 ? [replySegment, ...segments] : [replySegment, ' ']);
      } else if (segments.length > 0) {
        await e.reply(segments);
      } else {
        await e.reply(msg || ' ');
      }

      // 记录发送的内容（包含图片内容标记，用于历史记录）
      if (recordToHistory) {
        const originalTextWithMark = imageContent 
          ? `${sentContent || msg}[图片内容:${imageContent}]` 
          : (sentContent || msg);
        this.recordAIResponse(e, originalTextWithMark);
      }
      
      // 计入回复记录（记录用户实际看到的内容，不含图片内容标记）
      if (updateReplyContents) {
        allSentContent.push(sentContent || msg);
      }
      totalSent++;

      // ⚠️ 重要：多条消息之间延迟，避免发送过快
      if (i < messages.length - 1) {
        await BotUtil.sleep(randomRange(800, 1500));
      }
    }

    return { totalSent, allSentContent };
  }

  /**
   * 解析文本协议：提取 [开心]/[惊讶] 等表情标签，返回 { emotion, text }
   */
  parseTextProtocolEmotion(text) {
    const emotionRegex = /\[(开心|惊讶|伤心|大笑|害怕|生气)\]/;
    const match = text.match(emotionRegex);
    if (!match || !EMOTION_TYPES.includes(match[1])) return { emotion: null, text };
    return {
      emotion: match[1],
      text: text.replace(emotionRegex, '').trim()
    };
  }

  /**
   * 解析图片内容标记：提取 [图片内容:描述]，返回 { imageContent, text }
   * 此标记不会被用户看见，仅记录到聊天历史
   */
  parseImageContentMark(text) {
    const imageContentRegex = /\[图片内容:([^\]]+)\]/g;
    const matches = [];
    let match;
    while ((match = imageContentRegex.exec(text)) !== null) {
      matches.push(match[1]);
    }
    if (matches.length === 0) return { imageContent: null, text };
    const cleanText = text.replace(imageContentRegex, '').trim();
    return {
      imageContent: matches.join('；'), // 多个标记用分号连接
      text: cleanText
    };
  }

  /**
   * 用户可见路径：先保护文本协议片段，再剥离 Markdown，不把 MD 语法发到 QQ。
   * 围栏代码块整段丢弃（不把代码块当正文发出）；其余语法尽量还原成可读纯文本。
   */
  stripMarkdownForOutgoing(text) {
    if (!text || typeof text !== 'string') return '';
    const { masked, tokens } = ChatStream._protectProtocolMarkers(text);
    const stripped = ChatStream._stripMarkdownCore(masked);
    return ChatStream._restoreProtocolMarkers(stripped, tokens).trim();
  }

  /** 协议片段占位，避免被 Markdown 规则误伤（含表情、[CQ]、[回复]、[图片内容:]） */
  static _protectProtocolMarkers(text) {
    const tokens = [];
    const re =
      /(\[(?:开心|惊讶|伤心|大笑|害怕|生气)\]|(?:\[图片内容:[^\]]+\])|(?:\[回复:(?:ID:)?\d+\])|(?:\[CQ:[^\]]+\]))/g;
    const masked = text.replace(re, (full) => {
      const i = tokens.length;
      tokens.push(full);
      return `\uE000PRT${i}\uE001`;
    });
    return { masked, tokens };
  }

  static _restoreProtocolMarkers(text, tokens) {
    let out = text;
    for (let i = 0; i < tokens.length; i++) {
      out = out.split(`\uE000PRT${i}\uE001`).join(tokens[i]);
    }
    return out;
  }

  /** 对已无协议占位的内容剥离 Markdown（不在此处恢复占位符） */
  static _stripMarkdownCore(clean) {
    if (!clean || typeof clean !== 'string') return '';

    // 围栏代码块：整段不发出（避免把 Markdown 代码抄到群里）
    clean = clean.replace(/```[\s\S]*?```/g, '');

    clean = clean.replace(/`([^`]+)`/g, '$1');
    clean = clean.replace(/\*\*([^*]+)\*\*/g, '$1');
    clean = clean.replace(/__([^_]+)__/g, '$1');
    clean = clean.replace(/(?<!\*)\*([^*\[]+?)\*(?!\*)/g, '$1');
    clean = clean.replace(/(?<!_)_([^_[]+?)_(?!_)/g, '$1');
    clean = clean.replace(/~~([^~]+)~~/g, '$1');
    clean = clean.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
    clean = clean.replace(/\[([^\]]+)\]\[[^\]]+\]/g, '$1');
    clean = clean.replace(/!\[([^\]]*)\]\([^\)]+\)/g, '');
    clean = clean.replace(/^#{1,6}\s+(.+)$/gm, '$1');
    clean = clean.replace(/^>\s+(.+)$/gm, '$1');
    clean = clean.replace(/^[\s]*[-*+]\s+(.+)$/gm, '$1');
    clean = clean.replace(/^[\s]*\d+\.\s+(.+)$/gm, '$1');
    clean = clean.replace(/^[-*]{3,}$/gm, '');

    clean = clean
      .split('\n')
      .map((line) => {
        const trimmedLine = line.trim();
        const pipeCount = (line.match(/\|/g) || []).length;
        if (trimmedLine.startsWith('|') && pipeCount >= 2) {
          const cells = [];
          const regex = /\|\s*([^|]*?)\s*\|/g;
          let match;
          while ((match = regex.exec(trimmedLine)) !== null) {
            cells.push(match[1].trim());
          }
          return cells.join(' ');
        }
        return line;
      })
      .join('\n');
    clean = clean.replace(/^\|\s*[-:\s|]+\s*\|$/gm, '');
    clean = clean.replace(/\n{3,}/g, '\n\n');
    clean = clean.split('\n').map((line) => line.trim()).join('\n');
    return clean.trim();
  }

  parseCQToSegments(text, e) {
    const segments = [];
    let replyId = null;

    // [回复:消息ID] 或 [回复:ID:消息ID]
    const replyShortMatch = text.match(/\[回复:(?:ID:)?(\d+)\]/);
    if (replyShortMatch) {
      replyId = replyShortMatch[1];
      text = text.replace(/\[回复:(?:ID:)?\d+\]/g, '').trim();
    }
    const replyMatch = text.match(/\[CQ:reply,id=(\d+)\]/);
    if (replyMatch) {
      replyId = replyId || replyMatch[1];
      text = text.replace(/\[CQ:reply,id=\d+\]/g, '').trim();
    }

    const cqPattern = /\[CQ:(\w+)(?:,([^\]]+))?\]/g;
    let match;
    let currentIndex = 0;
    const seg = global.segment || segment;
    while ((match = cqPattern.exec(text)) !== null) {
      const [full, type, params] = match;
      if (match.index > currentIndex) {
        const textBefore = text.slice(currentIndex, match.index);
        if (textBefore.trim()) segments.push(textBefore);
      }
      currentIndex = match.index + full.length;
      const paramObj = {};
      if (params) {
        params.split(',').forEach(p => {
          const [key, value] = p.split('=');
          if (key && value) paramObj[key.trim()] = value.trim();
        });
      }
      if (type === 'at' && paramObj.qq) {
        if (e.isGroup) {
          const history = ChatStream.messageHistory.get(e.group_id) || [];
          const userExists = history.some(msg => String(msg.user_id) === String(paramObj.qq));
          if (userExists || e.isMaster) segments.push(seg.at(paramObj.qq));
        } else {
          segments.push(seg.at(paramObj.qq));
        }
      } else if (type === 'image' && paramObj.file) {
        segments.push(seg.image(paramObj.file));
      }
    }

    if (currentIndex < text.length) {
      const textAfter = text.slice(currentIndex);
      if (textAfter.trim()) {
        segments.push(textAfter);
      }
    }

    const mergedSegments = [];
    for (let i = 0; i < segments.length; i++) {
      const current = segments[i];
      const last = mergedSegments[mergedSegments.length - 1];
      if (typeof current === 'string' && typeof last === 'string') {
        mergedSegments[mergedSegments.length - 1] = last + current;
      } else {
        mergedSegments.push(current);
      }
    }
    
    return { replyId, segments: mergedSegments };
  }

  async sendMessages(e, cleanText) {
    if (!cleanText || !cleanText.trim() || !e?.reply) return;

    const filteredText = this.stripMarkdownForOutgoing(cleanText);
    if (!filteredText) return;

    await this._processAndSendTextProtocol(e, filteredText, {
      messageId: null,
      recordToHistory: true,
      updateReplyContents: true
    });
  }

  cleanupCache() {
    for (const [groupId, messages] of ChatStream.messageHistory.entries()) {
      if (!messages?.length) {
        ChatStream.messageHistory.delete(groupId);
        continue;
      }
      if (messages.length > 50) {
        ChatStream.messageHistory.set(groupId, messages.slice(-50));
      }
    }
  }

  /** 导出 JSON 中的 LLM 配置副本脱敏（与真实内存对象分离） */
  static _redactLlmConfigForDump(cfg) {
    if (!cfg || typeof cfg !== 'object') return cfg;
    let clone;
    try {
      clone = typeof structuredClone === 'function' ? structuredClone(cfg) : JSON.parse(JSON.stringify(cfg));
    } catch {
      return { _note: '配置无法完整克隆，已省略' };
    }
    const mask = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const k of Object.keys(o)) {
        const lk = k.toLowerCase();
        const v = o[k];
        if (typeof v === 'string' && v.length > 0) {
          const sensitive =
            lk === 'apikey' ||
            lk === 'api_key' ||
            lk === 'authorization' ||
            lk.endsWith('_token') ||
            lk === 'access_token' ||
            lk === 'refresh_token' ||
            lk.includes('secret') ||
            lk.includes('password');
          if (sensitive) {
            o[k] = '***';
          }
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
          mask(v);
        }
      }
    };
    mask(clone);
    return clone;
  }

  /**
   * 与 lib/aistream/aistream.js `callAI` 首轮一致：`resolveLLMConfig` + `{ stream:false, streams }` 再 `buildBody`。
   */
  static async _buildRound1RequestBody(client, ctor, messagesAssembled, overrides, timeoutMs) {
    const openAiVisionFirst = new Set([
      'OpenAICompatibleLLMClient',
      'OpenAILLMClient',
      'AzureOpenAICompatibleLLMClient'
    ]);

    if (ctor === 'OllamaCompatibleLLMClient' && typeof client.transformMessages === 'function' && typeof client.toOllamaMessages === 'function') {
      const t = await client.transformMessages(messagesAssembled);
      const ollamaMsgs = await client.toOllamaMessages(t);
      return client.buildBody(ollamaMsgs, overrides, false);
    }
    if (openAiVisionFirst.has(ctor)) {
      const prepared = await prepareOpenAIChatVisionMessages(messagesAssembled, client.config, { timeoutMs });
      return client.buildBody(prepared, overrides);
    }
    if (ctor === 'OpenAIResponsesCompatibleLLMClient') {
      const transformed = await prepareOpenAIChatVisionMessages(messagesAssembled, client.config, { timeoutMs });
      const input = transformed.map((m) => ({
        role: m.role || 'user',
        content: Array.isArray(m.content)
          ? m.content.map((part) => {
              if (part?.type === 'text') return { type: 'input_text', text: String(part.text || '') };
              if (part?.type === 'image_url' && part.image_url?.url) {
                return { type: 'input_image', image_url: String(part.image_url.url) };
              }
              return part;
            })
          : typeof m.content === 'string'
            ? [{ type: 'input_text', text: m.content }]
            : [{ type: 'input_text', text: m.content?.text || '' }]
      }));
      return client.buildBody(input, overrides, { stream: false });
    }
    if (typeof client.transformMessages === 'function') {
      const prepared = await client.transformMessages(messagesAssembled);
      return client.buildBody(prepared, overrides);
    }
    const prepared = await prepareOpenAIChatVisionMessages(messagesAssembled, client.config, { timeoutMs });
    return client.buildBody(prepared, overrides);
  }

  /**
   * 导出与真实 API 首轮 POST 一致的 `request_body`，并附带脱敏后的合并配置（与线上一致）。
   * @returns {Promise<{ success: boolean, path?: string, error?: string }>}
   */
  static async dumpLlmRequestSnapshot(stream, e, messagesAssembled, apiConfigRest) {
    const result = { success: false };
    try {
      const resolved = stream.resolveLLMConfig(apiConfigRest || {});
      const client = LLMFactory.createClient(resolved);
      const toolStreamNames = stream._getToolStreamNames();
      const overrides = { ...resolved, stream: false, streams: toolStreamNames };
      const timeoutMs = client.timeout ?? client._timeout ?? 360000;
      const ctor = client.constructor?.name || '';

      let requestBody = null;
      let requestBodyError = null;

      if (typeof client.buildBody === 'function' && client.config) {
        try {
          requestBody = await ChatStream._buildRound1RequestBody(client, ctor, messagesAssembled, overrides, timeoutMs);
        } catch (prepErr) {
          requestBodyError = prepErr.message;
          BotUtil.makeLog('warn', `[ChatStream] request_body 构建失败，仅写入 messages_assembled: ${prepErr.message}`, 'ChatStream');
        }
      }

      const payload = {
        at: new Date().toISOString(),
        workflow: stream.name,
        client_class: ctor,
        group_id: e?.group_id ?? null,
        user_id: e?.user_id ?? null,
        endpoint: typeof client.endpoint === 'string' ? client.endpoint : null,
        llm_resolved: ChatStream._redactLlmConfigForDump(resolved),
        call_overrides: ChatStream._redactLlmConfigForDump(overrides),
        messages_assembled: messagesAssembled,
        ...(requestBody != null ? { request_body: requestBody } : {}),
        ...(requestBodyError ? { request_body_error: requestBodyError } : {})
      };

      let bodyText;
      try {
        bodyText = JSON.stringify(payload, null, 2);
      } catch (serErr) {
        payload.messages_assembled = `[序列化失败: ${serErr.message}]`;
        bodyText = JSON.stringify(payload, null, 2);
      }

      const fpath = resolveProjectPath(DATA_DIR, `ai_llm_request_${Date.now()}.json`);
      const ok = await FileUtils.writeFile(fpath, bodyText, 'utf8');
      if (!ok) {
        result.error = 'writeFile 失败';
        return result;
      }
      result.success = true;
      result.path = fpath;
    } catch (error) {
      result.error = error.message;
      BotUtil.makeLog('error', `[ChatStream] dumpLlmRequestSnapshot 失败: ${error.message}`, 'ChatStream');
    }
    return result;
  }

  /**
   * 清除指定群组/用户的完整对话记录
   * @param {string|number} groupId - 群组ID或用户ID
   * @returns {Promise<Object>} 清除结果
   */
  static async clearConversation(groupId) {
    const gid = String(groupId);
    const result = {
      success: true,
      cleared: {
        history: false
      }
    };

    try {
      // 清除聊天记录
      if (ChatStream.messageHistory.has(gid)) {
        ChatStream.messageHistory.delete(gid);
        result.cleared.history = true;
        BotUtil.makeLog('debug', `[ChatStream] clearConversation 清除聊天记录 group=${gid}`, 'ChatStream');
      }

      BotUtil.makeLog('debug', `[ChatStream] clearConversation 完成 group=${gid} cleared=${JSON.stringify(result.cleared)}`, 'ChatStream');
    } catch (error) {
      result.success = false;
      BotUtil.makeLog('error', `[ChatStream] clearConversation 失败: ${error.message}`, 'ChatStream');
    }

    return result;
  }

  async cleanup() {
    await super.cleanup();
    
    if (ChatStream.cleanupTimer) {
      clearInterval(ChatStream.cleanupTimer);
      ChatStream.cleanupTimer = null;
    }
  }
}