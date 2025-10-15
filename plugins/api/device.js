// device.js - 设备管理 API（完整版 v2.1 + 录音功能）
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
  heartbeatTimeout: cfg.device?.heartbeat_timeout || 120,
  maxDevices: cfg.device?.max_devices || 100,
  commandTimeout: cfg.device?.command_timeout || 5000,
  maxLogsPerDevice: cfg.device?.max_logs_per_device || 100,
  reconnectDelay: cfg.device?.reconnect_delay || 5000,
  maxReconnectAttempts: cfg.device?.max_reconnect_attempts || 5,
  messageQueueSize: cfg.device?.message_queue_size || 100,
  enableStats: cfg.device?.enable_stats !== false
};

// ============================================================
// 设备管理器
// ============================================================

class DeviceManager {
  constructor() {
    this.cleanupInterval = null;
    this.statsInterval = null;
    
    // 音频相关
    this.audioBuffers = new Map();
    this.AUDIO_SAVE_DIR = './data/voicesss';
    
    // 确保录音目录存在
    if (!fs.existsSync(this.AUDIO_SAVE_DIR)) {
      fs.mkdirSync(this.AUDIO_SAVE_DIR, { recursive: true });
      BotUtil.makeLog('info', `[录音] 创建目录: ${this.AUDIO_SAVE_DIR}`, 'DeviceManager');
    }
  }

  // ========== Unicode编解码 ==========
  
