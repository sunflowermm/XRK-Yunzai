import cfg from '../config/config.js';
import WebSocket from 'ws';
import BotUtil from '../util.js';

// 数据存储
const devices = new Map();
const deviceCommands = new Map();
const deviceData = new Map();
const deviceWebSockets = new Map();
const deviceLogs = new Map();
const commandCallbacks = new Map();

class DeviceManager {
  /**
   * 设备管理器类。
   *
   * 使用方法：
   * - 初始化: const manager = new DeviceManager();
   * - 注册设备: await manager.registerDevice(deviceData, Bot, ws);
   * - 发送命令: await manager.sendCommand(deviceId, command, parameters, priority);
   * - 处理事件: await manager.processDeviceEvent(deviceId, eventType, eventData, Bot);
   * - 获取设备列表: manager.getDeviceList();
   */
  constructor() {
    this.heartbeatInterval = cfg.device?.heartbeat_interval || 30;
    this.heartbeatTimeout = cfg.device?.heartbeat_timeout || 120;
    this.maxDevices = cfg.device?.max_devices || 100;
    this.commandTimeout = cfg.device?.command_timeout || 5000;
    this.maxLogsPerDevice = 100;
    this.maxDataPerDevice = 50;
    this.batchSize = 10;
  }

  // Unicode编码（发送到设备）
  encodeUnicode(str) {
    if (typeof str !== 'string') return str;
    return str.split('').map(char => {
      const code = char.charCodeAt(0);
      return code > 127 ? '\\u' + ('0000' + code.toString(16)).slice(-4) : char;
    }).join('');
  }

