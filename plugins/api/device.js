import cfg from '../../lib/config/config.js';
import WebSocket from 'ws';
import BotUtil from '../../lib/common/util.js';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { v4 as uuidv4 } from 'uuid';

// ============================================================
// 火山引擎ASR配置（请填写您的配置）
// ============================================================
const VOLCENGINE_ASR_CONFIG = {
  enabled: true,  // 是否启用火山引擎ASR
  wsUrl: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',  // 双向流式优化版
  appKey: '你的APP_KEY',  // X-Api-App-Key
  accessKey: '你的ACCESS_KEY',  // X-Api-Access-Key
  resourceId: 'volc.bigasr.sauc.duration',  // 资源ID
  // ASR参数
  enableItn: true,       // 文本规范化
  enablePunc: true,      // 启用标点
  enableDdc: false,      // 语义顺滑
  showUtterances: true,  // 显示分句信息
  resultType: 'full'     // 结果返回方式：full=全量，single=增量
};

// ============================================================
// 数据存储
// ============================================================
const devices = new Map();
const deviceWebSockets = new Map();
const deviceLogs = new Map();
const deviceCommands = new Map();
const commandCallbacks = new Map();
const cameraStreams = new Map();
const deviceStats = new Map();

// ASR会话管理
const asrSessions = new Map();

// ============================================================
// 配置参数
// ============================================================
const CONFIG = {
  heartbeatInterval: cfg.device?.heartbeat_interval || 30,
  heartbeatTimeout: cfg.device?.heartbeat_timeout || 180,
  maxDevices: cfg.device?.max_devices || 100,
  commandTimeout: cfg.device?.command_timeout || 10000,
  maxLogsPerDevice: cfg.device?.max_logs_per_device || 100,
  messageQueueSize: cfg.device?.message_queue_size || 100
};

// ============================================================
// 火山引擎ASR会话管理器
// ============================================================
class VolcengineASRSession {
  constructor(sessionId, deviceId) {
    this.sessionId = sessionId;
    this.deviceId = deviceId;
    this.ws = null;
    this.connected = false;
    this.sequence = 0;
    this.audioChunks = [];
    this.startTime = Date.now();
    this.lastChunkTime = Date.now();
    this.totalChunks = 0;
    this.connectId = uuidv4();
    this.logId = null;
  }

  // 创建WebSocket连接头
  createHeaders() {
    return {
      'X-Api-App-Key': VOLCENGINE_ASR_CONFIG.appKey,
      'X-Api-Access-Key': VOLCENGINE_ASR_CONFIG.accessKey,
      'X-Api-Resource-Id': VOLCENGINE_ASR_CONFIG.resourceId,
      'X-Api-Connect-Id': this.connectId
    };
  }

  // 创建协议头（4字节）
  createProtocolHeader(messageType, messageFlags, serialization, compression) {
    const header = Buffer.alloc(4);
    
    // Byte 0: Protocol version (4 bits) + Header size (4 bits)
    header[0] = 0x11; // version=0001, headerSize=0001 (4 bytes)
    
    // Byte 1: Message type (4 bits) + Message type specific flags (4 bits)
    header[1] = (messageType << 4) | messageFlags;
    
    // Byte 2: Serialization method (4 bits) + Compression (4 bits)
    header[2] = (serialization << 4) | compression;
    
    // Byte 3: Reserved
    header[3] = 0x00;
    
    return header;
  }

  // 创建Full Client Request
  createFullClientRequest() {
    const requestPayload = {
      user: {
        uid: this.deviceId,
        platform: 'ESP32-S3'
      },
      audio: {
        format: 'pcm',
        codec: 'raw',
        rate: 16000,
        bits: 16,
        channel: 1
      },
      request: {
        model_name: 'bigmodel',
        enable_itn: VOLCENGINE_ASR_CONFIG.enableItn,
        enable_punc: VOLCENGINE_ASR_CONFIG.enablePunc,
        enable_ddc: VOLCENGINE_ASR_CONFIG.enableDdc,
        show_utterances: VOLCENGINE_ASR_CONFIG.showUtterances,
        result_type: VOLCENGINE_ASR_CONFIG.resultType,
        enable_accelerate_text: false,
        end_window_size: 800,  // 800ms判停
        force_to_speech_time: 1000  // 1秒后才判停
      }
    };

    const jsonPayload = JSON.stringify(requestPayload);
    const compressedPayload = zlib.gzipSync(Buffer.from(jsonPayload, 'utf-8'));

    // Message type: 0x1 (full client request)
    // Flags: 0x0 (no sequence)
    // Serialization: 0x1 (JSON)
    // Compression: 0x1 (Gzip)
    const header = this.createProtocolHeader(0x1, 0x0, 0x1, 0x1);
    
    const payloadSize = Buffer.alloc(4);
    payloadSize.writeUInt32BE(compressedPayload.length, 0);

    return Buffer.concat([header, payloadSize, compressedPayload]);
  }

