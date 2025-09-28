import cfg from '../../lib/config/config.js';
import WebSocket from 'ws';
import BotUtil from '../../lib/common/util.js';

// 数据存储结构
const devices = new Map(); // 存储设备信息
const deviceCommands = new Map(); // 存储设备待执行命令队列
const deviceData = new Map(); // 存储设备数据
const deviceWebSockets = new Map(); // 存储设备 WebSocket 连接
const deviceLogs = new Map(); // 存储设备日志
const commandCallbacks = new Map(); // 存储命令回调函数

/**
 * 设备管理器类
 * 负责设备注册、命令发送、事件处理、心跳监测等核心功能，提供扩展性架构。
 * 单片机端可通过 WebSocket 或 API 注册事件、发送日志和数据。
 */
class DeviceManager {
  /**
   * 构造函数，初始化配置参数。
   */
  constructor() {
    this.heartbeatInterval = cfg.device?.heartbeat_interval || 30; // 心跳间隔（秒）
    this.heartbeatTimeout = cfg.device?.heartbeat_timeout || 120; // 心跳超时（秒）
    this.maxDevices = cfg.device?.max_devices || 100; // 最大设备数
    this.commandTimeout = cfg.device?.command_timeout || 5000; // 命令超时（毫秒）
    this.maxLogsPerDevice = cfg.device?.max_logs_per_device || 100; // 每设备最大日志条数
    this.maxDataPerDevice = cfg.device?.max_data_per_device || 50; // 每设备最大数据条数
    this.batchSize = cfg.device?.batch_size || 10; // 命令批量发送大小
  }

  /**
   * Unicode 编码（用于发送到设备的数据）。
   * @param {string} str - 要编码的字符串。
   * @returns {string} 编码后的字符串。
   */
  encodeUnicode(str) {
    if (typeof str !== 'string') return str;
    return str.split('').map(char => {
      const code = char.charCodeAt(0);
      return code > 127 ? '\\u' + ('0000' + code.toString(16)).slice(-4) : char;
    }).join('');
  }

