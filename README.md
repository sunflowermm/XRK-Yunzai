# XRK-Yunzai v3.0.5

基于乐神版[云崽v3.0](https://gitee.com/le-niao/Yunzai-Bot) 与喵喵版[喵崽v3.1.3](https://gitee.com/yoimiya-kokomi/Miao-Yunzai) 还有时雨版[时雨崽3.1.3](https://gitee.com/TimeRainStarSky/Yunzai)

感谢我在编写过程中时雨佬等佬的帮助
感谢我在编写时萌新们的支持

## 项目特性

### 🚀 模块化工作流系统

XRK-Yunzai 采用模块化工作流架构，支持：

- **模块化设计**：每个工作流专注于特定功能（聊天、文件、设备等）
- **组合调用**：可以同时调用多个工作流，实现复杂需求
- **记忆系统**：所有工作流自动获得记忆能力，支持场景隔离
- **推理调优**：支持多轮推理和响应润色，提升AI回复质量
- **参数优先级**：灵活的配置系统，支持运行时参数覆盖

### 🔧 完整的基类体系

项目提供了完整的基类体系，方便开发者快速扩展：

- **AIStream** - 工作流基类，提供AI调用、记忆、功能管理
- **Plugin** - 插件基类，提供工作流集成、上下文管理
- **HttpApi** - HTTP API基类，提供路由注册、WebSocket支持
- **EventListener** - 事件监听基类，提供事件处理能力
- **Renderer** - 渲染器基类，提供图片渲染能力

**详细文档：**
- [工作流基类开发文档](./docs/WORKFLOW_BASE_CLASS.md)
- [插件基类开发文档](./docs/PLUGIN_BASE_CLASS.md)
- [HTTP API基类开发文档](./docs/HTTP_API_BASE_CLASS.md)
- [项目基类总览](./docs/BASE_CLASSES.md)

### 🌐 现代化HTTP服务器

- **Express框架**：基于Express的现代化HTTP服务器
- **WebSocket支持**：完整的WebSocket支持，支持实时通信
- **反向代理**：支持多域名反向代理，路径重写，负载均衡
- **HTTPS支持**：支持HTTP/2和现代TLS配置
- **安全特性**：CORS、Helmet、速率限制等安全特性

### 📦 插件系统

- **热重载**：支持插件热重载，无需重启
- **优先级控制**：灵活的优先级系统
- **权限管理**：完整的权限控制系统
- **上下文管理**：支持多轮对话和状态管理

### 🎨 渲染系统

- **多渲染器支持**：支持Puppeteer和Playwright
- **模板系统**：基于art-template的模板系统
- **文件监听**：自动监听模板文件变化

## 快速开始

### 环境要求

- **操作系统**: Windows/Linux + Chrome/Chromium/Edge
- **Node.js**: >= 18.14.0
- **Redis**: >= 5.0.0
- **包管理器**: pnpm (推荐) / npm / yarn

### 安装

```sh
# 使用Gitcode
git clone --depth=1 https://gitcode.com/Xrkseek/XRK-Yunzai.git
cd XRK-Yunzai 

# 使用Gitee
git clone --depth=1 https://gitee.com/xrkseek/XRK-Yunzai.git
cd XRK-Yunzai 

# 使用Github
git clone --depth=1 https://github.com/Xrkseek/XRK-Yunzai.git
cd XRK-Yunzai 
```

### 运行

```sh
node app
```

首次运行按提示输入登录信息。

## 部署方式

### 方式一：直接运行

```sh
# 1. 安装依赖（自动）
node app

# 2. 首次运行会提示登录
# 3. 登录成功后即可使用
```

### 方式二：Docker部署

#### 使用 Docker Compose（推荐）

```sh
# 1. 构建并启动
docker-compose up -d

# 2. 查看日志
docker-compose logs -f xrk-yunzai

# 3. 停止服务
docker-compose down
```

#### 使用 Dockerfile

```sh
# 1. 构建镜像
docker build -t xrk-yunzai:latest .

# 2. 运行容器
docker run -d \
  --name xrk-yunzai \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/plugins:/app/plugins \
  xrk-yunzai:latest

# 3. 查看日志
docker logs -f xrk-yunzai
```

**注意事项：**
- 确保 `data/`、`config/`、`plugins/` 目录存在
- 首次运行需要登录，建议先本地运行完成登录后再使用Docker
- Redis数据会持久化到 `redis-data` volume

### 方式三：PM2部署

```sh
# 1. 全局安装PM2
npm install -g pm2

# 2. 启动应用
pm2 start app.js --name xrk-yunzai

# 3. 查看状态
pm2 status

# 4. 查看日志
pm2 logs xrk-yunzai

# 5. 停止应用
pm2 stop xrk-yunzai
```

## 项目结构

```
XRK-Yunzai/
├── app.js                 # 应用入口（依赖检查和引导）
├── start.js              # 主启动文件
├── package.json          # 项目配置
├── docker-compose.yml    # Docker Compose配置
├── Dockerfile            # Docker镜像配置
│
├── lib/                  # 核心库
│   ├── bot.js           # Bot主类（HTTP服务器、WebSocket、插件管理）
│   ├── aistream/        # 工作流核心库
│   │   ├── aistream.js  # 工作流基类
│   │   ├── memory.js    # 记忆系统
│   │   ├── workflow-manager.js  # 多工作流管理器
│   │   └── loader.js    # 工作流加载器
│   ├── plugins/         # 插件系统
│   │   ├── plugin.js    # 插件基类
│   │   └── loader.js    # 插件加载器
│   ├── http/            # HTTP API系统
│   │   ├── http.js      # HTTP API基类
│   │   └── loader.js    # API加载器
│   ├── listener/        # 事件监听系统
│   │   ├── listener.js  # 事件监听基类
│   │   └── loader.js    # 监听器加载器
│   ├── renderer/        # 渲染器系统
│   │   ├── Renderer.js  # 渲染器基类
│   │   └── loader.js    # 渲染器加载器
│   ├── config/          # 配置系统
│   ├── common/          # 通用工具
│   └── modules/         # 模块（oicq等）
│
├── plugins/              # 插件目录
│   ├── stream/          # 工作流插件
│   │   ├── chat.js      # 聊天工作流
│   │   └── device.js    # 设备工作流
│   ├── api/             # API路由插件
│   ├── events/          # 事件处理插件
│   ├── adapter/         # 适配器插件
│   └── system/          # 系统插件
│
├── config/              # 配置文件
│   ├── default_config/  # 默认配置
│   │   ├── kuizai.yaml  # AI配置
│   │   ├── bot.yaml     # Bot配置
│   │   └── server.yaml   # 服务器配置
│   └── server_config/   # 服务器配置（登录信息等）
│
├── data/                # 数据目录
│   ├── bots/           # Bot数据（登录信息）
│   ├── wav/            # 音频文件
│   └── models/         # 模型文件
│
├── www/                 # 静态文件
│   └── xrk/            # 前端界面
│
├── renderers/           # 渲染器
│   ├── puppeteer/      # Puppeteer渲染器
│   └── playwright/     # Playwright渲染器
│
└── docs/                # 文档目录
    ├── WORKFLOW_BASE_CLASS.md  # 工作流基类文档
    ├── PLUGIN_BASE_CLASS.md    # 插件基类文档
    ├── HTTP_API_BASE_CLASS.md  # HTTP API基类文档
    └── BASE_CLASSES.md         # 项目基类总览
```

## 配置说明

### AI配置

配置文件：`config/default_config/kuizai.yaml`

```yaml
kuizai:
  ai:
    enabled: true
    baseUrl: 'https://api.gptgod.online/v1'
    apiKey: 'your-api-key'
    chatModel: 'deepseek-r1-0528'
    temperature: 0.8
    max_tokens: 2000
    
  responsePolish:
    enabled: true
    maxTokens: 400
    temperature: 0.3
    
  reasoning:
    enabled: false
    maxIterations: 3
    temperature: 0.8
    
  workflows:
    enabled: true
    allowMultiple: true
    defaultWorkflow: 'device'
```

### 服务器配置

配置文件：`config/default_config/server.yaml`

主要配置项：
- `server.host`: 监听地址（默认0.0.0.0）
- `server.url`: 外部访问URL
- `proxy.enabled`: 是否启用反向代理
- `https.enabled`: 是否启用HTTPS

## 开发文档

### 基类文档

- [工作流基类开发文档](./docs/WORKFLOW_BASE_CLASS.md) - 如何创建自定义工作流
- [插件基类开发文档](./docs/PLUGIN_BASE_CLASS.md) - 如何创建插件
- [HTTP API基类开发文档](./docs/HTTP_API_BASE_CLASS.md) - 如何创建API路由
- [项目基类总览](./docs/BASE_CLASSES.md) - 所有基类的概览

### 其他文档

- [葵崽重要特性](./stdin.md) - 用户功能说明

## 快速示例

### 创建插件

```javascript
// plugins/my-plugin.js
import plugin from '../../lib/plugins/plugin.js';

export default class MyPlugin extends plugin {
  constructor() {
    super({
      name: 'my-plugin',
      dsc: '我的插件',
      event: 'message',
      rule: [
        { reg: '^#测试$', fnc: 'test' }
      ]
    });
  }

  async test(e) {
    // 调用工作流
    const result = await this.callWorkflow('chat', {
      question: e.msg
    }, { e });
    
    return this.reply(result.content);
  }
}
```

### 创建API

```javascript
// plugins/api/my-api.js
export default {
  name: 'my-api',
  dsc: '我的API',
  routes: [
    {
      method: 'GET',
      path: '/api/test',
      handler: async (req, res, Bot) => {
        res.json({ success: true });
      }
    }
  ]
};
```

### 创建工作流

```javascript
// plugins/stream/my-workflow.js
import AIStream from '../../lib/aistream/aistream.js';

export default class MyWorkflow extends AIStream {
  constructor() {
    super({
      name: 'my-workflow',
      description: '我的工作流'
    });
  }

  buildSystemPrompt(context) {
    return '系统提示';
  }

  async buildChatContext(e, question) {
    return [
      { role: 'system', content: this.buildSystemPrompt({ e, question }) },
      { role: 'user', content: question }
    ];
  }
}
```

## 后续计划

- ✅ pm2启动方式
- ✅ 开源对接任务处理器
- ✅ 投入农业实践使用
- ✅ 完善任务处理逻辑
- 🔄 将icqq等相关底层剥离
- 🔄 类型扩展和开发规范化

## 致谢

| Nickname | name | Contribution |
|:--------:|------|--------------|
| [Yunzai v3.0](https://gitee.com/le-niao/Yunzai-Bot) | 乐神的Yunzai-Bot V3 | 元老级项目 |
| [Miao-Yunzai v3.1.3](https://gitee.com/yoimiya-kokomi/Miao-Yunzai) | 喵喵的Miao-Yunzai | 项目基础，提供了优化方向和原神功能适配 |
| [TRSS-Yunzai v3.1.3](https://gitee.com/TimeRainStarSky/Yunzai) | 时雨的Yunzai | 为葵崽底层设计提供了不可磨灭的贡献，时雨崽是当之无愧的node项目的艺术品 |