  // 创建Audio Only Request
  createAudioOnlyRequest(audioData, isLast = false) {
    const compressedAudio = zlib.gzipSync(audioData);

    // Message type: 0x2 (audio only request)
    // Flags: 0x2 (last packet) or 0x1 (has sequence)
    // Serialization: 0x0 (none)
    // Compression: 0x1 (Gzip)
    const flags = isLast ? 0x2 : 0x1;
    const header = this.createProtocolHeader(0x2, flags, 0x0, 0x1);
    
    const payloadSize = Buffer.alloc(4);
    payloadSize.writeUInt32BE(compressedAudio.length, 0);

    // 如果不是最后一包，添加sequence
    if (!isLast) {
      this.sequence++;
      const sequenceBuffer = Buffer.alloc(4);
      sequenceBuffer.writeUInt32BE(this.sequence, 0);
      return Buffer.concat([header, sequenceBuffer, payloadSize, compressedAudio]);
    }

    return Buffer.concat([header, payloadSize, compressedAudio]);
  }

  // 解析Server Response
  parseServerResponse(data) {
    try {
      if (data.length < 4) {
        BotUtil.makeLog('warn', '[ASR解析] 数据包太短', this.deviceId);
        return null;
      }

      const header = data.readUInt32BE(0);
      const messageType = (data[1] >> 4) & 0x0F;
      const messageFlags = data[1] & 0x0F;
      const compression = data[2] & 0x0F;

      // Error message (0xF)
      if (messageType === 0xF) {
        const errorCode = data.readUInt32BE(4);
        const errorSize = data.readUInt32BE(8);
        const errorMessage = data.slice(12, 12 + errorSize).toString('utf-8');
        BotUtil.makeLog('error', `[ASR错误] Code: ${errorCode}, Message: ${errorMessage}`, this.deviceId);
        return { type: 'error', errorCode, errorMessage };
      }

      // Full server response (0x9)
      if (messageType === 0x9) {
        let offset = 4;
        
        // 读取sequence（如果有）
        if (messageFlags === 0x1 || messageFlags === 0x3) {
          const sequence = data.readUInt32BE(offset);
          offset += 4;
        }

        const payloadSize = data.readUInt32BE(offset);
        offset += 4;

        let payload = data.slice(offset, offset + payloadSize);

        // 解压
        if (compression === 0x1) {
          payload = zlib.gunzipSync(payload);
        }

        const result = JSON.parse(payload.toString('utf-8'));
        
        // 检查是否是最后一包
        const isLast = messageFlags === 0x3 || messageFlags === 0x2;

        return { type: 'result', result, isLast };
      }

      return null;
    } catch (error) {
      BotUtil.makeLog('error', `[ASR解析] 失败: ${error.message}`, this.deviceId);
      return null;
    }
  }

  // 连接到火山引擎
  async connect() {
    return new Promise((resolve, reject) => {
      try {
        const headers = this.createHeaders();
        
        BotUtil.makeLog('info', `[ASR连接] 会话: ${this.sessionId}`, this.deviceId);
        
        this.ws = new WebSocket(VOLCENGINE_ASR_CONFIG.wsUrl, { headers });

        this.ws.on('open', () => {
          this.connected = true;
          BotUtil.makeLog('info', '[ASR连接] WebSocket已连接', this.deviceId);
          
          // 发送Full Client Request
          const fullRequest = this.createFullClientRequest();
          this.ws.send(fullRequest);
          BotUtil.makeLog('debug', '[ASR连接] 已发送Full Client Request', this.deviceId);
          
          resolve();
        });

        this.ws.on('message', (data) => {
          const response = this.parseServerResponse(data);
          
          if (!response) return;

          if (response.type === 'error') {
            BotUtil.makeLog('error', `[ASR错误] ${response.errorMessage}`, this.deviceId);
            return;
          }

          if (response.type === 'result') {
            this.handleASRResult(response.result, response.isLast);
          }
        });

        this.ws.on('upgrade', (response) => {
          // 提取logId
          this.logId = response.headers['x-tt-logid'];
          if (this.logId) {
            BotUtil.makeLog('info', `[ASR连接] LogId: ${this.logId}`, this.deviceId);
          }
        });

        this.ws.on('error', (error) => {
          BotUtil.makeLog('error', `[ASR错误] ${error.message}`, this.deviceId);
          reject(error);
        });

        this.ws.on('close', () => {
          this.connected = false;
          BotUtil.makeLog('info', '[ASR关闭] WebSocket连接已关闭', this.deviceId);
        });

      } catch (error) {
        BotUtil.makeLog('error', `[ASR连接] 失败: ${error.message}`, this.deviceId);
        reject(error);
      }
    });
  }

