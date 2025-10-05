// device.js - 设备管理 API（扩展图传支持）
import cfg from '../../lib/config/config.js';
import WebSocket from 'ws';
import BotUtil from '../../lib/common/util.js';

// 数据存储
const devices = new Map();
const deviceCommands = new Map();
const deviceWebSockets = new Map();
const deviceLogs = new Map();
const commandCallbacks = new Map();
const cameraStreams = new Map(); // 摄像头流

/**
 * 设备管理器
 */
class DeviceManager {
  constructor() {
    this.heartbeatInterval = cfg.device?.heartbeat_interval || 30;
    this.heartbeatTimeout = cfg.device?.heartbeat_timeout || 120;
    this.maxDevices = cfg.device?.max_devices || 100;
    this.commandTimeout = cfg.device?.command_timeout || 5000;
    this.maxLogsPerDevice = cfg.device?.max_logs_per_device || 100;
    this.maxFrameSize = 500 * 1024; // 最大帧大小 500KB
  }

  /**
   * Unicode编码
   */
  encodeUnicode(str) {
    if (typeof str !== 'string') return str;
    return str.split('').map(char => {
      const code = char.charCodeAt(0);
      return code > 127 ? '\\u' + ('0000' + code.toString(16)).slice(-4) : char;
    }).join('');
  }

