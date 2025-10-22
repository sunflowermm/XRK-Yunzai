// device.js - 设备管理API（优化版 v2.3 + 录音功能）
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
    this.audioBuffers = new Map();
    this.AUDIO_SAVE_DIR = './data/wav';  // 修改为data/wav目录
    
    // 确保录音目录存在
    if (!fs.existsSync(this.AUDIO_SAVE_DIR)) {
      fs.mkdirSync(this.AUDIO_SAVE_DIR, { recursive: true });
      BotUtil.makeLog('info', `[录音] 创建目录: ${this.AUDIO_SAVE_DIR}`, 'DeviceManager');
    }
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

  // ========== 音频处理 ==========
  createWavHeader(dataSize, sampleRate, bitsPerSample, channels) {
    const buffer = Buffer.alloc(44);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);  // PCM
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
    buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    return buffer;
  }
  
  async processAudioChunk(deviceId, chunkData) {
    try {
      const { 
        filename, 
        chunk_index, 
        chunks_total, 
        data, 
        is_last,
        sample_rate = 16000,
        bits_per_sample = 16,
        channels = 1
      } = chunkData;
      
      // 初始化缓冲区
      if (!this.audioBuffers.has(filename)) {
        this.audioBuffers.set(filename, {
          chunks: new Map(),
          total: chunks_total,
          sample_rate,
          bits_per_sample,
          channels,
          device_id: deviceId,
          started_at: Date.now()
        });
        
        BotUtil.makeLog('info', 
          `[录音接收] ${filename} 开始接收 (共${chunks_total}块, ${sample_rate}Hz, ${bits_per_sample}bit, ${channels}CH)`, 
          deviceId
        );
      }
      
      const buffer = this.audioBuffers.get(filename);
      
      // 存储数据块
      const audioData = Buffer.from(data, 'base64');
      buffer.chunks.set(chunk_index, audioData);
      
      const progress = ((buffer.chunks.size / chunks_total) * 100).toFixed(1);
      
      // 减少日志输出，每5块或最后一块才打印
      if (chunk_index % 5 === 0 || is_last) {
        BotUtil.makeLog('info', 
          `[录音接收] ${filename} 进度${progress}% (${buffer.chunks.size}/${chunks_total}块)`, 
          deviceId
        );
      }
      
      // 检查是否完成
      if (is_last || buffer.chunks.size === chunks_total) {
        BotUtil.makeLog('info', `[录音接收] ${filename} 接收完成，开始合成WAV文件...`, deviceId);
        await this.saveAudioFile(filename, buffer);
        this.audioBuffers.delete(filename);
      }
      
      return { 
        success: true, 
        chunk_index, 
        received: buffer.chunks.size, 
        total: chunks_total,
        progress: `${progress}%`
      };
      
    } catch (error) {
      BotUtil.makeLog('error', `[录音接收] 处理失败: ${error.message}`, deviceId);
      return { success: false, error: error.message };
    }
  }
  
  async saveAudioFile(filename, buffer) {
    try {
      const { chunks, sample_rate, bits_per_sample, channels, device_id } = buffer;
      
      BotUtil.makeLog('info', 
        `[录音保存] ${filename} 拼接${chunks.size}块数据...`, 
        device_id
      );
      
      // 按顺序拼接数据
      const sortedIndices = Array.from(chunks.keys()).sort((a, b) => a - b);
      const audioData = Buffer.concat(sortedIndices.map(key => chunks.get(key)));
      const dataSize = audioData.length;
      
      // 创建WAV文件
      const wavHeader = this.createWavHeader(dataSize, sample_rate, bits_per_sample, channels);
      const wavFile = Buffer.concat([wavHeader, audioData]);
      
      // 保存文件
      const wavFilename = filename.replace('.raw', '.wav');
      const filepath = path.join(this.AUDIO_SAVE_DIR, wavFilename);
      fs.writeFileSync(filepath, wavFile);
      
      const duration = (dataSize / (sample_rate * channels * (bits_per_sample / 8))).toFixed(2);
      const fileSize = (wavFile.length / 1024).toFixed(2);
      
      BotUtil.makeLog('info', 
        `[录音保存] ✓ 成功保存\n` +
        `  文件名: ${wavFilename}\n` +
        `  路径: ${filepath}\n` +
        `  时长: ${duration}秒\n` +
        `  大小: ${fileSize}KB\n` +
        `  采样率: ${sample_rate}Hz\n` +
        `  位深度: ${bits_per_sample}bit\n` +
        `  声道: ${channels}`, 
        device_id
      );
      
      // 触发录音完成事件
      if (Bot[device_id]) {
        Bot.em('device.audio_saved', {
          post_type: 'device',
          event_type: 'audio_saved',
          device_id,
          filename: wavFilename,
          filepath,
          duration: parseFloat(duration),
          size: wavFile.length,
          sample_rate,
          bits_per_sample,
          channels,
          self_id: device_id,
          time: Math.floor(Date.now() / 1000)
        });
      }
      
      return filepath;
      
    } catch (error) {
      BotUtil.makeLog('error', `[录音保存] 失败: ${error.message}`, buffer.device_id);
      throw error;
    }
  }
  
  cleanupStaleAudioBuffers() {
    const timeout = 10 * 60 * 1000;  // 10分钟超时
    const now = Date.now();
    
    for (const [filename, buffer] of this.audioBuffers) {
      if (now - buffer.started_at > timeout) {
        BotUtil.makeLog('warn', 
          `[录音接收] 超时清理: ${filename} (${buffer.chunks.size}/${buffer.total}块)`, 
          buffer.device_id
        );
        this.audioBuffers.delete(filename);
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
        `  IP: ${ip_address}\n` +
        `  固件: v${firmware_version}\n` +
        `  能力: ${capabilities.join(', ')}`, 
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
    
    // 心跳定时器
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
    
    // 减少日志输出
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
        
        case 'audio_chunk':
          return await this.processAudioChunk(deviceId, eventData);
        
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
    
    // 命令队列
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
          const result = await this.processDeviceEvent(deviceId, eventType, eventData, Bot);
          
          // 只有audio_chunk返回响应
          if (eventType === 'audio_chunk') {
            ws.send(JSON.stringify({ type: 'data_response', success: true, result }));
          }
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
  dsc: '设备管理API（v2.3 含录音功能）',
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
    
    // 获取录音接收状态
    {
      method: 'GET',
      path: '/api/device/:deviceId/audio/receiving',
      handler: async (req, res) => {
        const receiving = Array.from(deviceManager.audioBuffers.entries()).map(([filename, buffer]) => ({
          filename,
          device_id: buffer.device_id,
          chunks_received: buffer.chunks.size,
          chunks_total: buffer.total,
          progress: ((buffer.chunks.size / buffer.total) * 100).toFixed(1),
          started_at: buffer.started_at,
          elapsed: Date.now() - buffer.started_at
        }));
        res.json({ success: true, receiving, count: receiving.length });
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
      deviceManager.cleanupStaleAudioBuffers();
    }, 5 * 60 * 1000);
    
    BotUtil.makeLog('info', '[设备管理器] 初始化完成 (含录音功能)', 'DeviceManager');
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
    
    BotUtil.makeLog('info', '[设备管理器] 已清理', 'DeviceManager');
  }
};