  encodeUnicode(str) {
    if (typeof str !== 'string') return str;
    let result = '';
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      result += code > 127 ? `\\u${code.toString(16).padStart(4, '0')}` : str[i];
    }
    return result;
  }

  decodeUnicode(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/\\u([0-9a-fA-F]{4})/g, (match, p1) => {
      return String.fromCharCode(parseInt(p1, 16));
    });
  }

  encodeData(data) {
    if (typeof data === 'string') {
      return this.encodeUnicode(data);
    } else if (Array.isArray(data)) {
      return data.map(item => this.encodeData(item));
    } else if (typeof data === 'object' && data !== null) {
      const encoded = {};
      for (const key in data) {
        encoded[key] = this.encodeData(data[key]);
      }
      return encoded;
    }
    return data;
  }

  decodeData(data) {
    if (typeof data === 'string') {
      return this.decodeUnicode(data);
    } else if (Array.isArray(data)) {
      return data.map(item => this.decodeData(item));
    } else if (typeof data === 'object' && data !== null) {
      const decoded = {};
      for (const key in data) {
        decoded[key] = this.decodeData(data[key]);
      }
      return decoded;
    }
    return data;
  }

  // ========== 音频处理（新增）==========
  
  createWavHeader(dataSize, sampleRate, bitsPerSample, channels) {
    const buffer = Buffer.alloc(44);
    
    // RIFF标识
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4); // 文件大小 - 8
    buffer.write('WAVE', 8);
    
    // fmt子块
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // fmt块大小
    buffer.writeUInt16LE(1, 20); // 音频格式 (1 = PCM)
    buffer.writeUInt16LE(channels, 22); // 声道数
    buffer.writeUInt32LE(sampleRate, 24); // 采样率
    
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    buffer.writeUInt32LE(byteRate, 28); // 字节率
    
    const blockAlign = channels * (bitsPerSample / 8);
    buffer.writeUInt16LE(blockAlign, 32); // 块对齐
    buffer.writeUInt16LE(bitsPerSample, 34); // 位深度
    
    // data子块
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40); // 数据大小
    
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
          `[录音接收] 开始: ${filename} (共${chunks_total}块)`, 
          deviceId
        );
      }
      
      const buffer = this.audioBuffers.get(filename);
      
      // 存储数据块
      const audioData = Buffer.from(data, 'base64');
      buffer.chunks.set(chunk_index, audioData);
      
      BotUtil.makeLog('debug', 
        `[录音接收] 第${chunk_index}/${chunks_total}块 (${audioData.length}字节)`, 
        deviceId
      );
      
      // 检查是否接收完成
      if (is_last || buffer.chunks.size === chunks_total) {
        await this.saveAudioFile(filename, buffer);
        this.audioBuffers.delete(filename);
      }
      
      return { 
        success: true, 
        chunk_index, 
        received: buffer.chunks.size, 
        total: chunks_total 
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
        `[录音保存] 开始拼接: ${filename} (${chunks.size}块)`, 
        device_id
      );
      
      // 按顺序拼接所有数据块
      const sortedChunks = Array.from(chunks.keys()).sort((a, b) => a - b);
      const audioData = Buffer.concat(sortedChunks.map(key => chunks.get(key)));
      
      const dataSize = audioData.length;
      BotUtil.makeLog('info', 
        `[录音保存] 数据大小: ${(dataSize / 1024).toFixed(2)} KB`, 
        device_id
      );
      
      // 创建WAV头部
      const wavHeader = this.createWavHeader(dataSize, sample_rate, bits_per_sample, channels);
      
      // 合并头部和数据
      const wavFile = Buffer.concat([wavHeader, audioData]);
      
      // 生成文件路径（改为.wav扩展名）
      const wavFilename = filename.replace('.raw', '.wav');
      const filepath = path.join(this.AUDIO_SAVE_DIR, wavFilename);
      
      // 保存文件
      fs.writeFileSync(filepath, wavFile);
      
      const duration = (dataSize / (sample_rate * channels * (bits_per_sample / 8))).toFixed(2);
      
      BotUtil.makeLog('info', 
        `[录音保存] ✓ 成功: ${wavFilename}\n` +
        `  时长: ${duration}秒\n` +
        `  大小: ${(wavFile.length / 1024).toFixed(2)} KB\n` +
        `  路径: ${filepath}`, 
        device_id
      );
      
      // 触发录音完成事件
      if (Bot[device_id]) {
        Bot.em('device.audio_saved', {
          post_type: 'device',
          event_type: 'audio_saved',
          device_id: device_id,
          filename: wavFilename,
          filepath: filepath,
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
    const timeout = 5 * 60 * 1000; // 5分钟超时
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
      ws: ws,
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
      
      // 日志管理
      addLog: (level, message, data = {}) => {
        return this.addDeviceLog(deviceId, level, message, data);
      },
      
      getLogs: (filter = {}) => {
        return this.getDeviceLogs(deviceId, filter);
      },
      
      clearLogs: () => {
        deviceLogs.set(deviceId, []);
      },
      
      // 发送消息（调用display命令）
      sendMsg: async (msg) => {
        return await this.sendCommand(deviceId, 'display', {
          text: this.encodeData(msg),
          clear: true
        }, 1);
      },
      
      // 发送命令（优化版）
      sendCommand: async (cmd, params = {}, priority = 0) => {
        return await this.sendCommand(deviceId, cmd, params, priority);
      },
      
      // 显示文本
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
      
      // 摄像头控制
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
        },
        
        config: async (params) => {
          return await this.sendCommand(deviceId, 'camera_config', params, 1);
        }
      },
      
      // 麦克风控制（新增）
      microphone: {
        getStatus: async () => {
          return await this.sendCommand(deviceId, 'microphone_status', {}, 0);
        },
        
        test: async (duration = 3) => {
          return await this.sendCommand(deviceId, 'microphone_test', { duration }, 1);
        }
      },
      
      // 重启
      reboot: async () => {
        return await this.sendCommand(deviceId, 'reboot', {}, 99);
      },
      
      // 检查能力
      hasCapability: (cap) => {
        return deviceInfo.capabilities?.includes(cap);
      },
      
      // 获取状态
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
      
      // 获取统计
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
      uptime: 0,
      last_heartbeat: Date.now(),
      message_rate: 0,
      avg_latency: 0,
      latency_samples: []
    };
    
    deviceStats.set(deviceId, stats);
    return stats;
  }

  updateDeviceStats(deviceId, type, value) {
    const stats = deviceStats.get(deviceId);
    if (!stats) return;
    
    switch (type) {
      case 'message':
        stats.total_messages++;
        stats.message_rate = stats.total_messages / ((Date.now() - stats.connected_at) / 1000);
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
      
      case 'latency':
        stats.latency_samples.push(value);
        if (stats.latency_samples.length > 100) {
          stats.latency_samples.shift();
        }
        stats.avg_latency = stats.latency_samples.reduce((a, b) => a + b, 0) / stats.latency_samples.length;
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
      
      // 初始化日志
      if (!deviceLogs.has(device_id)) {
        deviceLogs.set(device_id, []);
      }
      
      // 初始化统计
      if (!deviceStats.has(device_id)) {
        this.initDeviceStats(device_id);
      }
      
      // 设置WebSocket
      if (ws) {
        this.setupWebSocket(device_id, ws);
      }
      
      // 添加到Bot.uin列表
      if (!Bot.uin.includes(device_id)) {
        Bot.uin.push(device_id);
      }
      
      // 创建Bot实例
      this.createDeviceBot(device_id, device, ws);
      
      BotUtil.makeLog('info', 
        `[设备注册] ${device.device_name} (${device_id}) - IP: ${ip_address}, 固件: v${firmware_version}`, 
        device.device_name
      );
      
      // 触发上线事件
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
    // 清理旧连接
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
    
    // Pong响应
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
      
      // 触发离线事件
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
    
    // 停止摄像头流
    const stream = cameraStreams.get(deviceId);
    if (stream) {
      stream.clients.forEach(client => {
        try {
          client.close();
        } catch (e) {}
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
    
    // 限制日志数量
    if (logs.length > CONFIG.maxLogsPerDevice) {
      logs.length = CONFIG.maxLogsPerDevice;
    }
    
    deviceLogs.set(deviceId, logs);
    
    // 统计错误
    const device = devices.get(deviceId);
    if (device?.stats && level === 'error') {
      device.stats.errors++;
      this.updateDeviceStats(deviceId, 'error');
    }
    
    BotUtil.makeLog(level, `[${device?.device_name || deviceId}] ${message}`, device?.device_name || deviceId);
    
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
      
      // 设备未注册
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
      
      BotUtil.makeLog('debug', `[设备事件] [${device.device_name}] [${eventType}]`, device.device_name);
      
      switch (eventType) {
        case 'log':
          const { level = 'info', message, data: logData } = eventData;
          this.addDeviceLog(deviceId, level, message, logData);
          break;
        
        case 'command_result':
          const { command_id, result, latency } = eventData;
          const callback = commandCallbacks.get(command_id);
          
          if (callback) {
            callback(result);
            commandCallbacks.delete(command_id);
            
            // 记录延迟
            if (latency) {
              this.updateDeviceStats(deviceId, 'latency', latency);
            }
          }
          break;
        
        case 'audio_chunk':
          // 处理录音数据块（新增）
          return await this.processAudioChunk(deviceId, eventData);
        
        case 'camera_frame':
          const stream = cameraStreams.get(deviceId);
          if (stream && stream.clients.size > 0) {
            const frameData = {
              device_id: deviceId,
              ...eventData
            };
            
            stream.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                try {
                  client.send(JSON.stringify({
                    type: 'camera_frame',
                    data: frameData
                  }));
                } catch (e) {
                  BotUtil.makeLog('error', `[摄像头流发送失败] ${e.message}`, device.device_name);
                }
              }
            });
            
            stream.frame_count++;
            stream.last_frame = Date.now();
          }
          break;
        
        default:
          // 触发自定义事件
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
    
    const startTime = Date.now();
    
    const cmd = {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      command,
      parameters: this.encodeData(parameters),
      priority,
      timestamp: Date.now()
    };
    
    BotUtil.makeLog('debug', `[发送命令] [${device.device_name}] [${command}]`, device.device_name);
    
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
          const latency = Date.now() - startTime;
          this.updateDeviceStats(deviceId, 'latency', latency);
          resolve({ 
            success: true, 
            command_id: cmd.id, 
            result,
            latency
          });
        });
        
        try {
          ws.send(JSON.stringify({
            type: 'command',
            command: cmd
          }));
          
          device.stats.commands_executed++;
        } catch (error) {
          clearTimeout(timeout);
          commandCallbacks.delete(cmd.id);
          resolve({
            success: false,
            command_id: cmd.id,
            error: error.message
          });
        }
      });
    }
    
    // 命令队列（设备离线时）
    const commands = deviceCommands.get(deviceId) || [];
    
    if (priority > 0) {
      commands.unshift(cmd);
    } else {
      commands.push(cmd);
    }
    
    // 限制队列大小
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
          
          BotUtil.makeLog('warn', `[设备离线] [${device.device_name}]`, device.device_name);
        }
      }
    }
  }

  // ========== 获取设备列表 ==========

  getDeviceList() {
    return Array.from(devices.values()).map(d => ({
      device_id: d.device_id,
      device_name: d.device_name,
      device_type: d.device_type,
      online: d.online,
      last_seen: d.last_seen,
      capabilities: d.capabilities,
      stats: d.stats,
      device_stats: deviceStats.get(d.device_id)
    }));
  }

  getDevice(deviceId) {
    const device = devices.get(deviceId);
    if (!device) return null;
    
    return {
      ...device,
      device_stats: deviceStats.get(deviceId)
    };
  }

  // ========== WebSocket消息处理 ==========

  async processWebSocketMessage(ws, data, Bot) {
    try {
      data = this.decodeData(data);
      const { type, device_id, ...payload } = data;
      
      const deviceId = device_id || ws.device_id;
      
      BotUtil.makeLog('debug', `[WS接收] [${deviceId}] [${type}]`, 'DeviceManager');
      
      const startTime = Date.now();
      
      switch (type) {
        case 'register':
          const device = await this.registerDevice({ device_id: deviceId, ...payload }, Bot, ws);
          ws.send(JSON.stringify({ 
            type: 'register_response', 
            success: true, 
            device
          }));
          break;
        
        case 'event':
        case 'data':
          const eventType = payload.data_type || payload.event_type || type;
          const eventData = payload.data || payload.event_data || payload;
          await this.processDeviceEvent(deviceId, eventType, eventData, Bot);
          ws.send(JSON.stringify({ type: 'event_response', success: true }));
          break;
        
        case 'log':
          const { level = 'info', message, data: logData } = payload;
          this.addDeviceLog(deviceId, level, message, logData);
          ws.send(JSON.stringify({ type: 'log_response', success: true }));
          break;
        
        case 'heartbeat':
          ws.isAlive = true;
          ws.lastPong = Date.now();
          
          const dev = devices.get(deviceId);
          if (dev) {
            dev.last_seen = Date.now();
            dev.online = true;
            if (payload.status) {
              dev.status = payload.status;
            }
          }
          
          this.updateDeviceStats(deviceId, 'heartbeat');
          
          // 发送队列命令
          const queuedCommands = deviceCommands.get(deviceId) || [];
          const commandsToSend = queuedCommands.splice(0, 3); 
          
          ws.send(JSON.stringify({ 
            type: 'heartbeat_response', 
            commands: commandsToSend,
            timestamp: Date.now()
          }));
          break;
        
        case 'command_result':
          const latency = Date.now() - startTime;
          await this.processDeviceEvent(deviceId, type, { 
            ...payload, 
            latency 
          }, Bot);
          break;
        
        default:
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: `未知类型: ${type}` 
          }));
      }
    } catch (error) {
      BotUtil.makeLog('error', `[WS处理失败] ${error.message}`, 'DeviceManager');
      try {
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: error.message 
        }));
      } catch (e) {}
    }
  }
}

