// device.js - 设备管理API（音频流式适配版 v2.3 / 保存到 data/wav）
import cfg from '../../lib/config/config.js';
import WebSocket from 'ws';
import BotUtil from '../../lib/common/util.js';
import fs from 'fs';
import path from 'path';

// ============================
// 存储与状态
// ============================
const devices = new Map();
const deviceWebSockets = new Map();
const deviceLogs = new Map();
const deviceCommands = new Map();
const commandCallbacks = new Map();
const cameraStreams = new Map();
const deviceStats = new Map();

// ============================
// 配置
// ============================
const CONFIG = {
  heartbeatInterval: cfg.device?.heartbeat_interval || 30,
  heartbeatTimeout: cfg.device?.heartbeat_timeout || 180,
  maxDevices: cfg.device?.max_devices || 100,
  commandTimeout: cfg.device?.command_timeout || 10000,
  maxLogsPerDevice: cfg.device?.max_logs_per_device || 100,
  messageQueueSize: cfg.device?.message_queue_size || 100
};

// ============================
// 设备管理器
// ============================
class DeviceManager {
  constructor() {
    this.cleanupInterval = null;

    // 录音缓冲：filename -> { chunks: Map<index, Buffer>, bytes, ... }
    this.audioBuffers = new Map();

    // 保存目录改为 ./data/wav
    this.AUDIO_SAVE_DIR = './data/wav';
    if (!fs.existsSync(this.AUDIO_SAVE_DIR)) {
      fs.mkdirSync(this.AUDIO_SAVE_DIR, { recursive: true });
      BotUtil.makeLog('info', `[录音] 创建目录: ${this.AUDIO_SAVE_DIR}`, 'DeviceManager');
    }
  }

