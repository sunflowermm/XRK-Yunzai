import WebSocket from 'ws';
import BotUtil from '../../lib/common/util.js';
import StreamLoader from '../../lib/aistream/loader.js';
import fs from 'fs';
import path from 'path';
import cfg from '../../lib/config/config.js';
import {
    EMOTION_KEYWORDS,
    SUPPORTED_EMOTIONS
} from '../../components/config/deviceConfig.js';
import { normalizeEmotion } from '../../components/util/emotionUtil.js';
import {
    initializeDirectories,
    validateDeviceRegistration,
    generateCommandId,
    hasCapability,
    getAudioFileList
} from '../../components/util/deviceUtil.js';
import ASRFactory from '../../components/asr/ASRFactory.js';
import TTSFactory from '../../components/tts/TTSFactory.js';

const devices = new Map();
const deviceWebSockets = new Map();
const deviceLogs = new Map();
const deviceCommands = new Map();
const commandCallbacks = new Map();
const deviceStats = new Map();
const asrClients = new Map();
const ttsClients = new Map();
const asrSessions = new Map();

class DeviceManager {
    constructor() {
        this.cleanupInterval = null;
        const kuizaiConfig = cfg.kuizai || {};
        const systemConfig = cfg.device || {};
        this.AUDIO_SAVE_DIR = './data/wav';
        this.initializeDirectories();
        
        // 获取配置的辅助方法
        this.getAIConfig = () => {
            const kuizai = cfg.kuizai || {};
            return {
                enabled: kuizai.ai?.enabled !== false,
                baseUrl: kuizai.ai?.baseUrl || '',
                apiKey: kuizai.ai?.apiKey || '',
                chatModel: kuizai.ai?.chatModel || 'deepseek-r1-0528',
                temperature: kuizai.ai?.temperature || 0.8,
                max_tokens: kuizai.ai?.max_tokens || 2000,
                top_p: kuizai.ai?.top_p || 0.9,
                presence_penalty: kuizai.ai?.presence_penalty || 0.6,
                frequency_penalty: kuizai.ai?.frequency_penalty || 0.6,
                timeout: kuizai.ai?.timeout || 30000,
                displayDelay: kuizai.ai?.displayDelay || 1500,
                persona: kuizai.ai?.persona || '我是一个智能语音助手，可以听懂你说的话并做出回应。我会用简短的话语和表情与你交流。'
            };
        };
        
        this.getTTSConfig = () => {
            const kuizai = cfg.kuizai || {};
            return {
                enabled: kuizai.tts?.enabled !== false,
                provider: kuizai.tts?.provider || 'volcengine',
                wsUrl: kuizai.tts?.wsUrl || 'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
                appKey: kuizai.tts?.appKey || '',
                accessKey: kuizai.tts?.accessKey || '',
                resourceId: kuizai.tts?.resourceId || 'seed-tts-2.0',
                voiceType: kuizai.tts?.voiceType || 'zh_female_vv_uranus_bigtts',
                encoding: kuizai.tts?.encoding || 'pcm',
                sampleRate: kuizai.tts?.sampleRate || 16000,
                speechRate: kuizai.tts?.speechRate || 5,
                loudnessRate: kuizai.tts?.loudnessRate || 0,
                emotion: kuizai.tts?.emotion || 'happy',
                chunkMs: kuizai.tts?.chunkMs || 128,
                chunkDelayMs: kuizai.tts?.chunkDelayMs || 5
            };
        };
        
        this.getASRConfig = () => {
            const kuizai = cfg.kuizai || {};
            return {
                enabled: kuizai.asr?.enabled !== false,
                provider: kuizai.asr?.provider || 'volcengine',
                wsUrl: kuizai.asr?.wsUrl || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
                appKey: kuizai.asr?.appKey || '',
                accessKey: kuizai.asr?.accessKey || '',
                resourceId: kuizai.asr?.resourceId || 'volc.bigasr.sauc.duration',
                enableItn: kuizai.asr?.enableItn !== false,
                enablePunc: kuizai.asr?.enablePunc !== false,
                enableDdc: kuizai.asr?.enableDdc || false,
                showUtterances: kuizai.asr?.showUtterances !== false,
                resultType: kuizai.asr?.resultType || 'full',
                enableAccelerateText: kuizai.asr?.enableAccelerateText !== false,
                accelerateScore: kuizai.asr?.accelerateScore || 15,
                persistentWs: kuizai.asr?.persistentWs !== false,
                idleCloseMs: kuizai.asr?.idleCloseMs || 6000,
                endWindowSize: kuizai.asr?.endWindowSize || 350,
                forceToSpeechTime: kuizai.asr?.forceToSpeechTime || 500,
                maxAudioBufferSize: kuizai.asr?.maxAudioBufferSize || 30,
                asrFinalTextWaitMs: kuizai.asr?.asrFinalTextWaitMs || 1200
            };
        };
        
        this.getSystemConfig = () => {
            const deviceConfig = cfg.device || {};
            return {
                heartbeatInterval: deviceConfig.heartbeat_interval || 30,
                heartbeatTimeout: deviceConfig.heartbeat_timeout || 180,
                commandTimeout: deviceConfig.command_timeout || 10000,
                maxDevices: deviceConfig.max_devices || 100,
                maxLogsPerDevice: deviceConfig.max_logs_per_device || 100,
                messageQueueSize: deviceConfig.message_queue_size || 100,
                wsPingIntervalMs: 30000,
                wsPongTimeoutMs: 10000,
                wsReconnectDelayMs: 2000,
                wsMaxReconnectAttempts: 5,
                enableDetailedLogs: true,
                enablePerformanceLogs: true,
                audioSaveDir: './data/wav'
            };
        };
    }

    /**
     * 初始化目录
     */
    initializeDirectories() {
        initializeDirectories([this.AUDIO_SAVE_DIR]);
    }

    /**
     * 获取ASR客户端（懒加载）
     * @param {string} deviceId - 设备ID
     * @returns {Object} ASR客户端
     * @private
     */
    _getASRClient(deviceId) {
        let client = asrClients.get(deviceId);
        if (!client) {
            client = ASRFactory.createClient(deviceId, this.getASRConfig(), Bot);
            asrClients.set(deviceId, client);
        }
        return client;
    }

