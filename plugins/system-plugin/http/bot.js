/**
 * 机器人管理API
 * 提供机器人状态查询、消息发送、好友群组列表等功能
 */
import {
  normalizeTargetId,
  normalizeSendMessage,
  normalizeMessageType,
  parseAdapterSendError,
  resolveSendBot,
  validateSendTarget,
} from '../../../lib/http/utils/messageSend.js';

export default {
  name: 'bot',
  dsc: '机器人管理与消息API',
  priority: 100,

  routes: [
    {
      method: 'GET',
      path: '/api/bots',
      handler: async (req, res, Bot) => {
        const bots = Object.entries(Bot.bots)
          .filter(([uin, bot]) => {
            if (!bot) return false;
            const excludeKeys = ['port', 'apiKey', 'stdin', 'logger', '_eventsCount', 'url'];
            if (excludeKeys.includes(uin)) return false;
            if (bot.device) return false;
            return bot.adapter || bot.nickname || bot.fl || bot.gl;
          })
          .map(([uin, bot]) => ({
            uin,
            online: bot.stat && bot.stat.online || false,
            nickname: bot.nickname || uin,
            adapter: bot.adapter && bot.adapter.name || 'unknown',
            friends: bot.fl && bot.fl.size || 0,
            groups: bot.gl && bot.gl.size || 0
          }));

        res.json({ success: true, bots });
      }
    },

    {
      method: 'GET',
      path: '/api/bot/:uin/friends',
      handler: async (req, res, Bot) => {
        const { uin } = req.params;
        const bot = Bot.bots[uin];

        if (!bot) {
          return res.status(404).json({ success: false, message: '机器人不存在' });
        }

        const friends = bot.fl ? Array.from(bot.fl.values()) : [];
        res.json({ success: true, friends });
      }
    },

    {
      method: 'GET',
      path: '/api/bot/:uin/groups',
      handler: async (req, res, Bot) => {
        const { uin } = req.params;
        const bot = Bot.bots[uin];

        if (!bot) {
          return res.status(404).json({ success: false, message: '机器人不存在' });
        }

        const groups = bot.gl ? Array.from(bot.gl.values()) : [];
        res.json({ success: true, groups });
      }
    },

    {
      method: 'POST',
      path: '/api/message/send',
      handler: async (req, res, Bot) => {
        const { bot_id, type, target_id, message } = req.body ?? {};

        if (!type || target_id == null || target_id === '' || message == null) {
          return res.status(400).json({
            success: false,
            message: '缺少必要参数：type、target_id、message'
          });
        }

        const msgType = normalizeMessageType(type);
        if (msgType !== 'private' && msgType !== 'group') {
          return res.status(400).json({
            success: false,
            message: '不支持的消息类型，请使用 private/group'
          });
        }

        const processedMessage = normalizeSendMessage(message);
        if (processedMessage == null || processedMessage === '') {
          return res.status(400).json({
            success: false,
            message: '消息内容不能为空'
          });
        }

        const targetId = normalizeTargetId(target_id);
        const resolved = resolveSendBot(Bot, bot_id);
        if (resolved.error) {
          return res.status(resolved.status || 400).json({
            success: false,
            message: resolved.error
          });
        }

        const { botId } = resolved;
        const targetCheck = validateSendTarget(Bot, resolved.bot, msgType, targetId);

        try {
          let sendResult;
          if (msgType === 'private') {
            sendResult = await Bot.sendFriendMsg(botId, targetId, processedMessage);
          } else {
            sendResult = await Bot.sendGroupMsg(botId, targetId, processedMessage);
          }

          const messageId = sendResult?.message_id ?? sendResult?.data?.message_id;
          const result = {
            message_id: messageId,
            time: Date.now() / 1000,
            raw_message: processedMessage
          };

          Bot.em('message.send', {
            bot_id: botId,
            type: msgType,
            target_id: targetId,
            message: processedMessage,
            message_id: messageId,
            time: Math.floor(Date.now() / 1000)
          });

          res.json({
            success: true,
            message_id: messageId,
            results: [result],
            timestamp: Date.now(),
            ...(targetCheck.warn ? { warn: targetCheck.warn } : {})
          });
        } catch (error) {
          const detail = parseAdapterSendError(error);
          Bot.makeLog('warn', `[message/send] ${msgType} ${targetId}: ${detail}`, 'BotAPI');
          res.status(500).json({
            success: false,
            message: '发送失败',
            error: detail,
            ...(targetCheck.warn ? { warn: targetCheck.warn } : {})
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/bot/:uin/control',
      handler: async (req, res, Bot) => {

        const { uin } = req.params;
        const { action } = req.body;

        if (!Bot.bots[uin]) {
          return res.status(404).json({ success: false, message: '机器人不存在' });
        }

        try {
          switch (action) {
            case 'shutdown':
              await global.redis.set(`Yz:shutdown:${uin}`, 'true');
              res.json({ success: true, message: '已关机' });
              break;
            case 'startup':
              await global.redis.del(`Yz:shutdown:${uin}`);
              res.json({ success: true, message: '已开机' });
              break;
            default:
              res.status(400).json({ success: false, message: '不支持的操作' });
          }
        } catch (error) {
          res.status(500).json({
            success: false,
            message: '操作失败',
            error: error.message
          });
        }
      }
    }
  ],

  // WebSocket处理器
  ws: {
    messages: [(conn, req, Bot) => {
      const messageListener = (data) => {
        conn.sendMsg(JSON.stringify({
          type: 'message',
          data,
          timestamp: Date.now()
        }));
      };

      const sendListener = (data) => {
        conn.sendMsg(JSON.stringify({
          type: 'message.send',
          data,
          timestamp: Date.now()
        }));
      };

      Bot.on('message', messageListener);
      Bot.on('message.send', sendListener);

      conn.on('close', () => {
        Bot.off('message', messageListener);
        Bot.off('message.send', sendListener);
      });
    }]
  },
};
