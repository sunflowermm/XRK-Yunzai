/**
 * 火山引擎 ASR 客户端：实时流式语音识别
 */
import WebSocket from 'ws';
import zlib from 'zlib';
import { v4 as uuidv4 } from 'uuid';
import BotUtil from '../../util.js';

export default class VolcengineASRClient {
  constructor(deviceId, config, Bot) {
    this.deviceId = deviceId;
    this.config = config;
    this.Bot = Bot;
    this.ws = null;
    this.connected = false;
    this.connecting = false;
    this.connectId = uuidv4();
    this.sequence = 1;
    this.currentUtterance = null;
    this._idleTimer = null;
    this._pingTimer = null;
    this._pongTimer = null;
    this.reconnectAttempts = 0;
    this.performanceMetrics = { firstResultTime: null, audioStartTime: null };
  }

  _headers() {
    return {
      'X-Api-App-Key': this.config.appKey,
      'X-Api-Access-Key': this.config.accessKey,
      'X-Api-Resource-Id': this.config.resourceId,
      'X-Api-Connect-Id': this.connectId
    };
  }

  _protoHeader(messageType, messageFlags, serialization, compression) {
    const header = Buffer.alloc(4);
    header[0] = 0x11;
    header[1] = (messageType << 4) | messageFlags;
    header[2] = (serialization << 4) | compression;
    header[3] = 0x00;
    return header;
  }

  _fullClientRequest(audioInfo) {
    const cfg = this.config;
    const audioFormat = audioInfo?.format ?? cfg.format ?? 'pcm';
    const audioCodec = audioInfo?.codec ?? cfg.codec ?? 'raw';
    const rate = audioInfo?.rate ?? cfg.sampleRate ?? 16000;
    const bits = audioInfo?.bits ?? cfg.bits ?? 16;
    const channel = audioInfo?.channel ?? cfg.channel ?? cfg.channels ?? 1;
    const audioOptions = audioInfo?.audioOptions ?? {};
    const modelName = audioInfo?.modelName ?? cfg.modelName ?? 'bigmodel';
    const requestOptions = audioInfo?.requestOptions ?? {};

    const payload = {
      user: { uid: this.deviceId, platform: 'ESP32-S3' },
      audio: { format: audioFormat, codec: audioCodec, rate, bits, channel, ...audioOptions },
      request: {
        model_name: modelName,
        enable_itn: cfg.enableItn,
        enable_punc: cfg.enablePunc,
        enable_ddc: cfg.enableDdc,
        show_utterances: cfg.showUtterances,
        result_type: cfg.resultType,
        enable_accelerate_text: cfg.enableAccelerateText,
        accelerate_score: cfg.accelerateScore,
        end_window_size: cfg.endWindowSize,
        force_to_speech_time: cfg.forceToSpeechTime,
        ...requestOptions
      }
    };

    const json = JSON.stringify(payload);
    const gz = zlib.gzipSync(Buffer.from(json, 'utf-8'));
    const header = this._protoHeader(0x1, 0x0, 0x1, 0x1);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(gz.length, 0);
    return Buffer.concat([header, size, gz]);
  }

  _audioOnlyRequest(audioBuf, isLast = false) {
    const gz = zlib.gzipSync(audioBuf);
    const flags = isLast ? 0x2 : 0x1;
    const header = this._protoHeader(0x2, flags, 0x0, 0x1);
    const payloadSize = Buffer.alloc(4);
    payloadSize.writeUInt32BE(gz.length, 0);
    if (!isLast) {
      this.sequence++;
      if (this.sequence > 0xFFFFFFFF) this.sequence = 1;
      const seq = Buffer.alloc(4);
      seq.writeUInt32BE(this.sequence, 0);
      return Buffer.concat([header, seq, payloadSize, gz]);
    }
    return Buffer.concat([header, payloadSize, gz]);
  }

  _parse(data) {
    try {
      if (!data || data.length < 4) return null;
      const messageType = (data[1] >> 4) & 0x0F;
      const messageFlags = data[1] & 0x0F;
      const compression = data[2] & 0x0F;
      if (messageType === 0xF) {
        const errCode = data.readUInt32BE(4);
        const errSize = data.readUInt32BE(8);
        const msg = data.slice(12, 12 + errSize).toString('utf-8');
        return { type: 'error', errorCode: errCode, errorMessage: msg };
      }
      if (messageType === 0x9) {
        let offset = 4;
        if (messageFlags === 0x1 || messageFlags === 0x3) offset += 4;
        const size = data.readUInt32BE(offset);
        offset += 4;
        let payload = data.slice(offset, offset + size);
        if (compression === 0x1) payload = zlib.gunzipSync(payload);
        const result = JSON.parse(payload.toString('utf-8'));
        const isLast = messageFlags === 0x3 || messageFlags === 0x2;
        return { type: 'result', result, isLast };
      }
      return null;
    } catch {
      return null;
    }
  }