    /**
     * 获取TTS客户端（懒加载）
     * @param {string} deviceId - 设备ID
     * @returns {Object} TTS客户端
     * @private
     */
    _getTTSClient(deviceId) {
        let client = ttsClients.get(deviceId);
        if (!client) {
            client = TTSFactory.createClient(deviceId, this.getTTSConfig(), Bot);
            ttsClients.set(deviceId, client);
        }
        return client;
    }

    /**
     * 处理ASR会话开始
     * @param {string} deviceId - 设备ID
     * @param {Object} data - 会话数据
     * @returns {Promise<Object>} 处理结果
     */
    async handleASRSessionStart(deviceId, data) {
        try {
            const { session_id, sample_rate, bits, channels, session_number } = data;

            BotUtil.makeLog('info',
                `⚡ [ASR会话#${session_number}] 开始: ${session_id}`,
                deviceId
            );

            if (!this.getASRConfig().enabled) {
                return { success: false, error: 'ASR未启用' };
            }

            asrSessions.set(session_id, {
                deviceId,
                sample_rate,
                bits,
                channels,
                sessionNumber: session_number,
                startTime: Date.now(),
                lastChunkTime: Date.now(),
                totalChunks: 0,
                totalBytes: 0,
                audioBuffers: [],
                asrStarted: false,
                endingChunks: 0,
                earlyEndSent: false,
                finalText: null,
                finalDuration: 0,
                finalTextSetAt: null
            });

            const client = this._getASRClient(deviceId);
            try {
                await client.beginUtterance(session_id, {
                    sample_rate,
                    bits,
                    channels
                });
                asrSessions.get(session_id).asrStarted = true;
            } catch (e) {
                BotUtil.makeLog('error',
                    `❌ [ASR] 启动utterance失败: ${e.message}`,
                    deviceId
                );
                return { success: false, error: e.message };
            }

            return { success: true, session_id };

        } catch (e) {
            BotUtil.makeLog('error',
                `❌ [ASR会话] 启动失败: ${e.message}`,
                deviceId
            );
            return { success: false, error: e.message };
        }
    }

    /**
     * 处理ASR音频块
     * @param {string} deviceId - 设备ID
     * @param {Object} data - 音频数据
     * @returns {Promise<Object>} 处理结果
     */
    async handleASRAudioChunk(deviceId, data) {
        try {
            const { session_id, chunk_index, data: audioHex, vad_state } = data;

            const session = asrSessions.get(session_id);
            if (!session) {
                return { success: false, error: '会话不存在' };
            }

            const audioBuf = Buffer.from(audioHex, 'hex');

            session.totalChunks++;
            session.totalBytes += audioBuf.length;
            session.lastChunkTime = Date.now();
            session.audioBuffers.push(audioBuf);

            if (session.asrStarted && (vad_state === 'active' || vad_state === 'ending')) {
                const client = this._getASRClient(deviceId);
                if (client.connected && client.currentUtterance && !client.currentUtterance.ending) {
                    client.sendAudio(audioBuf);

                    if (vad_state === 'ending') {
                        session.endingChunks = (session.endingChunks || 0) + 1;

                        if (session.endingChunks >= 2 && !session.earlyEndSent) {
                            session.earlyEndSent = true;

                            BotUtil.makeLog('info',
                                `⚡ [ASR] 检测到ending×${session.endingChunks}，提前结束`,
                                deviceId
                            );

                            setTimeout(async () => {
                                try {
                                    await client.endUtterance();
                                } catch (e) {
                                    BotUtil.makeLog('error',
                                        `❌ [ASR] 提前结束失败: ${e.message}`,
                                        deviceId
                                    );
                                }
                            }, 50);
                        }
                    } else {
                        session.endingChunks = 0;
                        session.earlyEndSent = false;
                    }
                }
            }

            return { success: true, received: chunk_index };

        } catch (e) {
            BotUtil.makeLog('error',
                `❌ [ASR] 处理音频块失败: ${e.message}`,
                deviceId
            );
            return { success: false, error: e.message };
        }
    }

    /**
     * 处理ASR会话停止（优化版 - 不等待最终文本）
     * @param {string} deviceId - 设备ID
     * @param {Object} data - 会话数据
     * @returns {Promise<Object>} 处理结果
     */
    async handleASRSessionStop(deviceId, data) {
        try {
            const { session_id, duration, session_number } = data;

            BotUtil.makeLog('info',
                `✓ [ASR会话#${session_number}] 停止: ${session_id} (时长=${duration}s)`,
                deviceId
            );

            const session = asrSessions.get(session_id);
            if (!session) {
                return { success: true };
            }

            // 避免重复处理同一会话停止
            if (session.stopped) {
                return { success: true };
            }
            session.stopped = true;

            if (session.asrStarted) {
                const client = this._getASRClient(deviceId);

                if (!session.earlyEndSent) {
                    try {
                        await client.endUtterance();
                        BotUtil.makeLog('info',
                            `✓ [ASR会话#${session_number}] Utterance已结束`,
                            deviceId
                        );
                    } catch (e) {
                        BotUtil.makeLog('warn',
                            `⚠️ [ASR] 结束utterance失败: ${e.message}`,
                            deviceId
                        );
                    }
                }
            }

            // ⭐ 关键改进：异步等待最终文本，不阻塞流程
            this._waitForFinalTextAsync(deviceId, session);

            return { success: true };

        } catch (e) {
            BotUtil.makeLog('error',
                `❌ [ASR会话] 停止失败: ${e.message}`,
                deviceId
            );
            return { success: false, error: e.message };
        }
    }