  // 发送音频数据
  sendAudio(audioData) {
    if (!this.connected || !this.ws) {
      BotUtil.makeLog('warn', '[ASR发送] WebSocket未连接', this.deviceId);
      return false;
    }

    try {
      const audioRequest = this.createAudioOnlyRequest(audioData, false);
      this.ws.send(audioRequest);
      
      this.totalChunks++;
      this.lastChunkTime = Date.now();
      
      return true;
    } catch (error) {
      BotUtil.makeLog('error', `[ASR发送] 失败: ${error.message}`, this.deviceId);
      return false;
    }
  }

  // 结束音频流（发送最后一包）
  endAudio() {
    if (!this.connected || !this.ws) {
      return false;
    }

    try {
      // 发送空的最后一包
      const lastRequest = this.createAudioOnlyRequest(Buffer.alloc(0), true);
      this.ws.send(lastRequest);
      
      BotUtil.makeLog('info', `[ASR结束] 已发送最后一包，共${this.totalChunks}块`, this.deviceId);
      
      return true;
    } catch (error) {
      BotUtil.makeLog('error', `[ASR结束] 失败: ${error.message}`, this.deviceId);
      return false;
    }
  }

  // 处理ASR识别结果
  handleASRResult(result, isLast) {
    try {
      if (result.result && result.result.text) {
        const text = result.result.text;
        const duration = result.audio_info?.duration || 0;
        
        // 输出到日志
        BotUtil.makeLog('info', 
          `[ASR识别] ${isLast ? '[最终]' : '[中间]'} ${text} (${duration}ms)`,
          this.deviceId
        );

        // 如果有分句信息
        if (result.result.utterances && result.result.utterances.length > 0) {
          result.result.utterances.forEach((utt, idx) => {
            if (utt.definite) {
              BotUtil.makeLog('info',
                `[ASR分句${idx + 1}] ${utt.text} (${utt.start_time}-${utt.end_time}ms)`,
                this.deviceId
              );
            }
          });
        }

        // 发送事件到Bot
        if (Bot[this.deviceId]) {
          Bot.em('device.asr_result', {
            post_type: 'device',
            event_type: 'asr_result',
            device_id: this.deviceId,
            session_id: this.sessionId,
            text: text,
            is_final: isLast,
            duration: duration,
            result: result.result,
            self_id: this.deviceId,
            time: Math.floor(Date.now() / 1000)
          });
        }
      }
    } catch (error) {
      BotUtil.makeLog('error', `[ASR结果] 处理失败: ${error.message}`, this.deviceId);
    }
  }

  // 关闭会话
  async close() {
    this.endAudio();
    
    // 等待一下让最后的结果返回
    await new Promise(resolve => setTimeout(resolve, 500));
    
    if (this.ws) {
      this.ws.close();
    }

    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(2);
    BotUtil.makeLog('info', 
      `[ASR会话] 已关闭 - 时长: ${elapsed}秒, 音频块: ${this.totalChunks}`,
      this.deviceId
    );
  }
}

// ============================================================
// 设备管理器核心类
// ============================================================
class DeviceManager {
  constructor() {
    this.cleanupInterval = null;
    this.audioSessions = new Map();
    this.AUDIO_SAVE_DIR = './data/wav';
    this.AUDIO_TEMP_DIR = './data/wav/temp';
    this.initializeDirectories();
  }

