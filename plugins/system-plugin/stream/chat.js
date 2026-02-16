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
      embedding: { enabled: true }
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
          return { success: true, message: text ? '已发送 @+文本' : '已 @ 该用户', data: { qq, text: text || undefined } };
        }, 200);
      },
      enabled: true
    });

    this.registerMCPTool('poke', {
      description: '戳一戳对方。群聊戳群成员，私聊戳好友。仅当你想戳用户时调用，qq 填当前说话人；同一轮最多调用一次。',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '要戳的QQ号（用户说戳我时填当前说话人），须为 5-10 位数字'
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
          return { success: true, message: '戳一戳成功', data: { qq: targetQq } };
        });
      },
      enabled: true
    });

    this.registerMCPTool('reply', {
      description: '向当前会话发送一条消息（立即发出，用户可见）。用于先快速回复（如「正在查～」「稍等」）再执行其他工具，或引用回复某条消息。建议：用户提问/查东西时先调用本工具发一句短回复再调其他工具。',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: {
            type: 'string',
            description: '要引用回复的消息ID（可选）。填写则发送为「回复该条消息」的形式。'
          },
          content: {
            type: 'string',
            description: '要发送的文本内容（必填）'
          }
        },
        required: ['content']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        if (!e?.reply) {
          return { success: false, error: '当前环境无法发送消息' };
        }
        const content = String(args.content ?? '').trim();
        if (!content) {
          return { success: false, error: 'content 不能为空' };
        }
        return this._wrapHandler(async () => {
          const seg = global.segment || segment;
          if (args.messageId) {
            const replySeg = seg.reply(args.messageId);
            await e.reply([replySeg, ' ', content]);
          } else {
            await e.reply(content);
          }
          return { success: true, message: '消息已发送', data: { content } };
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
              return { success: true, message: '表情回应成功', data: { msgId, emojiId, emojiType } };
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
          return { success: true, message: text ? '已发表情包+文字' : '已发表情包', data: { emotionType: t, text: text || undefined } };
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
          return { success: true, message: '点赞成功', data: { qq: args.qq, count: thumbCount } };
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
          return { success: true, message: '禁言成功', data: { qq: args.qq, duration: args.duration } };
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
          return { success: true, message: '解禁成功', data: { qq: args.qq } };
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
          return { success: true, message: '修改名片成功', data: { qq: targetQq, card: args.card } };
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
          return { success: true, message: '修改群名成功', data: { name: args.name } };
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
          return { success: true, message: '设置管理员成功', data: { qq: args.qq } };
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
          return { success: true, message: '取消管理员成功', data: { qq: args.qq } };
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
          return { success: true, message: '设置头衔成功', data: { qq: args.qq, title: args.title } };
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
          return { success: true, message: '踢出成员成功', data: { qq: args.qq } };
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
            return { success: true, message: '设置精华成功', data: { msgId } };
          } else if (context.e.bot?.sendApi) {
            await context.e.bot.sendApi('set_essence_msg', { message_id: msgId });
            return { success: true, message: '设置精华成功', data: { msgId } };
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
            return { success: true, message: '取消精华成功', data: { msgId } };
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
              return { success: true, message: '发送群公告成功', data: { content } };
            }
          } else if (context.e.bot?.sendApi) {
            const apiParams = { group_id: context.e.group_id, content };
            if (image) apiParams.image = image;
            const result = await context.e.bot.sendApi('_send_group_notice', apiParams);
            if (result?.status === 'ok') {
              return { success: true, message: '发送群公告成功', data: { content } };
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
            return { success: true, message: '消息撤回成功', data: { msgId: args.msgId } };
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
            return { success: true, data: info };
          }
          return { success: false, error: 'API不可用' };
        }, 0).catch(error => {
          BotUtil.makeLog('warn', `获取群信息ex失败: ${error.message}`, 'ChatStream');
          return { success: false, error: error.message };
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
            return { success: true, data: remain };
          }
          return { success: false, error: 'API不可用' };
        }, 0).catch(error => {
          BotUtil.makeLog('warn', `获取@全体剩余次数失败: ${error.message}`, 'ChatStream');
          return { success: false, error: error.message };
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
            return { success: true, data: banList };
          }
          return { success: false, error: 'API不可用' };
        }, 0).catch(error => {
          BotUtil.makeLog('warn', `获取禁言列表失败: ${error.message}`, 'ChatStream');
          return { success: false, error: error.message };
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
              return { success: true, message: '设置群代办成功', data: { msgId } };
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

          BotUtil.makeLog(
            'debug',
            `[chat.getFriendList] 好友数量: ${friends.length}`,
            'ChatStream'
          );

          return {
            success: true,
            data: { friends }
          };
        } catch (error) {
          return { success: false, error: error.message };
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

          BotUtil.makeLog(
            'debug',
            `[chat.getGroupMembers] 群 ${context.e?.group_id} 成员数量: ${members.length}`,
            'ChatStream'
          );

          return {
            success: true,
            data: { members }
          };
        } catch (error) {
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
              case 'at': return `@${seg.qq || seg.user_id || ''}`;
              case 'reply': return `[回复:${seg.id || ''}]`;
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
      if (!messageId) {
        messageId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        BotUtil.makeLog('debug', `消息ID缺失，使用临时ID: ${messageId}`, 'ChatStream');
      } else {
        messageId = String(messageId);
      }

      const msgData = {
        user_id: userId,
        nickname,
        message,
        message_id: messageId,
        time: e.time || Date.now(),
        platform: e.platform || 'onebot'
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
    } catch (error) {
      BotUtil.makeLog('debug', `记录消息失败: ${error.message}`, 'ChatStream');
    }
  }

  async getBotRole(e) {
    if (!e.isGroup) return '成员';
    const member = e.group?.pickMember(e.self_id);
    const roleValue = member?.role;
    return roleValue === 'owner' ? '群主' : 
           roleValue === 'admin' ? '管理员' : '成员';
  }

  recordAIResponse(e, text, executedFunctions = []) {
    if (!text || !text.trim()) return;
    
    const functionInfo = executedFunctions.length > 0 
      ? `[执行了: ${executedFunctions.join(', ')}] ` 
      : '';
    const botName = e.bot?.nickname || e.bot?.info?.nickname || e.bot?.name || 'Bot';
    const message = `${functionInfo}${text}`;
    const msgData = {
      user_id: e.self_id,
      nickname: botName,
      message,
      message_id: Date.now().toString(),
      time: Date.now(),
      platform: 'onebot'
    };
    
    if (e?.isGroup && e.group_id) {
      const history = ChatStream.messageHistory.get(e.group_id) || [];
      history.push(msgData);
      if (history.length > 50) {
        history.shift();
      }
    }
    
    if (this.embeddingConfig?.enabled) {
      const historyKey = e.group_id || `private_${e.user_id}`;
      this.storeMessageWithEmbedding(historyKey, msgData).catch(() => {});
    }
  }

  async buildSystemPrompt(context) {
    const { e, question } = context;
    const persona = question?.persona || '你是本群聊天助手，正常聊天、解决问题，不刻意卖萌或复读固定话术。';
    const botRole = question?.botRole || await this.getBotRole(e);
    const dateStr = question?.dateStr || new Date().toLocaleString('zh-CN');
    const embeddingHint = this.embeddingConfig?.enabled ? '\n💡 系统会自动检索相关历史对话\n' : '';
    const botName = e.bot?.nickname || e.bot?.info?.nickname || e.bot?.name || 'Bot';
    const isMaster = e.isMaster === true;

    return `【身份】昵称=${botName}，QQ=${e.self_id}，群=${e.group_id}，角色=${botRole}${isMaster ? '（当前是主人）' : ''} | 时间=${dateStr}${embeddingHint}

【人设】${persona}

【原则】所有回复与工具都基于「你想做」：想简短就简短，想多聊就多聊一句，想用表情/戳一戳/@ 就选对应工具，不想用就不必用。回复风格可多变，不必每次同一种句式或套路；像真人一样有时只回几个字、有时带情绪、有时先回再干活。单条消息建议别太长，可拆成多条或先短句再补一句。

【能力与选用】（需要时再用，不必每条消息都调工具）
- reply：发文字，可带 messageId 引用；想先回一句再干别的就先用 reply，再调其他。
- at：@某人，可选带 text 同条发（at+一句话）。想 @ 时用。
- emotion：发表情包（开心/惊讶/伤心/大笑/害怕/生气），可选带 text。想表达情绪时用。
- emojiReaction：对某条消息点表情回应（群聊）。想点个反应时用。
- poke：戳一戳（群聊/私聊皆可）。对方说「戳我」且你想戳时用，同一轮最多一次。
- 查票/查天气/查资料等：想帮查就先 reply 带出在查什么，在执行完之前说的话都打包进reply，无需输出，因为你事先输出的内容用户看不见（如「正在查沈阳到邯郸 2月28 的票～」），再调远程工具，最后 reply 结果。
- 改名片 setCard、群管等：用户明确要且你想执行时再调；非管理则说明权限不足。

【场景参考】（按你当下是否想做来选，非必须）
- 对方说戳我：可 reply 一句 + poke（qq=${e.user_id}）+ 想加的话再 reply 或 emotion。
- 在么/打招呼：随意简短回，不套固定模板。
- 已合并本群+远程工具（查票、记忆等），需要时调即可。

【格式】纯文本，禁止 Markdown。紧扣用户原话，不套固定模板。`;
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

    // 从事件中提取图片（OneBot 消息段）
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

    // 被回复消息中的图片一并交给工厂多模态处理（e.getReply 取被回复条目的图片）
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
        BotUtil.makeLog('debug', `[ChatStream] getReply 获取被回复图片失败: ${err?.message}`, 'ChatStream');
      }
    }

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
      const existingIds = new Set(
        history.map(msg => String(msg.message_id || msg.real_id || ''))
      );

      const newMessages = [];
      for (const msg of Array.isArray(rawHistory) ? rawHistory : []) {
        if (!msg || typeof msg !== 'object') continue;
        const mid = msg.real_id || msg.message_id || msg.message_seq;
        if (!mid) continue;
        const idStr = String(mid);
        if (existingIds.has(idStr)) continue;

        const sender = msg.sender || {};
        const segments = Array.isArray(msg.message) ? msg.message : [];

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
                return `[回复:${seg.id || ''}]`;
              case 'at':
                return `@${seg.qq || seg.user_id || ''}`;
              default:
                return '';
            }
          }).join('');
        } else {
          text = msg.raw_message || '';
        }

        const nickname = sender.card || sender.nickname || '未知';
        newMessages.push({
          user_id: msg.user_id ?? sender.user_id,
          nickname,
          message: text,
          message_id: idStr,
          time: msg.time || Date.now(),
          platform: 'onebot'
        });
      }

      if (newMessages.length > 0) {
        const merged = history.concat(newMessages);
        const limited = merged.length > 50 ? merged.slice(-50) : merged;
        ChatStream.messageHistory.set(groupId, limited);

        BotUtil.makeLog(
          'debug',
          `[ChatStream.syncHistoryFromAdapter] group=${groupId}, 原有=${history.length}, 新增=${newMessages.length}, 合并后=${limited.length}`,
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

  async mergeMessageHistory(messages, e) {
    if (!e?.isGroup || messages.length < 2) return messages;

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

    const formatMessage = (msg) => {
      const msgId = msg.message_id || msg.real_id || '未知';
      return `${msg.nickname}(${msg.user_id})[ID:${msgId}]: ${msg.message}`;
    };

    const filteredHistory = history.filter(msg => 
      String(msg.message_id) !== String(currentMsgId)
    );

    const uniqueHistory = [];
    const seenIds = new Set();
    for (let i = filteredHistory.length - 1; i >= 0; i--) {
      const msg = filteredHistory[i];
      const msgId = msg.message_id || msg.real_id;
      if (msgId && !seenIds.has(String(msgId))) {
        seenIds.add(String(msgId));
        uniqueHistory.unshift(msg);
      }
    }

    if (isGlobalTrigger) {
      const recentMessages = uniqueHistory.slice(-15);
      if (recentMessages.length > 0) {
        mergedMessages.push({
          role: 'user',
          content: `[群聊记录]\n${recentMessages.map(formatMessage).join('\n')}\n\n你闲来无事点开群聊，看到这些发言。请根据你的个性和人设，自然地表达情绪和感受，不要试图解决问题。`
        });
      }
    } else {
      const recentMessages = uniqueHistory.slice(-10);
      if (recentMessages.length > 0) {
        mergedMessages.push({
          role: 'user',
          content: `[群聊记录]\n${recentMessages.map(formatMessage).join('\n')}`
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
    return mergedMessages;
  }

  async execute(e, messages, config) {
    const StreamLoader = Bot.StreamLoader;
    try {
      if (e) this.recordMessage(e);
      if (!Array.isArray(messages)) {
        messages = await this.buildChatContext(e, messages);
      }
      messages = await this.mergeMessageHistory(messages, e);
      const query = Array.isArray(messages) ? this.extractQueryFromMessages(messages) : messages;
      messages = await this.buildEnhancedContext(e, query, messages);

      if (StreamLoader) StreamLoader.currentEvent = e || null;

      try {
        const preview = (messages || []).map((m, idx) => {
          const role = m.role || `msg${idx}`;
          let content = m.content;
          if (typeof content === 'object') {
            const text = content.text || content.content || '';
            content = text;
          }
          return {
            idx,
            role,
            text: String(content ?? '')
          };
        });
        BotUtil.makeLog(
          'debug',
          `[ChatStream.execute] LLM消息预览: ${JSON.stringify(preview, null, 2)}`,
          'ChatStream'
        );
      } catch {
        // 调试日志失败直接忽略
      }
      
      const response = await this.callAI(messages, config);
      const text = (response ?? '').toString().trim();
      if (!response) return null;
      if (text) {
        await this.sendMessages(e, text);
        this.recordAIResponse(e, text, []);
      }
      return text || '';
    } catch (error) {
      BotUtil.makeLog('error', 
        `工作流执行失败[${this.name}]: ${error.message}`, 
        'ChatStream'
      );
      return null;
    } finally {
      if (StreamLoader?.currentEvent === e) StreamLoader.currentEvent = null;
    }
  }

  parseCQToSegments(text, e) {
    const segments = [];
    let replyId = null;
    
    const replyMatch = text.match(/\[CQ:reply,id=(\d+)\]/);
    if (replyMatch) {
      replyId = replyMatch[1];
      // 从文本中移除回复CQ码
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
    if (!cleanText || !cleanText.trim()) return;

    const messages = cleanText.split('|').map(m => m.trim()).filter(Boolean);
    
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;
      
      // 解析CQ码为segment数组
      const { replyId, segments } = this.parseCQToSegments(msg, e);
      
      // 如果有回复ID或解析出了segment，使用segment方式发送
      if (replyId || segments.length > 0) {
        if (replyId) {
          // 有回复ID：回复段必须在最前面（OneBot协议要求）
          // segment.reply返回 { type: "reply", id, ... }，makeMsg会转换为 { type: "reply", data: { id } }
          const seg = global.segment || segment;
          const replySegment = seg.reply(replyId);
          const replySegments = segments.length > 0 
            ? [replySegment, ...segments] 
            : [replySegment, ' '];
          await e.reply(replySegments);
        } else {
          // 没有回复ID：直接发送segments
          await e.reply(segments);
        }
      } else {
        // 如果没有解析出任何内容，直接发送原始文本
        await e.reply(msg);
      }
      
      if (i < messages.length - 1) {
        await BotUtil.sleep(randomRange(800, 1500));
      }
    }
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

  async cleanup() {
    await super.cleanup();
    
    if (ChatStream.cleanupTimer) {
      clearInterval(ChatStream.cleanupTimer);
      ChatStream.cleanupTimer = null;
    }
  }
}