    /**
     * 异步等待最终文本并处理AI（新增）
     * @param {string} deviceId - 设备ID
     * @param {Object} session - 会话对象
     * @private
     */
    async _waitForFinalTextAsync(deviceId, session) {
        const maxWaitMs = 3000;  // 最多等待3秒（减少等待时间）
        const checkIntervalMs = 50;
        let waitCount = 0;
        const maxChecks = Math.ceil(maxWaitMs / checkIntervalMs);

        while (!session.finalText && waitCount < maxChecks) {
            await new Promise(r => setTimeout(r, checkIntervalMs));
            waitCount++;
        }

        if (session.finalText) {
            const waitedMs = waitCount * checkIntervalMs;
            BotUtil.makeLog('info',
                `✅ [ASR最终] "${session.finalText}" (等待${waitedMs}ms)`,
                deviceId
            );

            // 将最终识别结果推送给前端设备
            try {
                const ws = deviceWebSockets.get(deviceId);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'asr_final',
                        device_id: deviceId,
                        session_id: session.session_id,
                        text: session.finalText
                    }));
                }
            } catch { }

            // 处理AI响应
            if (this.getAIConfig().enabled && session.finalText.trim()) {
                await this._processAIResponse(deviceId, session.finalText);
            }
        } else {
            BotUtil.makeLog('warn',
                `⚠️ [ASR] 等待最终结果超时(${maxWaitMs}ms)`,
                deviceId
            );
            
            // 超时也要通知设备端，避免卡住
            await this._sendAIError(deviceId);
        }

        // 清理会话
        asrSessions.delete(session.session_id);
    }

    /**
     * 处理AI响应（增强版：使用增强的device工作流，包含记忆、推理、润色）
     * @param {string} deviceId - 设备ID
     * @param {string} question - 用户问题
     * @returns {Promise<void>}
     * @private
     */
    async _processAIResponse(deviceId, question) {
        try {
            const startTime = Date.now();

            BotUtil.makeLog('info',
                `⚡ [AI] 开始处理: ${question.substring(0, 50)}${question.length > 50 ? '...' : ''}`,
                deviceId
            );

            const deviceStream = StreamLoader.getStream('device');
            if (!deviceStream) {
                BotUtil.makeLog('error', '❌ [AI] 设备工作流未加载', deviceId);
                await this._sendAIError(deviceId);
                return;
            }

            const deviceInfo = devices.get(deviceId);
            const deviceBot = Bot[deviceId];

            if (!deviceBot) {
                BotUtil.makeLog('error', '❌ [AI] 设备Bot未找到', deviceId);
                await this._sendAIError(deviceId);
                return;
            }

            const aiConfig = this.getAIConfig();
            // 使用增强的execute方法（包含记忆、推理、润色）
            const aiResult = await deviceStream.execute(
                deviceId,
                question,
                aiConfig,
                deviceInfo || {},
                aiConfig.persona,
                deviceBot  // 传递deviceBot实例
            );

            if (!aiResult) {
                BotUtil.makeLog('warn', '⚠️ [AI] 工作流返回空结果', deviceId);
                await this._sendAIError(deviceId);
                return;
            }

            const aiTime = Date.now() - startTime;
            BotUtil.makeLog('info', `⚡ [AI性能] 处理耗时: ${aiTime}ms`, deviceId);
            BotUtil.makeLog('info', `✅ [AI] 回复: ${aiResult.text || '(仅表情)'}`, deviceId);

            // 表情已由工作流处理
            if (aiResult.emotion) {
                await new Promise(r => setTimeout(r, 200));
                
                // 通过WebSocket发送表情更新给前端（通用接口，适用于所有设备）
                const ws = deviceWebSockets.get(deviceId);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    try {
                        ws.send(JSON.stringify({
                            type: 'emotion_update',
                            device_id: deviceId,
                            emotion: aiResult.emotion
                        }));
                    } catch (e) {
                        BotUtil.makeLog('warn', `[AI] 发送表情更新失败: ${e.message}`, deviceId);
                    }
                }
            }

            // 播放TTS（通用接口，适用于所有设备）
            if (aiResult.text && this.getTTSConfig().enabled) {
                try {
                    const ttsClient = this._getTTSClient(deviceId);
                    const success = await ttsClient.synthesize(aiResult.text);

                    if (success) {
                        BotUtil.makeLog('info', `🔊 [TTS] 语音合成已启动`, deviceId);
                    } else {
                        BotUtil.makeLog('error', `❌ [TTS] 语音合成失败`, deviceId);
                        await this._sendAIError(deviceId);
                    }
                } catch (e) {
                    BotUtil.makeLog('error', `❌ [TTS] 语音合成异常: ${e.message}`, deviceId);
                    await this._sendAIError(deviceId);
                }
            }

            // 显示文字
            if (aiResult.text) {
                try {
                    await deviceBot.display(aiResult.text, {
                        x: 0,
                        y: 0,
                        font_size: 16,
                        wrap: true,
                        spacing: 2
                    });
                    BotUtil.makeLog('info', `✓ [设备] 文字: ${aiResult.text}`, deviceId);
                } catch (e) {
                    BotUtil.makeLog('error', `❌ [设备] 文字显示失败: ${e.message}`, deviceId);
                }
            }

        } catch (e) {
            BotUtil.makeLog('error', `❌ [AI] 处理失败: ${e.message}`, deviceId);
            await this._sendAIError(deviceId);
        }
    }

    /**
     * 发送AI错误通知
     * @param {string} deviceId - 设备ID
     * @private
     */
    async _sendAIError(deviceId) {
        try {
            const deviceBot = Bot[deviceId];
            if (deviceBot && deviceBot.sendCommand) {
                await deviceBot.sendCommand('ai_error', {}, 1);
            }
        } catch (e) {
            BotUtil.makeLog('error', `❌ [AI] 发送错误通知失败: ${e.message}`, deviceId);
        }
    }

    /**
     * 初始化设备统计
     * @param {string} deviceId - 设备ID
     * @returns {Object} 统计对象
     */
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

    /**
     * 更新设备统计
     * @param {string} deviceId - 设备ID
     * @param {string} type - 统计类型
     */
    updateDeviceStats(deviceId, type) {
        const stats = deviceStats.get(deviceId);
        if (!stats) return;

        if (type === 'message') stats.total_messages++;
        if (type === 'command') stats.total_commands++;
        if (type === 'error') stats.total_errors++;
        if (type === 'heartbeat') stats.last_heartbeat = Date.now();
    }

    /**
     * 添加设备日志
     * @param {string} deviceId - 设备ID
     * @param {string} level - 日志级别
     * @param {string} message - 日志消息
     * @param {Object} data - 附加数据
     * @returns {Object} 日志条目
     */
    addDeviceLog(deviceId, level, message, data = {}) {
        message = String(message).substring(0, 500);

        const entry = {
            timestamp: Date.now(),
            level,
            message,
            data
        };

        const logs = deviceLogs.get(deviceId) || [];
        logs.unshift(entry);

        const systemConfig = this.getSystemConfig();
        if (logs.length > systemConfig.maxLogsPerDevice) {
            logs.length = systemConfig.maxLogsPerDevice;
        }

        deviceLogs.set(deviceId, logs);

        const device = devices.get(deviceId);
        if (device?.stats && level === 'error') {
            device.stats.errors++;
            this.updateDeviceStats(deviceId, 'error');
        }

        if (level !== 'debug' || systemConfig.enableDetailedLogs) {
            BotUtil.makeLog(level,
                `[${device?.device_name || deviceId}] ${message}`,
                device?.device_name || deviceId
            );
        }

        return entry;
    }

    /**
     * 获取设备日志
     * @param {string} deviceId - 设备ID
     * @param {Object} filter - 过滤条件
     * @returns {Array} 日志列表
     */
    getDeviceLogs(deviceId, filter = {}) {
        let logs = deviceLogs.get(deviceId) || [];

        if (filter.level) {
            logs = logs.filter(l => l.level === filter.level);
        }

        if (filter.since) {
            const timestamp = new Date(filter.since).getTime();
            logs = logs.filter(l => l.timestamp >= timestamp);
        }

        if (filter.limit) {
            logs = logs.slice(0, filter.limit);
        }

        return logs;
    }

    /**
     * 注册设备
     * @param {Object} deviceData - 设备数据
     * @param {Object} Bot - Bot实例
     * @param {WebSocket} ws - WebSocket连接
     * @returns {Promise<Object>} 设备对象
     */
    async registerDevice(deviceData, Bot, ws) {
        const {
            device_id,
            device_type,
            device_name,
            capabilities = [],
            metadata = {},
            ip_address,
            firmware_version
        } = deviceData;

        const validation = validateDeviceRegistration(deviceData);
        if (!validation.valid) {
            throw new Error(validation.error);
        }

        const existedDevice = devices.get(device_id);

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
            registered_at: existedDevice?.registered_at || Date.now(),
            stats: existedDevice?.stats || {
                messages_sent: 0,
                messages_received: 0,
                commands_executed: 0,
                errors: 0,
                reconnects: existedDevice ? existedDevice.stats.reconnects + 1 : 0
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

        // 只在非 Web 客户端或 IP 不为 undefined 时记录日志，减少噪音
        if (device_type !== 'webclient' || ip_address !== 'undefined') {
          BotUtil.makeLog('debug',
              `🟢 [设备上线] ${device.device_name} (${device_id})${ip_address && ip_address !== 'undefined' ? ` - IP: ${ip_address}` : ''}`,
              device.device_name
          );
        }

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
    }

    /**
     * 设置WebSocket连接
     * @param {string} deviceId - 设备ID
     * @param {WebSocket} ws - WebSocket实例
     */
    setupWebSocket(deviceId, ws) {
        const oldWs = deviceWebSockets.get(deviceId);
        if (oldWs && oldWs !== ws) {
            clearInterval(oldWs.heartbeatTimer);
            try {
                if (oldWs.readyState === 1) {
                    oldWs.close();
                } else {
                    oldWs.terminate();
                }
            } catch (e) {
                // 忽略错误
            }
        }

        ws.device_id = deviceId;
        ws.isAlive = true;
        ws.lastPong = Date.now();
        ws.messageQueue = [];

        ws.heartbeatTimer = setInterval(() => {
            if (!ws.isAlive) {
                this.handleDeviceDisconnect(deviceId, ws);
                return;
            }

            ws.isAlive = false;

            if (ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send(JSON.stringify({
                        type: 'heartbeat_request',
                        timestamp: Date.now()
                    }));
                } catch (e) {
                    // 忽略错误
                }
            }
        }, this.getSystemConfig().heartbeatInterval * 1000);

        ws.on('pong', () => {
            ws.isAlive = true;
            ws.lastPong = Date.now();
            this.updateDeviceStats(deviceId, 'heartbeat');
        });

        ws.on('error', (error) => {
            BotUtil.makeLog('error',
                `❌ [WebSocket错误] ${error.message}`,
                deviceId
            );
        });

        deviceWebSockets.set(deviceId, ws);
    }

    /**
     * 处理设备断开连接
     * @param {string} deviceId - 设备ID
     * @param {WebSocket} ws - WebSocket实例
     */
    handleDeviceDisconnect(deviceId, ws) {
        clearInterval(ws.heartbeatTimer);

        const device = devices.get(deviceId);
        if (device) {
            device.online = false;

            BotUtil.makeLog('debug',
                `🔴 [设备离线] ${device.device_name} (${deviceId})`,
                device.device_name
            );

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

    /**
     * 创建设备Bot实例
     * @param {string} deviceId - 设备ID
     * @param {Object} deviceInfo - 设备信息
     * @param {WebSocket} ws - WebSocket实例
     * @returns {Object} Bot实例
     */
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

            addLog: (level, message, data = {}) =>
                this.addDeviceLog(deviceId, level, message, data),

            getLogs: (filter = {}) => this.getDeviceLogs(deviceId, filter),

            clearLogs: () => deviceLogs.set(deviceId, []),

            sendMsg: async (msg) => {
                for (const [keyword, emotion] of Object.entries(EMOTION_KEYWORDS)) {
                    if (msg.includes(keyword)) {
                        return await deviceManager.sendCommand(
                            deviceId,
                            'display_emotion',
                            { emotion },
                            1
                        );
                    }
                }

                return await deviceManager.sendCommand(
                    deviceId,
                    'display',
                    {
                        text: msg,
                        x: 0,
                        y: 0,
                        font_size: 16,
                        wrap: true,
                        spacing: 2
                    },
                    1
                );
            },

            sendCommand: async (cmd, params = {}, priority = 0) => {
                return await deviceManager.sendCommand(deviceId, cmd, params, priority);
            },

            sendAudioChunk: (hex) => {
                const ws = deviceWebSockets.get(deviceId);
                if (ws && ws.readyState === WebSocket.OPEN && typeof hex === 'string' && hex.length > 0) {
                    const cmd = {
                        command: 'play_tts_audio',
                        parameters: { audio_data: hex },
                        priority: 1,
                        timestamp: Date.now()
                    };
                    try {
                        ws.send(JSON.stringify({ type: 'command', command: cmd }));
                    } catch (e) { }
                }
            },

            display: async (text, options = {}) => {
                return await deviceManager.sendCommand(
                    deviceId,
                    'display',
                    {
                        text,
                        x: options.x || 0,
                        y: options.y || 0,
                        font_size: options.font_size || 16,
                        wrap: options.wrap !== false,
                        spacing: options.spacing || 2
                    },
                    1
                );
            },

            emotion: async (emotionName) => {
                const normalized = normalizeEmotion(emotionName);
                if (!normalized) {
                    throw new Error(`未知表情: ${emotionName}`);
                }
                
                // 通过WebSocket发送表情更新（通用接口，适用于所有设备）
                const ws = deviceWebSockets.get(deviceId);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    try {
                        ws.send(JSON.stringify({
                            type: 'emotion_update',
                            device_id: deviceId,
                            emotion: normalized
                        }));
                    } catch (e) {
                        BotUtil.makeLog('warn', `[设备] 发送表情更新失败: ${e.message}`, deviceId);
                    }
                }
                
                return await deviceManager.sendCommand(
                    deviceId,
                    'display_emotion',
                    { emotion: normalized },
                    1
                );
            },

            clear: async () => {
                return await deviceManager.sendCommand(deviceId, 'display_clear', {}, 1);
            },

            camera: {
                startStream: async (options = {}) => {
                    return await deviceManager.sendCommand(deviceId, 'camera_start_stream', {
                        fps: options.fps || 10,
                        quality: options.quality || 12,
                        resolution: options.resolution || 'VGA'
                    }, 1);
                },
                stopStream: async () => {
                    return await deviceManager.sendCommand(deviceId, 'camera_stop_stream', {}, 1);
                },
                capture: async () => {
                    return await deviceManager.sendCommand(deviceId, 'camera_capture', {}, 1);
                },
            },

            microphone: {
                getStatus: async () => {
                    return await deviceManager.sendCommand(deviceId, 'microphone_status', {}, 0);
                },
                start: async () => {
                    return await deviceManager.sendCommand(deviceId, 'microphone_start', {}, 1);
                },
                stop: async () => {
                    return await deviceManager.sendCommand(deviceId, 'microphone_stop', {}, 1);
                },
            },

            reboot: async () => {
                return await deviceManager.sendCommand(deviceId, 'reboot', {}, 99);
            },

            hasCapability: (cap) => hasCapability(deviceInfo, cap),

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

            getStats: () =>
                deviceStats.get(deviceId) || this.initDeviceStats(deviceId)
        };

        return Bot[deviceId];
    }

    /**
     * 发送命令到设备
     * @param {string} deviceId - 设备ID
     * @param {string} command - 命令名称
     * @param {Object} parameters - 命令参数
     * @param {number} priority - 优先级
     * @returns {Promise<Object>} 命令结果
     */
    async sendCommand(deviceId, command, parameters = {}, priority = 0) {
        const device = devices.get(deviceId);
        if (!device) {
            throw new Error('设备未找到');
        }

        const cmd = {
            id: generateCommandId(),
            command,
            parameters,
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
                }, this.getSystemConfig().commandTimeout);

                commandCallbacks.set(cmd.id, (result) => {
                    clearTimeout(timeout);
                    resolve({ success: true, command_id: cmd.id, result });
                });

                try {
                    const cmdJson = JSON.stringify({ type: 'command', command: cmd });
                    BotUtil.makeLog('info', `[设备] 发送命令到 ${deviceId}: ${cmd.command}`, deviceId);
                    BotUtil.makeLog('debug', `[设备] 命令内容: ${cmdJson}`, deviceId);
                    ws.send(cmdJson);
                    device.stats.commands_executed++;
                } catch (e) {
                    BotUtil.makeLog('error', `[设备] 发送命令失败: ${e.message}`, deviceId);
                    clearTimeout(timeout);
                    commandCallbacks.delete(cmd.id);
                    resolve({ success: false, command_id: cmd.id, error: e.message });
                }
            });
        }

        const queue = deviceCommands.get(deviceId) || [];
        if (priority > 0) {
            queue.unshift(cmd);
        } else {
            queue.push(cmd);
        }

        const systemConfig = this.getSystemConfig();
        if (queue.length > systemConfig.messageQueueSize) {
            queue.length = systemConfig.messageQueueSize;
        }

        deviceCommands.set(deviceId, queue);
        device.stats.commands_executed++;

        return { success: true, command_id: cmd.id, queued: queue.length };
    }

    /**
     * 处理设备事件
     * @param {string} deviceId - 设备ID
     * @param {string} eventType - 事件类型
     * @param {Object} eventData - 事件数据
     * @param {Object} Bot - Bot实例
     * @returns {Promise<Object>} 处理结果
     */
    async processDeviceEvent(deviceId, eventType, eventData = {}, Bot) {
        try {
            if (!devices.has(deviceId)) {
                if (eventType === 'register') {
                    return await this.registerDevice(
                        { device_id: deviceId, ...eventData },
                        Bot
                    );
                }
                return { success: false, error: '设备未注册' };
            }

            const device = devices.get(deviceId);
            device.last_seen = Date.now();
            device.online = true;
            device.stats.messages_received++;

            this.updateDeviceStats(deviceId, 'message');

            switch (eventType) {
                case 'log': {
                    const { level = 'info', message, data: logData } = eventData;
                    this.addDeviceLog(deviceId, level, message, logData);
                    break;
                }

                case 'command_result': {
                    const { command_id, result } = eventData;
                    const callback = commandCallbacks.get(command_id);
                    if (callback) {
                        callback(result);
                        commandCallbacks.delete(command_id);
                    }
                    break;
                }

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

        } catch (e) {
            this.updateDeviceStats(deviceId, 'error');
            return { success: false, error: e.message };
        }
    }

    /**
     * 处理WebSocket消息
     * @param {WebSocket} ws - WebSocket实例
     * @param {Object} data - 消息数据
     * @param {Object} Bot - Bot实例
     * @returns {Promise<void>}
     */
    async processWebSocketMessage(ws, data, Bot) {
        try {
            const { type, device_id, ...payload } = data;
            const deviceId = device_id || ws.device_id || 'unknown';

            if (type !== 'heartbeat' && type !== 'asr_audio_chunk') {
                BotUtil.makeLog('info',
                    `📨 [WebSocket] 收到消息: type="${type}", device_id="${deviceId}"`,
                    deviceId
                );
            }

            if (!type) {
                BotUtil.makeLog('error',
                    `❌ [WebSocket] 消息格式错误，缺少type字段`,
                    deviceId
                );
                ws.send(JSON.stringify({
                    type: 'error',
                    message: '消息格式错误：缺少type字段'
                }));
                return;
            }

            switch (type) {
                case 'register': {
                    BotUtil.makeLog('info', `🔌 [WebSocket] 设备注册请求`, deviceId);
                    const device = await this.registerDevice(
                        { device_id: deviceId, ...payload },
                        Bot,
                        ws
                    );
                    ws.send(JSON.stringify({
                        type: 'register_response',
                        success: true,
                        device
                    }));
                    break;
                }

                case 'event':
                case 'data': {
                    const eventType = payload.data_type || payload.event_type || type;
                    const eventData = payload.data || payload.event_data || payload;
                    await this.processDeviceEvent(deviceId, eventType, eventData, Bot);
                    break;
                }

                case 'asr_session_start':
                case 'asr_audio_chunk':
                case 'asr_session_stop':
                    await this.processDeviceEvent(deviceId, type, payload, Bot);
                    break;

                case 'log': {
                    const { level = 'info', message, data: logData } = payload;
                    this.addDeviceLog(deviceId, level, message, logData);
                    break;
                }

                case 'heartbeat': {
                    ws.isAlive = true;
                    ws.lastPong = Date.now();

                    const device = devices.get(deviceId);
                    if (device) {
                        device.last_seen = Date.now();
                        device.online = true;
                        if (payload.status) {
                            device.status = payload.status;
                        }
                    }

                    this.updateDeviceStats(deviceId, 'heartbeat');

                    const queued = deviceCommands.get(deviceId) || [];
                    const toSend = queued.splice(0, 3);

                    ws.send(JSON.stringify({
                        type: 'heartbeat_response',
                        commands: toSend,
                        timestamp: Date.now()
                    }));
                    break;
                }

                case 'command_result':
                    await this.processDeviceEvent(deviceId, type, payload, Bot);
                    break;

                default:
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: `未知消息类型: ${type}`
                    }));
            }
        } catch (e) {
            BotUtil.makeLog('error',
                `❌ [WebSocket] 处理消息失败: ${e.message}`,
                ws.device_id
            );
            try {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: e.message
                }));
            } catch (sendErr) {
                // 忽略发送错误
            }
        }
    }

    /**
     * 检查离线设备
     * @param {Object} Bot - Bot实例
     */
    checkOfflineDevices(Bot) {
        const timeout = this.getSystemConfig().heartbeatTimeout * 1000;
        const now = Date.now();

        for (const [id, device] of devices) {
            if (device.online && now - device.last_seen > timeout) {
                const ws = deviceWebSockets.get(id);

                if (ws) {
                    this.handleDeviceDisconnect(id, ws);
                } else {
                    device.online = false;

                    BotUtil.makeLog('debug',
                        `🔴 [设备离线] ${device.device_name} (${id})`,
                        device.device_name
                    );

                    Bot.em('device.offline', {
                        post_type: 'device',
                        event_type: 'offline',
                        device_id: id,
                        device_type: device.device_type,
                        device_name: device.device_name,
                        self_id: id,
                        time: Math.floor(Date.now() / 1000)
                    });
                }
            }
        }
    }

    /**
     * 获取设备列表
     * @returns {Array} 设备列表
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
     * @param {string} deviceId - 设备ID
     * @returns {Object|null} 设备信息
     */
    getDevice(deviceId) {
        const device = devices.get(deviceId);
        if (!device) return null;

        return {
            ...device,
            device_stats: deviceStats.get(deviceId)
        };
    }
}

