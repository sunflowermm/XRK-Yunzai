import path from 'path';
import AIStream from '../../../lib/aistream/aistream.js';
import BotUtil from '../../../lib/util.js';
import { FileUtils } from '../../../lib/utils/file-utils.js';
import { materializeMediaRefToPath } from '../../../lib/utils/outbound-media.js';
import { BaseTools } from '../../../lib/utils/base-tools.js';
import StreamLoader from '../../../lib/aistream/loader.js';
import LLMFactory from '../../../lib/factory/llm/LLMFactory.js';
import { prepareOpenAIChatVisionMessages } from '../../../lib/utils/llm/image-utils.js';
import {
  ensureAgentWorkspaceSync,
  getConfiguredDefaultWorkspaceId,
  resolveWorkspaceAbsFromContext
} from '../../../lib/utils/agent-workspace-paths.js';
import { resolveProjectPath, RESOURCES_AIIMAGES_DIR, DATA_DIR } from '../../../lib/config/config-constants.js';
import {
  buildFabricatorMsgList,
  fabricatorContextFromEvent,
  makeFabricatorForwardMsg
} from '../lib/message-fabricator.js';
import {
  TOOL_ROUNDS_EXHAUSTED_USER_TEXT
} from '../../../lib/utils/llm/llm-nonstream-reply.js';
import { summarizeToolForHistory } from '../../../lib/utils/mcp-server.js';
import { runWithStreamRequestContext, getStreamRequestContext } from '../../../lib/aistream/stream-request-context.js';
import {
  contentHasGroupAt,
  EMOTION_TYPES,
  parseImageContentMark,
  PROTOCOL_MARKER_RE,
  replyContentForbidden,
  resolveOutgoingMessage,
  buildOutboundSegments
} from '../../../lib/utils/chat-reply-protocol.js';
import {
  EMOTION_IMAGE_EXTS,
  EMOJI_REACTION_ALIASES,
  EMOJI_REACTION_TYPES,
  formatEmotionTypeList,
  getEmojiReactionIds,
  normalizeEmotionType
} from '../../../lib/utils/emotion-categories.js';
import {
  actionAck,
  createUserVisibleTurnState,
  describeEmotionSent,
  formatDeliveredAck,
  formatEmotionDeliveredAck,
  formatEmotionSkippedAck,
  formatSessionWhere,
  formatUserVisibleDuplicateAck,
  isOverlappingUserVisible
} from '../../../lib/utils/chat-user-visible-ack.js';
const EMOTIONS_DIR = resolveProjectPath(RESOURCES_AIIMAGES_DIR);
const IMAGE_SEND_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

function randomRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 聊天工作流：群管/互动；对用户说话仅 reply + emotion（协议见 lib/utils/chat-reply-protocol.js） */
export default class ChatStream extends AIStream {
  static emotionImages = {};
  static messageHistory = new Map();
  /** 本机写入（工具/【我】）在同一群内的单调序号，保证同毫秒内按执行顺序插入 */
  static historyLocalSeqByGroup = new Map();
  static cleanupTimer = null;
  /** 识图 MCP 暂关（getMessageImages / recognizeImage 不注册） */
  static IMAGE_RECOGNITION_MCP_ENABLED = false;
  /** 群聊历史：内存保留 / 适配器拉取 / 注入 LLM 条数 */
  static GROUP_HISTORY_STORE_MAX = 120;
  static GROUP_HISTORY_SYNC_FETCH = 120;
  static GROUP_HISTORY_PROMPT_DEFAULT = 45;
  static GROUP_HISTORY_PROMPT_GLOBAL = 60;
  static GROUP_HISTORY_PROMPT_DEBUG = 120;
  /** 已通过 reply/recordAIResponse 写入历史的对外工具，不再重复记工具摘要 */
  static TOOL_HISTORY_SKIP = new Set([
    'reply', 'emotion', 'send_file', 'send_image', 'poke',
    'thumbUp', 'sign', 'emojiReaction', 'recall', 'forgeForward'
  ]);

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
        maxTokens: 8000,
        topP: 0.9,
        presencePenalty: 0.6,
        frequencyPenalty: 0.6,
        /** 多工具同轮时顺序执行，降低「reply 与远程 MCP 抢跑」导致的重复铺垫 */
        parallel_tool_calls: false,
        /** 写 docx / 搜索 / run 等多步任务；模型端点可再覆盖 */
        maxToolRounds: 12
      }
    });
  }

  /**
   * 初始化工作流
   */
  async init() {
    await super.init();
    ensureAgentWorkspaceSync(getConfiguredDefaultWorkspaceId());

    try {
      await this.loadEmotionImages();
      this.registerAllFunctions();
      
      if (!ChatStream.cleanupTimer) {
        ChatStream.cleanupTimer = setInterval(() => this.cleanupCache(), 300000);
      }
    } catch (error) {
      Bot.makeLog('error', 
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
        const imageFiles = files.filter(file => EMOTION_IMAGE_EXTS.test(file));
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

  /** 群管类工具：需机器人在群内为群主或管理员 */
  _requireGroupAdmin(context) {
    const groupCheck = this._requireGroup(context);
    if (groupCheck) return groupCheck;
    const role = this.getBotRole(context.e);
    if (role !== '群主' && role !== '管理员') {
      return { success: false, error: '需要群主或管理员权限' };
    }
    return null;
  }

  async _fetchMessageById(e, msgId) {
    if (!e || !msgId) return null;
    const id = String(msgId).trim();
    if (!id) return null;
    if (e.bot?.sendApi) {
      try {
        const result = await e.bot.sendApi('get_msg', { message_id: id });
        if (result?.data) return result.data;
      } catch (err) {
        Bot.makeLog('debug', `[ChatStream] get_msg 失败 msgId=${id}: ${err?.message}`, 'ChatStream');
      }
    }
    if (e.bot?.adapter?.getMsg) {
      try {
        return await e.bot.adapter.getMsg(e, id);
      } catch (err) {
        Bot.makeLog('debug', `[ChatStream] adapter.getMsg 失败 msgId=${id}: ${err?.message}`, 'ChatStream');
      }
    }
    return null;
  }

  _summarizeSegmentFlags(segments) {
    if (!Array.isArray(segments)) {
      return { hasImage: false, hasFile: false, hasFace: false, isForward: false };
    }
    return {
      hasImage: segments.some(s => s?.type === 'image'),
      hasFile: segments.some(s => s?.type === 'file'),
      hasFace: segments.some(s => s?.type === 'face' || s?.type === 'mface'),
      isForward: segments.some(s => s?.type === 'forward' || s?.type === 'node')
    };
  }

  _extractMessageAssets(message) {
    const assets = [];
    if (!Array.isArray(message)) return assets;
    for (const seg of message) {
      if (!seg || typeof seg !== 'object') continue;
      const data = seg.data || seg;
      if (seg.type === 'image') {
        assets.push({
          type: 'image',
          url: seg.url || data.url,
          file: data.file || seg.file
        });
      } else if (seg.type === 'file') {
        assets.push({
          type: 'file',
          name: data.name || seg.name,
          url: data.url,
          file: data.file
        });
      } else if (seg.type === 'face') {
        assets.push({ type: 'face', id: data.id ?? seg.id });
      } else if (seg.type === 'mface') {
        assets.push({
          type: 'mface',
          url: data.url,
          file: data.file,
          summary: data.summary
        });
      }
    }
    return assets;
  }

  _describeMessageOneLevel(messageData) {
    const segments = Array.isArray(messageData?.message) ? messageData.message : [];
    const flags = this._summarizeSegmentFlags(segments);
    const assets = this._extractMessageAssets(segments).map((a, index) => ({
      index,
      ...a,
      downloadable: a.type === 'image' || a.type === 'file' || a.type === 'mface'
    }));
    const text = segments.length
      ? this._segmentsToPlainText(segments)
      : this._normalizeMessageText(messageData?.raw_message || '');
    return {
      messageId: String(messageData.message_id || messageData.real_id || ''),
      sender: {
        userId: messageData.sender?.user_id,
        nickname: messageData.sender?.card || messageData.sender?.nickname
      },
      time: messageData.time,
      text,
      ...flags,
      assets,
      forwardLimit: flags.isForward ? '框架协议限制：合并转发仅一层，内层不可读' : undefined
    };
  }

  _historyEntryToRecord(msg) {
    return {
      messageId: msg.message_id,
      userId: msg.user_id,
      nickname: msg.nickname,
      time: msg.time,
      text: msg.message,
      isBot: !!msg.isBot,
      isTool: !!msg.isTool,
      toolName: msg.toolName,
      sortSeq: msg.sortSeq,
      hasImage: !!msg.hasImage,
      hasFile: !!msg.hasFile,
      hasFace: !!msg.hasFace,
      isForward: !!msg.isForward,
      downloadable: !!(msg.hasImage || msg.hasFile)
    };
  }

  _guessAssetExtension(asset) {
    if (asset.type === 'file' && asset.name) {
      const ext = path.extname(asset.name);
      if (ext) return ext;
    }
    if (asset.type === 'image' || asset.type === 'mface') return '.png';
    return '.bin';
  }

  async _downloadMessageAssetToWorkspace(e, workspace, asset, relPath) {
    const baseTools = new BaseTools(workspace);
    const absPath = baseTools.resolvePathInWorkspace(relPath);
    const fileRef = String(asset.file || asset.url || '').trim() || null;
    const sendApi = e.bot?.sendApi ? (action, params) => e.bot.sendApi(action, params) : undefined;

    if (asset.type === 'face') {
      throw new Error('内置 QQ 表情（face）无法下载；请让用户发图片或自定义表情包（mface）');
    }

    if ((asset.type === 'image' || asset.type === 'mface') && (asset.file || asset.url)) {
      if (await materializeMediaRefToPath({ file: asset.file, url: asset.url }, absPath, sendApi)) {
        return absPath;
      }
    }

    if (fileRef && sendApi && asset.type === 'file') {
      const result = await e.bot.sendApi('get_file', { file: fileRef });
      const d = result?.data || {};
      const local = d.file || d.path;
      if (local && FileUtils.existsSync(local)) {
        const ok = await FileUtils.copyFile(local, absPath);
        if (!ok) throw new Error('复制到工作区失败');
        return absPath;
      }
    }

    throw new Error('无法获取可下载的资源（QQ 临时链可能已过期，或缺少本地文件）');
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
    const sanitized = ChatStream._sanitizeTextForAI(dataStr);
    const truncated = sanitized.length > MAX_DATA_LEN ? sanitized.slice(0, MAX_DATA_LEN) + '\n...[已截断]' : sanitized;
    return `已获取${description}。根据 data 回复，勿再调用。\n\ndata:\n${truncated}`;
  }

  /** 带上下文的查询工具返回：群聊带群号，私聊带用户，再附 data */
  _queryToolRawDetail(description, data, e) {
    const MAX_DATA_LEN = 4000;
    const dataStr = data != null ? (typeof data === 'string' ? data : JSON.stringify(data)) : '{}';
    const sanitized = ChatStream._sanitizeTextForAI(dataStr);
    const truncated = sanitized.length > MAX_DATA_LEN ? sanitized.slice(0, MAX_DATA_LEN) + '\n...[已截断]' : sanitized;
    const head = e?.isGroup && e?.group_id
      ? `你已在群 ${e.group_id} 获取${description}。根据 data 回复，勿再调用。`
      : e?.user_id
        ? `你已获取与 ${e.user_id}(私聊) 相关的${description}。根据 data 回复，勿再调用。`
        : `你已获取${description}。根据 data 回复，勿再调用。`;
    return `${head}\n\ndata:\n${truncated}`;
  }

  registerAllFunctions() {
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
          } else if (e.friend?.poke && String(e.user_id) === targetQq) {
            await e.friend.poke();
          } else if (e.bot?.sendApi) {
            const params = e.group_id != null
              ? { group_id: e.group_id, user_id: qqNum }
              : { user_id: qqNum };
            await e.bot.sendApi('send_poke', params);
          } else {
            return { success: false, error: '当前环境不支持戳一戳' };
          }
          const where = e.isGroup && e.group_id ? `群 ${e.group_id}` : '私聊';
          return { success: true, raw: actionAck(`你已对 ${targetQq} 戳一戳（当前会话：${where}）。`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('reply', {
      description: '发文字消息（用户可见）。content：| 分句；[回复:消息ID]；群聊 [at:数字QQ]。禁止 @QQ/@昵称。发表情包用 emotion，发图用 send_image。回执会说明是否已发出。',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'number', description: '可选，引用消息 ID' },
          content: { type: 'string', description: '正文（必填）' }
        },
        required: ['content']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        if (!e?.reply) return { success: false, error: '当前环境无法发送消息' };
        return this._wrapHandler(async () => {
          return this._sendUserVisibleText(e, {
            content: args.content,
            messageId: args.messageId
          }, context);
        });
      },
      enabled: true
    });

    this.registerMCPTool('emotion', {
      description: `发表情包图片（resources/aiimages/{分类}/ 随机一张）。emotionType：${formatEmotionTypeList()}。text 可选附言，支持 [回复:消息ID]。用户只要表情时不要填 text。`,
      inputSchema: {
        type: 'object',
        properties: {
          emotionType: { type: 'string', enum: EMOTION_TYPES },
          text: { type: 'string', description: '可选附言' }
        },
        required: ['emotionType']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        if (!e?.reply) return { success: false, error: '当前环境无法发送' };
        const t = String(args.emotionType ?? '').trim();
        if (!EMOTION_TYPES.includes(t)) return { success: false, error: '无效表情类型' };
        return this._wrapHandler(async () => {
          return this._sendEmotionImage(e, t, String(args.text ?? '').trim(), context);
        });
      },
      enabled: true
    });

    this.registerMCPTool('send_file', {
      description: '向当前会话发送非图片类文件（文档、压缩包等）。图片/表情包请用 send_image。filePath 为工作区内路径。',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '工作区内文件路径' },
          name: { type: 'string', description: '可选，客户端显示的文件名' }
        },
        required: ['filePath']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        const filePath = String(args.filePath ?? '').trim();
        if (!filePath) return { success: false, error: 'filePath 不能为空' };
        const workspace = resolveWorkspaceAbsFromContext(context);
        const baseTools = new BaseTools(workspace);
        return this._wrapHandler(async () => {
          let absPath;
          try {
            absPath = baseTools.resolvePathInWorkspace(filePath);
          } catch (err) {
            return { success: false, error: err.message || '路径无效' };
          }
          if (!FileUtils.existsSync(absPath)) {
            return { success: false, error: `文件不存在: ${filePath}` };
          }
          const st = FileUtils.statSync(absPath);
          if (!st?.isFile()) {
            return { success: false, error: '路径不是文件' };
          }
          if (ChatStream._isImageLikePath(absPath)) {
            return { success: false, error: '图片/表情包请用 send_image（segment 发图），勿用 send_file' };
          }
          const displayName = String(args.name ?? path.basename(absPath)).trim() || path.basename(absPath);
          const sender = e?.group_id ? e.group : e?.friend;
          if (!sender?.sendFile) {
            return { success: false, error: '当前环境不支持发送文件' };
          }
          await sender.sendFile(absPath, displayName);
          const where = e.group_id ? `群 ${e.group_id}` : `用户 ${e.user_id}(私聊)`;
          return {
            success: true,
            raw: actionAck(`你已在${where}发送文件「${displayName}」`)
          };
        });
      },
      enabled: true
    });

    this.registerMCPTool('send_image', {
      description: '向当前会话发送图片（segment.image）。filePath 为工作区内图片路径；可选 messageId 回复某条消息。GIF/PNG/JPG 等均走本工具，勿用 send_file。',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '工作区内图片路径' },
          messageId: { type: 'number', description: '可选，回复某条消息' }
        },
        required: ['filePath']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        const filePath = String(args.filePath ?? '').trim();
        if (!filePath) return { success: false, error: 'filePath 不能为空' };
        const workspace = resolveWorkspaceAbsFromContext(context);
        const baseTools = new BaseTools(workspace);
        return this._wrapHandler(async () => {
          let absPath;
          try {
            absPath = baseTools.resolvePathInWorkspace(filePath);
          } catch (err) {
            return { success: false, error: err.message || '路径无效' };
          }
          if (!FileUtils.existsSync(absPath)) {
            return { success: false, error: `文件不存在: ${filePath}` };
          }
          const st = FileUtils.statSync(absPath);
          if (!st?.isFile()) {
            return { success: false, error: '路径不是文件' };
          }
          if (!ChatStream._isImageLikePath(absPath)) {
            return { success: false, error: '非图片文件请用 send_file' };
          }
          if (!e?.reply) {
            return { success: false, error: '当前环境无法发送消息' };
          }
          const replyId = args.messageId != null ? String(args.messageId).trim() : '';
          const payload = buildOutboundSegments(segment, {
            replyId: replyId || null,
            imagePaths: [absPath]
          });
          if (!payload.length) {
            return { success: false, error: '无法组装发送内容' };
          }
          await e.reply(payload);
          const where = e.group_id ? `群 ${e.group_id}` : `用户 ${e.user_id}(私聊)`;
          const name = path.basename(absPath);
          this.recordAIResponse(e, `[图片:${name}]`);
          return {
            success: true,
            raw: actionAck(`你已在${where}发送图片「${name}」`)
          };
        });
      },
      enabled: true
    });

    this.registerMCPTool('emojiReaction', {
      description: `对群消息表情回应。emojiType：${formatEmotionTypeList(EMOJI_REACTION_TYPES)}。msgId 不填则最近一条他人消息。仅群聊。`,
      inputSchema: {
        type: 'object',
        properties: {
          msgId: { type: 'number', description: '可选，不填则最近一条' },
          emojiType: { type: 'string', description: '必填', enum: EMOJI_REACTION_TYPES }
        },
        required: ['emojiType']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        Bot.makeLog(
          'debug',
          `[chat.emojiReaction] 调用上下文: hasE=${Boolean(e)}, isGroup=${e?.isGroup}, message_type=${e?.message_type}, group_id=${e?.group_id}, user_id=${e?.user_id}`,
          'ChatStream'
        );
        if (!e?.isGroup) {
          return { success: false, error: '非群聊环境' };
        }

        const emojiType = normalizeEmotionType(args.emojiType, EMOJI_REACTION_ALIASES);
        const emojiIds = getEmojiReactionIds(emojiType);
        if (!emojiIds) {
          return { success: false, error: '无效表情类型' };
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
          if (group?.setEmojiLike) {
            await group.setEmojiLike(msgId, emojiId, true);
          } else if (e.bot?.sendApi) {
            await e.bot.sendApi('set_msg_emoji_like', {
              message_id: String(msgId),
              emoji_id: emojiId,
              set: true
            });
          } else {
            return { success: false, error: '表情回应功能不可用' };
          }
          await BotUtil.sleep(200);
          const gid = e.group_id;
          return { success: true, raw: actionAck(`你已在群 ${gid} 对消息 ${msgId} 发送了 ${emojiType} 表情回应。`) };
        } catch (error) {
          return { success: false, error: error.message };
        }
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
          return { success: true, raw: actionAck(`你已成功在群 ${gid} 给 ${args.qq} 点赞 ${thumbCount} 下。`) };
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
          return { success: true, raw: actionAck(`你已在群 ${gid} 签到成功。`) };
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
        const adminCheck = this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.muteMember(args.qq, args.duration);
          const gid = context.e.group_id;
          return { success: true, raw: actionAck(`你已成功在群 ${gid} 禁言 ${args.qq} ${args.duration} 秒。`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('unmute', {
      description: '解除禁言。qq 必填。需管理/群主。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { qq: { type: 'number' } },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const adminCheck = this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.muteMember(args.qq, 0);
          const gid = context.e.group_id;
          return { success: true, raw: actionAck(`你已成功在群 ${gid} 解除 ${args.qq} 的禁言。`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('muteAll', {
      description: '全员禁言。需管理/群主。仅群聊。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const adminCheck = this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.muteAll(true);
          const gid = context.e.group_id;
          return { success: true, raw: actionAck(`你已成功在群 ${gid} 开启全员禁言。`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('unmuteAll', {
      description: '解除全员禁言。需管理/群主。仅群聊。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const adminCheck = this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.muteAll(false);
          const gid = context.e.group_id;
          return { success: true, raw: actionAck(`你已成功在群 ${gid} 解除全员禁言。`) };
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
          const selfId = String(e.self_id || e.bot?.uin || '');
          if (targetQq !== selfId) {
            const adminCheck = this._requireGroupAdmin(context);
            if (adminCheck) return adminCheck;
          }

        return this._wrapHandler(async () => {
          await context.e.group.setCard(targetQq, args.card);
          const gid = context.e.group_id;
          const selfId = String(context.e.self_id || context.e.bot?.uin || '');
          const who = targetQq === selfId ? '自己' : targetQq;
          return { success: true, raw: actionAck(`你已成功在群 ${gid} 将 ${who} 的名片改为「${args.card}」。`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setGroupName', {
      description: '修改群名。name 必填。需管理/群主。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name']
      },
      handler: async (args = {}, context = {}) => {
        const adminCheck = this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.setName(args.name);
          const gid = context.e.group_id;
          return { success: true, raw: actionAck(`你已成功将群 ${gid} 的群名改为「${args.name}」。`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setAdmin', {
      description: '设置管理员。qq 必填。需管理/群主。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { qq: { type: 'number' } },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const adminCheck = this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.setAdmin(args.qq, true);
          const gid = context.e.group_id;
          return { success: true, raw: actionAck(`你已成功在群 ${gid} 设置 ${args.qq} 为管理员。`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('unsetAdmin', {
      description: '取消管理员。qq 必填。需管理/群主。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { qq: { type: 'number' } },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const adminCheck = this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.setAdmin(args.qq, false);
          const gid = context.e.group_id;
          return { success: true, raw: actionAck(`你已成功在群 ${gid} 取消 ${args.qq} 的管理员。`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setTitle', {
      description: '设置专属头衔。qq、title 必填；duration 秒，默认-1。需管理/群主。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { qq: { type: 'number' }, title: { type: 'string' }, duration: { type: 'number', default: -1 } },
        required: ['qq', 'title']
      },
      handler: async (args = {}, context = {}) => {
        const adminCheck = this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.setTitle(args.qq, args.title, args.duration || -1);
          const gid = context.e.group_id;
          const dur = args.duration && args.duration > 0 ? `，持续 ${args.duration} 秒` : '';
          return { success: true, raw: actionAck(`你已成功在群 ${gid} 为 ${args.qq} 设置专属头衔「${args.title}」${dur}。`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('kick', {
      description: '踢出群成员。qq 必填；reject 是否拒绝再申请。需管理/群主。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { qq: { type: 'number' }, reject: { type: 'boolean', default: false } },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const adminCheck = this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.kickMember(args.qq, args.reject || false);
          const gid = context.e.group_id;
          const extra = args.reject ? ' 并拒绝其再次申请' : '';
          return { success: true, raw: actionAck(`你已成功在群 ${gid} 踢出 ${args.qq}${extra}。`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setEssence', {
      description: '设置精华消息。msgId 必填。需管理/群主。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { msgId: { type: 'number' } },
        required: ['msgId']
      },
      handler: async (args = {}, context = {}) => {
        const adminCheck = this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;
        
        const msgId = String(args.msgId ?? '').trim();
        if (!msgId) {
          return { success: false, error: '消息ID不能为空' };
        }
        
        return this._wrapHandler(async () => {
          const e = context.e;
          const gid = e.group_id;
          const group = e.group;
          if (group?.setEssenceMessage) {
            await group.setEssenceMessage(msgId);
          } else if (e.bot?.sendApi) {
            await e.bot.sendApi('set_essence_msg', { message_id: msgId });
          } else {
            return { success: false, error: 'API不可用' };
          }
          return { success: true, raw: actionAck(`你已成功在群 ${gid} 将消息 ${msgId} 设为精华。`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('removeEssence', {
      description: '取消精华消息。msgId 必填。需管理/群主。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { msgId: { type: 'number' } },
        required: ['msgId']
      },
      handler: async (args = {}, context = {}) => {
        const adminCheck = this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;
        
        const msgId = String(args.msgId ?? '').trim();
        if (!msgId) {
          return { success: false, error: '消息ID不能为空' };
        }
        
        return this._wrapHandler(async () => {
          const e = context.e;
          const gid = e.group_id;
          const group = e.group;
          if (group?.removeEssenceMessage) {
            await group.removeEssenceMessage(msgId);
          } else if (e.bot?.sendApi) {
            await e.bot.sendApi('delete_essence_msg', { message_id: msgId });
          } else {
            return { success: false, error: 'API不可用' };
          }
          return { success: true, raw: actionAck(`你已成功在群 ${gid} 取消消息 ${msgId} 的精华。`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('announce', {
      description: '发送群公告。content 必填；image 可选。需管理/群主。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { content: { type: 'string' }, image: { type: 'string' } },
        required: ['content']
      },
      handler: async (args = {}, context = {}) => {
        const adminCheck = this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;
        
        const content = String(args.content ?? '').trim();
        if (!content) {
          return { success: false, error: '公告内容不能为空' };
        }
        
        return this._wrapHandler(async () => {
          const e = context.e;
          const gid = e.group_id;
          const group = e.group;
          const image = args.image ? String(args.image).trim() : undefined;
          if (group?.sendNotice) {
            await group.sendNotice(content, { image });
          } else if (group?.setAnnouncement) {
            await group.setAnnouncement(content, undefined, undefined, undefined, undefined, image);
          } else if (e.bot?.sendApi) {
            const params = { group_id: String(e.group_id), content };
            if (image) params.image = image;
            await e.bot.sendApi('_send_group_notice', params);
          } else {
            return { success: false, error: 'API不可用' };
          }
          return { success: true, raw: actionAck(`你已成功在群 ${gid} 发送公告。`) };
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
              return { success: true, raw: actionAck(`你已成功在群 ${gid} 撤回消息 ${args.msgId}。`) };
            } else if (context.e.bot) {
              await context.e.bot.sendApi('delete_msg', { message_id: args.msgId });
              const uid = context.e.user_id;
              return { success: true, raw: actionAck(`你已成功在与 ${uid} 的私聊中撤回消息 ${args.msgId}。`) };
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
            Bot.makeLog('debug', `获取群信息ex成功: ${JSON.stringify(info)}`, 'ChatStream');
            const raw = this._queryToolRawDetail('群扩展信息', info, context.e);
            const result = { success: true, data: info, raw };
            return result;
          }
          const result = { success: false, error: 'API不可用' };
          return result;
        }, 0).catch(error => {
          Bot.makeLog('warn', `获取群信息ex失败: ${error.message}`, 'ChatStream');
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
            Bot.makeLog('debug', `@全体成员剩余次数: ${JSON.stringify(remain)}`, 'ChatStream');
            const raw = this._queryToolRawDetail('@全体剩余次数', remain, context.e);
            const result = { success: true, data: remain, raw };
            return result;
          }
          const result = { success: false, error: 'API不可用' };
          return result;
        }, 0).catch(error => {
          Bot.makeLog('warn', `获取@全体剩余次数失败: ${error.message}`, 'ChatStream');
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
            Bot.makeLog('debug', `群禁言列表: ${JSON.stringify(banList)}`, 'ChatStream');
            const raw = this._queryToolRawDetail('禁言列表', banList, context.e);
            const result = { success: true, data: banList, raw };
            return result;
          }
          const result = { success: false, error: 'API不可用' };
          return result;
        }, 0).catch(error => {
          Bot.makeLog('warn', `获取禁言列表失败: ${error.message}`, 'ChatStream');
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
        const adminCheck = this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;
        
        const msgId = String(args.msgId ?? '').trim();
        if (!msgId) {
          return { success: false, error: '消息ID不能为空' };
        }
        
        return this._wrapHandler(async () => {
          const e = context.e;
          if (e.bot?.sendApi) {
            await e.bot.sendApi('set_group_todo', { group_id: e.group_id, message_id: msgId });
            const gid = e.group_id;
            return { success: true, raw: actionAck(`你已成功在群 ${gid} 将消息 ${msgId} 设为群待办。`) };
          }
          return { success: false, error: 'API不可用' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('completeGroupTodo', {
      description: '完成群待办（NapCat complete_group_todo）。msgId 必填。仅群聊，需管理权限。',
      inputSchema: {
        type: 'object',
        properties: { msgId: { type: 'number' } },
        required: ['msgId']
      },
      handler: async (args = {}, context = {}) => {
        const adminCheck = this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;
        const msgId = String(args.msgId ?? '').trim();
        if (!msgId) return { success: false, error: '消息ID不能为空' };
        return this._wrapHandler(async () => {
          const e = context.e;
          if (e.group?.completeTodo) {
            await e.group.completeTodo(msgId);
          } else {
            await e.bot.sendApi('complete_group_todo', { group_id: e.group_id, message_id: msgId });
          }
          return { success: true, raw: actionAck(`你已在群 ${e.group_id} 完成消息 ${msgId} 的群待办。`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('cancelGroupTodo', {
      description: '取消群待办（NapCat cancel_group_todo）。msgId 必填。仅群聊，需管理权限。',
      inputSchema: {
        type: 'object',
        properties: { msgId: { type: 'number' } },
        required: ['msgId']
      },
      handler: async (args = {}, context = {}) => {
        const adminCheck = this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;
        const msgId = String(args.msgId ?? '').trim();
        if (!msgId) return { success: false, error: '消息ID不能为空' };
        return this._wrapHandler(async () => {
          const e = context.e;
          if (e.group?.cancelTodo) {
            await e.group.cancelTodo(msgId);
          } else {
            await e.bot.sendApi('cancel_group_todo', { group_id: e.group_id, message_id: msgId });
          }
          return { success: true, raw: actionAck(`你已在群 ${e.group_id} 取消消息 ${msgId} 的群待办。`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('listAnnouncements', {
      description: '获取当前群公告列表（NapCat _get_group_notice）。仅群聊。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        const e = context.e;
        let data;
        if (e.group?.getAnnouncements) {
          data = await e.group.getAnnouncements();
        } else {
          data = await e.bot.sendApi('_get_group_notice', { group_id: String(e.group_id) });
        }
        return { success: true, raw: this._queryToolRawDetail('群公告列表', data, e) };
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

    this.registerMCPTool('readChatRecord', {
      description: '读取群聊记录（结构化 JSON）。合并转发仅一层摘要，内层不可展开（框架协议限制）。messageId 可选查单条；limit 默认 30。',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'number', description: '可选，查单条消息详情' },
          limit: { type: 'number', description: `最近条数 1-${ChatStream.GROUP_HISTORY_STORE_MAX}，默认 30` }
        },
        required: []
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        await this.syncHistoryFromAdapter(e);
        const msgId = String(args.messageId ?? '').trim();
        if (msgId) {
          const messageData = await this._fetchMessageById(e, msgId);
          if (!messageData) {
            return { success: false, error: '无法获取消息，可能已过期' };
          }
          const data = this._describeMessageOneLevel(messageData);
          return {
            success: true,
            data,
            raw: this._queryToolRawDetail(`消息 ${msgId}（仅一层）`, data, e)
          };
        }
        const limit = Math.min(
          Math.max(parseInt(args.limit, 10) || 30, 1),
          ChatStream.GROUP_HISTORY_STORE_MAX
        );
        const history = ChatStream.getGroupHistoryForPrompt(e.group_id).slice(-limit);
        const data = {
          limit,
          count: history.length,
          protocolNote: '合并转发/嵌套 node 仅展示一层，内层聊天记录不可读（OneBot 转发协议限制）',
          messages: history.map(m => this._historyEntryToRecord(m))
        };
        return {
          success: true,
          data,
          raw: this._queryToolRawDetail('群聊记录', data, e)
        };
      },
      enabled: true
    });

    this.registerMCPTool('saveMessageAsset', {
      description: '将消息中的图片/文件/自定义表情包下载到 Agent 工作区 downloads/ 下。messageId 必填；index 资源序号默认 0；saveAs 可选相对路径。',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'number' },
          index: { type: 'number', default: 0 },
          saveAs: { type: 'string', description: '工作区内相对路径，默认 downloads/qq/{msgId}_{index}.ext' }
        },
        required: ['messageId']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        if (!e) return { success: false, error: '事件对象不存在' };
        const msgId = String(args.messageId ?? '').trim();
        if (!msgId) return { success: false, error: '消息ID不能为空' };
        const index = Math.max(parseInt(args.index, 10) || 0, 0);
        const messageData = await this._fetchMessageById(e, msgId);
        if (!messageData) {
          return { success: false, error: '无法获取消息，可能已过期' };
        }
        const segments = Array.isArray(messageData.message) ? messageData.message : [];
        const assets = this._extractMessageAssets(segments).filter(
          a => a.type === 'image' || a.type === 'file' || a.type === 'mface'
        );
        if (assets.length === 0) {
          return { success: false, error: '该消息没有可下载的图片/文件/表情包' };
        }
        if (index >= assets.length) {
          return { success: false, error: `index 超出范围，共 ${assets.length} 个可下载资源` };
        }
        const asset = assets[index];
        const workspace = resolveWorkspaceAbsFromContext(context);
        const ext = this._guessAssetExtension(asset);
        const defaultName = asset.name || `qq_${msgId}_${index}${ext}`;
        const relPath = String(args.saveAs ?? '').trim() || path.posix.join('downloads', 'qq', defaultName);
        try {
          const absPath = await this._downloadMessageAssetToWorkspace(e, workspace, asset, relPath);
          const data = {
            messageId: msgId,
            index,
            type: asset.type,
            workspacePath: relPath,
            absolutePath: absPath
          };
          const hint =
            asset.type === 'image' || asset.type === 'mface'
              ? `已保存到 ${relPath}。发图用 send_image；内置表情包用 emotion。`
              : `已保存到 ${relPath}。发非图片文件用 send_file。`;
          return { success: true, data, raw: hint };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('forgeForward', {
      description:
        '整活向：伪造合并转发聊天记录并发到当前会话。messages 为结构化数组；或 batch 字符串（QQ|昵称|内容|时间，多条用||）。QQ 可用 me/我/bot/机器人；内容支持 [图片:url] [视频:url] 与 \\n。仅玩梗/情景再现，勿造谣。',
      inputSchema: {
        type: 'object',
        properties: {
          messages: {
            type: 'array',
            description: '推荐：结构化消息列表',
            items: {
              type: 'object',
              properties: {
                qq: { type: 'string', description: 'QQ 或 me/我/bot/机器人' },
                nickname: { type: 'string' },
                content: { type: 'string', description: '文字；[图片:url]；\\n 换行' },
                time: { type: 'string', description: '可选：-5分钟、刚刚、14:30 等' }
              },
              required: ['qq', 'nickname', 'content']
            }
          },
          batch: {
            type: 'string',
            description: '与 #制造消息 相同：qq|昵称|内容|时间，多条用 ||'
          }
        }
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        if (!e?.reply) return { success: false, error: '当前环境无法发送消息' };
        const hasBatch = String(args.batch ?? '').trim().length > 0;
        const hasMessages = Array.isArray(args.messages) && args.messages.length > 0;
        if (!hasBatch && !hasMessages) {
          return { success: false, error: '请提供 messages 数组或 batch 字符串' };
        }
        if (hasBatch && hasMessages) {
          return { success: false, error: 'messages 与 batch 二选一' };
        }

        return this._wrapHandler(async () => {
          try {
            const ctx = fabricatorContextFromEvent(e);
            const msgList = buildFabricatorMsgList(hasBatch ? String(args.batch).trim() : args.messages, ctx);
            const forwardMsg = await makeFabricatorForwardMsg(e, msgList);
            if (!forwardMsg) {
              return { success: false, error: '当前环境不支持合并转发' };
            }
            await e.reply(forwardMsg);
            const where = e.group_id ? `群 ${e.group_id}` : `用户 ${e.user_id}(私聊)`;
            const preview = msgList
              .map((m, i) => `${i + 1}. ${m.nickname}(${m.user_id}): ${ChatStream._fabricatorPreview(m.message)}`)
              .join('\n');
            this.recordAIResponse(e, `[伪造转发·${msgList.length}条]\n${preview}`);
            return {
              success: true,
              raw: `你已在${where}发送合并转发（共 ${msgList.length} 条）。用户可见。可说「整活完毕」之类收尾，勿重复 forgeForward。`
            };
          } catch (err) {
            return { success: false, error: err?.message || '伪造消息失败' };
          }
        });
      },
      enabled: true
    });

    if (ChatStream.IMAGE_RECOGNITION_MCP_ENABLED) {
      this._registerImageRecognitionTools();
    }
  }

  _registerImageRecognitionTools() {
    this.registerMCPTool('getMessageImages', {
      description: '获取消息中的图片URL列表。messageId 必填（见记录[ID:xxx]）。',
      inputSchema: {
        type: 'object',
        properties: { messageId: { type: 'number' } },
        required: ['messageId']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        if (!e) return { success: false, error: '事件对象不存在' };
        const msgId = String(args.messageId ?? '').trim();
        if (!msgId) return { success: false, error: '消息ID不能为空' };
        try {
          const messageData = await this._fetchMessageById(e, msgId);
          if (!messageData) {
            return { success: false, error: '无法获取消息，消息可能不存在或已过期' };
          }
          const images = this._extractMessageAssets(messageData.message)
            .filter(a => a.type === 'image')
            .map(a => a.url || a.file)
            .filter(Boolean);
          if (images.length === 0 && messageData.raw_message) {
            const cqImageRegex = /\[CQ:image,file=([^\]]+)\]/g;
            let match;
            while ((match = cqImageRegex.exec(messageData.raw_message)) !== null) {
              const urlMatch = match[1].match(/url=([^,]+)/);
              if (urlMatch) images.push(urlMatch[1]);
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
          return { success: true, data, raw: this._queryToolRaw(`消息 ${msgId} 的图片URL`, data) };
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('recognizeImage', {
      description: '识别图片内容。imageUrl 必填；每张图同一会话只调一次。',
      inputSchema: {
        type: 'object',
        properties: { imageUrl: { type: 'string' }, prompt: { type: 'string' } },
        required: ['imageUrl']
      },
      handler: async (args = {}, context = {}) => {
        if (!context.e) return { success: false, error: '事件对象不存在' };
        const imageUrl = String(args.imageUrl ?? '').trim();
        if (!imageUrl) return { success: false, error: '图片URL不能为空' };
        const prompt =
          String(args.prompt ?? '').trim() ||
          '请详细描述这张图片的内容，包括主要对象、场景、文字（如果有）、颜色、风格等。';
        try {
          const llm = await this.callAI(
            [
              { role: 'system', content: '你是图片识别助手。只输出中文描述，不要调用工具。' },
              { role: 'user', content: { text: prompt, images: [imageUrl] } }
            ],
            { enableTools: false }
          );
          if (llm == null || !String(llm.text ?? '').trim()) {
            return { success: false, error: 'AI识别失败，未返回结果' };
          }
          const description = llm.text.trim();
          return {
            success: true,
            data: { description, prompt },
            raw: `识图完成。描述：${description}\n请用 reply 告知用户。`
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
      const segFlags = Array.isArray(e.message) ? this._summarizeSegmentFlags(e.message) : {};
      const hasImage = !!(e.img?.length > 0 || segFlags.hasImage);
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
        time: ChatStream.normalizeHistoryTimeMs(e.time),
        platform: e.platform || 'onebot',
        hasImage,
        hasFile: !!segFlags.hasFile,
        hasFace: !!segFlags.hasFace,
        isForward: !!segFlags.isForward,
        imageCount: imageCount > 0 ? imageCount : undefined
      };

      if (groupId && e.isGroup !== false) {
        ChatStream._pushGroupHistoryEntry(groupId, msgData);
      }

      Bot.makeLog('debug', `[ChatStream] recordMessage group=${groupId} userId=${userId} msgLen=${(message || '').length} messageId=${messageId}`, 'ChatStream');
    } catch (err) {
      Bot.makeLog('debug', `[ChatStream] recordMessage 异常: ${err?.message}`, 'ChatStream');
    }
  }

  getBotRole(e) {
    if (!e.isGroup) return '成员';
    const group = e.group;
    if (group?.is_owner) return '群主';
    if (group?.is_admin) return '管理员';
    const member = group?.pickMember?.(e.self_id);
    const roleValue = member?.role;
    return roleValue === 'owner' ? '群主' :
           roleValue === 'admin' ? '管理员' : '成员';
  }

  recordAIResponse(e, text) {
    if (!text?.trim()) return;
    Bot.makeLog('debug', `[ChatStream] recordAIResponse group=${e?.group_id} textLen=${text.length} text=${text}`, 'ChatStream');
    
    // 提取图片内容标记（不会被用户看见，仅记录到历史）
    const { imageContent, text: cleanText } = parseImageContentMark(text);
    
    const msgData = {
      user_id: e.self_id,
      nickname: e.bot?.nickname || e.bot?.info?.nickname || e.bot?.name || 'Bot',
      message: cleanText || text, // 记录清理后的文本（不含图片内容标记）
      message_id: `local_${Date.now()}`,
      time: 0,
      platform: 'onebot',
      hasImage: false,
      isBot: true,
      imageContentMark: imageContent || undefined // 图片内容标记（如果存在）
    };
    if (e?.isGroup && e.group_id) {
      ChatStream._pushGroupHistoryEntry(e.group_id, msgData, { local: true });
    }
    if (imageContent) {
      Bot.makeLog('debug', `[ChatStream] recordAIResponse 提取图片内容标记: ${imageContent}`, 'ChatStream');
    }
  }

  async _buildMemoryContext(e) {
    try {
      const redisSummary = await this.buildMemorySummary(e);
      if (!redisSummary?.trim()) return null;
      return `【会话记忆】\n${redisSummary.trim()}`;
    } catch (err) {
      Bot.makeLog('debug', `[ChatStream] buildMemorySummary 失败: ${err?.message}`, 'ChatStream');
      return null;
    }
  }

  static _shouldRecordToolInHistory(toolName) {
    const base = String(toolName || '').split('.').pop();
    return base && !ChatStream.TOOL_HISTORY_SKIP.has(base);
  }

  static _dropGroupHistoryState(groupId) {
    ChatStream.messageHistory.delete(groupId);
    ChatStream.historyLocalSeqByGroup.delete(groupId);
  }

  /** OneBot 多为秒级 Unix；本机 Date.now 为毫秒，统一为毫秒再排序 */
  static normalizeHistoryTimeMs(time) {
    const n = Number(time);
    if (!Number.isFinite(n) || n <= 0) return Date.now();
    return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
  }

  static _allocateLocalHistorySlot(groupId) {
    const history = ChatStream.messageHistory.get(groupId) || [];
    let maxT = 0;
    for (const m of history) {
      const t = ChatStream.normalizeHistoryTimeMs(m.time);
      if (t > maxT) maxT = t;
    }
    const seq = (ChatStream.historyLocalSeqByGroup.get(groupId) || 0) + 1;
    ChatStream.historyLocalSeqByGroup.set(groupId, seq);
    return { time: Math.max(Date.now(), maxT + 1), sortSeq: seq };
  }

  static _prepareHistoryEntry(groupId, msgData, { local = false } = {}) {
    const entry = { ...msgData };
    if (local) {
      Object.assign(entry, ChatStream._allocateLocalHistorySlot(groupId));
    } else {
      entry.time = ChatStream.normalizeHistoryTimeMs(entry.time);
    }
    return entry;
  }

  static _mergeAndStoreGroupHistory(groupId, entries) {
    if (!groupId || !entries?.length) return;
    if (!ChatStream.messageHistory.has(groupId)) {
      ChatStream.messageHistory.set(groupId, []);
    }
    const history = ChatStream.messageHistory.get(groupId);
    const merged = ChatStream._sortHistoryChronological(history.concat(entries));
    ChatStream.messageHistory.set(
      groupId,
      merged.length > ChatStream.GROUP_HISTORY_STORE_MAX
        ? merged.slice(-ChatStream.GROUP_HISTORY_STORE_MAX)
        : merged
    );
  }

  static _pushGroupHistoryEntry(groupId, msgData, { local = false } = {}) {
    if (!groupId || !msgData) return;
    const entry = ChatStream._prepareHistoryEntry(groupId, msgData, { local });
    ChatStream._mergeAndStoreGroupHistory(groupId, [entry]);
  }

  /**
   * 将工具调用摘要写入群聊历史（供下一轮 prompt 延续任务；reply 等对外工具跳过）。
   */
  recordToolCallResult(e, toolName, result, args = null) {
    if (!e?.isGroup || !e.group_id) return;
    if (!ChatStream._shouldRecordToolInHistory(toolName)) return;
    try {
      const summary = summarizeToolForHistory(toolName, result, args);
      if (!summary?.trim()) return;
      const msgData = {
        user_id: e.self_id,
        nickname: e.bot?.nickname || e.bot?.info?.nickname || e.bot?.name || 'Bot',
        message: summary.trim(),
        message_id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        time: 0,
        platform: 'onebot',
        hasImage: false,
        isBot: true,
        isTool: true,
        toolName: String(toolName || '')
      };
      ChatStream._pushGroupHistoryEntry(e.group_id, msgData, { local: true });
      Bot.makeLog(
        'debug',
        `[ChatStream] recordToolCallResult tool=${toolName} group=${e.group_id} summaryLen=${summary.length}`,
        'ChatStream'
      );
    } catch (err) {
      Bot.makeLog('debug', `[ChatStream] recordToolCallResult 异常: ${err?.message}`, 'ChatStream');
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
        case 'file': {
          const name = seg.data?.name || seg.name || '未知';
          parts.push(`[文件:${name}]`);
          break;
        }
        case 'mface':
          parts.push('[表情包]');
          break;
        case 'forward':
          parts.push('[合并转发·仅一层]');
          break;
        // 合并转发节点：仅摘要，不展开内层（框架协议一层限制）
        case 'node': {
          const name = seg.data?.name || seg.data?.nickname || '';
          parts.push(name ? `[合并转发:${name}·仅一层]` : '[合并转发·仅一层]');
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
    // 把整段或嵌入的转发 CQ 简化为「[合并转发·仅一层]」
    clean = clean.replace(/\[CQ:forward,[^\]]*]/g, '[合并转发·仅一层]');
    clean = clean.replace(/base64:\/\/[A-Za-z0-9+/=]+/gi, '[base64已省略]');
    clean = clean.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/gi, '[内联图片]');
    clean = clean.replace(
      /\[CQ:image[^\]]*url=https:\/\/multimedia\.nt\.qq\.com\.cn\/download\?[^\]]+\]/gi,
      '[图片]'
    );
    clean = clean.replace(/https:\/\/multimedia\.nt\.qq\.com\.cn\/download\?[^\s"'\]}]+/gi, '[QQ图片链接]');
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
      `${botName}｜QQ ${e.self_id}｜群 ${e.group_id}｜${botRole}｜${dateStr}`,
      persona + masterNote,
      '',
      '## 对用户说话（assistant 正文群里不可见）',
      '- **reply**：文字。`|` 分句 · `[回复:消息ID]` · 群聊 `[at:数字QQ]`',
      '- **emotion**：发表情包图（支持附言与 `[回复:消息ID]`）；用户只要表情时不要填 text',
      '- **send_image**：工作区图片；可选 messageId 回复某条消息',
      '- 工具回执会说明「你已在群里发出什么」；用户已能看到后，不要重复 reply/emotion。',
      '- 禁止 `@QQ`/`@昵称`。只答 `[当前消息]`。',
      '',
      '## 记录',
      '- `昵称(QQ)[ID:xxx]` → QQ/消息ID · send_image · send_file',
      '',
      '## 工作区',
      '- 下文「可用能力」为 MCP 说明；「Workspace context」含 AGENTS / rules / skills。',
      '- skills 的 `<location>` 相对工作区根，用 read 加载 SKILL.md。'
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
          const ref = seg.file || seg.url || seg.data?.file || seg.data?.url;
          if (!ref) continue;
          if (inReplyRegion) {
            replyImages.push(ref);
          } else {
            images.push(ref);
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
              const ref = seg.file || seg.url || seg.data?.file || seg.data?.url;
              if (ref) replyImages.push(ref);
            }
          }
        }
      } catch (err) {
        Bot.makeLog('debug', `[ChatStream] _extractImagesFromEvent 获取被回复图片失败: ${err?.message}`, 'ChatStream');
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
      content: await this.finalizeSystemPromptContent(await this.buildSystemPrompt({ e, question }))
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
        // reverseOrder=false：适配器按时间正序返回，便于与 recordMessage 合并
        rawHistory = await getter(undefined, ChatStream.GROUP_HISTORY_SYNC_FETCH, false);
      } catch {
        rawHistory = await getter(undefined, ChatStream.GROUP_HISTORY_SYNC_FETCH);
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
        const segFlags = this._summarizeSegmentFlags(segments);
        const hasImage = segFlags.hasImage;
        // 确保 user_id 始终存在，QQ号是唯一标识
        const userId = msg.user_id ?? sender.user_id ?? '未知QQ';
        const isBot = String(userId) === String(e.self_id);

        newMessages.push({
          user_id: userId,
          nickname,
          message: text || '',
          message_id: idStr,
          time: ChatStream.normalizeHistoryTimeMs(msg.time),
          platform: 'onebot',
          hasImage,
          hasFile: segFlags.hasFile,
          hasFace: segFlags.hasFace,
          isForward: segFlags.isForward,
          isBot
        });
        existingIds.add(idStr); // 添加到已存在集合，避免重复
      }

      if (newMessages.length > 0) {
        ChatStream._mergeAndStoreGroupHistory(groupId, newMessages);
      }
    } catch (error) {
      Bot.makeLog(
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
  static _isEphemeralBotMessageId(messageId) {
    const id = String(messageId ?? '');
    return id.startsWith('local_') || id.startsWith('tool_') || /^\d{13}$/.test(id);
  }

  /** 按时间升序排列群聊历史（同毫秒用 sortSeq / message_id 兜底） */
  static _sortHistoryChronological(history) {
    if (!Array.isArray(history) || history.length <= 1) return history || [];
    return [...history].sort((a, b) => {
      const ta = ChatStream.normalizeHistoryTimeMs(a?.time);
      const tb = ChatStream.normalizeHistoryTimeMs(b?.time);
      if (ta !== tb) return ta - tb;
      const sa = Number(a?.sortSeq) || 0;
      const sb = Number(b?.sortSeq) || 0;
      if (sa !== sb) return sa - sb;
      const na = Number(a?.message_id);
      const nb = Number(b?.message_id);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
      return String(a?.message_id ?? '').localeCompare(String(b?.message_id ?? ''));
    });
  }

  /** 排序 + 去重压缩，供 prompt 与 readChatRecord 共用 */
  static getGroupHistoryForPrompt(groupId) {
    const raw = ChatStream.messageHistory.get(groupId) || [];
    return ChatStream._compactHistoryForPrompt(ChatStream._sortHistoryChronological(raw));
  }

  /** 合并重复的【我】条目（本地临时 id vs 适配器真实 id）；保留【我·工具】摘要 */
  static _compactHistoryForPrompt(history) {
    if (!Array.isArray(history) || history.length === 0) return [];
    const byBotText = new Map();
    const result = [];
    for (const msg of history) {
      if (msg.isTool) {
        result.push(msg);
        continue;
      }
      if (!msg.isBot) {
        result.push(msg);
        continue;
      }
      const key = ChatStream._sanitizeTextForAI(String(msg.message || '').trim()).slice(0, 300);
      if (!key) {
        result.push(msg);
        continue;
      }
      const prev = byBotText.get(key);
      if (!prev) {
        byBotText.set(key, msg);
        result.push(msg);
        continue;
      }
      const prevEphemeral = ChatStream._isEphemeralBotMessageId(prev.message_id);
      const curEphemeral = ChatStream._isEphemeralBotMessageId(msg.message_id);
      if (prevEphemeral && !curEphemeral) {
        const idx = result.indexOf(prev);
        if (idx >= 0) result[idx] = msg;
        byBotText.set(key, msg);
      }
    }
    return result;
  }

  _formatHistoryMessage(msg) {
    const msgId = msg.message_id || msg.real_id || '未知';
    const imageTag = msg.hasImage ? '[含图片]' : '';
    const fileTag = msg.hasFile ? '[含文件]' : '';
    const faceTag = msg.hasFace ? '[含表情]' : '';
    const forwardTag = msg.isForward ? '[合并转发]' : '';
    const toolLabel = msg.isTool && msg.toolName ? String(msg.toolName) : '';
    const tags = [imageTag, fileTag, faceTag, forwardTag].filter(Boolean).join(' ');
    if (msg.isBot && msg.isTool) {
      const content = this._normalizeMessageText((msg.message || '').replace(/\n/g, ' '));
      const label = toolLabel || '工具';
      return `${tags ? tags + ' ' : ''}【我·工具·${label}】${content}`;
    }
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

    const userMessage = messages[messages.length - 1];
    const isGlobalTrigger = userMessage.content?.isGlobalTrigger || false;
    const debugDumpFullPrompt = userMessage.content?.debugDumpFullPrompt || false;

    await this.syncHistoryFromAdapter(e);

    const history = ChatStream.getGroupHistoryForPrompt(e.group_id);
    const historyLimit = debugDumpFullPrompt
      ? ChatStream.GROUP_HISTORY_PROMPT_DEBUG
      : (isGlobalTrigger ? ChatStream.GROUP_HISTORY_PROMPT_GLOBAL : ChatStream.GROUP_HISTORY_PROMPT_DEFAULT);
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
      const historyBody = recentMessages.map(msg => this._formatHistoryMessage(msg)).join('\n');
      const historyFooter = isGlobalTrigger
        ? ''
        : '\n\n（说明：以上从上到下时间由早到晚；【我·工具】按执行顺序穿插，表示该步已完成；【我】= 你已回复；**只回应下方 `[当前消息]`**。）';
      const historyText = `${historyHeader}\n${historyBody}${historyFooter}`;
      mergedMessages.push({
        role: 'user',
        content: isGlobalTrigger
          ? `${historyText}\n\n请像群里真人一样接一两句：对准气氛或某条发言，可吐槽玩梗；勿全文总结、勿逐条点评、勿重复【我】已说过的话。`
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
        Bot.makeLog(
          r.success ? 'info' : 'warn',
          r.success
            ? `[ChatStream] 已导出 LLM 请求体: ${r.path}`
            : `[ChatStream] 请求体导出失败: ${r.error || '未知'}`,
          'ChatStream'
        );
      } catch (err) {
        Bot.makeLog('error', `[ChatStream] 请求体导出异常: ${err?.message}`, 'ChatStream');
      }
    }

    return super.callAI(forApi, rest);
  }

  /** 是否像工具 JSON 泄漏（仅拦整段 JSON，允许 [回复:id]、[开心] 等协议文本） */
  static _isLikelyToolJsonLeak(text) {
    const t = String(text ?? '').trim();
    if (!t || t.length > 4000) return true;
    if (/^\s*[\[{]/.test(t)) {
      try {
        JSON.parse(t);
        return true;
      } catch {
        /* 以 [ 开头但非 JSON，如 [回复:123]、[开心] */
      }
    }
    if (/"success"\s*:\s*(true|false)/.test(t) && /"data"\s*:/.test(t)) return true;
    if (/"tool_calls"\s*:/.test(t)) return true;
    return false;
  }

  static _prepareFallbackOutgoingText(text) {
    const emotionRe = new RegExp(
      `\\[(${EMOTION_TYPES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\]`,
      'g'
    );
    return String(text ?? '')
      .replace(emotionRe, '')
      .replace(/\[at:\d{5,10}\]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _getUserVisibleTurnState(context) {
    const turn = context?.turnState ?? getStreamRequestContext()?.turnState;
    if (turn) return turn;
    Bot.makeLog('warn', '[ChatStream] 无请求级 turnState，用户可见去重可能失效', 'ChatStream');
    return createUserVisibleTurnState();
  }

  async _sendEmotionImage(e, emotionType, text = '', context = {}) {
    const turn = this._getUserVisibleTurnState(context);
    const where = formatSessionWhere(e);
    if (turn.hasSentEmotion) {
      return {
        success: true,
        raw: formatEmotionSkippedAck(where, turn.lastEmotionSummary)
      };
    }
    const image = this.getRandomEmotionImage(emotionType);
    if (!image) {
      return {
        success: false,
        error: `表情包(${emotionType})暂无图片，请检查 resources/aiimages/${emotionType}/`
      };
    }
    const seg = segment;
    const body = String(text ?? '').trim();
    if (body) {
      const forbidden = replyContentForbidden(body);
      if (forbidden) return { success: false, error: forbidden };
      const filtered = this.stripMarkdownForOutgoing(body);
      if (!filtered) return { success: false, error: '附言清理后为空' };
      const { replyId, segments, displayText } = resolveOutgoingMessage(filtered);
      const payload = buildOutboundSegments(seg, {
        replyId,
        imagePaths: [image],
        segments
      });
      if (!payload.length) return { success: false, error: '无法组装发送内容' };
      await e.reply(payload);
      this.recordAIResponse(e, displayText);
      turn.hasSentEmotion = true;
      turn.lastEmotionSummary = describeEmotionSent(emotionType, displayText);
      return {
        success: true,
        raw: formatEmotionDeliveredAck(where, emotionType, displayText)
      };
    }
    const payload = buildOutboundSegments(seg, { imagePaths: [image] });
    await e.reply(payload);
    this.recordAIResponse(e, '');
    turn.hasSentEmotion = true;
    turn.lastEmotionSummary = describeEmotionSent(emotionType, '');
    return { success: true, raw: formatEmotionDeliveredAck(where, emotionType, '') };
  }

  async _sendUserVisibleText(e, { content = '', messageId } = {}, context = {}) {
    const turn = this._getUserVisibleTurnState(context);
    const where = formatSessionWhere(e);
    const rawContent = String(content ?? '').trim();
    if (!rawContent) return { success: false, error: 'content 不能为空' };

    const filteredContent = this.stripMarkdownForOutgoing(rawContent);
    if (!filteredContent) {
      return { success: false, error: '清理 Markdown 后无可发送正文' };
    }

    if (turn.hasSentReply && turn.lastReplySummary) {
      return {
        success: true,
        raw: formatUserVisibleDuplicateAck(where, turn.lastReplySummary, 'reply')
      };
    }

    if (turn.hasSentEmotion && turn.lastEmotionSummary) {
      const emotionText = turn.lastEmotionSummary.match(/附言「(.+)」/)?.[1] || '';
      if (emotionText && isOverlappingUserVisible(filteredContent, emotionText)) {
        return {
          success: true,
          raw: formatUserVisibleDuplicateAck(where, turn.lastEmotionSummary, 'reply')
        };
      }
    }

    const forbidden = replyContentForbidden(filteredContent);
    if (forbidden) return { success: false, error: forbidden };

    if (contentHasGroupAt(filteredContent) && !e?.isGroup) {
      return { success: false, error: '[at:QQ] 仅群聊可用' };
    }

    const { totalSent, allSentContent } = await this._processAndSendTextProtocol(e, filteredContent, {
      messageId,
      recordToHistory: true,
      updateReplyContents: true
    });
    if (totalSent < 1) {
      return { success: false, error: '未能发出任何可见消息，请检查 content 与文本协议' };
    }
    turn.hasSentReply = true;
    turn.lastReplySummary = allSentContent.join(' | ');
    return {
      success: true,
      raw: formatDeliveredAck(where, allSentContent)
    };
  }

  async _ensureUserVisibleReply(e, llm, text) {
    if (!e?.reply || llm?.usedReplyTool) return { llm, text };

    if (llm?.toolRoundsExhausted) {
      const notice = text || TOOL_ROUNDS_EXHAUSTED_USER_TEXT;
      await this._processAndSendTextProtocol(e, notice, { recordToHistory: true });
      return { llm, text: notice };
    }

    const fallback = ChatStream._prepareFallbackOutgoingText(text);
    if (fallback && !ChatStream._isLikelyToolJsonLeak(fallback)) {
      Bot.makeLog('warn', `[ChatStream] 未调用 reply，框架兜底发出 len=${fallback.length}`, 'ChatStream');
      await this._processAndSendTextProtocol(e, fallback, {
        recordToHistory: true,
        messageId: e.message_id || e.real_id
      });
      return { llm, text: fallback };
    }
    return { llm, text };
  }

  async execute(e, messages, config) {
    let debugDumpFullPrompt = false;
    if (!Array.isArray(messages) && messages && typeof messages === 'object') {
      debugDumpFullPrompt = !!messages.debugDumpFullPrompt;
    }

    return runWithStreamRequestContext({ e, turnState: createUserVisibleTurnState() }, async () => {
      try {
        if (e) this.recordMessage(e);

        if (!Array.isArray(messages)) {
          messages = await this.buildChatContext(e, messages);
        }

        messages = await this.mergeMessageHistory(messages, e);

        const query = Array.isArray(messages) ? this.extractQueryFromMessages(messages) : messages;
        messages = await this.buildEnhancedContext(e, query, messages);

        if (Bot.StreamLoader) Bot.StreamLoader.currentEvent = e || null;

        const callOpts = { ...config, debugDumpFullPrompt, _debugDumpEvent: e };
        let llm = await this.callAI(messages, callOpts);
        if (llm == null) return null;

        let text = String(llm.text ?? '').trim();
        if (text) text = this.stripMarkdownForOutgoing(text);

        ({ llm, text } = await this._ensureUserVisibleReply(e, llm, text));

        return text || '';
      } catch (error) {
        Bot.makeLog('error', `[ChatStream] execute 失败: ${error.message}`, 'ChatStream');
        return null;
      } finally {
        if (Bot.StreamLoader?.currentEvent === e) Bot.StreamLoader.currentEvent = null;
      }
    });
  }

  /**
   * 文本协议：分句（|）、[回复:ID]、[at:QQ]、[图片内容:]
   */
  async _processAndSendTextProtocol(e, content, options = {}) {
    const { messageId, recordToHistory = true, updateReplyContents = true } = options;
    if (!e?.reply || !content?.trim()) {
      return { totalSent: 0, allSentContent: [] };
    }

    const messages = content.split(/[|｜]/).map(m => m.trim()).filter(Boolean);
    if (messages.length === 0) {
      return { totalSent: 0, allSentContent: [] };
    }

    const seg = segment;
    let totalSent = 0;
    const allSentContent = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;

      const { imageContent, replyId, segments, displayText } = resolveOutgoingMessage(msg, {
        fallbackReplyId: messageId
      });
      const payload = buildOutboundSegments(seg, { replyId, segments });
      if (!payload.length) continue;

      await e.reply(payload);

      const sentContent = displayText || msg;
      if (recordToHistory) {
        const originalTextWithMark = imageContent
          ? `${sentContent}[图片内容:${imageContent}]`
          : sentContent;
        this.recordAIResponse(e, originalTextWithMark);
      }
      if (updateReplyContents) {
        allSentContent.push(sentContent);
      }
      totalSent++;

      if (i < messages.length - 1) {
        await BotUtil.sleep(randomRange(800, 1500));
      }
    }

    return { totalSent, allSentContent };
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

  static _isImageLikePath(filePath) {
    const ext = path.extname(String(filePath ?? '')).toLowerCase();
    return IMAGE_SEND_EXTS.has(ext);
  }

  /** 伪造转发记录预览（不把 URL/base64 灌进历史） */
  static _fabricatorPreview(message) {
    if (typeof message === 'string') {
      return ChatStream._sanitizeTextForAI(message.replace(/\n/g, ' ')).slice(0, 80);
    }
    if (!Array.isArray(message)) return '[媒体]';
    const parts = [];
    for (const seg of message) {
      if (typeof seg === 'string') parts.push(seg);
      else if (seg?.type === 'image') parts.push('[图片]');
      else if (seg?.type === 'video') parts.push('[视频]');
    }
    const joined = parts.join('').replace(/\n/g, ' ').trim();
    return joined ? joined.slice(0, 80) : '[媒体]';
  }

  /** 工具返回 / 聊天记录注入 AI 前脱敏（省略 base64、长图链） */
  static _sanitizeTextForAI(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      .replace(/base64:\/\/[A-Za-z0-9+/=]+/gi, 'base64://…')
      .replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/gi, '[内联图片]');
  }

  /** 协议片段占位，避免被 Markdown 规则误伤（含表情、[CQ]、[回复]、[图片内容:]） */
  static _protectProtocolMarkers(text) {
    const tokens = [];
    const re = new RegExp(PROTOCOL_MARKER_RE.source, PROTOCOL_MARKER_RE.flags);
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

  cleanupCache() {
    for (const [groupId, messages] of ChatStream.messageHistory.entries()) {
      if (!messages?.length) {
        ChatStream._dropGroupHistoryState(groupId);
        continue;
      }
      if (messages.length > ChatStream.GROUP_HISTORY_STORE_MAX) {
        const sorted = ChatStream._sortHistoryChronological(messages);
        ChatStream.messageHistory.set(groupId, sorted.slice(-ChatStream.GROUP_HISTORY_STORE_MAX));
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
      const overrides = { ...resolved, stream: false, streams: stream._getToolStreamNames() };
      const timeoutMs = client.timeout ?? client._timeout ?? 360000;
      const ctor = client.constructor?.name || '';

      let requestBody = null;
      let requestBodyError = null;

      if (typeof client.buildBody === 'function' && client.config) {
        try {
          requestBody = await ChatStream._buildRound1RequestBody(client, ctor, messagesAssembled, overrides, timeoutMs);
        } catch (prepErr) {
          requestBodyError = prepErr.message;
          Bot.makeLog('warn', `[ChatStream] request_body 构建失败，仅写入 messages_assembled: ${prepErr.message}`, 'ChatStream');
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
      Bot.makeLog('error', `[ChatStream] dumpLlmRequestSnapshot 失败: ${error.message}`, 'ChatStream');
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
        ChatStream._dropGroupHistoryState(gid);
        result.cleared.history = true;
        Bot.makeLog('debug', `[ChatStream] clearConversation 清除聊天记录 group=${gid}`, 'ChatStream');
      }

      Bot.makeLog('debug', `[ChatStream] clearConversation 完成 group=${gid} cleared=${JSON.stringify(result.cleared)}`, 'ChatStream');
    } catch (error) {
      result.success = false;
      Bot.makeLog('error', `[ChatStream] clearConversation 失败: ${error.message}`, 'ChatStream');
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