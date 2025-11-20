/**
 * WebSocket工具
 * 统一管理WebSocket命令发送
 */

import WebSocket from 'ws';
import { generateCommandId } from './deviceUtil.js';

/**
 * 发送命令到WebSocket客户端
 * @param {WebSocket} ws - WebSocket连接
 * @param {string} command - 命令名称
 * @param {Object} parameters - 命令参数
 * @param {number} priority - 优先级（默认1）
 * @returns {boolean} 是否发送成功
 */
export function sendWebSocketCommand(ws, command, parameters = {}, priority = 1) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  
  try {
    const cmd = {
      id: generateCommandId(),
      command,
      parameters,
      priority,
      timestamp: Date.now()
    };
    ws.send(JSON.stringify({ type: 'command', command: cmd }));
    return true;
  } catch (e) {
    console.error(`发送WebSocket命令失败 [${command}]:`, e);
    return false;
  }
}

/**
 * 发送表情命令到前端
 * @param {WebSocket} ws - WebSocket连接
 * @param {string} emotion - 表情代码（英文，如'happy'）
 * @returns {boolean} 是否发送成功
 */
export function sendEmotionCommand(ws, emotion) {
  if (!emotion) return false;
  return sendWebSocketCommand(ws, 'display_emotion', { emotion }, 1);
}

/**
 * 发送TTS音频命令到前端
 * @param {WebSocket} ws - WebSocket连接
 * @param {string} audioHex - 音频数据的十六进制字符串
 * @returns {boolean} 是否发送成功
 */
export function sendTTSAudioCommand(ws, audioHex) {
  if (!audioHex || typeof audioHex !== 'string' || audioHex.length === 0) {
    return false;
  }
  return sendWebSocketCommand(ws, 'play_tts_audio', { audio_data: audioHex }, 1);
}