const deviceManager = new DeviceManager();

export { deviceWebSockets, deviceManager };

export function getTTSClientForDevice(deviceId) {
    return deviceManager._getTTSClient(deviceId);
}

export default {
    name: 'device',
    dsc: '设备管理API v31.0 - 连续对话优化版',
    priority: 90,

    routes: [
        {
            method: 'POST',
            path: '/api/device/register',
            handler: async (req, res, Bot) => {
                try {
                    const device = await deviceManager.registerDevice(
                        {
                            ...req.body,
                            ip_address: req.ip || req.socket.remoteAddress
                        },
                        Bot
                    );
                    res.json({ success: true, device_id: device.device_id });
                } catch (e) {
                    res.status(400).json({ success: false, message: e.message });
                }
            }
        },

        {
            method: 'POST',
            path: '/api/device/:deviceId/ai',
            handler: async (req, res, Bot) => {
                try {
                    const deviceId = req.params.deviceId;
                    const { text } = req.body || {};
                    if (!text || !String(text).trim()) {
                        return res.status(400).json({ success: false, message: '缺少文本内容' });
                    }
                    const device = deviceManager.getDevice(deviceId);
                    if (!device) {
                        return res.status(404).json({ success: false, message: '设备未找到' });
                    }
                    if (!deviceManager.getAIConfig().enabled) {
                        return res.status(400).json({ success: false, message: 'AI未启用' });
                    }
                    await deviceManager._processAIResponse(deviceId, String(text));
                    return res.json({ success: true });
                } catch (e) {
                    return res.status(500).json({ success: false, message: e.message });
                }
            }
        },

        {
            method: 'GET',
            path: '/api/ai/stream',
            handler: async (req, res, Bot) => {
                res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.flushHeaders?.();
                
                try {
                    const prompt = (req.query.prompt || '').toString();
                    if (!prompt) {
                        res.write(`data: ${JSON.stringify({ error: '缺少prompt参数' })}\n\n`);
                        res.end();
                        return;
                    }

                    const persona = (req.query.persona || '').toString();
                    const workflow = (req.query.workflow || 'device').toString();
                    let context = [];
                    try {
                        const contextParam = req.query.context;
                        if (contextParam) {
                            context = JSON.parse(contextParam);
                        }
                    } catch (e) {
                        BotUtil.makeLog('warn', `解析context参数失败: ${e.message}`, 'AIStream');
                    }

                    if (!StreamLoader.loaded && !StreamLoader._loadingPromise) {
                        await StreamLoader.load();
                    } else if (StreamLoader._loadingPromise) {
                        await StreamLoader._loadingPromise;
                    }

                    const stream = StreamLoader.getStream(workflow);
                    if (!stream) {
                        res.write(`data: ${JSON.stringify({ error: `工作流 ${workflow} 未加载` })}\n\n`);
                        res.end();
                        return;
                    }

                    // 从请求中获取设备ID，默认为webclient（兼容旧版本）
                    const deviceId = req.query.deviceId || req.headers['x-device-id'] || 'webclient';
                    const deviceBot = Bot[deviceId];
                    const device = devices.get(deviceId);
                    const e = {
                        device_id: deviceId,
                        user_id: device?.user_id || `${deviceId}_user`,
                        self_id: deviceId
                    };

                    // 如果前端传递了context，使用它构建消息；否则使用工作流的buildChatContext
                    let messages;
                    if (Array.isArray(context) && context.length > 0) {
                        // 使用前端传递的上下文，转换为工作流需要的格式
                        messages = await stream.buildChatContext(e, { 
                            text: prompt, 
                            persona,
                            deviceId: deviceId,
                            history: context // 传递历史上下文
                        });
                    } else {
                        // 没有上下文，使用默认方式构建
                        messages = await stream.buildChatContext(e, { 
                            text: prompt, 
                            persona,
                            deviceId: deviceId
                        });
                    }
                    
                    let acc = '';
                    
                    await stream.callAIStream(messages, stream.config, (delta) => {
                        acc += delta;
                        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
                    });

                    const finalText = acc.trim();
                    
                    // 先解析表情并移除表情标记（和chat.js一样）
                    const { emotion, cleanText: rawCleanText } = stream.parseEmotion(finalText);
                    
                    // 使用cleanText（已移除表情标记），如果没有cleanText则使用原始文本
                    let displayText = (rawCleanText && rawCleanText.trim()) || finalText.trim();
                    
                    // 润色（可选，对已移除表情标记的文本进行润色）
                    if (stream.responsePolishConfig?.enabled && displayText) {
                        displayText = await stream.polishResponse(displayText, persona).catch(() => displayText);
                    }

                    res.write(`data: ${JSON.stringify({ done: true, text: displayText })}\n\n`);

                    // 检查是否为本地访问（127.0.0.1 或 localhost）
                    const clientIp = req.ip || req.socket?.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || '';
                    const isLocalhost = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1' || 
                                       req.headers.host?.includes('localhost') || req.headers.host?.includes('127.0.0.1');

                    // 处理表情：适用于所有设备
                    if (emotion && deviceBot?.emotion) {
                        try {
                            await deviceBot.emotion(emotion);
                            
                            // 通过WebSocket发送表情更新给前端（通用接口，适用于所有设备）
                            const ws = deviceWebSockets.get(deviceId);
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({
                                    type: 'emotion_update',
                                    device_id: deviceId,
                                    emotion: emotion
                                }));
                            }
                        } catch (e) {
                            BotUtil.makeLog('error', `[AI流式] 表情切换失败: ${e.message}`, 'AIStream');
                        }
                    }

                    // TTS处理：只有本地访问时才调用（适用于所有设备）
                    const ttsConfig = deviceManager.getTTSConfig();
                    if (isLocalhost && ttsConfig.enabled && displayText && deviceBot) {
                        try {
                            const ttsClient = getTTSClientForDevice(deviceId);
                            if (ttsClient) {
                                await ttsClient.synthesize(displayText);
                            }
                        } catch (e) {
                            BotUtil.makeLog('error', `[AI流式] TTS合成失败: ${e.message}`, 'AIStream');
                        }
                    }

                    // 记忆系统（通用接口）
                    if (displayText && stream.getMemorySystem()?.isEnabled() && prompt.length > 10) {
                        const memorySystem = stream.getMemorySystem();
                        const { ownerId, scene } = memorySystem.extractScene(e);
                        memorySystem.remember({
                            ownerId,
                            scene,
                            layer: 'short',
                            content: `用户: ${prompt.substring(0, 100)} | 助手: ${displayText.substring(0, 100)}`,
                            metadata: { deviceId: deviceId, type: 'conversation' },
                            authorId: deviceId
                        }).catch(() => {});
                    }
                    
                    res.end();
                } catch (e) {
                    try {
                        if (!res.headersSent) {
                            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                            res.setHeader('Cache-Control', 'no-cache');
                            res.setHeader('Connection', 'keep-alive');
                            res.flushHeaders?.();
                        }
                        res.write(`data: ${JSON.stringify({ error: e.message || '未知错误' })}\n\n`);
                        BotUtil.makeLog('error', `[AI流式] 错误: ${e.message}`, 'AIStream');
                    } catch (err) {}
                    res.end();
                }
            }
        },

        {
            method: 'GET',
            path: '/api/devices',
            handler: async (req, res) => {
                const list = deviceManager.getDeviceList();
                res.json({ success: true, devices: list, count: list.length });
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
                    .filter(([_, s]) => s.deviceId === req.params.deviceId)
                    .map(([sid, s]) => ({
                        session_id: sid,
                        device_id: s.deviceId,
                        session_number: s.sessionNumber,
                        total_chunks: s.totalChunks,
                        total_bytes: s.totalBytes,
                        started_at: s.startTime,
                        elapsed: ((Date.now() - s.startTime) / 1000).toFixed(1),
                    }));

                res.json({ success: true, sessions, count: sessions.length });
            }
        },

        {
            method: 'GET',
            path: '/api/device/:deviceId/asr/recordings',
            handler: async (req, res) => {
                try {
                    const recordings = await getAudioFileList(
                        deviceManager.AUDIO_SAVE_DIR,
                        req.params.deviceId
                    );

                    res.json({
                        success: true,
                        recordings,
                        count: recordings.length,
                        total_size: recordings.reduce((s, r) => s + r.size, 0)
                    });
                } catch (e) {
                    res.status(500).json({ success: false, message: e.message });
                }
            }
        },

        {
            method: 'GET',
            path: '/api/asr/recording/:filename',
            handler: async (req, res) => {
                try {
                    const filename = req.params.filename;

                    if (!filename.endsWith('.wav') || filename.includes('..')) {
                        return res.status(400).json({
                            success: false,
                            message: '无效的文件名'
                        });
                    }

                    // 使用path.resolve确保跨平台兼容
                    const filepath = path.resolve(deviceManager.AUDIO_SAVE_DIR, filename);

                    if (!fs.existsSync(filepath)) {
                        return res.status(404).json({
                            success: false,
                            message: '文件不存在'
                        });
                    }

                    res.setHeader('Content-Type', 'audio/wav');
                    res.setHeader(
                        'Content-Disposition',
                        `attachment; filename="${filename}"`
                    );

                    fs.createReadStream(filepath).pipe(res);
                } catch (e) {
                    res.status(500).json({ success: false, message: e.message });
                }
            }
        },

        {
            method: 'GET',
            path: '/api/ai/models',
            handler: async (req, res, Bot) => {
                if (!Bot.checkApiAuthorization(req)) {
                    return res.status(403).json({ success: false, message: 'Unauthorized' });
                }

                try {
                    const aiConfig = deviceManager.getAIConfig();
                    const StreamLoader = (await import('../../lib/aistream/loader.js')).default;
                    const allStreams = StreamLoader.getAllStreams();
                    
                    // 获取工作流列表
                    const workflows = allStreams.map(s => ({
                        name: s.name,
                        description: s.description || '',
                        enabled: s.config?.enabled || false
                    }));

                    // 构建模型配置（简化版，实际可以从配置中读取）
                    const profiles = [{
                        name: 'default',
                        displayName: '默认配置',
                        model: aiConfig.chatModel || 'deepseek-r1-0528',
                        baseUrl: aiConfig.baseUrl || '',
                        temperature: aiConfig.temperature || 0.8,
                        maxTokens: aiConfig.max_tokens || 2000
                    }];

                    res.json({
                        success: true,
                        enabled: aiConfig.enabled || false,
                        defaultProfile: 'default',
                        profiles,
                        workflows
                    });
                } catch (error) {
                    res.status(500).json({
                        success: false,
                        message: '获取AI模型列表失败',
                        error: error.message
                    });
                }
            }
        },
    ],

    ws: {
        device: [
            (ws, req, Bot) => {
                BotUtil.makeLog('info',
                    `🔌 [WebSocket] 新连接: ${req.socket.remoteAddress}`,
                    'DeviceManager'
                );

                ws.on('message', msg => {
                    try {
                        const data = JSON.parse(msg);
                        deviceManager.processWebSocketMessage(ws, data, Bot);
                    } catch (e) {
                        BotUtil.makeLog('error',
                            `❌ [WebSocket] 消息解析失败: ${e.message}`,
                            ws.device_id
                        );
                    }
                });

                ws.on('close', () => {
                    if (ws.device_id) {
                        deviceManager.handleDeviceDisconnect(ws.device_id, ws);
                    } else {
                        BotUtil.makeLog('info',
                            `✓ [WebSocket] 连接关闭: ${req.socket.remoteAddress}`,
                            'DeviceManager'
                        );
                    }
                });

                ws.on('error', (e) => {
                    BotUtil.makeLog('error',
                        `❌ [WebSocket] 错误: ${e.message}`,
                        ws.device_id || 'unknown'
                    );
                });
            }
        ]
    },

    init(app, Bot) {
        StreamLoader.configureEmbedding({
            enabled: false
        });

        deviceManager.cleanupInterval = setInterval(() => {
            deviceManager.checkOfflineDevices(Bot);
        }, 30000);

        setInterval(() => {
            const now = Date.now();
            for (const [id, _] of commandCallbacks) {
                const timestamp = parseInt(id.split('_')[0]);
                if (now - timestamp > 60000) {
                    commandCallbacks.delete(id);
                }
            }
        }, 60000);

        setInterval(() => {
            const now = Date.now();
            for (const [sessionId, session] of asrSessions) {
                if (now - session.lastChunkTime > 5 * 60 * 1000) {
                    try {
                        const client = asrClients.get(session.deviceId);
                        if (client) {
                            client.endUtterance().catch(() => { });
                        }
                    } catch (e) {
                        // 忽略错误
                    }
                    asrSessions.delete(sessionId);
                }
            }
        }, 5 * 60 * 1000);

        BotUtil.makeLog('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'DeviceManager');
        BotUtil.makeLog('info', '⚡ [设备管理器] v31.0 - 连续对话优化版', 'DeviceManager');

        const asrConfig = deviceManager.getASRConfig();
        if (asrConfig.enabled) {
            BotUtil.makeLog('info',
                `✓ [火山ASR] 已启用（提供商: ${asrConfig.provider}）`,
                'DeviceManager'
            );
        }

        const ttsConfig = deviceManager.getTTSConfig();
        if (ttsConfig.enabled) {
            BotUtil.makeLog('info',
                `✓ [火山TTS] 已启用（提供商: ${ttsConfig.provider}，语音: ${ttsConfig.voiceType}）`,
                'DeviceManager'
            );
        }

        const aiConfig = deviceManager.getAIConfig();
        if (aiConfig.enabled) {
            BotUtil.makeLog('info',
                `✓ [设备AI] 已启用（模型: ${aiConfig.chatModel}）`,
                'DeviceManager'
            );
        }

        // 订阅ASR结果事件：更新会话finalText并转发中间结果到前端
        try {
            Bot.on('device', (e) => {
                try {
                    if (!e || e.event_type !== 'asr_result') return;
                    const deviceId = e.device_id;
                    const sessionId = e.session_id;
                    const text = e.text || '';
                    const isFinal = !!e.is_final;
                    const duration = e.duration || 0;
                    const session = asrSessions.get(sessionId);
                    if (session && session.deviceId === deviceId) {
                        if (isFinal) {
                            session.finalText = text;
                            session.finalDuration = duration;
                            session.finalTextSetAt = Date.now();
                            // 立即将最终结果推送给前端
                            const ws = deviceWebSockets.get(deviceId);
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({
                                    type: 'asr_final',
                                    device_id: deviceId,
                                    session_id: sessionId,
                                    text
                                }));
                            }
                        } else if (text) {
                            // 中间结果实时转发到webclient
                            const ws = deviceWebSockets.get(deviceId);
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({
                                    type: 'asr_interim',
                                    device_id: deviceId,
                                    session_id: sessionId,
                                    text
                                }));
                            }
                        }
                    }
                } catch { }
            });
        } catch { }

        BotUtil.makeLog('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'DeviceManager');
    },

    destroy() {
        if (deviceManager.cleanupInterval) {
            clearInterval(deviceManager.cleanupInterval);
        }

        for (const [id, ws] of deviceWebSockets) {
            try {
                clearInterval(ws.heartbeatTimer);
                if (ws.readyState === 1) {
                    ws.close();
                } else {
                    ws.terminate();
                }
            } catch (e) {
                // 忽略错误
            }
        }

        for (const [deviceId, client] of asrClients) {
            try {
                client.destroy();
            } catch (e) {
                // 忽略错误
            }
        }

        for (const [deviceId, client] of ttsClients) {
            try {
                client.destroy();
            } catch (e) {
                // 忽略错误
            }
        }

        asrSessions.clear();
    }
};