  // Unicode解码（从设备接收）
  decodeUnicode(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/\\u([0-9a-fA-F]{4})/g, (match, p1) => {
      return String.fromCharCode(parseInt(p1, 16));
    });
  }

  // 递归编码
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

  // 递归解码
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

  // 创建设备Bot实例
  createDeviceBot(deviceId, deviceInfo, ws) {
    const data = { 
      self_id: deviceId,
      device_id: deviceId,
      bot: null
    };
    
    Bot[deviceId] = {
      adapter: this,
      ws: ws,
      uin: deviceId,
      nickname: deviceInfo.device_name,
      avatar: null,
      
      // 设备信息
      info: deviceInfo,
      device_type: deviceInfo.device_type,
      capabilities: deviceInfo.capabilities || [],
      metadata: deviceInfo.metadata || {},
      
      // 状态
      online: true,
      last_seen: Date.now(),
      stats: {
        messages_sent: 0,
        messages_received: 0,
        commands_executed: 0,
        errors: 0
      },
      
      // 日志系统
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
      
      // 数据存储
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
      
      // 发送消息
      sendMsg: async (msg) => {
        return await this.sendMessage(deviceId, msg);
      },
      
      // 发送命令 - 优化版
      sendCommand: async (cmd, params = {}, priority = 0) => {
        return await this.sendCommand(deviceId, cmd, params, priority);
      },
      
      // 显示到屏幕 - 增强参数
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
      
      // 发送数据到服务器
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
      
      // 批量命令
      batch: async (commands) => {
        const results = [];
        for (const cmd of commands) {
          results.push(await this.sendCommand(
            deviceId,
            cmd.command,
            cmd.parameters,
            cmd.priority || 0
          ));
        }
        return results;
      },
      
      // 系统命令
      reboot: async () => {
        return await this.sendCommand(deviceId, 'reboot', {}, 99);
      },
      
      gc: async () => {
        return await this.sendCommand(deviceId, 'gc');
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
      },
      
      // 更新状态
      updateStatus: (status) => {
        const device = devices.get(deviceId);
        if (device) {
          device.status = { ...device.status, ...status };
          device.last_seen = Date.now();
        }
      },
      
      // 广播命令
      broadcast: async (command, params = {}) => {
        const results = {};
        for (const [id, device] of devices) {
          if (device.device_type === deviceInfo.device_type) {
            try {
              results[id] = await this.sendCommand(id, command, params);
            } catch (error) {
              results[id] = { success: false, error: error.message };
            }
          }
        }
        return results;
      },
      
      // Pick系列方法
      pickDevice: (targetId) => {
        return Bot[targetId] || null;
      }
    };
    
    data.bot = Bot[deviceId];
    return Bot[deviceId];
  }

  async registerDevice(deviceData, Bot, ws) {
    /**
     * 注册新设备。
     *
     * @param {Object} deviceData - 设备数据，包括device_id, device_type等。
     * @param {Object} Bot - Bot实例。
     * @param {WebSocket} ws - 可选WebSocket连接。
     * @returns {Object} 注册后的设备对象。
     */
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
      
      // 初始化日志
      if (!deviceLogs.has(device_id)) {
        deviceLogs.set(device_id, []);
      }
      
      // 注册WebSocket
      if (ws) {
        deviceWebSockets.set(device_id, ws);
        ws.device_id = device_id;
        
        // 心跳定时器
        ws.heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'heartbeat_request' }));
          }
        }, this.heartbeatInterval * 1000);
      }
      
      // 添加到Bot.uin
      if (!Bot.uin.includes(device_id)) {
        Bot.uin.push(device_id);
      }
      
      // 创建设备Bot实例
      const deviceBot = this.createDeviceBot(device_id, device, ws);
      
      BotUtil.makeLog('mark', `[设备注册] [INFO] ${device.device_name} (${device_id})`, device.device_name);
      BotUtil.makeLog('info', `[设备注册] [INFO] IP: ${ip_address}, 固件: v${firmware_version}`, device.device_name);
      BotUtil.makeLog('info', `[设备注册] [INFO] 能力: ${capabilities.join(', ')}`, device.device_name);
      
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
      BotUtil.makeLog('error', `[设备注册] [ERROR] 失败: ${error.message}`, 'DeviceManager');
      throw error;
    }
  }

  addDeviceLog(deviceId, level, message, data = {}) {
    /**
     * 添加设备日志，并标准化输出。
     *
     * @param {string} deviceId - 设备ID。
     * @param {string} level - 日志级别 (info, error 等)。
     * @param {string} message - 日志消息。
     * @param {Object} data - 可选数据。
     * @returns {Object} 日志条目。
     */
    // 解码消息
    message = this.decodeUnicode(String(message));
    
    const logEntry = {
      timestamp: Date.now(),
      level,
      message: message.substring(0, 200),  // 增加长度限制
      data: data ? this.decodeData(data) : {}
    };
    
    const logs = deviceLogs.get(deviceId) || [];
    logs.unshift(logEntry);
    
    if (logs.length > this.maxLogsPerDevice) {
      logs.length = this.maxLogsPerDevice;
    }
    
    deviceLogs.set(deviceId, logs);
    
    if (Bot[deviceId]) {
      Bot[deviceId].logs = logs;
    }
    
    const device = devices.get(deviceId);
    if (device?.stats && level === 'error') {
      device.stats.errors++;
    }
    
    // 使用BotUtil.makeLog输出设备日志
    const deviceName = device?.device_name || deviceId;
    
    // 打印日志时，包含完整JSON
    BotUtil.makeLog(level, `[设备日志] [${level.toUpperCase()}] ${deviceName}: ${message} ${JSON.stringify(logEntry.data)}`, deviceName);
    
    return logEntry;
  }

  async processDeviceEvent(deviceId, eventType, eventData = {}, Bot) {
    /**
     * 处理设备事件。
     *
     * @param {string} deviceId - 设备ID。
     * @param {string} eventType - 事件类型。
     * @param {Object} eventData - 事件数据。
     * @param {Object} Bot - Bot实例。
     * @returns {Object} 处理结果。
     */
    try {
      eventData = this.decodeData(eventData);
      
      if (!devices.has(deviceId)) {
        if (eventType === 'register') {
          // 自动注册
          return await this.registerDevice({
            device_id: deviceId,
            ...eventData
          }, Bot);
        }
        return { success: false, error: '设备未注册' };
      }

      const device = devices.get(deviceId);
      device.last_seen = Date.now();
      device.online = true;
      device.stats.messages_received++;
      
      if (Bot[deviceId]) {
        Bot[deviceId].online = true;
        Bot[deviceId].last_seen = device.last_seen;
        Bot[deviceId].stats = device.stats;
      }

      // 打印事件日志，包括原生JSON
      BotUtil.makeLog('info', `[设备事件] [INFO] [${device.device_name}] [${eventType}] ${JSON.stringify(eventData)}`, device.device_name);

      // 处理不同类型的事件
      switch(eventType) {
        case 'log':
          const { level = 'info', message, data: logData } = eventData;
          this.addDeviceLog(deviceId, level, message, logData);
          break;
          
        case 'ble_scan_report':
          BotUtil.makeLog('mark', `[蓝牙扫描] [INFO] 发现 ${eventData.device_count} 个设备`, device.device_name);
          
          if (eventData.devices) {
            for (const ble of eventData.devices.slice(0, 3)) {
              BotUtil.makeLog('info', 
                `  └─ ${ble.name}: ${ble.rssi}dBm (${ble.estimated_distance}m) ` +
                `[平均:${ble.avg_rssi}dBm 最强:${ble.max_rssi}dBm]`, 
                device.device_name
              );
            }
          }
          
          const scanData = deviceData.get(deviceId) || [];
          scanData.push({
            type: 'ble_scan',
            timestamp: Date.now(),
            data: eventData
          });
          if (scanData.length > this.maxDataPerDevice) {
            scanData.shift();
          }
          deviceData.set(deviceId, scanData);
          break;
          
        case 'sensor_data':
          // 传感器数据
          BotUtil.makeLog('info', `[传感器] [INFO]: ${JSON.stringify(eventData)}`, device.device_name);
          break;
          
        case 'message':
          // 普通消息
          const { text, category = 'device' } = eventData;
          BotUtil.makeLog('info', `[${category}] [INFO]: ${text}`, device.device_name);
          break;
          
        default:
          if (eventType !== 'heartbeat' && eventType !== 'data') {
            BotUtil.makeLog('debug', `[${eventType}] [DEBUG] 事件`, device.device_name);
          }
      }

      // 命令结果回调
      if (eventType === 'command_result') {
        const { command_id } = eventData;
        const callback = commandCallbacks.get(command_id);
        if (callback) {
          callback(eventData.result);
          commandCallbacks.delete(command_id);
        }
      }

      // 触发事件
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

      return { success: true };
    } catch (error) {
      BotUtil.makeLog('error', `[设备事件] [ERROR] 处理失败: ${error.message}`, 'DeviceManager');
      return { success: false, error: error.message };
    }
  }

  async updateHeartbeat(deviceId, status = {}) {
    /**
     * 更新设备心跳。
     *
     * @param {string} deviceId - 设备ID。
     * @param {Object} status - 状态数据。
     * @returns {Object} 包含命令的响应。
     */
    const device = devices.get(deviceId);
    if (!device) return { commands: [] };

    device.last_seen = Date.now();
    device.online = true;
    
    status = this.decodeData(status);
    
    if (status) {
      device.status = { ...device.status, ...status };
      
      if (Bot[deviceId]) {
        Bot[deviceId].updateStatus(status);
      }
    }

    // 打印心跳日志，包括JSON
    BotUtil.makeLog('debug', `[设备心跳] [DEBUG] [${device.device_name}] ${JSON.stringify(status)}`, device.device_name);

    // 获取并清空命令队列
    const commands = deviceCommands.get(deviceId) || [];
    if (commands.length > 0) {
      const batch = commands.splice(0, this.batchSize);
      // 编码命令参数
      batch.forEach(cmd => {
        if (cmd.parameters) {
          cmd.parameters = this.encodeData(cmd.parameters);
        }
      });
      return { commands: batch };
    }

    return { commands: [] };
  }

  async sendCommand(deviceId, command, parameters = {}, priority = 0) {
    /**
     * 发送命令到设备。
     *
     * @param {string} deviceId - 设备ID。
     * @param {string} command - 命令类型。
     * @param {Object} parameters - 参数。
     * @param {number} priority - 优先级。
     * @returns {Object} 发送结果。
     */
    const device = devices.get(deviceId);
    if (!device) {
      throw new Error('设备未找到');
    }

    // 编码参数
    const encodedParams = this.encodeData(parameters);
    
    const cmd = {
      id: Date.now().toString(),
      command,
      parameters: encodedParams,
      priority,
      timestamp: Date.now()
    };

    // 打印命令日志，包括JSON
    BotUtil.makeLog('info', `[发送命令] [INFO] [${device.device_name}] [${command}] ${JSON.stringify(cmd)}`, device.device_name);

    // WebSocket推送 - 优化版
    const ws = deviceWebSockets.get(deviceId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          commandCallbacks.delete(cmd.id);
          resolve({ success: true, command_id: cmd.id, timeout: true });
        }, this.commandTimeout);
        
        commandCallbacks.set(cmd.id, (result) => {
          clearTimeout(timeout);
          // 打印命令结果
          BotUtil.makeLog('info', `[命令结果] [INFO] [${device.device_name}] [${command}] ${JSON.stringify(result)}`, device.device_name);
          resolve({ success: true, command_id: cmd.id, result });
        });
        
        ws.send(JSON.stringify({
          type: 'command',
          command: cmd
        }));
        
        device.stats.commands_executed++;
        if (Bot[deviceId]) {
          Bot[deviceId].stats.commands_executed++;
        }
      });
    }

    // 队列模式
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
    
    if (Bot[deviceId]) {
      Bot[deviceId].stats.commands_executed++;
    }

    return {
      success: true,
      command_id: cmd.id,
      queued: commands.length,
      method: 'queue'
    };
  }

  async sendMessage(deviceId, msg) {
    /**
     * 发送消息到设备（通过display命令）。
     *
     * @param {string} deviceId - 设备ID。
     * @param {string} msg - 消息文本。
     * @returns {Object} 发送结果。
     */
    return await this.sendCommand(deviceId, 'display', {
      text: typeof msg === 'string' ? msg : '设备消息',
      clear: true
    }, 1);
  }

  checkOfflineDevices(Bot) {
    /**
     * 检查离线设备并更新状态。
     *
     * @param {Object} Bot - Bot实例。
     */
    const timeout = this.heartbeatTimeout * 1000;
    const now = Date.now();

    for (const [id, device] of devices) {
      if (device.online && now - device.last_seen > timeout) {
        device.online = false;
        
        if (Bot[id]) {
          Bot[id].online = false;
        }
        
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

        BotUtil.makeLog('warn', `[设备离线] [WARN] 最后响应: ${new Date(device.last_seen).toLocaleTimeString()}`, device.device_name);
      }
    }
  }

  getDeviceList() {
    /**
     * 获取设备列表。
     *
     * @returns {Array} 设备数组。
     */
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
    /**
     * 获取特定设备。
     *
     * @param {string} deviceId - 设备ID。
     * @returns {Object|null} 设备对象。
     */
    return devices.get(deviceId);
  }

  getDeviceLogs(deviceId, filter = {}) {
    /**
     * 获取设备日志。
     *
     * @param {string} deviceId - 设备ID。
     * @param {Object} filter - 过滤条件 (level, since, limit)。
     * @returns {Array} 日志数组。
     */
    const logs = deviceLogs.get(deviceId) || [];
    let filtered = [...logs];
    
    if (filter.level) {
      filtered = filtered.filter(log => log.level === filter.level);
    }
    
    if (filter.since) {
      const sinceTime = new Date(filter.since).getTime();
      filtered = filtered.filter(log => log.timestamp >= sinceTime);
    }
    
    if (filter.limit) {
      filtered = filtered.slice(0, filter.limit);
    }
    
    return filtered;
  }

  async processWebSocketMessage(ws, data, Bot) {
    /**
     * 处理WebSocket消息。
     *
     * @param {WebSocket} ws - WebSocket连接。
     * @param {Object} data - 消息数据。
     * @param {Object} Bot - Bot实例。
     */
    try {
      data = this.decodeData(data);
      const { type, device_id, ...payload } = data;
      
      BotUtil.makeLog('info', `[WebSocket 接收] [INFO] [${device_id || ws.device_id}] [${type}] ${JSON.stringify(data)}`, 'DeviceManager');

      switch(type) {
        case 'register':
          const device = await this.registerDevice({
            device_id,
            ...payload
          }, Bot, ws);
          
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
          
          await this.processDeviceEvent(
            device_id || ws.device_id,
            eventType,
            eventData,
            Bot
          );
          
          ws.send(JSON.stringify({
            type: 'event_response',
            success: true
          }));
          break;
          
        case 'log':
          const { level = 'info', message, data: logData } = payload;
          this.addDeviceLog(device_id || ws.device_id, level, message, logData);
          
          ws.send(JSON.stringify({
            type: 'log_response',
            success: true
          }));
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
              ws.send(JSON.stringify({
                type: 'command',
                command: cmd
              }));
            }
          }
          
          ws.send(JSON.stringify({
            type: 'heartbeat_response',
            commands: []
          }));
          break;
          
        case 'command_result':
          const callback = commandCallbacks.get(payload.command_id);
          if (callback) {
            callback(payload.result);
            commandCallbacks.delete(payload.command_id);
          }
          break;
          
        default:
          ws.send(JSON.stringify({
            type: 'error',
            message: `Unknown type: ${type}`
          }));
      }
    } catch (error) {
      BotUtil.makeLog('error', `[WebSocket] [ERROR] 处理失败: ${error.message}`, 'DeviceManager');
      ws.send(JSON.stringify({
        type: 'error',
        message: error.message
      }));
    }
  }
}

