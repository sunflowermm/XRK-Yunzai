# XRK-Yunzai 用户使用指南

<h1 align="center">XRK-Yunzai 用户使用指南</h1>

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

启动 XRK-Yunzai 后，服务默认运行在：

- **HTTP 端口**: `3000`（可在配置中修改）
- **访问地址**: `http://localhost:3000` 或 `http://你的IP:3000`

### 1.2 查看服务状态

启动后，控制台会显示服务地址，例如：

```
✓ HTTP服务器已启动
  本地访问: http://localhost:3000
  公网访问: http://192.168.1.100:3000
```

---

<h2 align="center">2. Web 界面访问</h2>

### 2.1 主页（欢迎页面）

**访问地址**: `http://localhost:3000/`

这是项目的欢迎页面，展示项目介绍、特性、仓库链接等信息。

**功能**:
- 查看项目介绍
- 访问项目仓库
- 了解核心特性

### 2.2 API 控制中心

**访问地址**: `http://localhost:3000/xrk/`

这是功能完整的 API 控制面板，提供图形化界面管理机器人。

**主要功能**:

1. **系统状态监控**
   - 实时查看系统运行状态
   - CPU、内存、网络使用情况
   - 机器人在线状态

2. **葵宝聊天**
   - 与 AI 进行对话
   - 支持流式输出
   - 实时显示回复

3. **配置管理器**
   - 查看和修改配置
   - 支持热更新

4. **API 调试**
   - 测试 API 接口
   - 查看请求/响应
   - 支持多种 HTTP 方法

**使用步骤**:

1. 打开浏览器访问 `http://localhost:3000/xrk/`
2. 在顶部输入 API Key（如已配置）
3. 点击左侧导航选择功能模块
4. 开始使用各项功能

### 2.3 静态资源

静态资源目录：`www/`

- `favicon.ico` - 网站图标
- `robots.txt` - 搜索引擎爬虫规则
- `index.html` - 主页
- `xrk/` - API 控制中心目录

---

<h2 align="center">3. API 接口使用</h2>

### 3.1 API 认证

部分 API 需要认证，认证方式：

**方式1: API Key（推荐）**

在请求头中添加：

```bash
X-API-Key: your-api-key
```

**方式2: 查询参数**

```
?api_key=your-api-key
```

**方式3: 本地地址（开发环境）**

来自 `127.0.0.1` 或 `localhost` 的请求自动通过认证。

### 3.2 核心 API 接口

#### 3.2.1 系统状态

**获取系统详细状态**

```bash
GET /api/system/status
```

**示例**:

```bash
curl http://localhost:3000/api/system/status
```

**响应示例**:

```json
{
  "success": true,
  "timestamp": 1704067200000,
  "system": {
    "platform": "win32",
    "arch": "x64",
    "hostname": "DESKTOP-XXX",
    "nodeVersion": "v18.17.0",
    "uptime": 3600,
    "cpu": {
      "model": "Intel Core i7-9700K",
      "cores": 8,
      "usage": {...},
      "percent": 25.5,
      "loadavg": [0.5, 0.8, 1.2]
    },
    "memory": {
      "total": 17179869184,
      "free": 8589934592,
      "used": 8589934592,
      "usagePercent": "50.00"
    },
    "disks": [...],
    "net": {
      "rxBytes": 1024000,
      "txBytes": 2048000
    },
    "netRates": {
      "rxSec": 1024,
      "txSec": 2048
    }
  },
  "bot": {
    "url": "http://localhost:3000",
    "port": 3000,
    "startTime": 1704063600,
    "uptime": 3600
  },
  "bots": [
    {
      "uin": "123456789",
      "online": true,
      "nickname": "我的机器人",
      "adapter": "OneBotv11",
      "stats": {
        "friends": 100,
        "groups": 50
      }
    }
  ]
}
```

**获取简化状态**

```bash
GET /api/status
```

**示例**:

```bash
curl http://localhost:3000/api/status
```

#### 3.2.2 健康检查

**检查服务健康状态**

```bash
GET /api/health
```

**示例**:

```bash
curl http://localhost:3000/api/health
```

**响应示例**:

```json
{
  "status": "healthy",
  "timestamp": 1704067200000,
  "services": {
    "bot": "operational",
    "redis": "operational",
    "api": "operational"
  }
}
```

#### 3.2.3 机器人管理

**获取机器人列表**

```bash
GET /api/bots
```

**示例**:

```bash
curl http://localhost:3000/api/bots
```

**响应示例**:

```json
{
  "success": true,
  "bots": [
    {
      "uin": "123456789",
      "online": true,
      "nickname": "我的机器人",
      "adapter": "OneBotv11",
      "friends": 100,
      "groups": 50
    }
  ]
}
```

**获取好友列表**

```bash
GET /api/bot/:uin/friends
```

**示例**:

```bash
curl http://localhost:3000/api/bot/123456789/friends
```

**响应示例**:

```json
{
  "success": true,
  "friends": [
    {
      "user_id": "987654321",
      "nickname": "好友昵称",
      "remark": "备注名"
    }
  ]
}
```

**获取群组列表**

```bash
GET /api/bot/:uin/groups
```

**示例**:

```bash
curl http://localhost:3000/api/bot/123456789/groups
```

**响应示例**:

```json
{
  "success": true,
  "groups": [
    {
      "group_id": "123456789",
      "group_name": "测试群",
      "member_count": 100
    }
  ]
}
```

#### 3.2.4 消息发送

**发送消息**

```bash
POST /api/message/send
Content-Type: application/json
X-API-Key: your-api-key
```

**请求体**:

```json
{
  "bot_id": "123456789",
  "type": "private",
  "target_id": "987654321",
  "message": "你好，这是一条测试消息"
}
```

**参数说明**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `bot_id` | string | 否 | 机器人ID，不填则使用默认机器人 |
| `type` | string | 是 | 消息类型：`private`（私聊）或 `group`（群聊） |
| `target_id` | string | 是 | 目标ID（用户ID或群ID） |
| `message` | string/array | 是 | 消息内容，可以是字符串或消息段数组 |

**示例**:

```bash
curl -X POST http://localhost:3000/api/message/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "type": "private",
    "target_id": "987654321",
    "message": "你好"
  }'
```

**响应示例**:

```json
{
  "success": true,
  "message_id": 123456,
  "results": [
    {
      "message_id": 123456,
      "time": 1704067200,
      "raw_message": "你好"
    }
  ],
  "timestamp": 1704067200000
}
```

**发送消息段（支持图片、@等）**

```json
{
  "type": "group",
  "target_id": "123456789",
  "message": [
    {
      "type": "text",
      "data": {
        "text": "这是一条"
      }
    },
    {
      "type": "at",
      "data": {
        "qq": "987654321"
      }
    },
    {
      "type": "text",
      "data": {
        "text": "的消息"
      }
    }
  ]
}
```

#### 3.2.5 设备管理

**获取设备列表**

```bash
GET /api/devices
```

**示例**:

```bash
curl http://localhost:3000/api/devices
```

**响应示例**:

```json
{
  "success": true,
  "devices": [
    {
      "device_id": "device001",
      "device_name": "智能设备1",
      "device_type": "smart_display",
      "online": true,
      "last_seen": 1704067200000,
      "capabilities": ["display", "audio", "camera"],
      "stats": {
        "messages_sent": 100,
        "messages_received": 200,
        "commands_executed": 50,
        "errors": 0
      }
    }
  ],
  "count": 1
}
```

**获取设备信息**

```bash
GET /api/device/:deviceId
```

**示例**:

```bash
curl http://localhost:3000/api/device/device001
```

**设备AI对话**

```bash
POST /api/device/:deviceId/ai
Content-Type: application/json
```

**请求体**:

```json
{
  "text": "你好，今天天气怎么样？"
}
```

**示例**:

```bash
curl -X POST http://localhost:3000/api/device/device001/ai \
  -H "Content-Type: application/json" \
  -d '{"text": "你好"}'
```

#### 3.2.6 AI 流式对话

**流式 AI 对话（SSE）**

```bash
GET /api/ai/stream?prompt=你好&persona=你是一个助手
```

**示例**:

```bash
curl http://localhost:3000/api/ai/stream?prompt=你好
```

**响应格式（Server-Sent Events）**:

```
data: {"delta": "你"}

data: {"delta": "好"}

data: {"delta": "！"}

data: {"done": true, "text": "你好！"}
```

**JavaScript 示例**:

```javascript
const eventSource = new EventSource('/api/ai/stream?prompt=你好');

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.delta) {
    // 流式输出
    console.log(data.delta);
  } else if (data.done) {
    // 完成
    console.log('完整回复:', data.text);
    eventSource.close();
  }
};
```

---

<h2 align="center">4. 常用操作示例</h2>

### 4.1 使用 curl 发送消息

**发送私聊消息**:

```bash
curl -X POST http://localhost:3000/api/message/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "type": "private",
    "target_id": "987654321",
    "message": "Hello from API!"
  }'
```

**发送群聊消息**:

```bash
curl -X POST http://localhost:3000/api/message/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "type": "group",
    "target_id": "123456789",
    "message": "群消息测试"
  }'
```

### 4.2 使用 Python 调用 API

```python
import requests

# 配置
BASE_URL = "http://localhost:3000"
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

### 4.3 使用 JavaScript/Node.js 调用 API

```javascript
const fetch = require('node-fetch');

const BASE_URL = 'http://localhost:3000';
const API_KEY = 'your-api-key';

// 获取系统状态
async function getSystemStatus() {
  const response = await fetch(`${BASE_URL}/api/system/status`);
  const data = await response.json();
  console.log(data);
}

// 发送消息
async function sendMessage(type, targetId, message) {
  const response = await fetch(`${BASE_URL}/api/message/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY
    },
    body: JSON.stringify({
      type,
      target_id: targetId,
      message
    })
  });
  const data = await response.json();
  return data;
}

// 使用示例
sendMessage('private', '987654321', 'Hello from Node.js!')
  .then(result => console.log(result));
```

### 4.4 使用 Postman 测试

1. **创建新请求**
   - Method: `POST`
   - URL: `http://localhost:3000/api/message/send`

2. **设置 Headers**
   - `Content-Type`: `application/json`
   - `X-API-Key`: `your-api-key`

3. **设置 Body**
   - 选择 `raw` 和 `JSON`
   - 输入请求体：
   ```json
   {
     "type": "private",
     "target_id": "987654321",
     "message": "Hello from Postman!"
   }
   ```

4. **发送请求**

---

<h2 align="center">5. WebSocket 实时通信</h2>

### 5.1 消息监听

**连接地址**: `ws://localhost:3000/ws/messages`

**JavaScript 示例**:

```javascript
const ws = new WebSocket('ws://localhost:3000/ws/messages');

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

**连接地址**: `ws://localhost:3000/ws/device`

**设备注册消息**:

```json
{
  "type": "register",
  "device_id": "device001",
  "device_type": "smart_display",
  "device_name": "智能显示屏",
  "capabilities": ["display", "audio", "camera"],
  "firmware_version": "1.0.0"
}
```

**心跳消息**:

```json
{
  "type": "heartbeat",
  "device_id": "device001",
  "status": "online"
}
```

---

<h2 align="center">6. 常见问题</h2>

### 6.1 无法访问 Web 界面

**问题**: 浏览器无法打开 `http://localhost:3000`

**解决方案**:

1. 检查服务是否启动
   ```bash
   # 查看控制台是否有启动成功信息
   ```

2. 检查端口是否被占用
   ```bash
   # Windows
   netstat -ano | findstr :3000
   
   # Linux/Mac
   lsof -i :3000
   ```

3. 检查防火墙设置
   - 确保 3000 端口未被阻止

4. 尝试使用 IP 地址访问
   - `http://你的IP:3000`

### 6.2 API 返回 403 未授权

**问题**: API 请求返回 `{"success": false, "message": "Unauthorized"}`

**解决方案**:

1. 检查 API Key 是否正确
2. 确保请求头包含 `X-API-Key`
3. 如果从本地访问，确保使用 `127.0.0.1` 或 `localhost`

### 6.3 消息发送失败

**问题**: 调用 `/api/message/send` 返回错误

**解决方案**:

1. 检查机器人是否在线
   ```bash
   curl http://localhost:3000/api/bots
   ```

2. 检查目标ID是否正确
3. 检查消息格式是否正确
4. 查看服务器日志获取详细错误信息

### 6.4 WebSocket 连接失败

**问题**: WebSocket 无法连接

**解决方案**:

1. 检查服务是否支持 WebSocket
2. 检查防火墙是否阻止 WebSocket 连接
3. 确保使用正确的 WebSocket 地址（`ws://` 或 `wss://`）

### 6.5 静态资源无法加载

**问题**: 页面样式或图片无法加载

**解决方案**:

1. 检查 `www/` 目录是否存在
2. 检查文件权限
3. 清除浏览器缓存
4. 检查控制台错误信息

---

<h2 align="center">7. 更多资源</h2>

- **开发文档**: 查看 `docs/` 目录
- **API 参考**: 查看 `docs/reference/` 目录
- **问题反馈**: 提交 Issue 到项目仓库

---

<div align="center">

> 💡 **提示**: 更多高级功能请参考开发者文档。

</div>