  /**
   * Unicode 解码（用于从设备接收的数据）。
   * @param {string} str - 要解码的字符串。
   * @returns {string} 解码后的字符串。
   */
  decodeUnicode(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/\\u([0-9a-fA-F]{4})/g, (match, p1) => {
      return String.fromCharCode(parseInt(p1, 16));
    });
  }

  /**
   * 递归编码数据，支持字符串、数组和对象。
   * @param {*} data - 要编码的数据。
   * @returns {*} 编码后的数据。
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
   * 递归解码数据，支持字符串、数组和对象。
   * @param {*} data - 要解码的数据。
   * @returns {*} 解码后的数据。
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
   * 创建设备 Bot 实例，提供核心方法如发送命令、显示文本等。
   * @param {string} deviceId - 设备 ID。
   * @param {Object} deviceInfo - 设备信息。
   * @param {WebSocket} ws - WebSocket 连接。
   * @returns {Object} 设备 Bot 实例。
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
      logs: [],
      addLog: (level, message, data = {}) => {
        return this.addDeviceLog(deviceId, level, message, data);
      },
      getLogs: (filter = {}) => {
        return this.getDeviceLogs(deviceId, filter);
      },
      clearLogs: () => {
        deviceLogs.set(deviceId, []);
      },
      data: [],
      getData: () => {
        return deviceData.get(deviceId) || [];
      },
      setData: (key, value) => {
        const data = deviceData.get(deviceId) || [];
        data.push({ key, value, timestamp: Date.now() });
        if (data.length > this.maxDataPerDevice) {
          data.shift();
        }
        deviceData.set(deviceId, data);
      },
      sendMsg: async (msg) => {
        return await this.sendMessage(deviceId, msg);
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
          color: options.color || 1,
          size: options.size || 1,
          wrap: options.wrap !== false,
          spacing: options.spacing || 2,
          align: options.align || 'left'
        }, 1);
      },
      sendData: async (dataType, data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'data',
            data_type: dataType,
            data: this.encodeData(data),
            timestamp: Date.now()
          }));
          return true;
        }
        return false;
      },
      reboot: async () => {
        return await this.sendCommand(deviceId, 'reboot', {}, 99);
      },
      hasCapability: (cap) => {
        return deviceInfo.capabilities?.includes(cap);
      },
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
      },
      updateStatus: (status) => {
        const device = devices.get(deviceId);
        if (device) {
          device.status = { ...device.status, ...status };
          device.last_seen = Date.now();
        }
      }
    };
    return Bot[deviceId];
  }

  /**
   * 注册新设备，支持通过 WebSocket 或 API。
   * @param {Object} deviceData - 设备注册数据。
   * @param {Object} Bot - Bot 实例。
   * @param {WebSocket} [ws] - 可选 WebSocket 连接。
   * @returns {Object} 注册后的设备信息。
   */
  async registerDevice(deviceData, Bot, ws) {
    try {
      deviceData = this.decodeData(deviceData);
      const { device_id, device_type, device_name, capabilities = [], metadata = {}, ip_address, firmware_version } = deviceData;
      if (!device_id || !device_type) {
        throw new Error('缺少必需参数');
      }
      if (devices.size >= this.maxDevices && !devices.has(device_id)) {
        throw new Error(`设备数量已达上限`);
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
      BotUtil.makeLog('info', `[设备注册] ${device.device_name} (${device_id}) - IP: ${ip_address}, 固件: v${firmware_version}, 能力: ${capabilities.join(', ')}`, device.device_name);
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
   * 添加设备日志，记录简洁信息。
   * @param {string} deviceId - 设备 ID。
   * @param {string} level - 日志级别 (info, warn, error 等)。
   * @param {string} message - 日志消息。
   * @param {Object} [data={}] - 附加数据。
   * @returns {Object} 日志条目。
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
   * 处理设备事件，支持扩展自定义事件。
   * 单片机端可发送自定义 event_type 进行注册和处理。
   * @param {string} deviceId - 设备 ID。
   * @param {string} eventType - 事件类型。
   * @param {Object} [eventData={}] - 事件数据。
   * @param {Object} Bot - Bot 实例。
   * @returns {Object} 处理结果。
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
        default:
          // 支持自定义事件扩展，触发 Bot 事件系统
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
      BotUtil.makeLog('error', `[设备事件处理失败] ${error.message}`, 'DeviceManager');
      return { success: false, error: error.message };
    }
  }

  /**
   * 更新设备心跳，并检查命令队列。
   * @param {string} deviceId - 设备 ID。
   * @param {Object} [status={}] - 状态更新。
   * @returns {Object} 包含命令批次的响应。
   */
  async updateHeartbeat(deviceId, status = {}) {
    const device = devices.get(deviceId);
    if (!device) return { commands: [] };
    device.last_seen = Date.now();
    device.online = true;
    status = this.decodeData(status);
    if (status) {
      device.status = { ...device.status, ...status };
    }
    const commands = deviceCommands.get(deviceId) || [];
    if (commands.length > 0) {
      const batch = commands.splice(0, this.batchSize);
      batch.forEach(cmd => {
        if (cmd.parameters) {
          cmd.parameters = this.encodeData(cmd.parameters);
        }
      });
      return { commands: batch };
    }
    return { commands: [] };
  }

  /**
   * 发送命令到设备，支持实时或队列模式。
   * @param {string} deviceId - 设备 ID。
   * @param {string} command - 命令名称。
   * @param {Object} [parameters={}] - 参数。
   * @param {number} [priority=0] - 优先级。
   * @returns {Promise<Object>} 命令发送结果。
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
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          commandCallbacks.delete(cmd.id);
          resolve({ success: true, command_id: cmd.id, timeout: true });
        }, this.commandTimeout);
        commandCallbacks.set(cmd.id, (result) => {
          clearTimeout(timeout);
          BotUtil.makeLog('info', `[命令结果] [${device.device_name}] [${command}]`, device.device_name);
          resolve({ success: true, command_id: cmd.id, result });
        });
        ws.send(JSON.stringify({
          type: 'command',
          command: cmd
        }));
        device.stats.commands_executed++;
      });
    }
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
   * 发送消息到设备，使用 display 命令。
   * @param {string} deviceId - 设备 ID。
   * @param {string} msg - 消息内容。
   * @returns {Promise<Object>} 发送结果。
   */
  async sendMessage(deviceId, msg) {
    return await this.sendCommand(deviceId, 'display', {
      text: typeof msg === 'string' ? msg : '设备消息',
      clear: true
    }, 1);
  }

  /**
   * 检查离线设备并触发事件。
   * @param {Object} Bot - Bot 实例。
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
   * 获取设备列表。
   * @returns {Array<Object>} 设备信息列表。
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
   * 获取特定设备信息。
   * @param {string} deviceId - 设备 ID。
   * @returns {Object|null} 设备信息。
   */
  getDevice(deviceId) {
    return devices.get(deviceId);
  }

  /**
   * 获取设备日志，支持过滤。
   * @param {string} deviceId - 设备 ID。
   * @param {Object} [filter={}] - 过滤条件。
   * @returns {Array<Object>} 日志列表。
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
   * 处理 WebSocket 消息，支持事件扩展。
   * @param {WebSocket} ws - WebSocket 连接。
   * @param {Object} data - 消息数据。
   * @param {Object} Bot - Bot 实例。
   */
  async processWebSocketMessage(ws, data, Bot) {
    try {
      data = this.decodeData(data);
      const { type, device_id, ...payload } = data;
      BotUtil.makeLog('info', `[WebSocket 接收] [${device_id || ws.device_id}] [${type}]`, 'DeviceManager');
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
          const commands = deviceCommands.get(device_id || ws.device_id);
          if (commands && commands.length > 0) {
            const batch = commands.splice(0, this.batchSize);
            for (const cmd of batch) {
              ws.send(JSON.stringify({ type: 'command', command: cmd }));
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
      BotUtil.makeLog('error', `[WebSocket 处理失败] ${error.message}`, 'DeviceManager');
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  }
}

const deviceManager = new DeviceManager();

/**
 * 设备管理 API，提供 REST 和 WebSocket 接口。
 */
export default {
  name: 'device',
  dsc: '设备管理 API',
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
      method: 'POST',
      path: '/api/device/heartbeat',
      handler: async (req, res) => {
        try {
          const { device_id, status } = req.body;
          const result = await deviceManager.updateHeartbeat(device_id, status);
          res.json({ success: true, commands: result.commands });
        } catch (error) {
          res.status(404).json({ success: false, message: error.message });
        }
      }
    },
    {
      method: 'POST',
      path: '/api/device/event',
      handler: async (req, res, Bot) => {
        try {
          const { device_id, event_type, event_data } = req.body;
          const result = await deviceManager.processDeviceEvent(device_id, event_type, event_data, Bot);
          res.json(result);
        } catch (error) {
          res.status(404).json({ success: false, message: error.message });
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
    {
      method: 'DELETE',
      path: '/api/device/:deviceId',
      handler: async (req, res, Bot) => {
        const { deviceId } = req.params;
        const device = devices.get(deviceId);
        if (device) {
          devices.delete(deviceId);
          deviceCommands.delete(deviceId);
          deviceData.delete(deviceId);
          deviceLogs.delete(deviceId);
          const ws = deviceWebSockets.get(deviceId);
          if (ws) {
            clearInterval(ws.heartbeat);
            ws.close();
            deviceWebSockets.delete(deviceId);
          }
          delete Bot[deviceId];
          BotUtil.makeLog('info', `[设备删除] ${device.device_name} (${deviceId})`, device.device_name);
          res.json({ success: true, message: '设备已删除' });
        } else {
          res.status(404).json({ success: false, message: '设备未找到' });
        }
      }
    }
  ],

  ws: {
    device: [(ws, req, Bot) => {
      BotUtil.makeLog('info', `[WebSocket] 新设备连接来自 ${req.socket.remoteAddress}`, 'DeviceManager');
      ws.on('message', msg => {
        try {
          const data = JSON.parse(msg);
          deviceManager.processWebSocketMessage(ws, data, Bot);
        } catch (error) {
          BotUtil.makeLog('error', `[WebSocket 解析失败] ${error.message}`, 'DeviceManager');
        }
      });
      ws.on('close', () => {
        if (ws.device_id) {
          clearInterval(ws.heartbeat);
          deviceWebSockets.delete(ws.device_id);
          const device = devices.get(ws.device_id);
          if (device) {
            BotUtil.makeLog('info', `[WebSocket] 设备 ${device.device_name} 断开连接`, device.device_name);
          }
        }
      });
      ws.on('error', (error) => {
        BotUtil.makeLog('error', `[WebSocket 错误] ${error.message}`, 'DeviceManager');
      });
    }]
  },

  init(app, Bot) {
    setInterval(() => {
      deviceManager.checkOfflineDevices(Bot);
    }, 30000);
    setInterval(() => {
      const now = Date.now();
      for (const [id, callback] of commandCallbacks) {
        if (now - parseInt(id) > 60000) {
          commandCallbacks.delete(id);
        }
      }
      for (const [deviceId, logs] of deviceLogs) {
        if (logs.length > deviceManager.maxLogsPerDevice) {
          logs.length = deviceManager.maxLogsPerDevice;
        }
      }
      const onlineCount = [...devices.values()].filter(d => d.online).length;
      BotUtil.makeLog('debug', `[设备管理器] 在线设备: ${onlineCount}/${devices.size}`, 'DeviceManager');
    }, 60000);
  }
};