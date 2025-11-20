/**
 * AI流式输出API
 * 提供SSE流式输出，并自动处理表情和TTS
 */

import StreamLoader from '../../lib/aistream/loader.js';
import { deviceManager, getTTSClientForDevice } from './device.js';
import BotUtil from '../../lib/common/util.js';

/**
 * 设置SSE响应头
 */
function setSSEHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

/**
 * 发送SSE数据
 */
function sendSSEData(res, data) {
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (e) {
    // 客户端可能已断开连接，忽略错误
  }
}


/**
 * 处理流式输出完成后的逻辑
 * 使用工作流统一处理表情和TTS
 */
async function handleStreamComplete(res, finalText, stream, deviceBot) {
  if (!finalText) {
    sendSSEData(res, { done: true, text: '' });
    return;
  }

  BotUtil.makeLog('info', `[AI流式] 开始处理完成文本: ${finalText.substring(0, 100)}`, 'AIStream');

  // 解析表情
  const { emotion, cleanText } = stream.parseEmotion(finalText);
  BotUtil.makeLog('info', `[AI流式] 解析结果 - emotion: ${emotion || 'null'}, cleanText: ${cleanText || 'null'}`, 'AIStream');
  
  const displayText = cleanText || finalText;

  // 发送完整文本（清理后的文本，不包含表情标记）
  sendSSEData(res, { done: true, text: displayText });

  // 如果提供了deviceBot，直接调用emotion()切换表情
  if (emotion) {
    if (deviceBot && typeof deviceBot.emotion === 'function') {
      try {
        BotUtil.makeLog('info', `[AI流式] 准备切换表情: ${emotion}`, 'AIStream');
        await deviceBot.emotion(emotion);
        BotUtil.makeLog('info', `✓ [AI流式] 表情已切换: ${emotion}`, 'AIStream');
      } catch (e) {
        BotUtil.makeLog('error', `❌ [AI流式] 表情切换失败: ${e.message}`, 'AIStream');
        BotUtil.makeLog('error', `❌ [AI流式] 错误堆栈: ${e.stack}`, 'AIStream');
      }
    } else {
      BotUtil.makeLog('warn', `⚠ [AI流式] deviceBot不可用，无法切换表情: ${emotion}`, 'AIStream');
      BotUtil.makeLog('warn', `⚠ [AI流式] deviceBot类型: ${typeof deviceBot}, emotion方法: ${deviceBot && typeof deviceBot.emotion}`, 'AIStream');
    }
  } else {
    BotUtil.makeLog('info', `[AI流式] 未检测到表情标记`, 'AIStream');
  }

  // 触发TTS
  const ttsConfig = deviceManager.getTTSConfig();
  if (ttsConfig.enabled && displayText && deviceBot) {
    try {
      const ttsClient = getTTSClientForDevice('webclient');
      if (ttsClient) {
        await ttsClient.synthesize(displayText);
        BotUtil.makeLog('info', `✓ [AI流式] TTS合成完成`, 'AIStream');
      }
    } catch (e) {
      BotUtil.makeLog('error', `❌ [AI流式] TTS合成失败: ${e.message}`, 'AIStream');
    }
  }
}

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
          
          // 获取设备工作流
          const stream = StreamLoader.getStream('device');
          if (!stream) {
            setSSEHeaders(res);
            sendSSEData(res, { error: '设备工作流未加载' });
            res.end();
            return;
          }

          // 设置SSE头
          setSSEHeaders(res);

          // 获取webclient的Bot实例（用于表情和TTS）
          // 等待一下确保设备已注册
          let deviceBot = null;
          if (typeof Bot !== 'undefined' && Bot['webclient']) {
            deviceBot = Bot['webclient'];
            BotUtil.makeLog('info', `[AI流式] 找到deviceBot实例`, 'AIStream');
          } else {
            BotUtil.makeLog('warn', `[AI流式] deviceBot未找到，等待注册...`, 'AIStream');
            // 如果Bot未就绪，尝试等待一下
            for (let i = 0; i < 10; i++) {
              await new Promise(r => setTimeout(r, 100));
              if (typeof Bot !== 'undefined' && Bot['webclient']) {
                deviceBot = Bot['webclient'];
                BotUtil.makeLog('info', `[AI流式] deviceBot已就绪 (等待${i + 1}次)`, 'AIStream');
                break;
              }
            }
            if (!deviceBot) {
              BotUtil.makeLog('warn', `[AI流式] deviceBot等待超时，表情和TTS可能无法工作`, 'AIStream');
            }
          }

          // 构建消息并开始流式输出
          const messages = await stream.buildChatContext(null, { text: prompt, persona });
          let acc = '';
          
          await stream.callAIStream(messages, stream.config, (delta) => {
            acc += delta;
            sendSSEData(res, { delta });
          });

          // 流式输出完成后，处理表情和TTS（通过deviceBot统一处理）
          await handleStreamComplete(res, acc.trim(), stream, deviceBot);
          
          res.end();
        } catch (e) {
          // 错误处理
          try {
            if (!res.headersSent) {
              setSSEHeaders(res);
            }
            sendSSEData(res, { error: e.message || '未知错误' });
          } catch (err) {
            // 写入失败，可能客户端已断开
          }
          res.end();
        }
      }
    }
  ]
};