  initializeDirectories() {
    [this.AUDIO_SAVE_DIR, this.AUDIO_TEMP_DIR].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        BotUtil.makeLog('info', `[目录创建] ${dir}`, 'DeviceManager');
      }
    });
  }

  // ========== Unicode编解码工具 ==========
  encodeUnicode(str) {
    if (typeof str !== 'string') return str;
    return str.split('').map(char => {
      const code = char.charCodeAt(0);
      return code > 127 ? `\\u${code.toString(16).padStart(4, '0')}` : char;
    }).join('');
  }

  decodeUnicode(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
  }

  encodeData(data) {
    if (typeof data === 'string') return this.encodeUnicode(data);
    if (Array.isArray(data)) return data.map(item => this.encodeData(item));
    if (typeof data === 'object' && data !== null) {
      return Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, this.encodeData(v)])
      );
    }
    return data;
  }

  decodeData(data) {
    if (typeof data === 'string') return this.decodeUnicode(data);
    if (Array.isArray(data)) return data.map(item => this.decodeData(item));
    if (typeof data === 'object' && data !== null) {
      return Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, this.decodeData(v)])
      );
    }
    return data;
  }

  // ========== ASR会话管理 ==========
  async handleASRSessionStart(deviceId, data) {
    try {
      const { session_id, sample_rate, bits, channels } = data;
      
      BotUtil.makeLog('info', 
        `[ASR会话] 开始 - ${session_id} (${sample_rate}Hz, ${bits}bit, ${channels}ch)`,
        deviceId
      );

      // 检查火山引擎是否启用
      if (!VOLCENGINE_ASR_CONFIG.enabled) {
        BotUtil.makeLog('warn', '[ASR会话] 火山引擎ASR未启用', deviceId);
        return { success: false, error: '火山引擎ASR未启用' };
      }

      // 检查配置
      if (!VOLCENGINE_ASR_CONFIG.appKey || !VOLCENGINE_ASR_CONFIG.accessKey) {
        BotUtil.makeLog('error', '[ASR会话] 火山引擎配置不完整', deviceId);
        return { success: false, error: '火山引擎配置不完整' };
      }

      // 如果已有会话，先关闭
      if (asrSessions.has(session_id)) {
        const oldSession = asrSessions.get(session_id);
        await oldSession.close();
        asrSessions.delete(session_id);
      }

      // 创建新会话
      const session = new VolcengineASRSession(session_id, deviceId);
      asrSessions.set(session_id, session);

      // 连接到火山引擎
      await session.connect();

      BotUtil.makeLog('info', `[ASR会话] 已连接到火山引擎`, deviceId);

      return { success: true, session_id };

    } catch (error) {
      BotUtil.makeLog('error', `[ASR会话] 开始失败: ${error.message}`, deviceId);
      return { success: false, error: error.message };
    }
  }

  async handleASRAudioChunk(deviceId, data) {
    try {
      const { session_id, chunk_index, data: audioB64, size } = data;
      
      const session = asrSessions.get(session_id);
      if (!session) {
        BotUtil.makeLog('warn', `[ASR音频] 会话${session_id}不存在`, deviceId);
        return { success: false, error: '会话不存在' };
      }

      // 解码base64音频数据
      const audioBuffer = Buffer.from(audioB64, 'base64');

      // 发送到火山引擎
      const sent = session.sendAudio(audioBuffer);

      // 定期输出进度
      if (chunk_index % 50 === 0) {
        const elapsed = ((Date.now() - session.startTime) / 1000).toFixed(1);
        BotUtil.makeLog('debug',
          `[ASR音频] 会话${session_id} - 块#${chunk_index} - ${elapsed}秒`,
          deviceId
        );
      }

      return { success: sent, chunk_index };

    } catch (error) {
      BotUtil.makeLog('error', `[ASR音频] 处理失败: ${error.message}`, deviceId);
      return { success: false, error: error.message };
    }
  }

  async handleASRSessionStop(deviceId, data) {
    try {
      const { session_id, duration, chunks_sent } = data;
      
      BotUtil.makeLog('info',
        `[ASR会话] 停止 - ${session_id} (${duration}秒, ${chunks_sent}块)`,
        deviceId
      );

      const session = asrSessions.get(session_id);
      if (!session) {
        BotUtil.makeLog('warn', `[ASR会话] ${session_id}不存在`, deviceId);
        return { success: false, error: '会话不存在' };
      }

      // 关闭会话
      await session.close();
      asrSessions.delete(session_id);

      BotUtil.makeLog('info', `[ASR会话] ${session_id}已关闭`, deviceId);

      return { success: true };

    } catch (error) {
      BotUtil.makeLog('error', `[ASR会话] 停止失败: ${error.message}`, deviceId);
      return { success: false, error: error.message };
    }
  }

  cleanupStaleASRSessions() {
    const timeout = 5 * 60 * 1000; // 5分钟超时
    const now = Date.now();

    for (const [sessionId, session] of asrSessions) {
      if (now - session.lastChunkTime > timeout) {
        BotUtil.makeLog('warn',
          `[ASR会话] 超时清理: ${sessionId}`,
          session.deviceId
        );
        session.close().catch(() => {});
        asrSessions.delete(sessionId);
      }
    }
  }

  // ========== 设备Bot实例创建 ==========
  createDeviceBot(deviceId, deviceInfo, ws) {
    Bot[deviceId] = {
      adapter: this,
      ws,
      uin: deviceId,
      nickname: deviceInfo.device_name,
      avatar: null,
      info: deviceInfo,
      device_type: deviceInfo.device_type,
      capabilities: deviceInfo.capabilities || [],
      metadata: deviceInfo.metadata || {},
      online: true,
      last_seen: Date.now(),
      stats: {
        messages_sent: 0,
        messages_received: 0,
        commands_executed: 0,
        errors: 0,
        reconnects: 0
      },

      addLog: (level, message, data = {}) => this.addDeviceLog(deviceId, level, message, data),
      getLogs: (filter = {}) => this.getDeviceLogs(deviceId, filter),
      clearLogs: () => deviceLogs.set(deviceId, []),

      sendMsg: async (msg) => {
        const emotionKeywords = ['开心', '伤心', '生气', '惊讶', '爱', '酷', '睡觉', '思考', '眨眼', '大笑'];
        const emotionMap = {
          '开心': 'happy', '伤心': 'sad', '生气': 'angry', '惊讶': 'surprise',
          '爱': 'love', '酷': 'cool', '睡觉': 'sleep', '思考': 'think',
          '眨眼': 'wink', '大笑': 'laugh'
        };

        for (const keyword of emotionKeywords) {
          if (msg.includes(keyword)) {
            return await this.sendCommand(deviceId, 'display_emotion', {
              emotion: emotionMap[keyword]
            }, 1);
          }
        }

        return await this.sendCommand(deviceId, 'display', {
          text: this.encodeData(msg),
          x: 0, y: 0, font_size: 16, wrap: true, spacing: 2
        }, 1);
      },

      sendCommand: async (cmd, params = {}, priority = 0) => {
        return await this.sendCommand(deviceId, cmd, params, priority);
      },

      display: async (text, options = {}) => {
        return await this.sendCommand(deviceId, 'display', {
          text: this.encodeData(text),
          x: options.x || 0,
          y: options.y || 0,
          font_size: options.font_size || 16,
          wrap: options.wrap !== false,
          spacing: options.spacing || 2
        }, 1);
      },

      emotion: async (emotionName) => {
        const emotions = ['happy', 'sad', 'angry', 'surprise', 'love', 'cool', 'sleep', 'think', 'wink', 'laugh'];
        if (!emotions.includes(emotionName)) {
          throw new Error(`未知表情: ${emotionName}`);
        }
        return await this.sendCommand(deviceId, 'display_emotion', { emotion: emotionName }, 1);
      },

      switchMode: async (mode, options = {}) => {
        if (!['text', 'emotion'].includes(mode)) {
          throw new Error(`无效模式: ${mode}`);
        }
        return await this.sendCommand(deviceId, 'display_mode', { mode, ...options }, 1);
      },

      clear: async () => {
        return await this.sendCommand(deviceId, 'display_clear', {}, 1);
      },

      camera: {
        startStream: async (options = {}) => {
          return await this.sendCommand(deviceId, 'camera_start_stream', {
            fps: options.fps || 10,
            quality: options.quality || 12,
            resolution: options.resolution || 'VGA'
          }, 1);
        },
        stopStream: async () => {
          return await this.sendCommand(deviceId, 'camera_stop_stream', {}, 1);
        },
        capture: async () => {
          return await this.sendCommand(deviceId, 'camera_capture', {}, 1);
        }
      },

      microphone: {
        getStatus: async () => {
          return await this.sendCommand(deviceId, 'microphone_status', {}, 0);
        },
        start: async () => {
          return await this.sendCommand(deviceId, 'microphone_start', {}, 1);
        },
        stop: async () => {
          return await this.sendCommand(deviceId, 'microphone_stop', {}, 1);
        }
      },

      reboot: async () => {
        return await this.sendCommand(deviceId, 'reboot', {}, 99);
      },

      hasCapability: (cap) => deviceInfo.capabilities?.includes(cap),

      getStatus: () => {
        const device = devices.get(deviceId);
        return {
          device_id: deviceId,
          device_name: deviceInfo.device_name,
          device_type: deviceInfo.device_type,
          online: device?.online || false,
          last_seen: device?.last_seen,
          capabilities: deviceInfo.capabilities,
          metadata: deviceInfo.metadata,
          stats: device?.stats || Bot[deviceId].stats
        };
      },

      getStats: () => deviceStats.get(deviceId) || this.initDeviceStats(deviceId)
    };

    return Bot[deviceId];
  }

  // ========== 设备统计管理 ==========
  initDeviceStats(deviceId) {
    const stats = {
      device_id: deviceId,
      connected_at: Date.now(),
      total_messages: 0,
      total_commands: 0,
      total_errors: 0,
      last_heartbeat: Date.now()
    };
    deviceStats.set(deviceId, stats);
    return stats;
  }

  updateDeviceStats(deviceId, type) {
    const stats = deviceStats.get(deviceId);
    if (!stats) return;

    switch (type) {
      case 'message': stats.total_messages++; break;
      case 'command': stats.total_commands++; break;
      case 'error': stats.total_errors++; break;
      case 'heartbeat': stats.last_heartbeat = Date.now(); break;
    }
  }

  // ========== 设备注册 ==========
  async registerDevice(deviceData, Bot, ws) {
    try {
      deviceData = this.decodeData(deviceData);
      const {
        device_id, device_type, device_name,
        capabilities = [], metadata = {},
        ip_address, firmware_version
      } = deviceData;

      if (!device_id || !device_type) {
        throw new Error('缺少必需参数');
      }

      const existingDevice = devices.get(device_id);
      const device = {
        device_id, device_type,
        device_name: device_name || `${device_type}_${device_id}`,
        capabilities, metadata, ip_address, firmware_version,
        online: true,
        last_seen: Date.now(),
        registered_at: existingDevice?.registered_at || Date.now(),
        stats: existingDevice?.stats || {
          messages_sent: 0, messages_received: 0,
          commands_executed: 0, errors: 0,
          reconnects: existingDevice ? existingDevice.stats.reconnects + 1 : 0
        }
      };

      devices.set(device_id, device);

      if (!deviceLogs.has(device_id)) deviceLogs.set(device_id, []);
      if (!deviceStats.has(device_id)) this.initDeviceStats(device_id);
      if (ws) this.setupWebSocket(device_id, ws);
      if (!Bot.uin.includes(device_id)) Bot.uin.push(device_id);

      this.createDeviceBot(device_id, device, ws);

      BotUtil.makeLog('info',
        `[设备注册] ${device.device_name} (${device_id}) - 固件: v${firmware_version}`,
        device.device_name
      );

      Bot.em('device.online', {
        post_type: 'device',
        event_type: 'online',
        device_id, device_type,
        device_name: device.device_name,
        capabilities,
        self_id: device_id,
        time: Math.floor(Date.now() / 1000)
      });

      return device;
    } catch (error) {
      BotUtil.makeLog('error', `[设备注册失败] ${error.message}`, 'DeviceManager');
      throw error;
    }
  }

  // ========== WebSocket连接管理 ==========
  setupWebSocket(deviceId, ws) {
    const oldWs = deviceWebSockets.get(deviceId);
    if (oldWs && oldWs !== ws) {
      clearInterval(oldWs.heartbeatTimer);
      oldWs.close();
    }

    ws.device_id = deviceId;
    ws.isAlive = true;
    ws.lastPong = Date.now();
    ws.messageQueue = [];

    ws.heartbeatTimer = setInterval(() => {
      if (!ws.isAlive) {
        BotUtil.makeLog('warn', `[设备心跳超时] ${deviceId}`, deviceId);
        this.handleDeviceDisconnect(deviceId, ws);
        return;
      }

      ws.isAlive = false;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'heartbeat_request', timestamp: Date.now() }));
      }
    }, CONFIG.heartbeatInterval * 1000);

    ws.on('pong', () => {
      ws.isAlive = true;
      ws.lastPong = Date.now();
      this.updateDeviceStats(deviceId, 'heartbeat');
    });

    deviceWebSockets.set(deviceId, ws);
  }

  handleDeviceDisconnect(deviceId, ws) {
    clearInterval(ws.heartbeatTimer);

    const device = devices.get(deviceId);
    if (device) {
      device.online = false;
      BotUtil.makeLog('warn', `[设备离线] ${device.device_name}`, device.device_name);

      Bot.em('device.offline', {
        post_type: 'device',
        event_type: 'offline',
        device_id: deviceId,
        device_type: device.device_type,
        device_name: device.device_name,
        self_id: deviceId,
        time: Math.floor(Date.now() / 1000)
      });
    }

    deviceWebSockets.delete(deviceId);

    // 清理ASR会话
    for (const [sessionId, session] of asrSessions) {
      if (session.deviceId === deviceId) {
        session.close().catch(() => {});
        asrSessions.delete(sessionId);
      }
    }
  }

  // ========== 日志管理 ==========
  addDeviceLog(deviceId, level, message, data = {}) {
    message = this.decodeUnicode(String(message)).substring(0, 500);

    const logEntry = {
      timestamp: Date.now(),
      level,
      message,
      data: this.decodeData(data)
    };

    const logs = deviceLogs.get(deviceId) || [];
    logs.unshift(logEntry);

    if (logs.length > CONFIG.maxLogsPerDevice) {
      logs.length = CONFIG.maxLogsPerDevice;
    }

    deviceLogs.set(deviceId, logs);

    const device = devices.get(deviceId);
    if (device?.stats && level === 'error') {
      device.stats.errors++;
      this.updateDeviceStats(deviceId, 'error');
    }

    if (level !== 'debug') {
      BotUtil.makeLog(level, `[${device?.device_name || deviceId}] ${message}`, device?.device_name || deviceId);
    }

    return logEntry;
  }

  getDeviceLogs(deviceId, filter = {}) {
    let logs = deviceLogs.get(deviceId) || [];

    if (filter.level) logs = logs.filter(log => log.level === filter.level);
    if (filter.since) {
      const sinceTime = new Date(filter.since).getTime();
      logs = logs.filter(log => log.timestamp >= sinceTime);
    }
    if (filter.limit) logs = logs.slice(0, filter.limit);

    return logs;
  }

  // ========== 事件处理 ==========
  async processDeviceEvent(deviceId, eventType, eventData = {}, Bot) {
    try {
      eventData = this.decodeData(eventData);

      if (!devices.has(deviceId)) {
        if (eventType === 'register') {
          return await this.registerDevice({ device_id: deviceId, ...eventData }, Bot);
        }
        return { success: false, error: '设备未注册' };
      }

      const device = devices.get(deviceId);
      device.last_seen = Date.now();
      device.online = true;
      device.stats.messages_received++;
      this.updateDeviceStats(deviceId, 'message');

      switch (eventType) {
        case 'log':
          const { level = 'info', message, data: logData } = eventData;
          this.addDeviceLog(deviceId, level, message, logData);
          break;

        case 'command_result':
          const { command_id, result } = eventData;
          const callback = commandCallbacks.get(command_id);
          if (callback) {
            callback(result);
            commandCallbacks.delete(command_id);
          }
          break;

        case 'asr_session_start':
          return await this.handleASRSessionStart(deviceId, eventData);

        case 'asr_audio_chunk':
          return await this.handleASRAudioChunk(deviceId, eventData);

        case 'asr_session_stop':
          return await this.handleASRSessionStop(deviceId, eventData);

        default:
          Bot.em(`device.${eventType}`, {
            post_type: 'device',
            event_type: eventType,
            device_id: deviceId,
            device_type: device.device_type,
            device_name: device.device_name,
            event_data: eventData,
            self_id: deviceId,
            time: Math.floor(Date.now() / 1000)
          });
      }

      return { success: true };
    } catch (error) {
      BotUtil.makeLog('error', `[事件处理失败] ${error.message}`, 'DeviceManager');
      this.updateDeviceStats(deviceId, 'error');
      return { success: false, error: error.message };
    }
  }

  // ========== 命令发送 ==========
  async sendCommand(deviceId, command, parameters = {}, priority = 0) {
    const device = devices.get(deviceId);
    if (!device) throw new Error('设备未找到');

    const cmd = {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      command,
      parameters: this.encodeData(parameters),
      priority,
      timestamp: Date.now()
    };

    this.updateDeviceStats(deviceId, 'command');
    const ws = deviceWebSockets.get(deviceId);

    if (ws && ws.readyState === WebSocket.OPEN) {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          commandCallbacks.delete(cmd.id);
          resolve({ success: true, command_id: cmd.id, timeout: true });
        }, CONFIG.commandTimeout);

        commandCallbacks.set(cmd.id, (result) => {
          clearTimeout(timeout);
          resolve({ success: true, command_id: cmd.id, result });
        });

        try {
          ws.send(JSON.stringify({ type: 'command', command: cmd }));
          device.stats.commands_executed++;
        } catch (error) {
          clearTimeout(timeout);
          commandCallbacks.delete(cmd.id);
          resolve({ success: false, command_id: cmd.id, error: error.message });
        }
      });
    }

    const commands = deviceCommands.get(deviceId) || [];
    if (priority > 0) {
      commands.unshift(cmd);
    } else {
      commands.push(cmd);
    }

    if (commands.length > CONFIG.messageQueueSize) {
      commands.length = CONFIG.messageQueueSize;
    }

    deviceCommands.set(deviceId, commands);
    device.stats.commands_executed++;

    return { success: true, command_id: cmd.id, queued: commands.length };
  }

  // ========== 设备状态检查 ==========
  checkOfflineDevices(Bot) {
    const timeout = CONFIG.heartbeatTimeout * 1000;
    const now = Date.now();

    for (const [id, device] of devices) {
      if (device.online && now - device.last_seen > timeout) {
        const ws = deviceWebSockets.get(id);
        if (ws) {
          this.handleDeviceDisconnect(id, ws);
        } else {
          device.online = false;
          Bot.em('device.offline', {
            post_type: 'device',
            event_type: 'offline',
            device_id: id,
            device_type: device.device_type,
            device_name: device.device_name,
            self_id: id,
            time: Math.floor(Date.now() / 1000)
          });
          BotUtil.makeLog('warn', `[设备离线] ${device.device_name}`, device.device_name);
        }
      }
    }
  }

  // ========== 设备信息获取 ==========
  getDeviceList() {
    return Array.from(devices.values()).map(d => ({
      device_id: d.device_id,
      device_name: d.device_name,
      device_type: d.device_type,
      online: d.online,
      last_seen: d.last_seen,
      capabilities: d.capabilities,
      stats: d.stats
    }));
  }

  getDevice(deviceId) {
    const device = devices.get(deviceId);
    if (!device) return null;
    return { ...device, device_stats: deviceStats.get(deviceId) };
  }

  // ========== WebSocket消息处理 ==========
  async processWebSocketMessage(ws, data, Bot) {
    try {
      data = this.decodeData(data);
      const { type, device_id, ...payload } = data;
      const deviceId = device_id || ws.device_id;

      switch (type) {
        case 'register':
          const device = await this.registerDevice({ device_id: deviceId, ...payload }, Bot, ws);
          ws.send(JSON.stringify({ type: 'register_response', success: true, device }));
          break;

        case 'event':
        case 'data':
          const eventType = payload.data_type || payload.event_type || type;
          const eventData = payload.data || payload.event_data || payload;
          await this.processDeviceEvent(deviceId, eventType, eventData, Bot);
          break;

        case 'asr_session_start':
        case 'asr_audio_chunk':
        case 'asr_session_stop':
          await this.processDeviceEvent(deviceId, type, payload, Bot);
          break;

        case 'log':
          const { level = 'info', message, data: logData } = payload;
          this.addDeviceLog(deviceId, level, message, logData);
          break;

        case 'heartbeat':
          ws.isAlive = true;
          ws.lastPong = Date.now();

          const dev = devices.get(deviceId);
          if (dev) {
            dev.last_seen = Date.now();
            dev.online = true;
            if (payload.status) dev.status = payload.status;
          }

          this.updateDeviceStats(deviceId, 'heartbeat');

          const queuedCommands = deviceCommands.get(deviceId) || [];
          const commandsToSend = queuedCommands.splice(0, 3);

          ws.send(JSON.stringify({
            type: 'heartbeat_response',
            commands: commandsToSend,
            timestamp: Date.now()
          }));
          break;

        case 'command_result':
          await this.processDeviceEvent(deviceId, type, payload, Bot);
          break;

        default:
          ws.send(JSON.stringify({ type: 'error', message: `未知类型: ${type}` }));
      }
    } catch (error) {
      BotUtil.makeLog('error', `[WS处理失败] ${error.message}`, 'DeviceManager');
      try {
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
      } catch (e) {}
    }
  }
}

