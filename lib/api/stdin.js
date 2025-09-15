import fs from "fs";
import path from "path";

export default {
  name: 'stdin-api',
  description: '标准输入API接口',

  routes: [
    {
      method: 'GET',
      path: '/api/stdin/status',
      handler: async (req, res, Bot) => {
        const stdinHandler = global.stdinHandler;
        
        if (!stdinHandler) {
          return res.status(503).json({
            success: false,
            code: 503,
            message: 'Stdin handler not initialized'
          });
        }

        const tempDir = path.join(process.cwd(), "www/stdin");
        const mediaDir = path.join(process.cwd(), "www/media");
        
        res.json({
          success: true,
          code: 200,
          data: {
            bot_id: 'stdin',
            status: 'online',
            uptime: process.uptime(),
            temp_files: fs.existsSync(tempDir) ? fs.readdirSync(tempDir).length : 0,
            media_files: fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).length : 0,
            base_url: Bot.url,
            timestamp: Date.now()
          }
        });
      }
    },

    {
      method: 'POST',
      path: '/api/stdin/command',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ 
            success: false, 
            code: 403,
            message: 'Unauthorized' 
          });
        }

        const stdinHandler = global.stdinHandler;
        
        if (!stdinHandler) {
          return res.status(503).json({
            success: false,
            code: 503,
            message: 'Stdin handler not initialized'
          });
        }

        try {
          const { command, user_info = {} } = req.body;
          
          if (!command) {
            return res.status(400).json({
              success: false,
              code: 400,
              message: 'Command is required'
            });
          }

          user_info.adapter = 'api';
          const result = await stdinHandler.processCommand(command, user_info);
          res.json(result);
        } catch (error) {
          res.status(500).json({
            success: false,
            code: 500,
            error: error.message,
            timestamp: Date.now()
          });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/stdin/event',
      handler: async (req, res, Bot) => {
        if (!Bot.checkApiAuthorization(req)) {
          return res.status(403).json({ 
            success: false, 
            code: 403,
            message: 'Unauthorized' 
          });
        }

        const stdinHandler = global.stdinHandler;
        
        if (!stdinHandler) {
          return res.status(503).json({
            success: false,
            code: 503,
            message: 'Stdin handler not initialized'
          });
        }

        try {
          const { event_type = 'message', content, user_info = {} } = req.body;
          
          // 设置adapter为api
          user_info.adapter = 'api';
          
          // 创建并触发事件
          const event = stdinHandler.createEvent(content, {
            ...user_info,
            post_type: event_type
          });

          // 触发Bot事件
          Bot.em(event_type, event);

          res.json({
            success: true,
            code: 200,
            message: 'Event triggered',
            event_id: event.message_id,
            timestamp: Date.now()
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            code: 500,
            error: error.message,
            timestamp: Date.now()
          });
        }
      }
    }
  ],

  async init(app, bot) {
    if (!global.stdinHandler) {
      const StdinHandler = (await import('../../plugins/adapter/Stdin.js')).StdinHandler;
      global.stdinHandler = new StdinHandler();
    }

    bot.wsf.stdin = [(conn, req) => {
      const listener = (data) => {
        conn.sendMsg(JSON.stringify({
          type: 'stdin',
          data,
          timestamp: Date.now()
        }));
      };

      bot.on('stdin.command', listener);
      bot.on('stdin.output', listener);

      conn.on('close', () => {
        bot.off('stdin.command', listener);
        bot.off('stdin.output', listener);
      });
    }];
  }
};