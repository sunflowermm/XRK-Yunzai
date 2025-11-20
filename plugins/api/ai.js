import StreamLoader from '../../lib/aistream/loader.js';

export default {
  name: 'ai-stream',
  dsc: 'AI 流式输出（SSE）',
  priority: 80,
  routes: [
    {
      method: 'GET',
      path: '/api/ai/stream',
      handler: async (req, res) => {
        try {
          const prompt = (req.query.prompt || '').toString();
          const persona = (req.query.persona || '').toString();
          const stream = StreamLoader.getStream('device');
          if (!stream) {
            // SSE 头
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders?.();
            res.write(`data: ${JSON.stringify({ error: '设备工作流未加载' })}\n\n`);
            res.end();
            return;
          }
          // SSE 头
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.flushHeaders?.();

          const messages = await stream.buildChatContext(null, { text: prompt, persona });
          let acc = '';
          await stream.callAIStream(messages, stream.config, (delta) => {
            acc += delta;
            try {
              res.write(`data: ${JSON.stringify({ delta })}\n\n`);
            } catch (e) {
              // 客户端可能已断开连接
            }
          });
          try {
            res.write(`data: ${JSON.stringify({ done: true, text: acc })}\n\n`);
          } catch (e) {
            // 客户端可能已断开连接
          }
          res.end();
        } catch (e) {
          try {
            // 如果还没有设置SSE头，先设置
            if (!res.headersSent) {
              res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              res.flushHeaders?.();
            }
            res.write(`data: ${JSON.stringify({ error: e.message || '未知错误' })}\n\n`);
          } catch (err) {
            // 写入失败，可能客户端已断开
          }
          res.end();
        }
      }
    }
  ]
};


