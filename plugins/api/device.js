// device.js - 设备管理API（优化版 v3.0 - 流式录音保存）
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
// 配置
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
// 设备管理器
// ============================================================
class DeviceManager {
  constructor() {
    this.cleanupInterval = null;
    this.audioSessions = new Map(); // 使用会话管理替代简单缓冲
    this.AUDIO_SAVE_DIR = './data/wav';
    this.AUDIO_TEMP_DIR = './data/wav/temp';
   
    // 创建目录
    [this.AUDIO_SAVE_DIR, this.AUDIO_TEMP_DIR].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        BotUtil.makeLog('info', `[录音] 创建目录: ${dir}`, 'DeviceManager');
      }
    });
  }
  // ========== Unicode编解码 ==========
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
  // ========== WAV头创建 ==========
  createWavHeader(dataSize, sampleRate, bitsPerSample, channels) {
    const buffer = Buffer.alloc(44);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM
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
    const { sample_rate = 32000, bits_per_sample = 16, channels = 1 } = config;
   
    // 创建临时文件用于流式写入
    const tempPath = path.join(this.AUDIO_TEMP_DIR, `${filename}.tmp`);
    const writeStream = fs.createWriteStream(tempPath, { flags: 'w' });
   
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
      chunks_buffer: [], // 临时缓冲，用于排序
      next_expected_index: 0
    };
   
    this.audioSessions.set(filename, session);
   
    BotUtil.makeLog('info',
      `[录音会话] ${filename} 开始 (${sample_rate}Hz, ${bits_per_sample}bit, ${channels}CH)`,
      deviceId
    );
   
    return session;
  }
 
  async handleAudioStart(deviceId, data) {
    try {
      const { filename, sample_rate, bits_per_sample, channels } = data;
     
      // 创建新的录音会话
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
     
      // 获取会话
      let session = this.audioSessions.get(filename);
      if (!session) {
        // 如果没有会话（可能audio_start丢失），自动创建
        BotUtil.makeLog('warn', `[录音接收] ${filename} 会话不存在，自动创建`, deviceId);
        session = this.createAudioSession(filename, deviceId, {});
      }
     
      // 解码音频数据
      const audioData = Buffer.from(data, 'base64');
     
      session.chunks_received++;
      session.total_bytes += audioData.length;
      session.last_chunk_time = Date.now();
     
      // 立即写入临时文件（流式写入，不积压内存）
      await new Promise((resolve, reject) => {
        session.write_stream.write(audioData, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
     
      // 减少日志输出
      if (chunk_index % 20 === 0) {
        const elapsed = ((Date.now() - session.started_at) / 1000).toFixed(1);
        BotUtil.makeLog('info',
          `[录音接收] ${filename} 块#${chunk_index} (${session.chunks_received}块, ${(session.total_bytes/1024).toFixed(1)}KB, ${elapsed}s)`,
          deviceId
        );
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
        `[录音停止] ${filename} 开始最终保存 (${session.chunks_received}块, ${(session.total_bytes/1024).toFixed(1)}KB)`,
        deviceId
      );
     
      // 关闭写入流
      await new Promise((resolve) => {
        session.write_stream.end(() => resolve());
      });
     
      // 立即生成WAV文件
      const filepath = await this.finalizeAudioFile(session);
     
      // 清理会话
      this.audioSessions.delete(filename);
     
      BotUtil.makeLog('info',
        `[录音完成] ✓ ${path.basename(filepath)}\n` +
        ` 时长: ${duration.toFixed(2)}秒\n` +
        ` 大小: ${(session.total_bytes/1024).toFixed(1)}KB\n` +
        ` 块数: ${session.chunks_received}`,
        deviceId
      );
     
      // 触发事件
      if (Bot[deviceId]) {
        Bot.em('device.audio_saved', {
          post_type: 'device',
          event_type: 'audio_saved',
          device_id: deviceId,
          filename: path.basename(filepath),
          filepath,
          duration: parseFloat(duration.toFixed(2)),
          size: session.total_bytes,
          sample_rate: session.sample_rate,
          bits_per_sample: session.bits_per_sample,
          channels: session.channels,
          chunks: session.chunks_received,
          self_id: deviceId,
          time: Math.floor(Date.now() / 1000)
        });
      }
     
      return { success: true, filepath };
     
    } catch (error) {
      BotUtil.makeLog('error', `[录音停止] 失败: ${error.message}`, deviceId);
      return { success: false, error: error.message };
    }
  }
 
  async finalizeAudioFile(session) {
    try {
      const { temp_path, filename, sample_rate, bits_per_sample, channels, total_bytes } = session;
     
      // 读取临时文件
      const audioData = fs.readFileSync(temp_path);
      const dataSize = audioData.length;
     
      // 创建WAV头
      const wavHeader = this.createWavHeader(dataSize, sample_rate, bits_per_sample, channels);
     
      // 合并为完整WAV文件
      const wavFile = Buffer.concat([wavHeader, audioData]);
     
      // 保存最终文件
      const wavFilename = filename.replace('.raw', '.wav');
      const finalPath = path.join(this.AUDIO_SAVE_DIR, wavFilename);
      fs.writeFileSync(finalPath, wavFile);
     
      // 删除临时文件
      try {
        fs.unlinkSync(temp_path);
      } catch (e) {}
     
      return finalPath;
     
    } catch (error) {
      BotUtil.makeLog('error', `[文件生成] 失败: ${error.message}`, session.device_id);
      throw error;
    }
  }
 
  cleanupStaleAudioSessions() {
    const timeout = 10 * 60 * 1000; // 10分钟超时
    const now = Date.now();
   
    for (const [filename, session] of this.audioSessions) {
      if (now - session.last_chunk_time > timeout) {
        BotUtil.makeLog('warn',
          `[录音会话] 超时清理: ${filename} (${session.chunks_received}块)`,
          session.device_id
        );
       
        // 关闭流
        try {
          session.write_stream.end();
        } catch (e) {}
       
        // 删除临时文件
        try {
          fs.unlinkSync(session.temp_path);
        } catch (e) {}
       
        this.audioSessions.delete(filename);
      }
    }
  }
  // ========== 设备Bot创建 ==========
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
     
      addLog: (level, message, data = {}) => {
        return this.addDeviceLog(deviceId, level, message, data);
      },
     
      getLogs: (filter = {}) => {
        return this.getDeviceLogs(deviceId, filter);
      },
     
      clearLogs: () => {
        deviceLogs.set(deviceId, []);
      },
     
      sendMsg: async (msg) => {
        return await this.sendCommand(deviceId, 'display', {
          text: this.encodeData(msg),
          clear: true
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
          clear: options.clear !== false,
          wrap: options.wrap !== false,
          spacing: options.spacing || 2,
          color: options.color || 1
        }, 1);
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
     
      hasCapability: (cap) => {
        return deviceInfo.capabilities?.includes(cap);
      },
     
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
     
      getStats: () => {
        return deviceStats.get(deviceId) || this.initDeviceStats(deviceId);
      }
    };
   
    return Bot[deviceId];
  }
  // ========== 设备统计 ==========
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
   
    if (type === 'message') stats.total_messages++;
    else if (type === 'command') stats.total_commands++;
    else if (type === 'error') stats.total_errors++;
    else if (type === 'heartbeat') stats.last_heartbeat = Date.now();
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
     
      if (!deviceLogs.has(device_id)) {
        deviceLogs.set(device_id, []);
      }
     
      if (!deviceStats.has(device_id)) {
        this.initDeviceStats(device_id);
      }
     
      if (ws) {
        this.setupWebSocket(device_id, ws);
      }
     
      if (!Bot.uin.includes(device_id)) {
        Bot.uin.push(device_id);
      }
     
      this.createDeviceBot(device_id, device, ws);
     
      BotUtil.makeLog('info',
        `[设备注册] ${device.device_name} (${device_id})\n` +
        ` IP: ${ip_address}\n` +
        ` 固件: v${firmware_version}\n` +
        ` 能力: ${capabilities.join(', ')}`,
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
  // ========== WebSocket设置 ==========
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
        ws.send(JSON.stringify({
          type: 'heartbeat_request',
          timestamp: Date.now()
        }));
      }
    }, CONFIG.heartbeatInterval * 1000);
   
    ws.on('pong', () => {
      ws.isAlive = true;
      ws.lastPong = Date.now();
      this.updateDeviceStats(deviceId, 'heartbeat');
    });
   
    deviceWebSockets.set(deviceId, ws);
  }
  // ========== 设备断开处理 ==========
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
   
    if (filter.level) {
      logs = logs.filter(log => log.level === filter.level);
    }
   
    if (filter.since) {
      const sinceTime = new Date(filter.since).getTime();
      logs = logs.filter(log => log.timestamp >= sinceTime);
    }
   
    if (filter.limit) {
      logs = logs.slice(0, filter.limit);
    }
   
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
    if (!device) {
      throw new Error('设备未找到');
    }
   
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
          resolve({
            success: true,
            command_id: cmd.id,
            timeout: true,
            message: '命令超时'
          });
        }, CONFIG.commandTimeout);
       
        commandCallbacks.set(cmd.id, (result) => {
          clearTimeout(timeout);
          resolve({
            success: true,
            command_id: cmd.id,
            result
          });
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
   
    return {
      success: true,
      command_id: cmd.id,
      queued: commands.length,
      method: 'queue'
    };
  }
  // ========== 离线检查 ==========
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
  // ========== 获取设备信息 ==========
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
// 设备管理API
// ============================================================
export default {
  name: 'device',
  dsc: '设备管理API（v3.0 流式录音优化版）',
  priority: 90,
  routes: [
    // 获取录音列表
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
   
    // 下载录音文件
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
   
    // 删除录音文件
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
   
    // 获取正在录音的会话
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
          elapsed: ((Date.now() - session.started_at) / 1000).toFixed(1)
        }));
        res.json({ success: true, sessions, count: sessions.length });
      }
    },
   
    // 麦克风状态
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
   
    // 麦克风测试
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
  // WebSocket路由
  ws: {
    device: [(ws, req, Bot) => {
      BotUtil.makeLog('info', `[WebSocket] 新连接 ${req.socket.remoteAddress}`, 'DeviceManager');
     
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
    }]
  },
  // 初始化
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
   
    BotUtil.makeLog('info', '[设备管理器] 初始化完成 (流式录音v3.0)', 'DeviceManager');
    BotUtil.makeLog('info', `[录音目录] ${deviceManager.AUDIO_SAVE_DIR}`, 'DeviceManager');
  },
 
  // 清理
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
   
    // 清理所有录音会话
    for (const [filename, session] of deviceManager.audioSessions) {
      try {
        session.write_stream.end();
        fs.unlinkSync(session.temp_path);
      } catch (e) {}
    }
   
    BotUtil.makeLog('info', '[设备管理器] 已清理', 'DeviceManager');
  }
};