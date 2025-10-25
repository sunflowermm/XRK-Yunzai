import cfg from '../../lib/config/config.js';
import WebSocket from 'ws';
import BotUtil from '../../lib/common/util.js';
import fs from 'fs';
import path from 'path';

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

  // ========== 初始化目录结构 ==========
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

  // ========== WAV文件头生成 ==========
  createWavHeader(dataSize, sampleRate = 16000, bitsPerSample = 16, channels = 1) {
    const buffer = Buffer.alloc(44);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
    buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    return buffer;
  }

  // ========== 录音会话管理 ==========
  createAudioSession(filename, deviceId, config) {
    const { sample_rate = 16000, bits_per_sample = 16, channels = 1 } = config;
    const tempPath = path.join(this.AUDIO_TEMP_DIR, `${filename}.tmp`);
    const writeStream = fs.createWriteStream(tempPath, {
      flags: 'w',
      highWaterMark: 65536
    });

    const session = {
      filename,
      device_id: deviceId,
      sample_rate,
      bits_per_sample,
      channels,
      temp_path: tempPath,
      write_stream: writeStream,
      started_at: Date.now(),
      chunks_received: 0,
      total_bytes: 0,
      last_chunk_time: Date.now(),
      last_log_time: Date.now(),
      write_errors: 0
    };

    this.audioSessions.set(filename, session);
    BotUtil.makeLog('info',
      `[录音会话] ${filename} 开始 - ${sample_rate}Hz, ${bits_per_sample}bit, ${channels}声道`,
      deviceId
    );

    return session;
  }

  async handleAudioStart(deviceId, data) {
    try {
      const { filename, sample_rate, bits_per_sample, channels } = data;
      if (this.audioSessions.has(filename)) {
        BotUtil.makeLog('warn', `[录音开始] 会话${filename}已存在，先清理`, deviceId);
        await this.cleanupSession(filename);
      }
      this.createAudioSession(filename, deviceId, { sample_rate, bits_per_sample, channels });
      return { success: true, message: '录音会话已创建' };
    } catch (error) {
      BotUtil.makeLog('error', `[录音开始] 失败: ${error.message}`, deviceId);
      return { success: false, error: error.message };
    }
  }

  async handleAudioChunk(deviceId, chunkData) {
    try {
      const { filename, chunk_index, data, size } = chunkData;
      let session = this.audioSessions.get(filename);
      
      if (!session) {
        BotUtil.makeLog('warn',
          `[录音接收] ${filename} 会话不存在，自动创建（chunk_index=${chunk_index}）`,
          deviceId
        );
        session = this.createAudioSession(filename, deviceId, {});
      }

      const audioData = Buffer.from(data, 'base64');
      session.chunks_received++;
      session.total_bytes += audioData.length;
      session.last_chunk_time = Date.now();

      const writePromise = new Promise((resolve, reject) => {
        const ok = session.write_stream.write(audioData, (err) => {
          if (err) {
            session.write_errors++;
            reject(err);
          } else {
            resolve();
          }
        });
        if (!ok) session.write_stream.once('drain', resolve);
      });

      writePromise.catch(err => {
        BotUtil.makeLog('error', `[录音写入] 错误: ${err.message}`, deviceId);
      });

      const now = Date.now();
      const shouldLog = session.chunks_received % 50 === 0 || (now - session.last_log_time) > 3000;
      
      if (shouldLog) {
        const elapsed = ((now - session.started_at) / 1000).toFixed(1);
        const speed = (session.total_bytes / 1024 / elapsed).toFixed(1);
        BotUtil.makeLog('debug',
          `[录音接收] ${filename} - 块#${chunk_index} (共${session.chunks_received}块) - ` +
          `${(session.total_bytes/1024).toFixed(1)}KB - ${elapsed}秒 (${speed}KB/s) - 错误: ${session.write_errors}`,
          deviceId
        );
        session.last_log_time = now;
      }

      return { success: true, chunk_index, received: session.chunks_received };
    } catch (error) {
      BotUtil.makeLog('error', `[录音接收] 失败: ${error.message}`, deviceId);
      return { success: false, error: error.message };
    }
  }

  async handleAudioStop(deviceId, stopData) {
    try {
      const { filename, duration, total_bytes, total_chunks } = stopData;
      const session = this.audioSessions.get(filename);
      
      if (!session) {
        BotUtil.makeLog('warn', `[录音停止] ${filename} 会话不存在`, deviceId);
        return { success: false, error: '会话不存在' };
      }

      BotUtil.makeLog('info',
        `[录音停止] ${filename} - 设备报告: ${duration.toFixed(2)}秒, ${total_chunks}块, ` +
        `${(total_bytes/1024).toFixed(1)}KB - 服务器接收: ${session.chunks_received}块, ` +
        `${(session.total_bytes/1024).toFixed(1)}KB - 写入错误: ${session.write_errors}`,
        deviceId
      );

      await new Promise((resolve, reject) => {
        session.write_stream.end((err) => err ? reject(err) : resolve());
      });

      const filepath = await this.finalizeAudioFile(session);
      this.audioSessions.delete(filename);

      const finalStats = {
        duration: parseFloat(duration.toFixed(2)),
        reported_bytes: total_bytes,
        received_bytes: session.total_bytes,
        reported_chunks: total_chunks,
        received_chunks: session.chunks_received,
        write_errors: session.write_errors,
        loss_rate: ((1 - session.chunks_received / total_chunks) * 100).toFixed(2) + '%'
      };

      BotUtil.makeLog('info',
        `[录音完成] ✓ ${path.basename(filepath)} - 时长: ${finalStats.duration}秒 - ` +
        `接收: ${session.chunks_received}/${total_chunks}块 (丢失${finalStats.loss_rate}) - ` +
        `大小: ${(session.total_bytes/1024).toFixed(1)}KB`,
        deviceId
      );

      if (Bot[deviceId]) {
        Bot.em('device.audio_saved', {
          post_type: 'device',
          event_type: 'audio_saved',
          device_id: deviceId,
          filename: path.basename(filepath),
          filepath,
          duration: finalStats.duration,
          size: session.total_bytes,
          sample_rate: session.sample_rate,
          bits_per_sample: session.bits_per_sample,
          channels: session.channels,
          chunks: session.chunks_received,
          stats: finalStats,
          self_id: deviceId,
          time: Math.floor(Date.now() / 1000)
        });
      }

      return { success: true, filepath, stats: finalStats };
    } catch (error) {
      BotUtil.makeLog('error', `[录音停止] 失败: ${error.message}`, deviceId);
      return { success: false, error: error.message };
    }
  }

  async finalizeAudioFile(session) {
    try {
      const { temp_path, filename, sample_rate, bits_per_sample, channels, total_bytes, device_id } = session;
      const audioData = fs.readFileSync(temp_path);
      const dataSize = audioData.length;

      BotUtil.makeLog('debug', `[文件生成] 读取临时文件: ${dataSize}字节`, device_id);

      const wavHeader = this.createWavHeader(dataSize, sample_rate, bits_per_sample, channels);
      const wavFile = Buffer.concat([wavHeader, audioData]);
      const wavFilename = filename.replace('.raw', '.wav');
      const finalPath = path.join(this.AUDIO_SAVE_DIR, wavFilename);
      
      fs.writeFileSync(finalPath, wavFile);
      BotUtil.makeLog('info',
        `[文件生成] WAV文件已保存: ${wavFilename} (${(wavFile.length/1024).toFixed(1)}KB)`,
        device_id
      );

      try {
        fs.unlinkSync(temp_path);
      } catch (e) {
        BotUtil.makeLog('warn', `[清理] 删除临时文件失败: ${e.message}`, device_id);
      }

      return finalPath;
    } catch (error) {
      BotUtil.makeLog('error', `[文件生成] 失败: ${error.message}`, session.device_id);
      throw error;
    }
  }

  async cleanupSession(filename) {
    const session = this.audioSessions.get(filename);
    if (!session) return;

    try {
      if (session.write_stream) session.write_stream.end();
      if (fs.existsSync(session.temp_path)) fs.unlinkSync(session.temp_path);
    } catch (e) {
      BotUtil.makeLog('warn', `[清理会话] ${filename} 失败: ${e.message}`, session.device_id);
    }

    this.audioSessions.delete(filename);
  }

  cleanupStaleAudioSessions() {
    const timeout = 10 * 60 * 1000;
    const now = Date.now();

    for (const [filename, session] of this.audioSessions) {
      if (now - session.last_chunk_time > timeout) {
        BotUtil.makeLog('warn',
          `[录音会话] 超时清理: ${filename} (${session.chunks_received}块)`,
          session.device_id
        );
        this.cleanupSession(filename);
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

      // ========== 通用消息发送（自动切换模式）==========
      sendMsg: async (msg) => {
        const emotionKeywords = ['开心', '伤心', '生气', '惊讶', '爱', '酷', '睡觉', '思考', '眨眼', '大笑'];
        const emotionMap = {
          '开心': 'happy',
          '伤心': 'sad',
          '生气': 'angry',
          '惊讶': 'surprise',
          '爱': 'love',
          '酷': 'cool',
          '睡觉': 'sleep',
          '思考': 'think',
          '眨眼': 'wink',
          '大笑': 'laugh'
        };

        for (const keyword of emotionKeywords) {
          if (msg.includes(keyword)) {
            const emotion = emotionMap[keyword];
            return await this.sendCommand(deviceId, 'display_emotion', {
              emotion: emotion
            }, 1);
          }
        }

        // 否则使用文字模式
        return await this.sendCommand(deviceId, 'display', {
          text: this.encodeData(msg),
          x: 0,
          y: 0,
          font_size: 16,
          wrap: true,
          spacing: 2
        }, 1);
      },

      sendCommand: async (cmd, params = {}, priority = 0) => {
        return await this.sendCommand(deviceId, cmd, params, priority);
      },

      // ========== 显示API（智能模式切换）==========
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

      // 表情显示（左表情+右时钟）
      emotion: async (emotionName) => {
        const emotions = ['happy', 'sad', 'angry', 'surprise', 'love', 'cool', 'sleep', 'think', 'wink', 'laugh'];
        if (!emotions.includes(emotionName)) {
          throw new Error(`未知表情: ${emotionName}，可用: ${emotions.join(', ')}`);
        }
        return await this.sendCommand(deviceId, 'display_emotion', {
          emotion: emotionName
        }, 1);
      },

      // 模式切换
      switchMode: async (mode, options = {}) => {
        if (!['text', 'emotion'].includes(mode)) {
          throw new Error(`无效模式: ${mode}，可用: text, emotion`);
        }
        return await this.sendCommand(deviceId, 'display_mode', {
          mode: mode,
          ...options
        }, 1);
      },

      // 清屏
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
        },
        getStats: async () => {
          return await this.sendCommand(deviceId, 'camera_stats', {}, 0);
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
        },
        test: async (duration = 3) => {
          return await this.sendCommand(deviceId, 'microphone_test', { duration }, 1);
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
      case 'message':
        stats.total_messages++;
        break;
      case 'command':
        stats.total_commands++;
        break;
      case 'error':
        stats.total_errors++;
        break;
      case 'heartbeat':
        stats.last_heartbeat = Date.now();
        break;
    }
  }

  // ========== 设备注册 ==========
  async registerDevice(deviceData, Bot, ws) {
    try {
      deviceData = this.decodeData(deviceData);
      const {
        device_id,
        device_type,
        device_name,
        capabilities = [],
        metadata = {},
        ip_address,
        firmware_version
      } = deviceData;

      if (!device_id || !device_type) {
        throw new Error('缺少必需参数: device_id 或 device_type');
      }

      if (devices.size >= CONFIG.maxDevices && !devices.has(device_id)) {
        throw new Error(`设备数量已达上限 (${CONFIG.maxDevices})`);
      }

      const existingDevice = devices.get(device_id);
      const device = {
        device_id,
        device_type,
        device_name: device_name || `${device_type}_${device_id}`,
        capabilities,
        metadata,
        ip_address,
        firmware_version,
        online: true,
        last_seen: Date.now(),
        registered_at: existingDevice?.registered_at || Date.now(),
        stats: existingDevice?.stats || {
          messages_sent: 0,
          messages_received: 0,
          commands_executed: 0,
          errors: 0,
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
        `[设备注册] ${device.device_name} (${device_id}) - IP: ${ip_address} - ` +
        `固件: v${firmware_version} - 能力: ${capabilities.join(', ')}`,
        device.device_name
      );

      Bot.em('device.online', {
        post_type: 'device',
        event_type: 'online',
        device_id,
        device_type,
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

    const stream = cameraStreams.get(deviceId);
    if (stream) {
      stream.clients.forEach(client => {
        try { client.close(); } catch (e) {}
      });
      cameraStreams.delete(deviceId);
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

        case 'audio_start':
          return await this.handleAudioStart(deviceId, eventData);

        case 'audio_chunk':
          return await this.handleAudioChunk(deviceId, eventData);

        case 'audio_stop':
          return await this.handleAudioStop(deviceId, eventData);

        case 'camera_frame':
          const stream = cameraStreams.get(deviceId);
          if (stream && stream.clients.size > 0) {
            const frameData = { device_id: deviceId, ...eventData };
            stream.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                try {
                  client.send(JSON.stringify({ type: 'camera_frame', data: frameData }));
                } catch (e) {}
              }
            });
            stream.frame_count++;
            stream.last_frame = Date.now();
          }
          break;

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
          resolve({ success: true, command_id: cmd.id, timeout: true, message: '命令超时' });
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

    return { success: true, command_id: cmd.id, queued: commands.length, method: 'queue' };
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
// 设备管理HTTP API路由定义
// ============================================================
export default {
  name: 'device',
  dsc: '设备管理API（支持智能显示模式 v3.4）',
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
          res.json({ success: true, device_id: device.device_id, device_name: device.device_name });
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
      path: '/api/device/:deviceId/logs',
      handler: async (req, res) => {
        const { deviceId } = req.params;
        const filter = {
          level: req.query.level,
          since: req.query.since,
          limit: parseInt(req.query.limit) || 50
        };
        const logs = deviceManager.getDeviceLogs(deviceId, filter);
        res.json({ success: true, logs, count: logs.length });
      }
    },

    {
      method: 'POST',
      path: '/api/device/:deviceId/command',
      handler: async (req, res) => {
        try {
          const { deviceId } = req.params;
          const { command, parameters, priority } = req.body;
          const result = await deviceManager.sendCommand(deviceId, command, parameters, priority);
          res.json(result);
        } catch (error) {
          res.status(400).json({ success: false, message: error.message });
        }
      }
    },

    // ========== 智能显示模式API ==========
    {
      method: 'POST',
      path: '/api/device/:deviceId/display/text',
      handler: async (req, res, Bot) => {
        try {
          const { deviceId } = req.params;
          const result = await Bot[deviceId].display(req.body.text, req.body.options || {});
          res.json(result);
        } catch (error) {
          res.status(400).json({ success: false, message: error.message });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/device/:deviceId/display/emotion',
      handler: async (req, res, Bot) => {
        try {
          const { deviceId } = req.params;
          const result = await Bot[deviceId].emotion(req.body.emotion);
          res.json(result);
        } catch (error) {
          res.status(400).json({ success: false, message: error.message });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/device/:deviceId/display/mode',
      handler: async (req, res, Bot) => {
        try {
          const { deviceId } = req.params;
          const result = await Bot[deviceId].switchMode(req.body.mode, req.body.options || {});
          res.json(result);
        } catch (error) {
          res.status(400).json({ success: false, message: error.message });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/device/:deviceId/display/clear',
      handler: async (req, res, Bot) => {
        try {
          const { deviceId } = req.params;
          const result = await Bot[deviceId].clear();
          res.json(result);
        } catch (error) {
          res.status(400).json({ success: false, message: error.message });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/device/:deviceId/audio/list',
      handler: async (req, res) => {
        try {
          const files = fs.readdirSync(deviceManager.AUDIO_SAVE_DIR)
            .filter(f => f.endsWith('.wav'))
            .map(f => {
              const filepath = path.join(deviceManager.AUDIO_SAVE_DIR, f);
              const stats = fs.statSync(filepath);
              return {
                filename: f,
                size: stats.size,
                size_kb: (stats.size / 1024).toFixed(2),
                created_at: stats.birthtime,
                modified_at: stats.mtime
              };
            })
            .sort((a, b) => b.modified_at - a.modified_at);
          res.json({ success: true, files, count: files.length });
        } catch (error) {
          res.status(500).json({ success: false, message: error.message });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/device/:deviceId/audio/download/:filename',
      handler: async (req, res) => {
        try {
          const { filename } = req.params;
          const filepath = path.join(deviceManager.AUDIO_SAVE_DIR, filename);

          if (!fs.existsSync(filepath)) {
            return res.status(404).json({ success: false, message: '文件不存在' });
          }

          res.setHeader('Content-Type', 'audio/wav');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          fs.createReadStream(filepath).pipe(res);
        } catch (error) {
          res.status(500).json({ success: false, message: error.message });
        }
      }
    },

    {
      method: 'DELETE',
      path: '/api/device/:deviceId/audio/:filename',
      handler: async (req, res) => {
        try {
          const { filename } = req.params;
          const filepath = path.join(deviceManager.AUDIO_SAVE_DIR, filename);

          if (!fs.existsSync(filepath)) {
            return res.status(404).json({ success: false, message: '文件不存在' });
          }

          fs.unlinkSync(filepath);
          BotUtil.makeLog('info', `[录音删除] ${filename}`, 'DeviceManager');
          res.json({ success: true, message: '文件已删除' });
        } catch (error) {
          res.status(500).json({ success: false, message: error.message });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/device/:deviceId/audio/sessions',
      handler: async (req, res) => {
        const sessions = Array.from(deviceManager.audioSessions.entries()).map(([filename, session]) => ({
          filename,
          device_id: session.device_id,
          chunks_received: session.chunks_received,
          total_bytes: session.total_bytes,
          size_kb: (session.total_bytes / 1024).toFixed(1),
          started_at: session.started_at,
          elapsed: ((Date.now() - session.started_at) / 1000).toFixed(1),
          write_errors: session.write_errors
        }));
        res.json({ success: true, sessions, count: sessions.length });
      }
    },

    {
      method: 'GET',
      path: '/api/device/:deviceId/microphone/status',
      handler: async (req, res, Bot) => {
        try {
          const { deviceId } = req.params;
          const result = await Bot[deviceId].microphone.getStatus();
          res.json(result);
        } catch (error) {
          res.status(400).json({ success: false, message: error.message });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/device/:deviceId/microphone/test',
      handler: async (req, res, Bot) => {
        try {
          const { deviceId } = req.params;
          const { duration = 3 } = req.body;
          const result = await Bot[deviceId].microphone.test(duration);
          res.json(result);
        } catch (error) {
          res.status(400).json({ success: false, message: error.message });
        }
      }
    }
  ],

  // ========== WebSocket路由定义 ==========
  ws: {
    device: [(ws, req, Bot) => {
      BotUtil.makeLog('info', `[WebSocket连接] ${req.socket.remoteAddress}`, 'DeviceManager');

      ws.on('message', msg => {
        try {
          const data = JSON.parse(msg);
          deviceManager.processWebSocketMessage(ws, data, Bot);
        } catch (error) {
          BotUtil.makeLog('error', `[WS解析失败] ${error.message}`, 'DeviceManager');
          try {
            ws.send(JSON.stringify({ type: 'error', message: `解析失败: ${error.message}` }));
          } catch (e) {}
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
    }],

    'camera-stream': [(ws, req, Bot) => {
      const deviceId = req.query.device_id;
      const apiKey = req.query.api_key || req.headers['x-api-key'];

      if (cfg.api?.key && apiKey !== cfg.api.key) {
        ws.close(1008, '无效的API密钥');
        return;
      }

      if (!deviceId) {
        ws.close(1008, '缺少device_id参数');
        return;
      }

      const device = devices.get(deviceId);
      if (!device) {
        ws.close(1008, '设备未找到');
        return;
      }

      if (!cameraStreams.has(deviceId)) {
        cameraStreams.set(deviceId, {
          device_id: deviceId,
          clients: new Set(),
          frame_count: 0,
          last_frame: Date.now(),
          started_at: Date.now()
        });
      }

      const stream = cameraStreams.get(deviceId);
      stream.clients.add(ws);

      BotUtil.makeLog('info', `[摄像头流] 新客户端连接 ${deviceId}`, device.device_name);

      ws.on('close', () => {
        stream.clients.delete(ws);
        if (stream.clients.size === 0) {
          Bot[deviceId].camera.stopStream().catch(() => {});
          cameraStreams.delete(deviceId);
        }
        BotUtil.makeLog('info', `[摄像头流] 客户端断开 ${deviceId}`, device.device_name);
      });

      ws.on('error', (error) => {
        BotUtil.makeLog('error', `[摄像头流错误] ${error.message}`, device.device_name);
      });

      try {
        ws.send(JSON.stringify({
          type: 'connected',
          device_id: deviceId,
          device_name: device.device_name,
          stream_info: { clients: stream.clients.size, frame_count: stream.frame_count }
        }));
      } catch (e) {}
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

    setInterval(() => {
      deviceManager.cleanupStaleAudioSessions();
    }, 5 * 60 * 1000);

    BotUtil.makeLog('info', '[设备管理器] 初始化完成（支持智能显示模式 v3.4）', 'DeviceManager');
    BotUtil.makeLog('info', `[录音目录] ${deviceManager.AUDIO_SAVE_DIR}`, 'DeviceManager');
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

    for (const [filename, session] of deviceManager.audioSessions) {
      deviceManager.cleanupSession(filename);
    }

    BotUtil.makeLog('info', '[设备管理器] 已清理', 'DeviceManager');
  }
};