const deviceManager = new DeviceManager();

// 创建设备适配器
export default {
  name: 'device',
  description: '设备管理API',
  manager: deviceManager,

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
          
          res.json({
            success: true,
            device_id: device.device_id,
            device_name: device.device_name
          });
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
          res.json({ 
            success: true, 
            commands: result.commands
          });
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
          const result = await deviceManager.processDeviceEvent(
            device_id, event_type, event_data, Bot
          );
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
        res.json({ 
          success: true, 
          devices,
          count: devices.length
        });
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
        res.json({ 
          success: true, 
          logs,
          count: logs.length
        });
      }
    },

    {
      method: 'POST',
      path: '/api/device/:deviceId/command',
      handler: async (req, res) => {
        try {
          const { deviceId } = req.params;
          const { command, parameters, priority } = req.body;
          
          const result = await deviceManager.sendCommand(
            deviceId, command, parameters, priority
          );
          res.json(result);
        } catch (error) {
          res.status(400).json({ success: false, message: error.message });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/device/:deviceId/display',
      handler: async (req, res) => {
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
          
          BotUtil.makeLog('info', `[设备删除] [INFO] ${device.device_name} (${deviceId})`, device.device_name);
          
          res.json({ success: true, message: '设备已删除' });
        } else {
          res.status(404).json({ success: false, message: '设备未找到' });
        }
      }
    }
  ],

  init(app, Bot) {
    /**
     * 初始化设备适配器，包括WebSocket处理和定时任务。
     *
     * @param {Object} app - 应用实例。
     * @param {Object} Bot - Bot实例。
     */
    if (!Array.isArray(Bot.wsf.device)) Bot.wsf.device = [];
    
    Bot.wsf.device.push((ws, req) => {
      BotUtil.makeLog('info', `[WebSocket] [INFO] 新设备连接来自 ${req.socket.remoteAddress}`, 'DeviceManager');
      
      ws.on('message', msg => {
        try {
          const data = JSON.parse(msg);
          deviceManager.processWebSocketMessage(ws, data, Bot);
        } catch (error) {
          BotUtil.makeLog('error', `[WebSocket] [ERROR] 解析失败: ${error.message}`, 'DeviceManager');
        }
      });
      
      ws.on('close', () => {
        if (ws.device_id) {
          clearInterval(ws.heartbeat);
          deviceWebSockets.delete(ws.device_id);
          const device = devices.get(ws.device_id);
          if (device) {
            deviceManager.addDeviceLog(ws.device_id, 'info', 'WebSocket连接关闭', {});
            BotUtil.makeLog('info', `[WebSocket] [INFO] 设备 ${device.device_name} 断开连接`, device.device_name);
          }
        }
      });
      
      ws.on('error', (error) => {
        BotUtil.makeLog('error', `[WebSocket] [ERROR] 错误: ${error.message}`, 'DeviceManager');
      });
    });

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
      BotUtil.makeLog('debug', `[设备管理器] [DEBUG] 定期清理完成 - 在线设备: ${onlineCount}/${devices.size}`, 'DeviceManager');
    }, 60000);
    
    BotUtil.makeLog('mark', '[设备管理器] [INFO] 初始化完成', 'DeviceManager');
    BotUtil.makeLog('info', `[设备管理器] [INFO] 配置: 心跳间隔=${deviceManager.heartbeatInterval}s, 超时=${deviceManager.heartbeatTimeout}s`, 'DeviceManager');
  }
};