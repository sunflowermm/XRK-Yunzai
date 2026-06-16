/**
 * 机器人管理API
 */
import {
  normalizeTargetId,
  normalizeMessageType,
  buildSendMessage,
  resolveSendBot,
} from '../../../lib/http/utils/messageSend.js';
import { respondFail, sanitizeErrorMessage } from '../../../lib/http/utils/helpers.js';

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

        res.json({ success: true, friends: bot.fl ? Array.from(bot.fl.values()) : [] });
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

        res.json({ success: true, groups: bot.gl ? Array.from(bot.gl.values()) : [] });
      }
    },

    {
      method: 'POST',
      path: '/api/message/send',
      handler: async (req, res, Bot) => {
        const body = req.body ?? {};
        const { bot_id, type, target_id, message, file_id, file_ids } = body;

        if (!type || target_id == null || target_id === '') {
          return res.status(400).json({
            success: false,
            message: '缺少必要参数：type、target_id'
          });
        }

        const hasContent = message != null && message !== ''
          || file_id || (file_ids != null && (Array.isArray(file_ids) ? file_ids.length : file_ids));
        if (!hasContent) {
          return res.status(400).json({
            success: false,
            message: '请提供 message 或 file_id/file_ids（先上传图片）'
          });
        }

        const msgType = normalizeMessageType(type);
        if (msgType !== 'private' && msgType !== 'group') {
          return res.status(400).json({
            success: false,
            message: '不支持的消息类型，请使用 private/group'
          });
        }

        const resolved = resolveSendBot(Bot, bot_id);
        if (resolved.error) {
          return res.status(resolved.status || 400).json({
            success: false,
            message: resolved.error
          });
        }

        const { botId } = resolved;
        const targetId = normalizeTargetId(target_id);

        let processedMessage;
        try {
          processedMessage = await buildSendMessage(body);
        } catch (error) {
          return respondFail(res, error.status || 400, error.message || '消息格式无效', 'BotAPI', error);
        }

        if (processedMessage == null || processedMessage === '') {
          return res.status(400).json({ success: false, message: '消息内容不能为空' });
        }

        try {
          const sendResult = msgType === 'private'
            ? await Bot.sendFriendMsg(botId, targetId, processedMessage)
            : await Bot.sendGroupMsg(botId, targetId, processedMessage);

          const messageId = sendResult?.message_id ?? sendResult?.data?.message_id;

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
            results: [{ message_id: messageId, time: Date.now() / 1000, raw_message: processedMessage }],
            timestamp: Date.now()
          });
        } catch (error) {
          return respondFail(
            res,
            500,
            sanitizeErrorMessage(error, '发送失败'),
            'BotAPI',
            error
          );
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
          return respondFail(res, 500, '操作失败', 'BotAPI', error);
        }
      }
    }
  ],

  ws: {
    messages: [(conn, req, Bot) => {
      const messageListener = (data) => {
        conn.sendMsg(JSON.stringify({ type: 'message', data, timestamp: Date.now() }));
      };
      const sendListener = (data) => {
        conn.sendMsg(JSON.stringify({ type: 'message.send', data, timestamp: Date.now() }));
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