const deviceManager = new DeviceManager();

// ============================================================
// HTTP API路由
// ============================================================
export default {
  name: 'device',
  dsc: '设备管理API（支持火山引擎实时ASR v4.0）',
  priority: 90,
  routes: [
    {
      method: 'POST',
      path: '/api/device/register',
      handler: async (req, res, Bot) => {
        try {
          const device = await deviceManager.registerDevice({
            ...req.body,
            ip_address: req.ip || req.socket.remoteAddress
          }, Bot);
          res.json({ success: true, device_id: device.device_id });
        } catch (error) {
          res.status(400).json({ success: false, message: error.message });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/devices',
      handler: async (req, res) => {
        const devices = deviceManager.getDeviceList();
        res.json({ success: true, devices, count: devices.length });
      }
    },

    {
      method: 'GET',
      path: '/api/device/:deviceId',
      handler: async (req, res) => {
        const device = deviceManager.getDevice(req.params.deviceId);
        if (device) {
          res.json({ success: true, device });
        } else {
          res.status(404).json({ success: false, message: '设备未找到' });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/device/:deviceId/asr/sessions',
      handler: async (req, res) => {
        const sessions = Array.from(asrSessions.entries())
          .filter(([_, session]) => session.deviceId === req.params.deviceId)
          .map(([sessionId, session]) => ({
            session_id: sessionId,
            device_id: session.deviceId,
            connected: session.connected,
            total_chunks: session.totalChunks,
            started_at: session.startTime,
            elapsed: ((Date.now() - session.startTime) / 1000).toFixed(1),
            log_id: session.logId
          }));
        res.json({ success: true, sessions, count: sessions.length });
      }
    }
  ],

  // ========== WebSocket路由 ==========
  ws: {
    device: [(ws, req, Bot) => {
      BotUtil.makeLog('info', `[WebSocket连接] ${req.socket.remoteAddress}`, 'DeviceManager');

      ws.on('message', msg => {
        try {
          const data = JSON.parse(msg);
          deviceManager.processWebSocketMessage(ws, data, Bot);
        } catch (error) {
          BotUtil.makeLog('error', `[WS解析失败] ${error.message}`, 'DeviceManager');
        }
      });

      ws.on('close', () => {
        if (ws.device_id) {
          deviceManager.handleDeviceDisconnect(ws.device_id, ws);
        }
      });

      ws.on('error', (error) => {
        BotUtil.makeLog('error', `[WS错误] ${error.message}`, 'DeviceManager');
      });
    }]
  },

  // ========== 模块初始化 ==========
  init(app, Bot) {
    deviceManager.cleanupInterval = setInterval(() => {
      deviceManager.checkOfflineDevices(Bot);
    }, 30000);

    setInterval(() => {
      const now = Date.now();
      for (const [id, callback] of commandCallbacks) {
        const timestamp = parseInt(id.split('_')[0]);
        if (now - timestamp > 60000) {
          commandCallbacks.delete(id);
        }
      }
    }, 60000);

    // 清理过期的ASR会话
    setInterval(() => {
      deviceManager.cleanupStaleASRSessions();
    }, 5 * 60 * 1000);

    BotUtil.makeLog('info', '[设备管理器] 初始化完成（支持火山引擎实时ASR v4.0）', 'DeviceManager');
    
    if (VOLCENGINE_ASR_CONFIG.enabled) {
      BotUtil.makeLog('info', '[火山引擎ASR] 已启用', 'DeviceManager');
    } else {
      BotUtil.makeLog('warn', '[火山引擎ASR] 未启用', 'DeviceManager');
    }
  },

  // ========== 模块清理 ==========
  destroy() {
    if (deviceManager.cleanupInterval) {
      clearInterval(deviceManager.cleanupInterval);
    }

    for (const [id, ws] of deviceWebSockets) {
      try {
        clearInterval(ws.heartbeatTimer);
        ws.close();
      } catch (e) {}
    }

    // 关闭所有ASR会话
    for (const [sessionId, session] of asrSessions) {
      session.close().catch(() => {});
    }
    asrSessions.clear();

    BotUtil.makeLog('info', '[设备管理器] 已清理', 'DeviceManager');
  }
};