/**
 * 火山引擎 TTS 客户端：V3 双向流式语音合成
 */
import WebSocket from 'ws';
import zlib from 'zlib';
import { v4 as uuidv4 } from 'uuid';
import BotUtil from '../../util.js';

export default class VolcengineTTSClient {
  constructor(deviceId, config, Bot) {
    this.deviceId = deviceId;
    this.config = config;
    this.Bot = Bot;
    this.ws = null;
    this.connected = false;
    this.connecting = false;
    this.connectId = uuidv4();
    this._idleTimer = null;
    this._pingTimer = null;
    this._pongTimer = null;
    this.reconnectAttempts = 0;
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

  _buildSynthesisRequest(text, options = {}) {
    const cfg = this.config;
    const voiceType = options.voiceType ?? cfg.voiceType ?? 'zh_female_vv_uranus_bigtts';
    const encoding = options.encoding ?? cfg.encoding ?? 'pcm';
    const sampleRate = options.sampleRate ?? cfg.sampleRate ?? 16000;
    const speechRate = options.speechRate ?? cfg.speechRate ?? 0;
    const volume = options.volume ?? cfg.volume ?? 50;
    const pitch = options.pitch ?? cfg.pitch ?? 0;

    const payload = {
      user: { uid: this.deviceId, platform: 'ESP32-S3' },
      audio: { voice_type: voiceType, encoding, sample_rate: sampleRate, speech_rate: speechRate, volume, pitch }
    };
    const json = JSON.stringify(payload);
    const gz = zlib.gzipSync(Buffer.from(json, 'utf-8'));
    const header = this._protoHeader(0x1, 0x0, 0x1, 0x1);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(gz.length, 0);
    const req = Buffer.concat([header, size, gz]);
    const textBuf = Buffer.from(text, 'utf-8');
    const textGz = zlib.gzipSync(textBuf);
    const textHeader = this._protoHeader(0x2, 0x2, 0x0, 0x1);
    const textSize = Buffer.alloc(4);
    textSize.writeUInt32BE(textGz.length, 0);
    return Buffer.concat([req, textHeader, textSize, textGz]);
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
        return { type: 'audio', payload };
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
      BotUtil.makeLog('warn', '[TTS] Pong超时，断开连接', this.deviceId);
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
            BotUtil.makeLog('debug', '⚡ [TTS] WebSocket已连接', this.deviceId);
            this._startPingTimer();
            resolve();
          });
          ws.on('message', (buf) => {
            const msg = this._parse(buf);
            if (!msg) return;
            if (msg.type === 'error') {
              if (msg.errorCode !== 45000000) BotUtil.makeLog('error', `❌ [TTS错误] ${msg.errorCode}: ${msg.errorMessage}`, this.deviceId);
              return;
            }
            if (msg.type === 'audio' && msg.payload && msg.payload.length > 0) {
              const hex = msg.payload.toString('hex');
              this.Bot[this.deviceId].sendAudioChunk(hex);
            }
          });
          ws.on('pong', () => this._clearPongTimer());
          ws.on('error', (err) => {
            clearTimeout(connectTimeout);
            if (err.message.includes('401')) BotUtil.makeLog('error', '❌ [TTS] 认证失败(401): 请检查appKey和accessKey', this.deviceId);
            else BotUtil.makeLog('error', `❌ [TTS] WebSocket错误: ${err.message}`, this.deviceId);
            this.connected = false;
            this.connecting = false;
            this._clearIdleTimer();
            this._clearPingTimer();
            this._clearPongTimer();
            reject(err);
          });
          ws.on('close', (code) => {
            BotUtil.makeLog('debug', `✓ [TTS] WebSocket关闭 (code=${code})`, this.deviceId);
            this.connected = false;
            this.connecting = false;
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
    BotUtil.makeLog('warn', `[TTS] 将在${delay}ms后重连（第${this.reconnectAttempts}次）`, this.deviceId);
    setTimeout(() => {
      if (!this.connected && !this.connecting) this._ensureConnected().catch(e => BotUtil.makeLog('error', `❌ [TTS] 重连失败: ${e.message}`, this.deviceId));
    }, delay);
  }

  _armIdleTimer() {
    if (this.config.idleCloseMs > 0) {
      this._clearIdleTimer();
      this._idleTimer = setTimeout(() => {
        if (this.ws && this.connected) {
          BotUtil.makeLog('debug', '✓ [TTS] 空闲超时，关闭连接', this.deviceId);
          this.ws.close();
        }
      }, this.config.idleCloseMs);
    }
  }

  _clearIdleTimer() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }

  async synthesize(text, options = {}) {
    if (!text || typeof text !== 'string') return;
    await this._ensureConnected();
    this._clearIdleTimer();
    const req = this._buildSynthesisRequest(text, options);
    this.ws.send(req);
    this._armIdleTimer();
  }

  async destroy() {
    this._clearIdleTimer();
    this._clearPingTimer();
    this._clearPongTimer();
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
