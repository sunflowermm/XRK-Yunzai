import StreamLoader from '../../lib/aistream/loader.js';
import { deviceWebSockets, deviceManager } from './device.js';
import TTSFactory from '../../components/tts/TTSFactory.js';
import WebSocket from 'ws';
import { generateCommandId } from '../../components/util/deviceUtil.js';
import cfg from '../../lib/config/config.js';

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
          
          // 流式输出完成后，解析表情并触发TTS
          const finalText = acc.trim();
          if (finalText) {
            // 解析表情
            const { emotion, cleanText } = stream.parseEmotion(finalText);
            
            // 发送完整文本（清理后的文本）
            try {
              res.write(`data: ${JSON.stringify({ done: true, text: cleanText || finalText })}\n\n`);
            } catch (e) {
              // 客户端可能已断开连接
            }
            
            // 发送表情命令到前端
            if (emotion) {
              try {
                const ws = deviceWebSockets.get('webclient');
                if (ws && ws.readyState === WebSocket.OPEN) {
                  const cmd = {
                    id: generateCommandId(),
                    command: 'display_emotion',
                    parameters: { emotion },
                    priority: 1,
                    timestamp: Date.now()
                  };
                  ws.send(JSON.stringify({ type: 'command', command: cmd }));
                }
              } catch (e) {
                console.error('发送表情命令失败:', e);
              }
            }
            
            // 触发TTS
            const ttsConfig = deviceManager.getTTSConfig();
            if (ttsConfig.enabled && (cleanText || finalText)) {
              try {
                // 创建临时的Bot对象来接收音频
                const fakeBot = {
                  webclient: {
                    sendAudioChunk: (hex) => {
                      const ws = deviceWebSockets.get('webclient');
                      if (ws && ws.readyState === WebSocket.OPEN && typeof hex === 'string' && hex.length > 0) {
                        const cmd = {
                          command: 'play_tts_audio',
                          parameters: { audio_data: hex },
                          priority: 1,
                          timestamp: Date.now()
                        };
                        try {
                          ws.send(JSON.stringify({ type: 'command', command: cmd }));
                        } catch (e) {
                          // 忽略发送错误
                        }
                      }
                    }
                  }
                };
                const ttsClient = TTSFactory.createClient('webclient', ttsConfig, fakeBot);
                await ttsClient.synthesize(cleanText || finalText);
              } catch (e) {
                // TTS合成失败，但不影响主流程
                console.error('TTS合成失败:', e);
              }
            }
          } else {
            try {
              res.write(`data: ${JSON.stringify({ done: true, text: finalText })}\n\n`);
            } catch (e) {
              // 客户端可能已断开连接
            }
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


