# XRK-Yunzai 用户使用指南

<div align="center">

![User Guide](https://img.shields.io/badge/User%20Guide-v3.1.3-blue?style=flat-square)
![API](https://img.shields.io/badge/API-REST%20%7C%20WebSocket-green?style=flat-square)
![Frontend](https://img.shields.io/badge/Frontend-Web%20Panel-orange?style=flat-square)

</div>

> 📖 本文档面向最终用户，介绍如何使用 XRK-Yunzai 的 Web 界面和 API 接口。

---

<h2 align="center">目录</h2>

- [1. 快速开始](#1-快速开始)
- [2. Web 界面访问](#2-web-界面访问)
- [3. API 接口使用](#3-api-接口使用)
- [4. 常用操作示例](#4-常用操作示例)
- [5. WebSocket 实时通信](#5-websocket-实时通信)
- [6. 常见问题](#6-常见问题)

---

<h2 align="center">1. 快速开始</h2>

### 1.1 启动服务

启动 XRK-Yunzai 后，HTTP/HTTPS **端口为自定义配置**，无项目内硬编码默认端口。配置来源：`config/default_config/server.yaml` 或按运行端口隔离的 `data/server_bots/<port>/server.yaml`；启动时控制台会打印实际访问地址。

- **访问地址**：`http://localhost:<端口>` 或 `http://你的IP:<端口>`，端口为**自定义配置**（见下方配置说明），启动时控制台会打印实际地址。

### 1.2 查看服务状态

启动后，控制台会显示**实际端口与地址**（端口来自 `server.yaml` 或启动参数，项目内无硬编码默认端口），例如：

```
✓ HTTP服务器已启动
  本地访问: http://localhost:<端口>
  公网访问: http://<本机IP>:<端口>
```

---

<h2 align="center">2. Web 界面访问</h2>

### 2.1 主页

**http://localhost:<端口>/** — 欢迎页。`<端口>` 为自定义配置，见启动日志或 `server.yaml`。

### 2.2 API 控制中心（xrk 面板）

**http://localhost:<端口>/xrk/** — 系统状态监控、AI 对话（Event/语音/文本）、配置管理、API 调试。顶部可填 API Key，左侧切换功能模块。**Event 模式**下支持引用回复（点击消息「引用」后发送，与后端 getReply 协议一致）。`<端口>` 以实际配置为准。

### 2.3 静态资源

根路径提供 `favicon.ico`、`robots.txt`、`index.html`；`/xrk/` 为控制中心前端。

---

<h2 align="center">3. API 接口使用</h2>

### 3.1 API 认证

部分 API 需认证：请求头 `X-API-Key: your-api-key` 或 URL 参数 `?api_key=your-api-key`；`127.0.0.1` / `localhost` 可免认证。

### 3.2 核心 API 接口

以下接口均需认证时在请求头加 `X-API-Key` 或 URL 加 `?api_key=xxx`。示例：`curl http://localhost:<端口>/api/system/status`（`<端口>` 以实际配置或启动日志为准，下同）。

#### 3.2.1 系统状态

**GET /api/system/status** — 系统详细状态（platform、cpu、memory、disks、net、bot、bots）。  
**GET /api/status** — 简化状态。

#### 3.2.2 健康检查

**GET /api/health** — 返回 `{ status: "healthy", services: { bot, redis, api } }`。

#### 3.2.3 机器人管理

| 接口 | 说明 |
|------|------|
| GET /api/bots | 机器人列表 `{ success, bots[] }` |
| GET /api/bot/:uin/friends | 好友列表 `{ success, friends[] }` |
| GET /api/bot/:uin/groups | 群组列表 `{ success, groups[] }` |

#### 3.2.4 消息发送

**POST /api/message/send** — 请求体：`{ bot_id?（可选）, type: "private"|"group", target_id, message: string | 消息段数组 }`。响应：`{ success, message_id, results[], timestamp }`。消息段格式见 OneBot 消息段（text/at/image 等）。

#### 3.2.5 设备管理

| 接口 | 说明 |
|------|------|
| GET /api/devices | 设备列表 `{ success, devices[], count }`，每项含 device_id、device_type、device_name、capabilities、registeredAt |
| GET /api/device/:deviceId | 单设备详情 |
| POST /api/device/:deviceId/ai | 请求体 `{ text, workflow? }`，执行设备工作流 |

#### 3.2.6 AI 对话

**GET /api/ai/stream?prompt=…&workflow=chat&persona=…** — SSE 流式输出（传统工作流入口）。

**POST /api/v3/chat/completions** — OpenAI 兼容对话接口，支持 `stream`、`model`（提供商名）、`workflow.streams`（MCP 工具作用域）。请求体同 OpenAI Chat Completions（messages、temperature、max_tokens 等），响应为 SSE 流式或 JSON。xrk 面板 AI 对话与第三方客户端均可用此接口。

**响应格式（Server-Sent Events）**:

每行一条 `data:`，内容为 JSON：`{"delta": "字"}` 表示增量文本；结束时发送 `data: [DONE]`。若出错则发送 `{"error": "错误信息"}` 后跟 `[DONE]`。

```
data: {"delta": "你"}

data: {"delta": "好"}

data: {"delta": "！"}

data: [DONE]
```

**JavaScript 示例**:

```javascript
const eventSource = new EventSource('/api/ai/stream?prompt=你好');

eventSource.onmessage = (event) => {
  const raw = event.data;
  if (raw === '[DONE]') {
    eventSource.close();
    return;
  }
  try {
    const data = JSON.parse(raw);
    if (data.delta) console.log(data.delta);
    if (data.error) console.error(data.error);
  } catch (e) {}
};
```

---

<h2 align="center">4. 常用操作示例</h2>

### 4.1 curl 示例

```bash
# <端口> 为自定义配置，见 server.yaml 或启动日志
curl -X POST http://localhost:<端口>/api/message/send \
  -H "Content-Type: application/json" -H "X-API-Key: your-api-key" \
  -d '{"type": "private", "target_id": "987654321", "message": "Hello"}'
```

群聊将 `type` 改为 `group`、`target_id` 改为群 ID 即可。

### 4.2 Python 示例

```python
import requests

# 端口为自定义配置，见 server.yaml 或启动日志，无项目内硬编码默认值
BASE_URL = "http://localhost:<端口>"
API_KEY = "your-api-key"

headers = {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY
}

# 获取系统状态
response = requests.get(f"{BASE_URL}/api/system/status")
print(response.json())

# 发送消息
data = {
    "type": "private",
    "target_id": "987654321",
    "message": "Hello from Python!"
}
response = requests.post(
    f"{BASE_URL}/api/message/send",
    headers=headers,
    json=data
)
print(response.json())
```

### 4.3 Node.js 示例

`fetch(BASE_URL + '/api/message/send', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY }, body: JSON.stringify({ type: 'private', target_id: '987654321', message: 'Hello' }) })` 即可。其他接口同理。

---

<h2 align="center">5. WebSocket 实时通信</h2>

### 5.1 消息监听

**连接地址**: `ws://localhost:<端口>/messages`（`<端口>` 以实际配置为准）

**JavaScript 示例**:

```javascript
// 端口为自定义配置，见 server.yaml 或启动日志
const ws = new WebSocket('ws://localhost:<端口>/messages');

ws.onopen = () => {
  console.log('WebSocket 连接已建立');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('收到消息:', data);
  
  if (data.type === 'message') {
    // 处理收到的消息
    console.log('消息内容:', data.data);
  } else if (data.type === 'message.send') {
    // 处理发送的消息
    console.log('消息已发送:', data.data);
  }
};

ws.onerror = (error) => {
  console.error('WebSocket 错误:', error);
};

ws.onclose = () => {
  console.log('WebSocket 连接已关闭');
};
```

### 5.2 设备 WebSocket

**连接地址**: `ws://localhost:<端口>/device`（`<端口>` 以实际配置为准；认证可通过查询参数 `?api_key=xxx` 传递）。协议与 XRK-AGT 对齐。

**设备注册（客户端发送）**:

```json
{
  "type": "register",
  "device_id": "device001",
  "device_type": "smart_display",
  "device_name": "智能显示屏",
  "capabilities": ["display", "audio", "camera"]
}
```

服务端成功响应：`{"type": "register_response", "success": true, "device": {"device_id": "...", "device_type": "...", "device_name": "..."}}`

**心跳（客户端发送）**:

```json
{
  "type": "heartbeat"
}
```

服务端响应：`{"type": "heartbeat_response", "timestamp": 1704067200000}`

**客户端发送**：`{"type": "message", "text": "..."}` 或带消息段数组的 `{"type": "message", "message": [...]}`。若首条为引用，可传 `{ "type": "reply", "id": "被引用消息ID", "text": "摘要" }`，后端会注入 `e.reply_id` 与 `e._replyPayload`，插件内 `e.getReply()` 将返回 `{ message_id, id, text, raw_message, segments }`（不再为 null）。

**服务端下行类型**：

| type | 说明 |
|------|------|
| `reply` | 回复内容：`segments`（文本/图片/引用/工具卡片等）、可选 `title`/`description`、可选 `mcp_tools` |
| `asr_interim` | 语音识别中间结果：`session_id`、`text` |
| `asr_final` | 语音识别最终结果：`session_id`、`text` |
| `command` | 子类型 `play_tts_audio`：`parameters.audio_data` 为 PCM 十六进制字符串，16kHz 单声道 |
| `typing` | 输入状态：`typing: true/false` |
| `error` | 错误：`message` |
| `register_response` / `heartbeat_response` | 注册与心跳响应 |

---

<h2 align="center">6. 常见问题</h2>

| 现象 | 处理 |
|------|------|
| 无法打开服务端口页面 | 确认服务已启动，查看控制台打印的端口（端口为自定义配置，无硬编码）；Windows 用 `netstat -ano`、Linux/Mac 用 `lsof -i :<端口>` 排查；检查防火墙 |
| API 返回 403 | 检查 API Key、请求头 `X-API-Key` 或 `?api_key=`；本地可用 127.0.0.1/localhost 免认证 |
| /api/message/send 失败 | 确认机器人在线（GET /api/bots）、target_id 与 type 正确、消息格式符合要求；查服务端日志 |
| WebSocket 连不上 | 确认地址为 `ws://` 或 `wss://`、防火墙放行、服务支持 WS |
| 静态资源不加载 | 确认 `www/` 存在、权限正确、清缓存、看控制台报错 |

更多：`docs/`、`docs/reference/`、Issue 反馈。

