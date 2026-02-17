import path from 'path';
import fs from 'fs';
import AIStream from '../../../lib/aistream/aistream.js';
import BotUtil from '../../../lib/util.js';

const EMOTIONS_DIR = path.join(process.cwd(), 'resources/aiimages');
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
        frequencyPenalty: 0.6
      },
      embedding: { enabled: false }
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

  registerAllFunctions() {
    this.registerMCPTool('at', {
      description: '@群成员并可选附带一句话。在群聊中@指定用户，可只发 at 或 at+文本（如 @某人 你好）。仅群聊可用。',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '要@的用户QQ号（必填），须为群内成员。'
          },
          text: {
            type: 'string',
            description: '可选。@ 后跟的简短文字，与 at 同条消息发出。'
          }
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
          // 返回实际发送内容给 AI 作为上下文，避免正文重复发类似内容
          const MAX_RAW_LEN = 400;
          const sentSummary = text
            ? `已发送（请让下一条内容与之连贯）：@${qq} ${text.length > MAX_RAW_LEN ? text.slice(0, MAX_RAW_LEN) + '…' : text}`
            : `已@${qq}（请让下一条内容与之连贯）`;
          return { success: true, raw: sentSummary };
        }, 200);
      },
      enabled: true
    });

    this.registerMCPTool('poke', {
      description: '戳一戳对方（执行戳一戳动作，无需在文本中说明）。群聊戳群成员，私聊戳好友。qq 填当前说话人。调用此工具后，戳一戳动作会自动执行，不需要在reply工具的content中追加任何文本（如"poke xxxxx"）。',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '要戳的QQ号（用户说戳我时填当前说话人），须为 5-10 位数字。调用此工具后，戳一戳动作会自动执行，不需要在reply工具的content中追加任何文本。'
          }
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
          return { success: true, raw: '戳一戳已发送' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('reply', {
      description: '发送文本到当前会话（立即发出），支持文本协议：|分隔多句、[开心]表情、[CQ:at,qq=QQ号]@人、[回复:消息ID]引用回复。需要引用回复某条消息、或需要与工具操作（如搜索/查票）配合时使用。直接输出文本时无需调用此工具。',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: {
            type: 'string',
            description: '要引用回复的消息ID（可选，优先级低于content中的[回复:消息ID]）。填写则发送为「回复该条消息」的形式。'
          },
          content: {
            type: 'string',
            description: '要发送的文本内容（必填）。支持文本协议：用|分隔多句（每句单独发送）、[开心]/[惊讶]等表情、[CQ:at,qq=QQ号]@人、[回复:消息ID]引用回复、[图片内容:描述]标记（不显示给用户）。'
          }
        },
        required: ['content']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        if (!e?.reply) return { success: false, error: '当前环境无法发送消息' };
        const content = String(args.content ?? '').trim();
        if (!content) return { success: false, error: 'content 不能为空' };
        BotUtil.makeLog('debug', `[ChatStream] reply 工具调用 group=${e?.group_id} messageId=${args.messageId ?? '无'} contentLen=${content.length} content=${content}`, 'ChatStream');
        return this._wrapHandler(async () => {
          // 过滤Markdown格式
          let filteredContent = this.filterMarkdown(content);
          if (filteredContent !== content) {
            BotUtil.makeLog('debug', `[ChatStream] reply 工具过滤Markdown beforeLen=${content.length} afterLen=${filteredContent.length}`, 'ChatStream');
          }
          
          // ⚠️ 使用统一的文本协议处理和发送方法
          const { totalSent, allSentContent } = await this._processAndSendTextProtocol(e, filteredContent, {
            messageId: args.messageId,
            recordToHistory: true,
            updateReplyContents: true
          });
          
          const preview = allSentContent.join('|');
          // 日志输出完整内容
          BotUtil.makeLog('debug', `[ChatStream] reply 已发送 ${totalSent}条消息 contentLen=${content.length} content=${content} preview=${preview}`, 'ChatStream');
          // 返回给AI的结果可以截断（避免工具返回过长）
          const MAX_RETURN_PREVIEW_LENGTH = 500;
          const returnPreview = preview.length > MAX_RETURN_PREVIEW_LENGTH
            ? preview.slice(0, MAX_RETURN_PREVIEW_LENGTH) + '…'
            : preview;
          const n = this._replyCountThisTurn || 0;
          return { success: true, raw: `已发送（本轮第${n - totalSent + 1}-${n}条，共${totalSent}条；下一条请与之连贯；见好就收：如已足够回答用户就别再追加多条消息/复述/消息内容内核别重复）。若已满足用户需求：建议直接结束本轮（优先不再调用其它工具，也无需再输出正文）：${returnPreview}` };
        });
      },
      enabled: true
    });

    this.registerMCPTool('emojiReaction', {
      description: '对群消息进行表情回应。支持：开心、惊讶、伤心、大笑、害怕、喜欢、爱心、生气。不指定消息ID时自动选择最近一条他人消息。仅群聊环境可用。',
      inputSchema: {
        type: 'object',
        properties: {
          msgId: {
            type: 'string',
            description: '要回应的消息ID（可选，不填则自动选择最近一条消息）'
          },
          emojiType: {
            type: 'string',
            description: '表情类型（必填）。可选值：开心、惊讶、伤心、大笑、害怕、喜欢、爱心、生气。根据消息内容和用户意图选择合适的表情。',
            enum: ['开心', '惊讶', '伤心', '大笑', '害怕', '喜欢', '爱心', '生气']
          }
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
              return { success: true, raw: '戳一戳已发送' };
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
      description: '发表情包到当前会话，可带可选文字（同条消息发出）。表达情绪时调用，类型：开心/惊讶/伤心/大笑/害怕/生气。',
      inputSchema: {
        type: 'object',
        properties: {
          emotionType: {
            type: 'string',
            description: '表情类型：开心、惊讶、伤心、大笑、害怕、生气',
            enum: ['开心', '惊讶', '伤心', '大笑', '害怕', '生气']
          },
          text: {
            type: 'string',
            description: '可选。与表情包同条消息发出的简短文字（如「哈哈」）。'
          }
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
          return {
            success: true,
            raw:
              '已跳过（本轮已发送过一次表情包，本次 emotion 不再重复发送）。建议不要再重复调用 emotion（同参重试无效），直接用正文承接并尽快收尾：1-2 句即可。'
          };
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
          // 更新回复内容记录
          if (!Array.isArray(this._replyContentsThisTurn)) this._replyContentsThisTurn = [];
          this._replyContentsThisTurn.push(sentText || `[${t}]`);
          this._replyCountThisTurn = (this._replyCountThisTurn || 0) + 1;
          const rawContent = sentText ? sentText : `[表情${t}]`;
          const raw = `已发送（与正文同属一条回复，请让后续内容与之连贯）：${rawContent}`;
          return { success: true, raw };
        });
      },
      enabled: true
    });

    this.registerMCPTool('thumbUp', {
      description: '给群成员点赞',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '要点赞的成员QQ号'
          },
          count: {
            type: 'number',
            description: '点赞次数（1-50）',
            default: 1
          }
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
          return { success: true, raw: '戳一戳已发送' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('sign', {
      description: '群签到',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.sign();
          return { success: true, message: '签到成功' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('mute', {
      description: '禁言群成员。需要管理员或群主权限。仅群聊环境可用。',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '要禁言的成员QQ号'
          },
          duration: {
            type: 'number',
            description: '禁言时长（秒）'
          }
        },
        required: ['qq', 'duration']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.muteMember(args.qq, args.duration);
          return { success: true, raw: '戳一戳已发送' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('unmute', {
      description: '解除禁言',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '要解禁的成员QQ号'
          }
        },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.muteMember(args.qq, 0);
          return { success: true, raw: '戳一戳已发送' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('muteAll', {
      description: '全员禁言',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.muteAll(true);
          return { success: true, message: '全员禁言成功' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('unmuteAll', {
      description: '解除全员禁言',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.muteAll(false);
          return { success: true, message: '解除全员禁言成功' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setCard', {
      description: '修改群名片。未指定QQ号时默认修改机器人自己的名片。需要管理员或群主权限。仅群聊环境可用。',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '成员QQ号'
          },
          card: {
            type: 'string',
            description: '新名片'
          }
        },
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
          return { success: true, raw: '戳一戳已发送' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setGroupName', {
      description: '修改群名',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '新群名'
          }
        },
        required: ['name']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.setName(args.name);
          return { success: true, raw: '戳一戳已发送' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setAdmin', {
      description: '设置管理员',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '成员QQ号'
          }
        },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.setAdmin(args.qq, true);
          return { success: true, raw: '戳一戳已发送' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('unsetAdmin', {
      description: '取消管理员',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '成员QQ号'
          }
        },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.setAdmin(args.qq, false);
          return { success: true, raw: '戳一戳已发送' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setTitle', {
      description: '设置专属头衔',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '成员QQ号'
          },
          title: {
            type: 'string',
            description: '头衔名称'
          },
          duration: {
            type: 'number',
            description: '持续时间（秒）',
            default: -1
          }
        },
        required: ['qq', 'title']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.setTitle(args.qq, args.title, args.duration || -1);
          return { success: true, raw: '戳一戳已发送' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('kick', {
      description: '踢出群成员',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '要踢出的成员QQ号'
          },
          reject: {
            type: 'boolean',
            description: '是否拒绝再次申请',
            default: false
          }
        },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.kickMember(args.qq, args.reject || false);
          return { success: true, raw: '戳一戳已发送' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setEssence', {
      description: '设置精华消息',
      inputSchema: {
        type: 'object',
        properties: {
          msgId: {
            type: 'string',
            description: '消息ID'
          }
        },
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
          if (group && typeof group.setEssenceMessage === 'function') {
            await group.setEssenceMessage(msgId);
            return { success: true, raw: '戳一戳已发送' };
          } else if (context.e.bot?.sendApi) {
            await context.e.bot.sendApi('set_essence_msg', { message_id: msgId });
            return { success: true, raw: '戳一戳已发送' };
          }
          return { success: false, error: 'API不可用' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('removeEssence', {
      description: '取消精华消息',
      inputSchema: {
        type: 'object',
        properties: {
          msgId: {
            type: 'string',
            description: '消息ID'
          }
        },
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
          if (group && typeof group.removeEssenceMessage === 'function') {
            await group.removeEssenceMessage(msgId);
            return { success: true, raw: '戳一戳已发送' };
          }
          return { success: false, error: 'API不可用' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('announce', {
      description: '发送群公告',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '公告内容'
          },
          image: {
            type: 'string',
            description: '公告图片URL（可选）'
          }
        },
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
          
          if (group && typeof group.sendNotice === 'function') {
            const result = await group.sendNotice(content, image ? { image } : {});
            if (result !== undefined) {
              return { success: true, raw: '已发送' };
            }
          } else if (context.e.bot?.sendApi) {
            const apiParams = { group_id: context.e.group_id, content };
            if (image) apiParams.image = image;
            const result = await context.e.bot.sendApi('_send_group_notice', apiParams);
            if (result?.status === 'ok') {
              return { success: true, raw: '已发送' };
            }
          }
          return { success: false, error: 'API不可用' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('recall', {
      description: '撤回消息',
      inputSchema: {
        type: 'object',
        properties: {
          msgId: {
            type: 'string',
            description: '要撤回的消息ID'
          }
        },
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
            } else if (context.e.bot) {
              await context.e.bot.sendApi('delete_msg', { message_id: args.msgId });
            }
            return { success: true, raw: '戳一戳已发送' };
          });
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('getGroupInfoEx', {
      description: '获取群的扩展详细信息（包括更多群信息）。此功能仅在群聊中可用。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          const group = context.e.group;
          if (group && typeof group.getInfoEx === 'function') {
            const info = await group.getInfoEx();
            BotUtil.makeLog('debug', `获取群信息ex成功: ${JSON.stringify(info)}`, 'ChatStream');
            const result = { success: true, data: info };
            this.recordToolCallResult(context.e, 'getGroupInfoEx', result);
            return result;
          }
          const result = { success: false, error: 'API不可用' };
          this.recordToolCallResult(context.e, 'getGroupInfoEx', result);
          return result;
        }, 0).catch(error => {
          BotUtil.makeLog('warn', `获取群信息ex失败: ${error.message}`, 'ChatStream');
          const result = { success: false, error: error.message };
          this.recordToolCallResult(context.e, 'getGroupInfoEx', result);
          return result;
        });
      },
      enabled: true
    });

    this.registerMCPTool('getAtAllRemain', {
      description: '获取群@全体成员的剩余次数',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          const group = context.e.group;
          if (group && typeof group.getAtAllRemain === 'function') {
            const remain = await group.getAtAllRemain();
            BotUtil.makeLog('debug', `@全体成员剩余次数: ${JSON.stringify(remain)}`, 'ChatStream');
            const result = { success: true, data: remain };
            this.recordToolCallResult(context.e, 'getAtAllRemain', result);
            return result;
          }
          const result = { success: false, error: 'API不可用' };
          this.recordToolCallResult(context.e, 'getAtAllRemain', result);
          return result;
        }, 0).catch(error => {
          BotUtil.makeLog('warn', `获取@全体剩余次数失败: ${error.message}`, 'ChatStream');
          const result = { success: false, error: error.message };
          this.recordToolCallResult(context.e, 'getAtAllRemain', result);
          return result;
        });
      },
      enabled: true
    });

    this.registerMCPTool('getBanList', {
      description: '获取当前被禁言的成员列表',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          const group = context.e.group;
          if (group && typeof group.getBanList === 'function') {
            const banList = await group.getBanList();
            BotUtil.makeLog('debug', `群禁言列表: ${JSON.stringify(banList)}`, 'ChatStream');
            const result = { success: true, data: banList };
            this.recordToolCallResult(context.e, 'getBanList', result);
            return result;
          }
          const result = { success: false, error: 'API不可用' };
          this.recordToolCallResult(context.e, 'getBanList', result);
          return result;
        }, 0).catch(error => {
          BotUtil.makeLog('warn', `获取禁言列表失败: ${error.message}`, 'ChatStream');
          const result = { success: false, error: error.message };
          this.recordToolCallResult(context.e, 'getBanList', result);
          return result;
        });
      },
      enabled: true
    });

    this.registerMCPTool('setGroupTodo', {
      description: '设置群代办',
      inputSchema: {
        type: 'object',
        properties: {
          msgId: {
            type: 'string',
            description: '消息ID'
          }
        },
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
              return { success: true, raw: '戳一戳已发送' };
            }
          }
          return { success: false, error: 'API不可用' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('getFriendList', {
      description: '获取当前机器人的好友列表（QQ号、昵称、备注）',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
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

          const result = {
            success: true,
            data: { friends }
          };
          this.recordToolCallResult(context.e, 'getFriendList', result);
          return result;
        } catch (error) {
          const result = { success: false, error: error.message };
          this.recordToolCallResult(context.e, 'getFriendList', result);
          return result;
        }
      },
      enabled: true
    });

    this.registerMCPTool('getGroupMembers', {
      description: '获取群成员列表。返回当前群的所有成员列表，包含QQ号、昵称、名片、角色等信息。仅群聊环境可用。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
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

          const result = { success: true, data: { members } };
          this.recordToolCallResult(context.e, 'getGroupMembers', result);
          return result;
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('getGroupInfo', {
      description: '获取群的基础信息（群名、群号、成员数、群主等）。仅群聊环境可用。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
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

          const result = { success: true, data: info };
          this.recordToolCallResult(context.e, 'getGroupInfo', result);
          return result;
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('getMemberInfo', {
      description: '获取群内指定成员的信息（昵称、名片、角色、权限等）。仅群聊环境可用。',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '成员QQ号'
          }
        },
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

          const result = { success: true, data: info };
          this.recordToolCallResult(context.e, 'getMemberInfo', { ...result, qq });
          return result;
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('getFriendInfo', {
      description: '获取指定好友的信息（QQ号、昵称、备注等）。',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '好友QQ号'
          }
        },
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

          const result = { success: true, data: info };
          this.recordToolCallResult(context.e, 'getFriendInfo', { ...result, qq });
          return result;
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('getMessageImages', {
      description: '获取指定消息中的图片URL列表。用于识别历史消息中的图片内容。当看到聊天记录中有[含图片]标记但没有图片内容描述时，可以调用此工具获取图片URL。',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: {
            type: 'string',
            description: '要获取图片的消息ID（必填）。可以从聊天记录中的[ID:xxx]获取。'
          }
        },
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

          const result = {
            success: true,
            data: {
              messageId: msgId,
              images,
              imageCount: images.length,
              sender: messageData.sender?.nickname || messageData.sender?.user_id || '未知',
              time: messageData.time || Date.now()
            }
          };
          
          this.recordToolCallResult(context.e, 'getMessageImages', result);
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
      description: '识别图片内容并返回描述。此工具会自动处理图片URL到多模态消息格式的转换，调用AI进行识别。当看到聊天记录中有[含图片]标记但没有图片内容描述时，可以先用getMessageImages获取图片URL，然后调用此工具识别。',
      inputSchema: {
        type: 'object',
        properties: {
          imageUrl: {
            type: 'string',
            description: '要识别的图片URL（必填）。可以是http/https URL或base64 data URL。'
          },
          prompt: {
            type: 'string',
            description: '可选的识别提示词（如"描述这张图片"、"识别图片中的文字"等）。默认会使用通用的图片描述提示。'
          }
        },
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
          const recognitionResult = await this.callAI(recognitionMessages, config);

          if (!recognitionResult || !recognitionResult.trim()) {
            return { success: false, error: 'AI识别失败，未返回结果' };
          }

          const result = {
            success: true,
            data: {
              imageUrl,
              description: recognitionResult.trim(),
              prompt
            }
          };

          this.recordToolCallResult(context.e, 'recognizeImage', result);
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
      const historyKey = groupId || `private_${userId}`;

      let message = '';
      if (e.raw_message) {
        message = e.raw_message;
      } else if (e.msg) {
        message = e.msg;
      } else if (e.message) {
        if (typeof e.message === 'string') {
          message = e.message;
        } else if (Array.isArray(e.message)) {
          message = e.message.map(seg => {
            switch (seg.type) {
              case 'text': return seg.text || '';
              case 'image': return '[图片]';
              case 'at': return `@${this._atSegmentToDisplay(seg)}`;
              case 'reply': return `[回复:${seg.id || seg.data?.id || ''}]`;
              default: return '';
            }
          }).join('');
        }
      } else if (e.content) {
        message = typeof e.content === 'string' ? e.content : e.content.text || '';
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

      if (this.embeddingConfig?.enabled && message && message.length > 5) {
        this.storeMessageWithEmbedding(historyKey, msgData).catch(() => {});
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
    if (this.embeddingConfig?.enabled) {
      this.storeMessageWithEmbedding(e.group_id || `private_${e.user_id}`, msgData).catch(() => {});
    }
    if (imageContent) {
      BotUtil.makeLog('debug', `[ChatStream] recordAIResponse 提取图片内容标记: ${imageContent}`, 'ChatStream');
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

  async buildSystemPrompt(context) {
    const { e, question } = context;
    const persona = question?.persona || '你是本群聊天助手，正常聊天、解决问题，不刻意卖萌或复读固定话术。';
    const botRole = question?.botRole || this.getBotRole(e);
    const dateStr = question?.dateStr || new Date().toLocaleString('zh-CN');
    const embeddingHint = this.embeddingConfig?.enabled ? '\n💡 系统会自动检索相关历史对话\n' : '';
    const botName = e.bot?.nickname || e.bot?.info?.nickname || e.bot?.name || 'Bot';
    const isMaster = e.isMaster === true;

    const gid = e?.group_id ?? e?.user_id ?? '_';
    const lastRepliesArr = (this._replyContentsLastTurnByGroup && this._replyContentsLastTurnByGroup[gid]) || [];
    // 传给AI的上一轮回复内容（限制长度，避免prompt过长）
    const MAX_REPLY_LENGTH_IN_PROMPT = 200;
    const lastRepliesForPrompt = lastRepliesArr.map((c, i) => {
      const truncated = c.length > MAX_REPLY_LENGTH_IN_PROMPT 
        ? c.slice(0, MAX_REPLY_LENGTH_IN_PROMPT) + '…'
        : c;
      return `${i + 1}. ${truncated}`;
    }).join('\n');
    const lastRepliesBlock = lastRepliesForPrompt
      ? `\n【上一轮已发送内容】\n${lastRepliesForPrompt}\n→ 不要重复：若与上面高度相似，禁止原样再发；可简短回应或换说法。同一轮内不要重复发送相同或近似内容。`
      : '';
    
    // 日志输出完整内容
    const lastRepliesFull = lastRepliesArr.map((c, i) => `${i + 1}. ${c}`).join('\n');
    if (lastRepliesFull) {
      BotUtil.makeLog('debug', `[ChatStream] buildSystemPrompt 上一轮回复内容: ${lastRepliesFull}`, 'ChatStream');
    }

    const masterTrustBlock = isMaster
      ? '\n- **无条件相信主人**：当前对话者是主人时，主人的判断、要求、偏好均优先，按主人说的做，不质疑、不反驳。'
      : '';
    const prompt = `## Role
你是 ${botName}（QQ=${e.self_id}，群=${e.group_id}，角色=${botRole}${isMaster ? '，当前是主人' : ''}）。时间：${dateStr}${embeddingHint}
${persona}${masterTrustBlock}
${lastRepliesBlock}

## Context（必读）
- **QQ 号是区分不同人的唯一标识（核心规则）**：
  - 聊天记录中每条消息的格式为「昵称(QQ号)」，QQ号是唯一标识。
  - **同名但QQ不同就是不同人**：即使昵称相同（如都叫"李诗雅"），只要QQ号不同，就是完全不同的两个人。必须以QQ号区分身份，不能仅凭昵称判断。
  - 消息中的 @、查询成员、戳一戳、at 工具等均以 QQ 号为准，请以 QQ 号分辨不同用户，避免歧义。
- 工具执行后会返回「已发送：…」或「已发送（第x条）：…」，这些内容即你**本轮已发给用户的消息**，会记入聊天记录。
- **reply/emotion/at 与正文是同一条回复**：用户会按顺序看到「工具发的内容 → 正文」。因此工具发完后，你的下一条（reply 或正文）必须**承接上一条**：同一话题、语气连贯，不要另起话题，不要重复已发。例如：emotion 已发「喵～主人夸我啦！」→ 正文应简短承接（如「嘿嘿～」）或留空，而不是再问「主人是在夸我吗？」（与已发割裂）。
- 查询类工具（车票、天气等）的返回结果也是当前轮的上下文。下一条回复必须与之连贯，不得插入与主题无关的表情/图片。
- **工具失败优先不重试**：若工具返回 success=false，或返回文本包含“重试无效/请勿再次调用/已跳过”，说明本轮继续同参重试大概率无效。此时**优先**接受结果，换策略用正文继续回答并**尽快收尾**；如确有必要再次调用，必须**改变参数/目标**且最多再试 1 次。
- **已完成就停止**：若你已经通过工具（reply/emotion/at/poke 等）把用户需要的内容发出（工具提示“已发送/已跳过”），本轮通常就已经完成；**优先直接结束**（不再追加工具、不再补一段重复正文），除非用户明确要求继续。

## Task
用纯文本回复用户（禁止 Markdown），可调用工具。**防刷屏：默认只发 1 条消息，能用 2~3 句话讲清就立刻收尾**；除非确有必要（例如必须先发工具结果再承接），不要把一句话拆成多条发送。poke/at/emotion 等必须通过工具调用，不可在正文或 reply 的 content 里写工具名或参数。

## 输出风格（防刷屏，必守）
- **普通聊天**：优先 1 条消息内完成，**2~3 句为宜**，不拓展到长篇科普；用户没要求时不要列清单/分点长写。
- **调用工具后**：只做结论性承接与下一步建议，**最多 5 句**；不要逐条复述工具返回的原文，必要时只摘最关键的 1~3 个要点。
- **见好就收**：答案足够就停，不要追加“顺便再讲讲…”；除非用户明确要求，不要追问多轮澄清。

## 正文与 reply（防重复，必守）
- **正文 = 最后一次 reply**：正文就是本轮你发给用户的「最后一条」消息，和 reply 工具发出的每条消息是同一类东西；用户看到的顺序是：reply 第1条、第2条、…、最后一条。最后一条要么由 reply 发出，要么由正文发出，二者只会有其一。因此**正文不能是前面任一条 reply 的重复或换说法**。
- **每条内容都必须不同**：同一轮内，每条 reply 的内容相互不能重复、不能近似（不能换一种说法说同一件事）。若你已经用 reply 发过「新年快乐喵～」和「要吃饺子还是汤圆？」，正文就**只能留空**或发一句与前面完全无关的极短收尾（如「喵～」），**不能再发**「主人新年快乐」「饺子还是汤圆」等任何与已发意思重合的句子。
- **操作习惯**：除非需要工具（at/poke/emotion/emojiReaction/reply）或需要先发一条承接语再补充，否则**尽量不要在一轮里发多条 reply**；能用 1 条正文讲完就不要拆分。正文只在你**还有且仅有一条**从未说过的内容时使用，否则正文留空。

## 文本协议（正文中可用）
分句：尽量用 |/｜ 拆分；若确需分开发送，最多拆成少量几句并各自简短。表情：[开心]/[惊讶]/[伤心]/[大笑]/[害怕]/[生气]（一轮最多一次）。引用：[回复:消息ID] 或 [CQ:reply,id=消息ID]。@人：[CQ:at,qq=QQ号]。识图标记：[图片内容:描述]（用户不可见）。

## 工具（均为调用，禁止在文本中写工具名/参数）
reply/at/emotion/emojiReaction/poke：须通过接口调用。emotion 一轮最多一次；表情包放在整段回复末尾，不要插在连贯多条（如查票结果→中转建议）中间。查询工具：getGroupInfo、getGroupMembers、getMemberInfo、getFriendList、getFriendInfo、getAtAllRemain、getBanList、getMessageImages、recognizeImage。识图：用户发图标为 [含图片]；多模态时用 [图片内容:描述] 标记；历史无描述时可 getMessageImages→recognizeImage→[图片内容:xxx]。群管：mute/unmute、muteAll/unmuteAll、setCard、setGroupName、setAdmin/unsetAdmin、setTitle、kick、setEssence/removeEssence、announce、recall、setGroupTodo（需权限）。

## 禁止
- 禁止 Markdown（粗体、标题、链接、代码块等）。
- 禁止在正文或 reply 的 content 中写 "poke 123"、"at 123"、"emotion 开心" 等。
- 禁止正文与任一条已发的 reply 意思相同或近似（换说法也算重复）。
- 禁止同一轮内多条 reply 内容相同或近似。
- 禁止在连贯多条回复中间插入与主题无关的表情/图片。

## 示例
✅ 用户说戳一戳我 → 调用 poke 工具 → 正文只输出「好的，戳一下你～」。
✅ emotion 发「喵～主人夸我啦！」→ 正文承接「嘿嘿～」或留空，不要另起话题。
✅ reply 发「新年快乐喵～」再发「要吃饺子还是汤圆？」→ 正文留空或只发「喵～」。
❌ reply 已发「新年快乐喵～」和「要吃饺子还是汤圆？…」后，正文又输出「喵～主人新年快乐！要吃饺子还是汤圆？…」。
❌ emotion 已发「喵～主人夸我啦！」后，正文又问「主人是在夸我吗？」（与已发割裂）。`;
    BotUtil.makeLog('debug', `[ChatStream] buildSystemPrompt 完成 len=${prompt.length} botRole=${botRole} isMaster=${isMaster}`, 'ChatStream');
    return prompt;
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

    // 若无图片，则仍然用纯文本，兼容旧逻辑
    if (images.length === 0 && replyImages.length === 0) {
      messages.push({
        role: 'user',
        content: text
      });
    } else {
      messages.push({
        role: 'user',
        content: {
          text: text || '',
          images,
          replyImages
        }
      });
    }

    BotUtil.makeLog('debug', `[ChatStream] buildChatContext 完成 messagesLen=${messages.length} hasImages=${images.length} hasReplyImages=${replyImages.length} textLen=${(text || '').length}`, 'ChatStream');
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

        // 统一的消息文本提取逻辑
        let text = '';
        if (segments.length > 0) {
          text = segments.map(seg => {
            if (!seg || typeof seg !== 'object') return '';
            switch (seg.type) {
              case 'text':
                return seg.text || '';
              case 'image':
                return '[图片]';
              case 'face':
                return '[表情]';
              case 'reply':
                return `[回复:${seg.id || seg.data?.id || ''}]`;
              case 'at':
                return `@${this._atSegmentToDisplay(seg)}`;
              default:
                return '';
            }
          }).join('');
        } else {
          text = msg.raw_message || '';
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

        BotUtil.makeLog(
          'debug',
          `[ChatStream] syncHistoryFromAdapter group=${groupId} 原有=${history.length} 新增=${newMessages.length} 合并后=${limited.length}`,
          'ChatStream'
        );
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
   * @param {Object} msg - 消息对象
   * @returns {string} 格式化后的文本
   */
  _formatHistoryMessage(msg) {
    const msgId = msg.message_id || msg.real_id || '未知';
    const imageTag = msg.hasImage ? '[含图片]' : '';
    const toolTag = msg.isTool ? '[系统操作]' : '';
    const tags = [imageTag, toolTag].filter(Boolean).join(' ');
    // 确保 user_id 始终存在，QQ号是唯一标识
    const userId = msg.user_id || msg.userId || '未知QQ';
    const nickname = msg.nickname || '未知用户';
    return `${tags ? tags + ' ' : ''}${nickname}(${userId})[ID:${msgId}]: ${msg.message || ''}`;
  }

  async mergeMessageHistory(messages, e) {
    if (!e?.isGroup || messages.length < 2) return messages;

    // 同步历史记录（仅在群聊中）
    await this.syncHistoryFromAdapter(e);

    const userMessage = messages[messages.length - 1];
    const isGlobalTrigger = userMessage.content?.isGlobalTrigger || false;
    const history = ChatStream.messageHistory.get(e.group_id) || [];
    
    const mergedMessages = [messages[0]];
    const currentMsgId = e.message_id || e.real_id || e.messageId || e.id || e.source?.id || '未知';
    const currentUserNickname = e.sender?.card || e.sender?.nickname || e.user?.name || '用户';
    const currentContent = typeof userMessage.content === 'string' 
      ? userMessage.content 
      : (userMessage.content?.text ?? '');

    // 过滤掉当前消息，避免重复
    const filteredHistory = history.filter(msg => 
      String(msg.message_id) !== String(currentMsgId)
    );

    if (isGlobalTrigger) {
      const recentMessages = filteredHistory.slice(-15);
      if (recentMessages.length > 0) {
        mergedMessages.push({
          role: 'user',
          content: `[群聊记录]\n${recentMessages.map(msg => this._formatHistoryMessage(msg)).join('\n')}\n\n你闲来无事点开群聊，看到这些发言。请根据你的个性和人设，自然地表达情绪和感受，不要试图解决问题。`
        });
      }
    } else {
      const recentMessages = filteredHistory.slice(-10);
      if (recentMessages.length > 0) {
        mergedMessages.push({
          role: 'user',
          content: `[群聊记录]\n${recentMessages.map(msg => this._formatHistoryMessage(msg)).join('\n')}`
        });
      }
      if (currentMsgId !== '未知' && currentContent) {
        if (typeof userMessage.content === 'object' && userMessage.content !== null) {
          const content = userMessage.content;
          const baseText = content.text || content.content || currentContent;
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
            content: `[当前消息]\n${currentUserNickname}(${e.user_id})[ID:${currentMsgId}]: ${currentContent}`
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
    const roles = mergedMessages.map(m => m.role).join(',');
    const firstContent = mergedMessages[0]?.content;
    const lastContent = mergedMessages[mergedMessages.length - 1]?.content;
    const firstContentStr = typeof firstContent === 'string' ? firstContent : (firstContent?.text ?? '');
    const lastContentStr = typeof lastContent === 'string' ? lastContent : (lastContent?.text ?? '');
    BotUtil.makeLog('debug', `[ChatStream] mergeMessageHistory 完成 mergedLen=${mergedMessages.length} historyLen=${history.length} roles=[${roles}]`, 'ChatStream');
    BotUtil.makeLog('debug', `[ChatStream] mergeMessageHistory 首条 contentLen=${firstContentStr.length} content=${firstContentStr}`, 'ChatStream');
    BotUtil.makeLog('debug', `[ChatStream] mergeMessageHistory 末条 contentLen=${lastContentStr.length} content=${lastContentStr}`, 'ChatStream');
    return mergedMessages;
  }

  async execute(e, messages, config) {
    const StreamLoader = Bot.StreamLoader;
    const groupId = e?.group_id ?? e?.user_id;
    BotUtil.makeLog('debug', `[ChatStream] execute 开始 group=${groupId} isArray=${Array.isArray(messages)} len=${messages?.length ?? 0}`, 'ChatStream');
    try {
      // 记录当前消息（统一记录逻辑）
      if (e) this.recordMessage(e);
      
      // 构建聊天上下文（如果未提供）
      if (!Array.isArray(messages)) {
        messages = await this.buildChatContext(e, messages);
      }
      
      // 合并历史记录（统一合并逻辑）
      messages = await this.mergeMessageHistory(messages, e);
      
      // 构建增强上下文（语义检索）
      const query = Array.isArray(messages) ? this.extractQueryFromMessages(messages) : messages;
      messages = await this.buildEnhancedContext(e, query, messages);
      
      BotUtil.makeLog('debug', `[ChatStream] execute 上下文构建完成 messagesLen=${messages?.length ?? 0} query=${typeof query === 'string' ? query : (query?.content ?? query?.text ?? '')}`, 'ChatStream');

      // 记录历史聊天记录（喂给 AI 的内容）
      if (Array.isArray(messages) && messages.length > 0) {
        const historyPreview = messages.map((msg, idx) => {
          const role = msg.role || 'unknown';
          let content = '';
          if (typeof msg.content === 'string') {
            content = msg.content.length > 200 ? msg.content.slice(0, 200) + '…' : msg.content;
          } else if (msg.content?.text) {
            content = msg.content.text.length > 200 ? msg.content.text.slice(0, 200) + '…' : msg.content.text;
          } else {
            content = '[非文本内容]';
          }
          return `  [${idx + 1}] ${role}: ${content.replace(/\n/g, '\\n')}`;
        }).join('\n');
        BotUtil.makeLog('info', `[ChatStream] 历史聊天记录（喂给 AI）:\n${historyPreview}`, 'ChatStream');
      }

      if (StreamLoader) StreamLoader.currentEvent = e || null;
      this._replyCountThisTurn = 0;
      this._replyContentsThisTurn = [];
      this._hasSentEmotionThisTurn = false; // 跟踪本轮是否已发送表情包

      BotUtil.makeLog('debug', `[ChatStream] execute 调用 callAI messagesLen=${messages?.length ?? 0}`, 'ChatStream');
      const response = await this.callAI(messages, config);
      let text = (response ?? '').toString().trim();
      BotUtil.makeLog('debug', `[ChatStream] execute callAI 返回 responseLen=${(response ?? '').length} textLen=${text.length} text=${text}`, 'ChatStream');
      
      // 过滤Markdown格式，转换为纯文本
      if (text) {
        const beforeFilter = text;
        text = this.filterMarkdown(text);
        if (beforeFilter !== text) {
          BotUtil.makeLog('debug', `[ChatStream] execute 过滤Markdown beforeLen=${beforeFilter.length} afterLen=${text.length}`, 'ChatStream');
        }
      }
      
      if (text && e?.reply) {
        const replyContents = this._getEffectiveReplyContentsThisTurn();
        if (this._shouldSkipBodyAsRedundant(text, replyContents)) {
          BotUtil.makeLog('debug', `[ChatStream] execute 跳过重复正文 textLen=${text.length}`, 'ChatStream');
        } else {
          BotUtil.makeLog('debug', `[ChatStream] execute 发送最终正文 textLen=${text.length}`, 'ChatStream');
          await this.sendMessages(e, text);
        }
      }
      
      if (!response) return null;
      return text || '';
    } catch (error) {
      BotUtil.makeLog('error', `[ChatStream] execute 失败: ${error.message}`, 'ChatStream');
      return null;
    } finally {
      const gid = e?.group_id ?? e?.user_id ?? '_';
      const contentsToSave = this._getEffectiveReplyContentsThisTurn();
      if (!this._replyContentsLastTurnByGroup) this._replyContentsLastTurnByGroup = {};
      this._replyContentsLastTurnByGroup[gid] = contentsToSave?.length ? [...contentsToSave] : [];
      this._replyCountThisTurn = 0;
      this._replyContentsThisTurn = [];
      if (this._mergedStreams?.[0]) this._mergedStreams[0]._replyContentsThisTurn = [];
      this._hasSentEmotionThisTurn = false;
      if (StreamLoader?.currentEvent === e) StreamLoader.currentEvent = null;
    }
  }

  /** 合并流时 reply 工具更新的是主 stream，此处取主 stream 的本轮已发内容以便重复判定一致 */
  _getEffectiveReplyContentsThisTurn() {
    const primary = this._mergedStreams?.[0];
    if (primary && Array.isArray(primary._replyContentsThisTurn) && primary._replyContentsThisTurn.length > 0) {
      return primary._replyContentsThisTurn;
    }
    return this._replyContentsThisTurn ?? [];
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
    BotUtil.makeLog('debug', `[ChatStream] _processAndSendTextProtocol 分句 contentLen=${content.length} messagesCount=${messages.length}`, 'ChatStream');
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
      
      BotUtil.makeLog('debug', `[ChatStream] _processAndSendTextProtocol 发送第${i + 1}/${messages.length}条消息 msgLen=${msg.length} sentContentLen=${sentContent.length} msg=${msg}`, 'ChatStream');
      
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

      if (imageContent) {
        BotUtil.makeLog('debug', `[ChatStream] _processAndSendTextProtocol 提取图片内容标记: ${imageContent}`, 'ChatStream');
      }

      // ⚠️ 重要：多条消息之间延迟，避免发送过快
      if (i < messages.length - 1) {
        await BotUtil.sleep(randomRange(800, 1500));
      }
    }

    // 更新回复计数和内容记录
    if (updateReplyContents) {
      const n = (this._replyCountThisTurn = (this._replyCountThisTurn || 0) + totalSent);
      if (!Array.isArray(this._replyContentsThisTurn)) this._replyContentsThisTurn = [];
      this._replyContentsThisTurn.push(...allSentContent);
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
   * 提取纯文本内容（去除CQ码、表情标记、图片内容标记等）
   */
  _extractPlainText(text) {
    if (!text || typeof text !== 'string') return '';
    // 移除CQ码：[CQ:xxx,...]
    let clean = text.replace(/\[CQ:[^\]]+\]/g, '');
    // 移除回复标记：[回复:xxx] 或 [回复:ID:xxx]
    clean = clean.replace(/\[回复:(?:ID:)?\d+\]/g, '');
    // 移除表情标记：[开心]/[惊讶]等
    clean = clean.replace(/\[(开心|惊讶|伤心|大笑|害怕|生气)\]/g, '');
    // 移除图片内容标记：[图片内容:xxx]
    clean = clean.replace(/\[图片内容:[^\]]+\]/g, '');
    // 移除多余空白
    clean = clean.replace(/\s+/g, ' ').trim();
    return clean;
  }

  /**
   * 过滤Markdown格式，转换为纯文本（保留文本协议标记）
   * @param {string} text - 原始文本
   * @returns {string} - 过滤后的纯文本
   */
  filterMarkdown(text) {
    if (!text || typeof text !== 'string') return text;
    let clean = text;

    // 移除代码块：```语言\n内容\n```
    clean = clean.replace(/```[\s\S]*?```/g, (match) => {
      // 提取代码块内容，保留换行但移除标记
      const content = match.replace(/```[\w]*\n?/g, '').replace(/```/g, '');
      return content.trim();
    });

    // 移除行内代码：`代码`
    clean = clean.replace(/`([^`]+)`/g, '$1');

    // 移除粗体：**文本** 或 __文本__
    clean = clean.replace(/\*\*([^*]+)\*\*/g, '$1');
    clean = clean.replace(/__([^_]+)__/g, '$1');

    // 移除斜体：*文本* 或 _文本_（但保留表情标记如 [开心]）
    clean = clean.replace(/(?<!\*)\*([^*\[]+?)\*(?!\*)/g, '$1');
    clean = clean.replace(/(?<!_)_([^_[]+?)_(?!_)/g, '$1');

    // 移除删除线：~~文本~~
    clean = clean.replace(/~~([^~]+)~~/g, '$1');

    // 移除链接：[文本](URL) 或 [文本][引用]
    clean = clean.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
    clean = clean.replace(/\[([^\]]+)\]\[[^\]]+\]/g, '$1');

    // 移除图片：![alt](URL)
    clean = clean.replace(/!\[([^\]]*)\]\([^\)]+\)/g, '');

    // 移除标题标记：# ## ### 等（保留文本）
    clean = clean.replace(/^#{1,6}\s+(.+)$/gm, '$1');

    // 移除引用标记：> 文本
    clean = clean.replace(/^>\s+(.+)$/gm, '$1');

    // 移除列表标记：- * + 或 1. 2. 等（保留文本）
    clean = clean.replace(/^[\s]*[-*+]\s+(.+)$/gm, '$1');
    clean = clean.replace(/^[\s]*\d+\.\s+(.+)$/gm, '$1');

    // 移除水平线：--- 或 ***
    clean = clean.replace(/^[-*]{3,}$/gm, '');

    // 移除表格标记：仅匹配整行表格格式（行首有半角|且行内有多个半角|），避免误删分句用的|和全角｜
    // 分句协议为 句子1|句子2（半角|，无空格，不在行首）
    // 全角｜用于内容分隔（如天气信息），不应被处理
    // 表格一般为 | 列1 | 列2 |（行首有半角|，有空格）
    // 策略：只处理行首有半角|且该行包含至少2个半角|的情况（真正的表格行）
    // ⚠️ 重要：正则表达式中的 \| 只匹配半角|（U+007C），不会匹配全角｜（U+FF5C）
    clean = clean.split('\n').map(line => {
      // 检查是否为表格行：行首有半角|且该行包含至少2个半角|
      // 注意：只匹配半角|（U+007C），不匹配全角｜（U+FF5C）
      const trimmedLine = line.trim();
      // 只统计半角|的数量，不统计全角｜（全角｜不会被 \| 匹配）
      const pipeCount = (line.match(/\|/g) || []).length;
      // 只检查行首是否为半角|，不检查全角｜
      if (trimmedLine.startsWith('|') && pipeCount >= 2) {
        // 这是表格行，提取所有单元格内容，用单个空格连接
        // 只匹配半角|，不匹配全角｜（正则 \| 只匹配半角|）
        const cells = [];
        const regex = /\|\s*([^|]*?)\s*\|/g; // 只匹配半角|（U+007C），不匹配全角｜（U+FF5C）
        let match;
        while ((match = regex.exec(trimmedLine)) !== null) {
          cells.push(match[1].trim());
        }
        return cells.join(' ');
      }
      // 不是表格行，保留原样（包括分句用的半角|和内容分隔用的全角｜）
      return line;
    }).join('\n');
    // 移除表格分隔行（只匹配半角|，如 |---|---|）
    clean = clean.replace(/^\|\s*[-:\s|]+\s*\|$/gm, '');

    // 清理多余的空行（保留单个换行）
    clean = clean.replace(/\n{3,}/g, '\n\n');

    // 清理行首行尾空白
    clean = clean.split('\n').map(line => line.trim()).join('\n');

    return clean.trim();
  }

  /**
   * 正文是否与本轮已发内容重复，应跳过发送（避免用户看到重复）
   * 规则：1) 正文去分句符后与已发拼接串完全一致 2) 与任一条包含/被包含或前缀相似 3) 已发≥2条且与拼接串有较长公共子串
   */
  _shouldSkipBodyAsRedundant(text, sentList) {
    if (!text || !Array.isArray(sentList) || sentList.length === 0) return false;
    const cleanText = this._extractPlainText(text);
    if (!cleanText) return false;
    const cleanList = sentList.map(s => this._extractPlainText(s)).filter(Boolean);
    if (cleanList.length === 0) return false;
    const joined = cleanList.join('');
    const normBody = cleanText.replace(/[|｜]/g, '').replace(/\s+/g, ' ').trim();
    const normSent = joined.replace(/\s+/g, ' ').trim();
    if (normBody.length > 0 && normSent.length > 0 && normBody === normSent) return true;
    for (const s of cleanList) {
      if (s.includes(cleanText) || cleanText.includes(s)) return true;
      if (this._isSimilarContent(cleanText, s, 0.7)) return true;
    }
    if (cleanList.length >= 2 && joined.length > 30 && cleanText.length > 18 && this._hasSignificantOverlap(cleanText, joined)) return true;
    return false;
  }

  /** 两段文本公共前缀占比是否 ≥ threshold，用于近似重复判断 */
  _isSimilarContent(text1, text2, threshold = 0.7) {
    if (!text1 || !text2) return false;
    const t1 = typeof text1 === 'string' ? text1 : this._extractPlainText(text1);
    const t2 = typeof text2 === 'string' ? text2 : this._extractPlainText(text2);
    if (!t1 || !t2) return false;
    const maxLen = Math.max(t1.length, t2.length);
    if (Math.abs(t1.length - t2.length) / maxLen > 0.35) return false;
    let i = 0;
    while (i < t1.length && i < t2.length && t1[i] === t2[i]) i++;
    return i / maxLen >= threshold;
  }

  /** 是否存在长度 ≥ minLen 的公共子串 */
  _hasSignificantOverlap(a, b, minLen = 6) {
    if (!a || !b || a.length < minLen || b.length < minLen) return false;
    for (let len = Math.min(12, a.length); len >= minLen; len--) {
      for (let i = 0; i <= a.length - len; i++) {
        if (b.includes(a.slice(i, i + len))) return true;
      }
    }
    return false;
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

    BotUtil.makeLog('debug', `[ChatStream] sendMessages 入口 cleanTextLen=${cleanText.length} cleanText=${cleanText}`, 'ChatStream');

    // 过滤Markdown格式
    let filteredText = this.filterMarkdown(cleanText);
    if (filteredText !== cleanText) {
      BotUtil.makeLog('debug', `[ChatStream] sendMessages 过滤Markdown beforeLen=${cleanText.length} afterLen=${filteredText.length}`, 'ChatStream');
    }

    // ⚠️ 使用统一的文本协议处理和发送方法
    const result = await this._processAndSendTextProtocol(e, filteredText, {
      messageId: null,
      recordToHistory: true,
      updateReplyContents: true
    });
    BotUtil.makeLog('debug', `[ChatStream] sendMessages 完成 totalSent=${result.totalSent} allSentContent=${result.allSentContent.join('|')}`, 'ChatStream');
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

  /**
   * 清除指定群组/用户的完整对话记录
   * @param {string|number} groupId - 群组ID或用户ID
   * @param {Object} options - 选项
   * @param {boolean} options.clearEmbedding - 是否清除embedding记忆（默认true）
   * @returns {Promise<Object>} 清除结果
   */
  static async clearConversation(groupId, options = {}) {
    const { clearEmbedding = true } = options;
    const gid = String(groupId);
    const result = {
      success: true,
      cleared: {
        history: false,
        embedding: false,
        replyContents: false
      }
    };

    try {
      // 清除聊天记录
      if (ChatStream.messageHistory.has(gid)) {
        ChatStream.messageHistory.delete(gid);
        result.cleared.history = true;
        BotUtil.makeLog('debug', `[ChatStream] clearConversation 清除聊天记录 group=${gid}`, 'ChatStream');
      }

      // 清除embedding记忆
      if (clearEmbedding) {
        try {
          const redis = global.redis || null;
          if (redis) {
            const embeddingKey = `ai:embedding:chat:${gid}`;
            const deleted = await redis.del(embeddingKey).catch(() => 0);
            if (deleted > 0) {
              result.cleared.embedding = true;
              BotUtil.makeLog('debug', `[ChatStream] clearConversation 清除embedding记忆 group=${gid} key=${embeddingKey}`, 'ChatStream');
            } else {
              BotUtil.makeLog('debug', `[ChatStream] clearConversation embedding键不存在或已清除 group=${gid} key=${embeddingKey}`, 'ChatStream');
            }
          } else {
            BotUtil.makeLog('debug', `[ChatStream] clearConversation Redis不可用，跳过embedding清除 group=${gid}`, 'ChatStream');
          }
        } catch (err) {
          BotUtil.makeLog('debug', `[ChatStream] clearConversation 清除embedding失败: ${err?.message}`, 'ChatStream');
        }
      }

      // 清除上一轮回复内容（需要从实例中清除）
      // 注意：这是实例属性，需要通过实例访问，这里记录到日志
      result.cleared.replyContents = true;
      BotUtil.makeLog('debug', `[ChatStream] clearConversation 完成 group=${gid} cleared=${JSON.stringify(result.cleared)}`, 'ChatStream');
    } catch (error) {
      result.success = false;
      BotUtil.makeLog('error', `[ChatStream] clearConversation 失败: ${error.message}`, 'ChatStream');
    }

    return result;
  }

  /**
   * 实例方法：清除当前实例的回复内容记录
   * @param {string|number} groupId - 群组ID或用户ID
   */
  clearReplyContents(groupId) {
    const gid = String(groupId);
    if (this._replyContentsLastTurnByGroup && this._replyContentsLastTurnByGroup[gid]) {
      delete this._replyContentsLastTurnByGroup[gid];
      BotUtil.makeLog('debug', `[ChatStream] clearReplyContents 清除回复内容记录 group=${gid}`, 'ChatStream');
    }
  }

  async cleanup() {
    await super.cleanup();
    
    if (ChatStream.cleanupTimer) {
      clearInterval(ChatStream.cleanupTimer);
      ChatStream.cleanupTimer = null;
    }
  }
}