const deviceManager = new DeviceManager();

// ============================================================
// 设备管理API（优化版 + 录音功能）
// ============================================================

export default {
  name: 'device',
  dsc: '设备管理API（优化版 v2.1 + 录音功能）',
  priority: 90,

  routes: [
    // ========== 设备基础API ==========
    
    // 注册设备
    {
      method: 'POST',
      path: '/api/device/register',
      handler: async (req, res, Bot) => {
        try {
          const device = await deviceManager.registerDevice({
            ...req.body,
            ip_address: req.ip || req.socket.remoteAddress
          }, Bot);
          
          res.json({ 
            success: true, 
            device_id: device.device_id, 
            device_name: device.device_name 
          });
        } catch (error) {
          res.status(400).json({ 
            success: false, 
            message: error.message 
          });
        }
      }
    },
    
    // 获取设备列表
    {
      method: 'GET',
      path: '/api/devices',
      handler: async (req, res) => {
        const devices = deviceManager.getDeviceList();
        res.json({ 
          success: true, 
          devices, 
          count: devices.length 
        });
      }
    },
    
    // 获取设备信息
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
    
    // 获取设备日志
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
    
    // 发送命令
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
    
    // 显示文本
    {
      method: 'POST',
      path: '/api/device/:deviceId/display',
      handler: async (req, res, Bot) => {
        try {
          const { deviceId } = req.params;
          const { text, ...options } = req.body;
          
          const result = await Bot[deviceId].display(text, options);
          res.json(result);
        } catch (error) {
          res.status(400).json({ success: false, message: error.message });
        }
      }
    },
    
    // 获取设备统计
    {
      method: 'GET',
      path: '/api/device/:deviceId/stats',
      handler: async (req, res, Bot) => {
        const { deviceId } = req.params;
        const stats = Bot[deviceId]?.getStats();
        
        if (stats) {
          res.json({ success: true, stats });
        } else {
          res.status(404).json({ success: false, message: '设备未找到' });
        }
      }
    },
    
    // ========== 摄像头API ==========
    
    // 开始流
    {
      method: 'POST',
      path: '/api/device/:deviceId/camera/start',
      handler: async (req, res, Bot) => {
        try {
          const { deviceId } = req.params;
          const result = await Bot[deviceId].camera.startStream(req.body);
          res.json(result);
        } catch (error) {
          res.status(400).json({ success: false, message: error.message });
        }
      }
    },
    
    // 停止流
    {
      method: 'POST',
      path: '/api/device/:deviceId/camera/stop',
      handler: async (req, res, Bot) => {
        try {
          const { deviceId } = req.params;
          const result = await Bot[deviceId].camera.stopStream();
          res.json(result);
        } catch (error) {
          res.status(400).json({ success: false, message: error.message });
        }
      }
    },
    
    // 捕获
    {
      method: 'POST',
      path: '/api/device/:deviceId/camera/capture',
      handler: async (req, res, Bot) => {
        try {
          const { deviceId } = req.params;
          const result = await Bot[deviceId].camera.capture();
          res.json(result);
        } catch (error) {
          res.status(400).json({ success: false, message: error.message });
        }
      }
    },
    
    // 摄像头统计
    {
      method: 'GET',
      path: '/api/device/:deviceId/camera/stats',
      handler: async (req, res, Bot) => {
        try {
          const { deviceId } = req.params;
          const result = await Bot[deviceId].camera.getStats();
          res.json(result);
        } catch (error) {
          res.status(400).json({ success: false, message: error.message });
        }
      }
    },
    
    // ========== 录音API（新增）==========
    
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
          
          const fileStream = fs.createReadStream(filepath);
          fileStream.pipe(res);
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
    
    // 麦克风测试录音
    {
      method: 'POST',
      path: '/api/device/:deviceId/microphone/test',
      handler: async (req, res, Bot) => {
        try {
          const { deviceId } = req.params;
          const { duration } = req.body;
          const result = await Bot[deviceId].microphone.test(duration);
          res.json(result);
        } catch (error) {
          res.status(400).json({ success: false, message: error.message });
        }
      }
    }
  ],

  // ========== WebSocket路由 ==========
  ws: {
    device: [(ws, req, Bot) => {
      BotUtil.makeLog('info', `[WebSocket] 新连接 ${req.socket.remoteAddress}`, 'DeviceManager');
      
      // 消息处理
      ws.on('message', msg => {
        try {
          const data = JSON.parse(msg);
          deviceManager.processWebSocketMessage(ws, data, Bot);
        } catch (error) {
          BotUtil.makeLog('error', `[WS解析失败] ${error.message}`, 'DeviceManager');
          try {
            ws.send(JSON.stringify({ 
              type: 'error', 
              message: `消息解析失败: ${error.message}` 
            }));
          } catch (e) {}
        }
      });
      
      // 关闭处理
      ws.on('close', () => {
        if (ws.device_id) {
          deviceManager.handleDeviceDisconnect(ws.device_id, ws);
        }
      });
      
      // 错误处理
      ws.on('error', (error) => {
        BotUtil.makeLog('error', `[WS错误] ${error.message}`, 'DeviceManager');
      });
    }],
    
    // 摄像头流WebSocket
    'camera-stream': [(ws, req, Bot) => {
      const deviceId = req.query.device_id;
      const apiKey = req.query.api_key || req.headers['x-api-key'];
      
      // 验证API密钥
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
      
      // 创建或获取流
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
      
      // 关闭处理
      ws.on('close', () => {
        stream.clients.delete(ws);
        
        if (stream.clients.size === 0) {
          // 没有客户端时停止流
          Bot[deviceId].camera.stopStream().catch(() => {});
          cameraStreams.delete(deviceId);
        }
        
        BotUtil.makeLog('info', `[摄像头流] 客户端断开 ${deviceId}`, device.device_name);
      });
      
      // 错误处理
      ws.on('error', (error) => {
        BotUtil.makeLog('error', `[摄像头流错误] ${error.message}`, device.device_name);
      });
      
      // 发送欢迎消息
      try {
        ws.send(JSON.stringify({
          type: 'connected',
          device_id: deviceId,
          device_name: device.device_name,
          stream_info: {
            clients: stream.clients.size,
            frame_count: stream.frame_count
          }
        }));
      } catch (e) {}
    }]
  },

  // ========== 初始化 ==========
  init(app, Bot) {
    // 离线检查定时器
    deviceManager.cleanupInterval = setInterval(() => {
      deviceManager.checkOfflineDevices(Bot);
    }, 30000);
    
    // 清理过期命令回调
    setInterval(() => {
      const now = Date.now();
      for (const [id, callback] of commandCallbacks) {
        const timestamp = parseInt(id.split('_')[0]);
        if (now - timestamp > 60000) {
          commandCallbacks.delete(id);
        }
      }
    }, 60000);
    
    // 清理过期音频缓冲（新增）
    setInterval(() => {
      deviceManager.cleanupStaleAudioBuffers();
    }, 5 * 60 * 1000);
    
    BotUtil.makeLog('info', '[设备管理器] 初始化完成（含录音功能）', 'DeviceManager');
  },
  
  // ========== 清理 ==========
  destroy() {
    if (deviceManager.cleanupInterval) {
      clearInterval(deviceManager.cleanupInterval);
    }
    
    if (deviceManager.statsInterval) {
      clearInterval(deviceManager.statsInterval);
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