  /**
   * Unicode解码
   */
  decodeUnicode(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/\\u([0-9a-fA-F]{4})/g, (match, p1) => {
      return String.fromCharCode(parseInt(p1, 16));
    });
  }

  /**
   * 递归编码
   */
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

  /**
   * 递归解码
   */
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

  /**
   * 创建设备Bot实例
   */
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
        errors: 0
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
      
      // 发送命令
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
          color: options.color || 1,
          wrap: options.wrap !== false,
          spacing: options.spacing || 2
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
        return {
          device_id: deviceId,
          device_name: deviceInfo.device_name,
          device_type: deviceInfo.device_type,
          online: devices.get(deviceId)?.online || false,
          last_seen: devices.get(deviceId)?.last_seen,
          capabilities: deviceInfo.capabilities,
          metadata: deviceInfo.metadata,
          stats: devices.get(deviceId)?.stats
        };
      }
    };
    return Bot[deviceId];
  }

  /**
   * 注册设备
   */
  async registerDevice(deviceData, Bot, ws) {
    try {
      deviceData = this.decodeData(deviceData);
      const { device_id, device_type, device_name, capabilities = [], metadata = {}, ip_address, firmware_version } = deviceData;
      
      if (!device_id || !device_type) {
        throw new Error('缺少必需参数');
      }
      
      if (devices.size >= this.maxDevices && !devices.has(device_id)) {
        throw new Error('设备数量已达上限');
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
          errors: 0
        }
      };
      
      devices.set(device_id, device);
      
      if (!deviceLogs.has(device_id)) {
        deviceLogs.set(device_id, []);
      }
      
      if (ws) {
        deviceWebSockets.set(device_id, ws);
        ws.device_id = device_id;
        ws.heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'heartbeat_request' }));
          }
        }, this.heartbeatInterval * 1000);
      }
      
      if (!Bot.uin.includes(device_id)) {
        Bot.uin.push(device_id);
      }
      
      this.createDeviceBot(device_id, device, ws);
      
      BotUtil.makeLog('info', `[设备注册] ${device.device_name} (${device_id}) - IP: ${ip_address}, 固件: v${firmware_version}`, device.device_name);
      
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

  /**
   * 添加设备日志
   */
  addDeviceLog(deviceId, level, message, data = {}) {
    message = this.decodeUnicode(String(message)).substring(0, 200);
    const logEntry = {
      timestamp: Date.now(),
      level,
      message,
      data: this.decodeData(data)
    };
    
    const logs = deviceLogs.get(deviceId) || [];
    logs.unshift(logEntry);
    if (logs.length > this.maxLogsPerDevice) {
      logs.length = this.maxLogsPerDevice;
    }
    deviceLogs.set(deviceId, logs);
    
    const device = devices.get(deviceId);
    if (device?.stats && level === 'error') {
      device.stats.errors++;
    }
    
    BotUtil.makeLog(level, `[${device?.device_name || deviceId}] ${message}`, device?.device_name || deviceId);
    return logEntry;
  }

  /**
   * 处理设备事件
   */
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
      
      BotUtil.makeLog('info', `[设备事件] [${device.device_name}] [${eventType}]`, device.device_name);
      
      switch (eventType) {
        case 'log':
          const { level = 'info', message, data: logData } = eventData;
          this.addDeviceLog(deviceId, level, message, logData);
          break;
          
        case 'command_result':
          const { command_id } = eventData;
          const callback = commandCallbacks.get(command_id);
          if (callback) {
            callback(eventData.result);
            commandCallbacks.delete(command_id);
          }
          break;
        
        // 摄像头帧数据  
        case 'camera_frame':
          const stream = cameraStreams.get(deviceId);
          if (stream && stream.clients.size > 0) {
            const frameData = {
              device_id: deviceId,
              ...eventData
            };
            
            // 广播给所有订阅的客户端
            stream.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                  type: 'camera_frame',
                  data: frameData
                }));
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
      BotUtil.makeLog('error', `[设备事件失败] ${error.message}`, 'DeviceManager');
      return { success: false, error: error.message };
    }
  }

  /**
   * 发送命令
   */
  async sendCommand(deviceId, command, parameters = {}, priority = 0) {
    const device = devices.get(deviceId);
    if (!device) {
      throw new Error('设备未找到');
    }
    
    const cmd = {
      id: Date.now().toString(),
      command,
      parameters: this.encodeData(parameters),
      priority,
      timestamp: Date.now()
    };
    
    BotUtil.makeLog('info', `[发送命令] [${device.device_name}] [${command}]`, device.device_name);
    
    const ws = deviceWebSockets.get(deviceId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          commandCallbacks.delete(cmd.id);
          resolve({ success: true, command_id: cmd.id, timeout: true });
        }, this.commandTimeout);
        
        commandCallbacks.set(cmd.id, (result) => {
          clearTimeout(timeout);
          resolve({ success: true, command_id: cmd.id, result });
        });
        
        ws.send(JSON.stringify({
          type: 'command',
          command: cmd
        }));
        
        device.stats.commands_executed++;
      });
    }
    
    // 命令队列
    const commands = deviceCommands.get(deviceId) || [];
    if (priority > 0) {
      commands.unshift(cmd);
    } else {
      commands.push(cmd);
    }
    if (commands.length > 10) {
      commands.length = 10;
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

  /**
   * 检查离线设备
   */
  checkOfflineDevices(Bot) {
    const timeout = this.heartbeatTimeout * 1000;
    const now = Date.now();
    
    for (const [id, device] of devices) {
      if (device.online && now - device.last_seen > timeout) {
        device.online = false;
        
        const ws = deviceWebSockets.get(id);
        if (ws) {
          clearInterval(ws.heartbeat);
          ws.close();
          deviceWebSockets.delete(id);
        }
        
        // 停止摄像头流
        const stream = cameraStreams.get(id);
        if (stream) {
          stream.clients.forEach(client => client.close());
          cameraStreams.delete(id);
        }
        
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

  /**
   * 获取设备列表
   */
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

  /**
   * 获取设备信息
   */
  getDevice(deviceId) {
    return devices.get(deviceId);
  }

  /**
   * 获取设备日志
   */
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

  /**
   * 处理WebSocket消息
   */
  async processWebSocketMessage(ws, data, Bot) {
    try {
      data = this.decodeData(data);
      const { type, device_id, ...payload } = data;
      
      BotUtil.makeLog('info', `[WS接收] [${device_id || ws.device_id}] [${type}]`, 'DeviceManager');
      
      switch (type) {
        case 'register':
          const device = await this.registerDevice({ device_id, ...payload }, Bot, ws);
          ws.send(JSON.stringify({ type: 'register_response', success: true, device }));
          break;
          
        case 'event':
        case 'data':
          const eventType = payload.data_type || payload.event_type || type;
          const eventData = payload.data || payload.event_data || payload;
          await this.processDeviceEvent(device_id || ws.device_id, eventType, eventData, Bot);
          ws.send(JSON.stringify({ type: 'event_response', success: true }));
          break;
          
        case 'log':
          const { level = 'info', message, data: logData } = payload;
          this.addDeviceLog(device_id || ws.device_id, level, message, logData);
          ws.send(JSON.stringify({ type: 'log_response', success: true }));
          break;
          
        case 'heartbeat':
          const dev = devices.get(device_id || ws.device_id);
          if (dev) {
            dev.last_seen = Date.now();
            dev.online = true;
            if (payload.status) {
              dev.status = payload.status;
            }
          }
          ws.send(JSON.stringify({ type: 'heartbeat_response', commands: [] }));
          break;
          
        case 'command_result':
          const callback = commandCallbacks.get(payload.command_id);
          if (callback) {
            callback(payload.result);
            commandCallbacks.delete(payload.command_id);
          }
          break;
          
        default:
          ws.send(JSON.stringify({ type: 'error', message: `未知类型: ${type}` }));
      }
    } catch (error) {
      BotUtil.makeLog('error', `[WS处理失败] ${error.message}`, 'DeviceManager');
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  }
}

const deviceManager = new DeviceManager();

/**
 * 设备管理API
 */
export default {
  name: 'device',
  dsc: '设备管理API',
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
        const devices = deviceManager.getDeviceList();
        res.json({ success: true, devices, count: devices.length });
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
    
    // 摄像头控制 - 开始流
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
    
    // 摄像头控制 - 停止流
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
    
    // 摄像头控制 - 捕获
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
          clearInterval(ws.heartbeat);
          deviceWebSockets.delete(ws.device_id);
          const device = devices.get(ws.device_id);
          if (device) {
            BotUtil.makeLog('info', `[WS断开] ${device.device_name}`, device.device_name);
          }
        }
      });
      
      ws.on('error', (error) => {
        BotUtil.makeLog('error', `[WS错误] ${error.message}`, 'DeviceManager');
      });
    }],
    
    // 摄像头流WebSocket
    'camera-stream': [(ws, req, Bot) => {
      const deviceId = req.query.device_id;
      const apiKey = req.query.api_key || req.headers['x-api-key'];
      
      // 验证API密钥（可选）
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
          last_frame: Date.now()
        });
      }
      
      const stream = cameraStreams.get(deviceId);
      stream.clients.add(ws);
      
      BotUtil.makeLog('info', `[摄像头流] 新客户端连接 ${deviceId}`, device.device_name);
      
      ws.on('close', () => {
        stream.clients.delete(ws);
        if (stream.clients.size === 0) {
          // 没有客户端时停止流
          Bot[deviceId].camera.stopStream().catch(() => {});
          cameraStreams.delete(deviceId);
        }
        BotUtil.makeLog('info', `[摄像头流] 客户端断开 ${deviceId}`, device.device_name);
      });
      
      ws.on('error', (error) => {
        BotUtil.makeLog('error', `[摄像头流错误] ${error.message}`, device.device_name);
      });
      
      // 发送欢迎消息
      ws.send(JSON.stringify({
        type: 'connected',
        device_id: deviceId,
        device_name: device.device_name
      }));
    }]
  },

  // 初始化
  init(app, Bot) {
    // 检查离线设备
    setInterval(() => {
      deviceManager.checkOfflineDevices(Bot);
    }, 30000);
    
    // 清理过期数据
    setInterval(() => {
      const now = Date.now();
      for (const [id, callback] of commandCallbacks) {
        if (now - parseInt(id) > 60000) {
          commandCallbacks.delete(id);
        }
      }
    }, 60000);
  }
};