  // ---------- 编解码 ----------
  encodeUnicode(str) {
    if (typeof str !== 'string') return str;
    return str.split('').map(ch => {
      const code = ch.charCodeAt(0);
      return code > 127 ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
    }).join('');
  }
  decodeUnicode(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  encodeData(data) {
    if (typeof data === 'string') return this.encodeUnicode(data);
    if (Array.isArray(data)) return data.map(v => this.encodeData(v));
    if (data && typeof data === 'object') {
      return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, this.encodeData(v)]));
    }
    return data;
  }
  decodeData(data) {
    if (typeof data === 'string') return this.decodeUnicode(data);
    if (Array.isArray(data)) return data.map(v => this.decodeData(v));
    if (data && typeof data === 'object') {
      return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, this.decodeData(v)]));
    }
    return data;
  }

  // ---------- WAV 头 ----------
  createWavHeader(dataSize, sampleRate, bitsPerSample, channels) {
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

  // ---------- 音频：开始 ----------
  async processAudioStart(deviceId, data) {
    const {
      filename,
      sample_rate = 16000,
      bits_per_sample = 16,
      channels = 1
    } = data;

    if (!filename) {
      throw new Error('audio_start 缺少 filename');
    }

    this.audioBuffers.set(filename, {
      chunks: new Map(),
      bytes_received: 0,
      sample_rate,
      bits_per_sample,
      channels,
      device_id: deviceId,
      started_at: Date.now(),
      last_index: -1
    });

    BotUtil.makeLog('info', `[录音接收] ${filename} 开始 (rate=${sample_rate}, bits=${bits_per_sample}, ch=${channels})`, deviceId);
    return { success: true };
  }

  // ---------- 音频：分片 ----------
  async processAudioChunk(deviceId, data) {
    const {
      filename,
      chunk_index,
      data: b64,
      is_last = false,
      sample_rate = 16000,
      bits_per_sample = 16,
      channels = 1
    } = data;

    if (!filename) {
      return { success: false, error: 'audio_chunk 缺少 filename' };
    }

    // 兼容：如果未收到 audio_start，也初始化
    if (!this.audioBuffers.has(filename)) {
      await this.processAudioStart(deviceId, { filename, sample_rate, bits_per_sample, channels });
    }

    const buf = this.audioBuffers.get(filename);
    const audioData = Buffer.from(b64, 'base64');
    buf.chunks.set(chunk_index, audioData);
    buf.bytes_received += audioData.length;
    buf.sample_rate = sample_rate;
    buf.bits_per_sample = bits_per_sample;
    buf.channels = channels;
    buf.last_index = Math.max(buf.last_index, chunk_index);

    // 粗略进度（按已收秒数估算）
    const seconds = (buf.bytes_received / (sample_rate * channels * (bits_per_sample / 8))).toFixed(2);

    BotUtil.makeLog('debug',
      `[录音接收] ${filename} 块#${chunk_index} (${audioData.length}B, 已收~${seconds}s)`,
      deviceId
    );

    if (is_last) {
      return await this.processAudioEnd(deviceId, { filename });
    }

    return { success: true, chunk_index };
  }

  // ---------- 音频：结束并保存 ----------
  async processAudioEnd(deviceId, data) {
    const { filename } = data;
    const buf = this.audioBuffers.get(filename);
    if (!buf) {
      return { success: false, error: 'audio_end 未找到对应缓冲（可能已清理或文件名不一致）' };
    }

    // 组装（按 index 排序）
    const indices = Array.from(buf.chunks.keys()).sort((a, b) => a - b);
    const audioData = Buffer.concat(indices.map(i => buf.chunks.get(i)));
    const dataSize = audioData.length;

    // 写 WAV
    const wavHeader = this.createWavHeader(
      dataSize,
      buf.sample_rate,
      buf.bits_per_sample,
      buf.channels
    );
    const wavFile = Buffer.concat([wavHeader, audioData]);

    const wavFilename = filename.endsWith('.raw')
      ? filename.replace(/\.raw$/i, '.wav')
      : `${filename}.wav`;
    const filepath = path.join(this.AUDIO_SAVE_DIR, wavFilename);

    fs.writeFileSync(filepath, wavFile);

    const duration = (dataSize / (buf.sample_rate * buf.channels * (buf.bits_per_sample / 8))).toFixed(2);

    BotUtil.makeLog(
      'info',
      `[录音保存] ✓ ${wavFilename}  时长: ${duration}s, 大小: ${(wavFile.length / 1024).toFixed(2)}KB  路径: ${filepath}`,
      deviceId
    );

    // 事件通知
    if (Bot[deviceId]) {
      Bot.em('device.audio_saved', {
        post_type: 'device',
        event_type: 'audio_saved',
        device_id,
        filename: wavFilename,
        filepath,
        duration: parseFloat(duration),
        size: wavFile.length,
        sample_rate: buf.sample_rate,
        bits_per_sample: buf.bits_per_sample,
        channels: buf.channels,
        self_id: deviceId,
        time: Math.floor(Date.now() / 1000)
      });
    }

    // 清理缓存
    this.audioBuffers.delete(filename);

    return {
      success: true,
      filename: wavFilename,
      filepath,
      duration: parseFloat(duration),
      size: wavFile.length
    };
  }

  // ---------- 清理超时录音 ----------
  cleanupStaleAudioBuffers() {
    const timeout = 10 * 60 * 1000; // 10 分钟
    const now = Date.now();
    for (const [filename, buf] of this.audioBuffers) {
      if (now - buf.started_at > timeout) {
        BotUtil.makeLog('warn',
          `[录音接收] 超时清理: ${filename} (${buf.chunks.size} 块, 已收 ${buf.bytes_received}B)`,
          buf.device_id
        );
        this.audioBuffers.delete(filename);
      }
    }
  }

  // =======================
  // 以下保留与原版一致的流程
  // =======================

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
        return await this.sendCommand(deviceId, 'display', {
          text: this.encodeData(msg),
          clear: true
        }, 1);
      },

      sendCommand: async (cmd, params = {}, priority = 0) => {
        return await this.sendCommand(deviceId, cmd, params, priority);
      },

      microphone: {
        getStatus: async () => {
          return await this.sendCommand(deviceId, 'microphone_status', {}, 0);
        },
        test: async (duration = 3) => {
          return await this.sendCommand(deviceId, 'microphone_test', { duration }, 1);
        },
        start: async (duration) => {
          return await this.sendCommand(deviceId, 'microphone_start', { duration }, 1);
        },
        stop: async () => {
          return await this.sendCommand(deviceId, 'microphone_stop', {}, 1);
        }
      },

      reboot: async () => this.sendCommand(deviceId, 'reboot', {}, 99),

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
      }
    };
    return Bot[deviceId];
  }

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

      if (!Bot.uin.includes?.(device_id) && Array.isArray(Bot.uin)) {
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
      stream.clients.forEach(c => { try { c.close(); } catch (e) {} });
      cameraStreams.delete(deviceId);
    }
  }

  addDeviceLog(deviceId, level, message, data = {}) {
    message = this.decodeUnicode(String(message)).substring(0, 500);
    const logEntry = { timestamp: Date.now(), level, message, data: this.decodeData(data) };
    const logs = deviceLogs.get(deviceId) || [];
    logs.unshift(logEntry);
    if (logs.length > CONFIG.maxLogsPerDevice) logs.length = CONFIG.maxLogsPerDevice;
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
    if (filter.level) logs = logs.filter(l => l.level === filter.level);
    if (filter.since) {
      const since = new Date(filter.since).getTime();
      logs = logs.filter(l => l.timestamp >= since);
    }
    if (filter.limit) logs = logs.slice(0, filter.limit);
    return logs;
  }

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

      BotUtil.makeLog('debug', `[设备事件] ${eventType}`, device.device_name);

      switch (eventType) {
        case 'log': {
          const { level = 'info', message, data: logData } = eventData;
          this.addDeviceLog(deviceId, level, message, logData);
          break;
        }
        case 'command_result': {
          const { command_id, result } = eventData;
          const cb = commandCallbacks.get(command_id);
          if (cb) {
            cb(result);
            commandCallbacks.delete(command_id);
          }
          break;
        }

        // 新的音频三段式
        case 'audio_start':
          return await this.processAudioStart(deviceId, eventData);
        case 'audio_chunk':
          return await this.processAudioChunk(deviceId, eventData);
        case 'audio_end':
          return await this.processAudioEnd(deviceId, eventData);

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

    BotUtil.makeLog('debug', `[发送命令] ${command}`, device.device_name);
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

    // 无 WS，入队
    const commands = deviceCommands.get(deviceId) || [];
    if (priority > 0) commands.unshift(cmd);
    else commands.push(cmd);
    if (commands.length > CONFIG.messageQueueSize) commands.length = CONFIG.messageQueueSize;
    deviceCommands.set(deviceId, commands);
    device.stats.commands_executed++;

    return { success: true, command_id: cmd.id, queued: commands.length, method: 'queue' };
  }

  checkOfflineDevices(Bot) {
    const timeout = CONFIG.heartbeatTimeout * 1000;
    const now = Date.now();
    for (const [id, device] of devices) {
      if (device.online && now - device.last_seen > timeout) {
        const ws = deviceWebSockets.get(id);
        if (ws) this.handleDeviceDisconnect(id, ws);
        else {
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

  async processWebSocketMessage(ws, data, Bot) {
    try {
      data = this.decodeData(data);
      const { type, device_id, ...payload } = data;
      const deviceId = device_id || ws.device_id;

      BotUtil.makeLog('debug', `[WS接收] ${type}`, deviceId);

      switch (type) {
        case 'register': {
          const device = await this.registerDevice({ device_id: deviceId, ...payload }, Bot, ws);
          ws.send(JSON.stringify({ type: 'register_response', success: true, device }));
          break;
        }
        case 'data':
        case 'event': {
          const eventType = payload.data_type || payload.event_type || type;
          const eventData = payload.data || payload.event_data || payload;
          const result = await this.processDeviceEvent(deviceId, eventType, eventData, Bot);
          ws.send(JSON.stringify({ type: `${type}_response`, success: true, result }));
          break;
        }
        case 'log': {
          const { level = 'info', message, data: logData } = payload;
          this.addDeviceLog(deviceId, level, message, logData);
          break;
        }
        case 'heartbeat': {
          ws.isAlive = true;
          ws.lastPong = Date.now();
          const dev = devices.get(deviceId);
          if (dev) {
            dev.last_seen = Date.now();
            dev.online = true;
            if (payload.status) dev.status = payload.status;
          }
          this.updateDeviceStats(deviceId, 'heartbeat');

          const queued = deviceCommands.get(deviceId) || [];
          const toSend = queued.splice(0, 3);
          ws.send(JSON.stringify({ type: 'heartbeat_response', commands: toSend, timestamp: Date.now() }));
          break;
        }
        case 'command_result':
          await this.processDeviceEvent(deviceId, type, payload, Bot);
          break;
        default:
          ws.send(JSON.stringify({ type: 'error', message: `未知类型: ${type}` }));
      }
    } catch (error) {
      BotUtil.makeLog('error', `[WS处理失败] ${error.message}`, 'DeviceManager');
      try { ws.send(JSON.stringify({ type: 'error', message: error.message })); } catch (e) {}
    }
  }
}

const deviceManager = new DeviceManager();

// ============================
// 导出 API
// ============================
export default {
  name: 'device',
  dsc: '设备管理API（音频流式适配版 v2.3）',
  priority: 90,

  routes: [
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
          res.json({ success: true, device_id: device.device_id, device_name: device.device_name });
        } catch (error) {
          res.status(400).json({ success: false, message: error.message });
        }
      }
    },
    // 获取设备列表
    {
      method: 'GET',
      path: '/api/devices',
      handler: async (req, res) => {
        const list = deviceManager.getDeviceList();
        res.json({ success: true, devices: list, count: list.length });
      }
    },
    // 获取设备信息
    {
      method: 'GET',
      path: '/api/device/:deviceId',
      handler: async (req, res) => {
        const device = deviceManager.getDevice(req.params.deviceId);
        if (device) res.json({ success: true, device });
        else res.status(404).json({ success: false, message: '设备未找到' });
      }
    },

    // ===== 音频文件管理（data/wav）=====
    {
      method: 'GET',
      path: '/api/device/:deviceId/audio/list',
      handler: async (req, res) => {
        try {
          const files = fs.readdirSync(deviceManager.AUDIO_SAVE_DIR)
            .filter(f => f.toLowerCase().endsWith('.wav'))
            .map(f => {
              const p = path.join(deviceManager.AUDIO_SAVE_DIR, f);
              const st = fs.statSync(p);
              return {
                filename: f,
                size: st.size,
                created_at: st.birthtime,
                modified_at: st.mtime
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
          res.json({ success: true, message: '文件已删除' });
        } catch (error) {
          res.status(500).json({ success: false, message: error.message });
        }
      }
    },
    {
      method: 'GET',
      path: '/api/device/:deviceId/audio/receiving',
      handler: async (req, res) => {
        const receiving = Array.from(deviceManager.audioBuffers.entries()).map(([filename, buf]) => ({
          filename,
          device_id: buf.device_id,
          chunks_received: buf.chunks.size,
          bytes_received: buf.bytes_received,
          started_at: buf.started_at,
          elapsed_ms: Date.now() - buf.started_at
        }));
        res.json({ success: true, receiving, count: receiving.length });
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
    }
  ],

  ws: {
    device: [(ws, req, Bot) => {
      BotUtil.makeLog('info', `[WebSocket] 新连接 ${req.socket.remoteAddress}`, 'DeviceManager');

      ws.on('message', msg => {
        try {
          const data = JSON.parse(msg);
          deviceManager.processWebSocketMessage(ws, data, Bot);
        } catch (error) {
          BotUtil.makeLog('error', `[WS解析失败] ${error.message}`, 'DeviceManager');
          try { ws.send(JSON.stringify({ type: 'error', message: `解析失败: ${error.message}` })); } catch (e) {}
        }
      });

      ws.on('close', () => {
        if (ws.device_id) deviceManager.handleDeviceDisconnect(ws.device_id, ws);
      });

      ws.on('error', (error) => {
        BotUtil.makeLog('error', `[WS错误] ${error.message}`, 'DeviceManager');
      });
    }]
  },

  init(app, Bot) {
    deviceManager.cleanupInterval = setInterval(() => {
      deviceManager.checkOfflineDevices(Bot);
    }, 30000);

    setInterval(() => {
      // 清理陈旧 command 回调
      const now = Date.now();
      for (const [id] of commandCallbacks) {
        const ts = parseInt(String(id).split('_')[0], 10);
        if (now - ts > 60000) commandCallbacks.delete(id);
      }
    }, 60000);

    setInterval(() => {
      deviceManager.cleanupStaleAudioBuffers();
    }, 5 * 60 * 1000);

    BotUtil.makeLog('info', '[设备管理器] 初始化完成（音频流式适配 v2.3, 保存到 data/wav）', 'DeviceManager');
  },

  destroy() {
    if (deviceManager.cleanupInterval) clearInterval(deviceManager.cleanupInterval);
    for (const [, ws] of deviceWebSockets) {
      try { clearInterval(ws.heartbeatTimer); ws.close(); } catch (e) {}
    }
    BotUtil.makeLog('info', '[设备管理器] 已清理', 'DeviceManager');
  }
};
