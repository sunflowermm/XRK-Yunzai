# 设备协议与引用（Device / Reply）

> 设备 HTTP/WebSocket 业务层：`plugins/system-plugin/http/device.js`。与 XRK-AGT 协议对齐。

---

## 1. 概述

- **REST**：设备注册、列表、单设备、TTS、AI 工作流。
- **WebSocket**：设备连接 `/device`，上行 `register` / `heartbeat` / `message`；下行 `reply`、`asr_interim`/`asr_final`、`command.play_tts_audio`、`typing`、`error`。
- **事件链**：设备消息经 `Bot.PluginsLoader.deal(event)` 进入插件；事件上挂载 `e.reply`（发送回复）、`e.getReply`（获取当前引用消息）。

---

## 2. 消息上行（客户端 → 服务端）

| type       | 说明 |
|-----------|------|
| `register` | 设备注册：`device_id`、`device_type`、`device_name`、可选 `capabilities`。 |
| `heartbeat` | 保活。 |
| `message`  | 聊天消息：`text`（可选）或 `message`（消息段数组）。 |

**消息段**：`message` 为 `[{ type, ... }]`。常见类型：

- `{ type: "text", text: "..." }`
- `{ type: "reply", id: "被引用消息ID", text: "摘要" }` — 引用某条消息时放在首条，后端会解析并注入 `e.reply_id`、`e._replyPayload`，插件内 `e.getReply()` 可拿到引用内容。
- `{ type: "image", url: "..." }` 等媒体段。

---

## 3. 引用与 getReply（底层）

1. 客户端发送的 `message` 中若包含一条 `type === 'reply'` 的段，后端会取 `id`、`text`，在事件上设置：
   - `event.reply_id`：被引用消息 ID
   - `event._replyPayload`：`{ message_id, id, text, raw_message, segments }`（供插件读取）
2. `lib/plugins/loader.js` 在 `setupEventProps` 中：若 `e.isDevice && e._replyPayload != null`，则 `e.getReply = async () => e._replyPayload`，否则走原有逻辑（`e.source?.message_id || e.reply_id` + `target?.getMsg(msgId)`）。
3. 因此设备/Web 端带引用发送时，插件里 `await e.getReply()` 得到引用 payload，**不再为 null**。

---

## 4. 回复下行（服务端 → 客户端）

| type     | 说明 |
|----------|------|
| `reply`  | 回复内容：`segments`（文本/图片等）、可选 `title`/`description`、可选 `mcp_tools`。 |
| `asr_interim` / `asr_final` | 语音识别中间/最终结果。 |
| `command` | 子类型 `play_tts_audio`：`parameters.audio_data` 为 PCM 十六进制，16kHz 单声道。 |
| `typing` | 输入状态。 |
| `error`  | 错误信息。 |

---

## 5. 相关文档

- [USER_GUIDE.md](../../USER_GUIDE.md) — 设备 WS 连接与消息格式
- [BOT.md](./BOT.md) — Bot 与事件