  _startPingTimer() {
    if (!this.config.wsPingIntervalMs) return;
    this._clearPingTimer();
    this._pingTimer = setInterval(() => {
      try {
        if (this.ws && this.connected) {
          this.ws.ping();
          this._startPongTimer();
        }
      } catch {}
    }, this.config.wsPingIntervalMs || 30000);
  }

  _clearPingTimer() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  _startPongTimer() {
    this._clearPongTimer();
    this._pongTimer = setTimeout(() => {
      BotUtil.makeLog('warn', '[ASR] Pong超时，断开连接', this.deviceId);
      if (this.ws) try { this.ws.terminate(); } catch {}
    }, this.config.wsPongTimeoutMs || 10000);
  }

  _clearPongTimer() {
    if (this._pongTimer) { clearTimeout(this._pongTimer); this._pongTimer = null; }
  }

  async _ensureConnected() {
    if (this.connected) return;
    if (this.connecting) {
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 30));
        if (this.connected) return;
      }
      throw new Error('连接超时');
    }
    this.connecting = true;
    try {
      await new Promise((resolve, reject) => {
        const connectTimeout = setTimeout(() => {
          this.connecting = false;
          reject(new Error('连接超时'));
        }, 8000);
        try {
          const ws = new WebSocket(this.config.wsUrl, { headers: this._headers(), handshakeTimeout: 8000 });
          this.ws = ws;
          ws.on('open', () => {
            clearTimeout(connectTimeout);
            this.connected = true;
            this.connecting = false;
            this.reconnectAttempts = 0;
            BotUtil.makeLog('debug', '⚡ [ASR] WebSocket已连接', this.deviceId);
            this._startPingTimer();
            resolve();
          });
          ws.on('message', (buf) => {
            const msg = this._parse(buf);
            if (!msg) return;
            if (msg.type === 'error') { this._handleError(msg); return; }
            if (msg.type === 'result') {
              if (!this.performanceMetrics.firstResultTime && this.performanceMetrics.audioStartTime) {
                this.performanceMetrics.firstResultTime = Date.now() - this.performanceMetrics.audioStartTime;
                BotUtil.makeLog('debug', `⚡ [ASR性能] 首字返回: ${this.performanceMetrics.firstResultTime}ms`, this.deviceId);
              }
              this._handleResult(msg.result, msg.isLast);
              if (msg.isLast) this._armIdleTimer();
            }
          });
          ws.on('pong', () => this._clearPongTimer());
          ws.on('error', (err) => {
            clearTimeout(connectTimeout);
            if (err.message.includes('401')) BotUtil.makeLog('error', '❌ [ASR] 认证失败(401): 请检查appKey和accessKey', this.deviceId);
            else BotUtil.makeLog('error', `❌ [ASR] WebSocket错误: ${err.message}`, this.deviceId);
            this.connected = false;
            this.connecting = false;
            this.currentUtterance = null;
            this._clearIdleTimer();
            this._clearPingTimer();
            this._clearPongTimer();
            reject(err);
          });
          ws.on('close', (code) => {
            BotUtil.makeLog('debug', `✓ [ASR] WebSocket关闭 (code=${code})`, this.deviceId);
            this.connected = false;
            this.connecting = false;
            this.currentUtterance = null;
            this._clearIdleTimer();
            this._clearPingTimer();
            this._clearPongTimer();
            if (code !== 1000 && this.reconnectAttempts < (this.config.wsMaxReconnectAttempts || 5)) this._scheduleReconnect();
          });
        } catch (e) {
          clearTimeout(connectTimeout);
          this.connecting = false;
          reject(e);
        }
      });
    } catch (e) {
      this.connecting = false;
      throw e;
    }
  }

  _scheduleReconnect() {
    this.reconnectAttempts++;
    const delay = Math.min((this.config.wsReconnectDelayMs || 2000) * this.reconnectAttempts, 10000);
    BotUtil.makeLog('warn', `[ASR] 将在${delay}ms后重连（第${this.reconnectAttempts}次）`, this.deviceId);
    setTimeout(() => {
      if (!this.connected && !this.connecting) this._ensureConnected().catch(e => BotUtil.makeLog('error', `❌ [ASR] 重连失败: ${e.message}`, this.deviceId));
    }, delay);
  }

  _handleError(msg) {
    if (msg.errorCode === 45000081) BotUtil.makeLog('warn', '⚠️ [ASR] 服务器超时，清理状态', this.deviceId);
    else if (msg.errorCode !== 45000000) BotUtil.makeLog('error', `❌ [ASR错误] ${msg.errorCode}: ${msg.errorMessage}`, this.deviceId);
    if (msg.errorCode === 45000000) this.sequence = 1;
    this.currentUtterance = null;
    this._armIdleTimer();
  }

  _handleResult(result, isLast) {
    const text = result?.result?.text ?? '';
    const duration = result?.audio_info?.duration ?? 0;
    if (!text) return;
    const sessionId = this.currentUtterance?.sessionId ?? null;
    BotUtil.makeLog('debug', isLast ? `✅ [ASR最终] "${text}" (${duration}ms)` : `⚡ [ASR中间] "${text}" (${duration}ms)`, this.deviceId);
    this.Bot.em('device.asr_result', {
      post_type: 'device',
      event_type: 'asr_result',
      device_id: this.deviceId,
      session_id: sessionId,
      text,
      is_final: !!isLast,
      duration,
      result: result?.result ?? result,
      self_id: this.deviceId,
      time: Math.floor(Date.now() / 1000)
    });
  }

  _armIdleTimer() {
    if (this.config.idleCloseMs > 0) {
      this._clearIdleTimer();
      this._idleTimer = setTimeout(() => {
        if (this.ws && this.connected && !this.currentUtterance) {
          BotUtil.makeLog('debug', '✓ [ASR] 空闲超时，关闭连接', this.deviceId);
          this.ws.close();
        }
      }, this.config.idleCloseMs);
    }
  }

  _clearIdleTimer() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }

  async beginUtterance(sessionId, audioInfo) {
    if (this.currentUtterance) await this.endUtterance();
    await this._ensureConnected();
    this._clearIdleTimer();
    this.performanceMetrics = { firstResultTime: null, audioStartTime: Date.now() };
    this.currentUtterance = { sessionId, startedAt: Date.now(), ending: false };
    this.sequence = 1;
    const fullReq = this._fullClientRequest({
      rate: audioInfo?.sample_rate || 16000,
      bits: audioInfo?.bits || 16,
      channel: audioInfo?.channels || 1,
      format: audioInfo?.format,
      codec: audioInfo?.codec,
      modelName: audioInfo?.modelName
    });
    this.ws.send(fullReq);
    BotUtil.makeLog('debug', `⚡ [ASR会话] 开始: ${sessionId}`, this.deviceId);
  }

  sendAudio(audioBuf) {
    if (!this.ws || !this.connected || !this.currentUtterance || this.currentUtterance.ending) return false;
    this.ws.send(this._audioOnlyRequest(audioBuf, false));
    return true;
  }

  async endUtterance() {
    if (!this.currentUtterance || this.currentUtterance.ending) return false;
    this.currentUtterance.ending = true;
    if (!this.ws || !this.connected) {
      this.currentUtterance = null;
      this._armIdleTimer();
      return false;
    }
    this.ws.send(this._audioOnlyRequest(Buffer.alloc(0), true));
    const sessionId = this.currentUtterance.sessionId;
    BotUtil.makeLog('debug', `✓ [ASR会话] 结束: ${sessionId}`, this.deviceId);
    setTimeout(() => {
      if (this.currentUtterance && this.currentUtterance.sessionId === sessionId) this.currentUtterance = null;
    }, 300);
    this._armIdleTimer();
    return true;
  }

  async destroy() {
    this._clearIdleTimer();
    this._clearPingTimer();
    this._clearPongTimer();
    if (this.currentUtterance && !this.currentUtterance.ending) await this.endUtterance();
    this.currentUtterance = null;
    this.sequence = 1;
    if (this.ws) {
      if (this.ws.readyState === 1) this.ws.close(1000, 'client destroy');
      else this.ws.terminate();
      this.ws = null;
    }
    this.connected = false;
    this.connecting = false;
    this.reconnectAttempts = 0;
  }
}
