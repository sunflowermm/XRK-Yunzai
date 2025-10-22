// device.js - 设备管理API（完整优化录音版 v2.3）
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
    this.AUDIO_SAVE_DIR = './data/mp3';  // 改为 mp3 目录
    
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

  // ========== 音频处理（优化版）==========
  createWavHeader(dataSize, sampleRate = 16000, bitsPerSample = 16, channels = 1) {
    const buffer = Buffer.alloc(44);
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);                    // fmt chunk size
    buffer.writeUInt16LE(1, 20);                     // audio format (PCM)
    buffer.writeUInt16LE(channels, 22);              // channels
    buffer.writeUInt32LE(sampleRate, 24);            // sample rate
    buffer.writeUInt32LE(byteRate, 28);              // byte rate
    buffer.writeUInt16LE(blockAlign, 32);            // block align
    buffer.writeUInt16LE(bitsPerSample, 34);         // bits per sample
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
        channels = 1,
        timestamp
      } = chunkData;
      
      const device = devices.get(deviceId);
      const deviceName = device?.device_name || deviceId;
      
      // 初始化缓冲区
      if (!this.audioBuffers.has(filename)) {
        this.audioBuffers.set(filename, {
          chunks: [],                    // 改用数组顺序存储
          received_indices: new Set(),   // 跟踪已接收的索引
          total: chunks_total || 0,
          sample_rate,
          bits_per_sample,
          channels,
          device_id: deviceId,
          device_name: deviceName,
          started_at: Date.now(),
          last_chunk_at: Date.now(),
          total_bytes: 0
        });
        
        BotUtil.makeLog('info', 
          `[录音接收] ${filename} 开始接收`, 
          deviceName
        );
      }
      
      const buffer = this.audioBuffers.get(filename);
      buffer.last_chunk_at = Date.now();
      
      // 存储数据块
      if (data && data.length > 0) {
        const audioData = Buffer.from(data, 'base64');
        
        // 按索引存储
        if (!buffer.received_indices.has(chunk_index)) {
          buffer.chunks[chunk_index] = audioData;
          buffer.received_indices.add(chunk_index);
          buffer.total_bytes += audioData.length;
          
          // 更新总块数
          if (chunks_total && chunks_total > buffer.total) {
            buffer.total = chunks_total;
          }
          
          // 每5块输出一次进度
          if (chunk_index % 5 === 0) {
            const progress = buffer.total > 0 
              ? ((buffer.received_indices.size / buffer.total) * 100).toFixed(1)
              : '?';
            const elapsed = ((Date.now() - buffer.started_at) / 1000).toFixed(1);
            
            BotUtil.makeLog('debug', 
              `[录音] 块#${chunk_index} ${audioData.length}B | ` +
              `进度:${buffer.received_indices.size}/${buffer.total || '?'} (${progress}%) | ` +
              `耗时:${elapsed}s | 总:${(buffer.total_bytes / 1024).toFixed(1)}KB`,
              deviceName
            );
          }
        }
      }
      
      // 检查是否完成
      if (is_last || (buffer.total > 0 && buffer.received_indices.size >= buffer.total)) {
        BotUtil.makeLog('info', 
          `[录音] ${filename} 接收完成，开始保存 (共${buffer.received_indices.size}块, ${(buffer.total_bytes / 1024).toFixed(1)}KB)`, 
          deviceName
        );
        
        // 立即保存
        const savedPath = await this.saveAudioFile(filename, buffer);
        this.audioBuffers.delete(filename);
        
        return { 
          success: true, 
          completed: true,
          chunk_index, 
          total_chunks: buffer.received_indices.size,
          filepath: savedPath,
          message: '录音完成'
        };
      }
      
      return { 
        success: true, 
        chunk_index, 
        received: buffer.received_indices.size, 
        total: buffer.total || '?'
      };
      
    } catch (error) {
      BotUtil.makeLog('error', `[录音接收] 处理失败: ${error.message}`, deviceId);
      return { success: false, error: error.message };
    }
  }
  
  async saveAudioFile(filename, buffer) {
    const startTime = Date.now();
    
    try {
      const { chunks, received_indices, sample_rate, bits_per_sample, channels, device_id, device_name } = buffer;
      
      BotUtil.makeLog('info', 
        `[录音保存] ${filename} 拼接${received_indices.size}块数据`, 
        device_name
      );
      
      // 按索引顺序拼接数据（过滤空块）
      const sortedChunks = [];
      for (let i = 0; i < chunks.length; i++) {
        if (chunks[i]) {
          sortedChunks.push(chunks[i]);
        }
      }
      
      if (sortedChunks.length === 0) {
        throw new Error('没有有效的音频数据');
      }
      
      const audioData = Buffer.concat(sortedChunks);
      const dataSize = audioData.length;
      
      // 创建WAV文件
      const wavHeader = this.createWavHeader(dataSize, sample_rate, bits_per_sample, channels);
      const wavFile = Buffer.concat([wavHeader, audioData]);
      
      // 保存文件（改为 .wav 后缀）
      const wavFilename = filename.replace('.raw', '.wav');
      const filepath = path.join(this.AUDIO_SAVE_DIR, wavFilename);
      fs.writeFileSync(filepath, wavFile);
      
      const duration = (dataSize / (sample_rate * channels * (bits_per_sample / 8))).toFixed(2);
      const saveTime = ((Date.now() - startTime) / 1000).toFixed(2);
      
      BotUtil.makeLog('info', 
        `[录音保存] ✓ ${wavFilename}\n` +
        `  时长: ${duration}秒 | 大小: ${(wavFile.length / 1024).toFixed(2)}KB\n` +
        `  路径: ${filepath}\n` +
        `  保存耗时: ${saveTime}秒`, 
        device_name
      );
      
      // 触发录音完成事件
      if (Bot[device_id]) {
        Bot.em('device.audio_saved', {
          post_type: 'device',
          event_type: 'audio_saved',
          device_id,
          device_name,
          filename: wavFilename,
          filepath,
          duration: parseFloat(duration),
          size: wavFile.length,
          sample_rate,
          bits_per_sample,
          channels,
          save_time: parseFloat(saveTime),
          self_id: device_id,
          time: Math.floor(Date.now() / 1000)
        });
      }
      
      return filepath;
      
    } catch (error) {
      BotUtil.makeLog('error', `[录音保存] 失败: ${error.message}`, buffer.device_name);
      throw error;
    }
  }
  
  cleanupStaleAudioBuffers() {
    const timeout = 5 * 60 * 1000;  // 5分钟超时
    const now = Date.now();
    
    for (const [filename, buffer] of this.audioBuffers) {
      const idle = now - buffer.last_chunk_at;
      
      if (idle > timeout) {
        BotUtil.makeLog('warn', 
          `[录音] 超时清理: ${filename} (${buffer.received_indices.size}/${buffer.total || '?'}块, 空闲${(idle/1000).toFixed(0)}s)`, 
          buffer.device_name
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
        `[设备注册] ${device.device_name} (${device_id}) - IP: ${ip_address}, 固件: v${firmware_version}`, 
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
    
    BotUtil.makeLog('debug', `[发送命令] ${command}`, device.device_name);
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
          
          // audio_chunk 立即返回确认
          if (eventType === 'audio_chunk' && result.success) {
            ws.send(JSON.stringify({ 
              type: 'data_response', 
              success: true, 
              chunk_index: eventData.chunk_index,
              result 
            }));
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
  dsc: '设备管理API（完整优化录音版 v2.3）',
  priority: 90,

  routes: [
    // ... 保留所有原有路由 ...
    
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
          fs.createReadStream(filepath).pipe(res);
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
        const receiving = Array.from(deviceManager.audioBuffers.entries()).map(([filename, buffer]) => {
          const progress = buffer.total > 0 
            ? ((buffer.received_indices.size / buffer.total) * 100).toFixed(1)
            : '0';
          
          return {
            filename,
            device_id: buffer.device_id,
            device_name: buffer.device_name,
            chunks_received: buffer.received_indices.size,
            chunks_total: buffer.total,
            progress: `${progress}%`,
            started_at: buffer.started_at,
            elapsed: Date.now() - buffer.started_at,
            total_bytes: buffer.total_bytes
          };
        });
        res.json({ success: true, receiving, count: receiving.length });
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
      deviceManager.cleanupStaleAudioBuffers();
    }, 2 * 60 * 1000);  // 每2分钟清理一次
    
    BotUtil.makeLog('info', '[设备管理器] 初始化完成（优化录音版）', 'DeviceManager');
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