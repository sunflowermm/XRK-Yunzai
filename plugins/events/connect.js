import EventListener from "../../lib/listener/listener.js"
import cfg from "../../lib/config/config.js"
import { takeScreenshot } from "../../lib/common/takeScreenshot.js"
import fs from 'fs/promises'
import path from 'path'
import loader from '../../lib/plugins/loader.js'

export default class connectEvent extends EventListener {
  constructor() {
    super({ event: "connect" })
    this.key = 'Yz:restart'
    this.dataDir = path.join(process.cwd(), 'data')
  }

  async execute(e) {
    if (!Bot.uin.includes(e.self_id)) Bot.uin.push(e.self_id)
    
    const currentUin = e?.self_id || Bot.uin[0]
    if (!currentUin) return logger.debug('无法获取机器人QQ号')

    const restart = await this.getRestartInfo(currentUin)
    
    await this.handleRestart(currentUin, restart)
    await this.handleNormalStart(e)
    
  }

  async getRestartInfo(uin) {
    try {
      const data = await redis.get(`${this.key}:${uin}`)
      return data ? JSON.parse(data) : null
    } catch (error) {
      logger.error(`获取重启信息失败：${error}`)
      return null
    }
  }

  async handleNormalStart(e) {
    if (!cfg.bot.online_msg_exp) return
    
    const key = `Yz:XRKMsg:${e.self_id}`
    
    await this.sendWelcomeMessage()
  }

  async handleRestart(currentUin, restart) {
    const time = ((new Date().getTime() - (restart.time || new Date().getTime())) / 1000).toFixed(4)
    const target = restart.isGroup ? Bot[currentUin].pickGroup(restart.id) : Bot[currentUin].pickUser(restart.id)
    
    await target.sendMsg(`重启成功，耗时 ${time} 秒`)
    await this.sendPluginLoadReport(target)
    await redis.del(`${this.key}:${currentUin}`)
  }

  async sendWelcomeMessage() {
    const htmlPath = await this.generateHTML('welcome', this.getWelcomeHTML())
    const screenshotPath = await takeScreenshot(htmlPath, 'welcome_message', {
      width: 600, deviceScaleFactor: 3
    })
    
    Bot.sendMasterMsg([segment.image(screenshotPath)])
    this.cleanupFile(htmlPath)
  }

  async sendPluginLoadReport(target) {
    const stats = loader.getPluginStats()
    if (!stats?.plugins?.length) return logger.debug('没有插件加载统计信息')
    
    const htmlPath = await this.generateHTML('plugin_load', this.getPluginLoadHTML(stats))
    const screenshotPath = await takeScreenshot(htmlPath, 'plugin_load_report', {
      width: 800, height: 1200, deviceScaleFactor: 1.5, quality: 90
    })
    
    await target.sendMsg([segment.image(screenshotPath)])
    this.cleanupFile(htmlPath)
  }

  async generateHTML(prefix, content) {
    await fs.mkdir(this.dataDir, { recursive: true }).catch(() => {})
    const htmlPath = path.join(this.dataDir, `${prefix}_${Date.now()}.html`)
    await fs.writeFile(htmlPath, content, 'utf-8')
    return htmlPath
  }

  cleanupFile(filePath, delay = 5000) {
    setTimeout(() => fs.unlink(filePath).catch(() => {}), delay)
  }

  getWelcomeHTML() {
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>XRK-MultiBot 控制面板</title>
  <style>
    /* 字体优化：保留原神字体+中文友好 fallback */
    @font-face {
      font-family: 'Genshin';
      src: url('./fonts/Genshin.ttf') format('truetype');
      font-weight: normal;
      font-style: normal;
    }

    /* 基础样式重置 + 全局配置 */
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    }

    body {
      font-family: 'Genshin', 'Noto Sans SC', -apple-system, 'Segoe UI', system-ui, sans-serif;
      background-color: #f0f2f5; /* 柔和背景，突出主体 */
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    /* 主体容器：固定截图友好尺寸（竖版比例） */
    .container {
      width: 520px;
      height: 780px;
      background: rgba(255, 255, 255, 0.99);
      border-radius: 24px; /* 圆润边角，更现代 */
      box-shadow: 0 12px 48px rgba(102, 126, 234, 0.15); /* 层次感阴影 */
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start; /* 顶部开始布局，避免底部留白 */
      padding: 50px 30px;
      position: relative;
      overflow: hidden;
    }

    /* 顶部Logo区域：增强视觉焦点 */
    .logo {
      width: 88px;
      height: 88px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border-radius: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 32px;
      box-shadow: 0 10px 36px rgba(102, 126, 234, 0.3);
      cursor: pointer;
    }

    .logo:hover {
      transform: rotate(5deg) scale(1.05); /* 轻微互动效果，截图时可选静态 */
      box-shadow: 0 12px 40px rgba(102, 126, 234, 0.35);
    }

    .logo-text {
      color: white;
      font-size: 38px;
      font-weight: 700;
      letter-spacing: -1.2px;
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }

    /* 标题区域：层级分明 */
    .title {
      font-size: 32px;
      color: #1a1a2e;
      margin-bottom: 8px;
      font-weight: 700;
      text-align: center;
      letter-spacing: 0.5px;
    }

    .subtitle {
      font-size: 16px;
      color: #4a4a6a;
      margin-bottom: 6px;
      text-align: center;
      opacity: 0.9;
    }

    .version {
      font-size: 14px;
      color: #8a8f98;
      margin-bottom: 40px;
      font-weight: 500;
      text-align: center;
    }

    /* 命令按钮区域：网格布局优化 */
    .commands {
      width: 100%;
      max-width: 420px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 60px; /* 底部留白，避免贴边 */
    }

    .command {
      background: #f8fafc;
      padding: 18px;
      border-radius: 14px;
      border: 1px solid #e5e7eb;
      cursor: pointer;
    }

    .command:hover {
      transform: translateY(-3px);
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.1);
      border-color: #8a94e0; /* 主色浅化，过渡自然 */
      background-color: #fff;
    }

    .command-tag {
      font-size: 15px;
      color: #4c51bf;
      font-weight: 600;
      margin-bottom: 6px;
      letter-spacing: 0.3px;
    }

    .command-desc {
      font-size: 13px;
      color: #6b7280;
      line-height: 1.5;
      opacity: 0.9;
    }

    /* 特殊按钮：强化视觉突出 */
    .command.special {
      grid-column: span 2;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border: none;
      box-shadow: 0 8px 24px rgba(102, 126, 234, 0.2);
    }

    .command.special:hover {
      transform: translateY(-3px);
      box-shadow: 0 10px 30px rgba(102, 126, 234, 0.3);
      background: linear-gradient(135deg, #7286fd 0%, #845ec2 100%); /*  hover时颜色提亮 */
    }

    .command.special .command-tag,
    .command.special .command-desc {
      color: white;
      opacity: 1;
    }

    .command.special .command-tag {
      text-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
    }

    /* 底部信息：弱化但清晰 */
    .footer {
      position: absolute;
      bottom: 28px;
      font-size: 13px;
      color: #a1a7b3;
      text-align: center;
      letter-spacing: 0.2px;
    }

    /* 细节装饰：增强精致感（可选，不影响核心功能） */
    .container::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 6px;
      background: linear-gradient(90deg, #667eea, #764ba2);
      border-top-left-radius: 24px;
      border-top-right-radius: 24px;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Logo区域 -->
    <div class="logo">
      <div class="logo-text">XK</div>
    </div>

    <!-- 标题区域 -->
    <h1 class="title">XRK-MultiBot</h1>
    <div class="subtitle">多功能机器人控制面板</div>
    <div class="version">Version 1.0.0</div> <!-- 固定版本号，方便截图 -->

    <!-- 命令按钮区域 -->
    <div class="commands">
      <div class="command special">
        <div class="command-tag">向日葵妈咪妈咪哄</div>
        <div class="command-desc">一键安装原神适配器和向日葵插件</div>
      </div>
      <div class="command">
        <div class="command-tag">#状态</div>
        <div class="command-desc">查看机器人当前运行状态</div>
      </div>
      <div class="command">
        <div class="command-tag">#日志</div>
        <div class="command-desc">查看近期运行日志详情</div>
      </div>
      <div class="command">
        <div class="command-tag">#重启</div>
        <div class="command-desc">重新启动机器人服务</div>
      </div>
      <div class="command">
        <div class="command-tag">#更新</div>
        <div class="command-desc">拉取Git最新核心代码</div>
      </div>
      <div class="command">
        <div class="command-tag">#全部更新</div>
        <div class="command-desc">更新所有已安装插件</div>
      </div>
      <div class="command">
        <div class="command-tag">#更新日志</div>
        <div class="command-desc">查看版本更新记录</div>
      </div>
    </div>

    <!-- 底部信息 -->
    <div class="footer">Powered by XRK-Yunzai | 截图专用版</div>
  </div>
</body>
</html>`
  }

  getPluginLoadHTML(stats) {
    const plugins = [...stats.plugins].sort((a, b) => b.loadTime - a.loadTime)
    const success = plugins.filter(p => p.success)
    const failed = plugins.filter(p => !p.success)
    
    const packages = this.groupPluginsByPackage(success)
    const single = success.filter(p => !p.name.includes('/'))
    
    const fastest = success[success.length - 1]
    const slowest = success[0]
    
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Plugin Load Report</title>
  <style>
    @font-face {
      font-family: 'Genshin';
      src: url('./fonts/Genshin.ttf') format('truetype');
      font-weight: normal;
      font-style: normal;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Genshin', -apple-system, 'Segoe UI', system-ui, sans-serif;
      background: #0a0a0a;
      width: 800px;
      color: #fff;
    }

    .container {
      background: linear-gradient(to bottom, #0f0f0f, #1a1a1a);
      min-height: 100vh;
    }

    .header {
      padding: 48px 32px;
      text-align: center;
      background: linear-gradient(180deg, rgba(99, 102, 241, 0.1), transparent);
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }

    .header h1 {
      font-size: 36px;
      font-weight: 800;
      background: linear-gradient(135deg, #6366f1, #ec4899);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 8px;
      letter-spacing: -0.5px;
    }

    .subtitle {
      font-size: 14px;
      color: #6b7280;
      font-weight: 500;
      letter-spacing: 2px;
      text-transform: uppercase;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      padding: 32px;
    }

    .stat-card {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 20px;
      text-align: center;
    }

    .stat-icon {
      font-size: 24px;
      margin-bottom: 12px;
    }

    .stat-value {
      font-size: 32px;
      font-weight: 700;
      margin-bottom: 4px;
      background: linear-gradient(135deg, #6366f1, #ec4899);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .stat-label {
      font-size: 13px;
      color: #9ca3af;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .highlights {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      padding: 0 32px 32px;
    }

    .highlight-card {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .highlight-card.fastest {
      background: linear-gradient(135deg, rgba(34, 197, 94, 0.1), transparent);
      border-color: rgba(34, 197, 94, 0.3);
    }

    .highlight-card.slowest {
      background: linear-gradient(135deg, rgba(239, 68, 68, 0.1), transparent);
      border-color: rgba(239, 68, 68, 0.3);
    }

    .highlight-info h3 {
      font-size: 12px;
      color: #9ca3af;
      text-transform: uppercase;
      margin-bottom: 4px;
      letter-spacing: 0.5px;
    }

    .highlight-name {
      font-size: 16px;
      font-weight: 600;
      color: #fff;
    }

    .highlight-time {
      font-size: 28px;
      font-weight: 700;
    }

    .fastest .highlight-time {
      color: #22c55e;
    }

    .slowest .highlight-time {
      color: #ef4444;
    }

    .section {
      padding: 0 32px 32px;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }

    .section-title {
      font-size: 20px;
      font-weight: 700;
      color: #fff;
    }

    .section-count {
      font-size: 14px;
      color: #9ca3af;
      background: rgba(255, 255, 255, 0.05);
      padding: 4px 12px;
      border-radius: 999px;
    }

    .package-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      margin-bottom: 16px;
      overflow: hidden;
    }

    .package-header {
      padding: 16px 20px;
      background: rgba(255, 255, 255, 0.03);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .package-name {
      font-size: 16px;
      font-weight: 600;
      color: #fff;
    }

    .package-meta {
      display: flex;
      gap: 12px;
      font-size: 13px;
      color: #9ca3af;
    }

    .plugin-list {
      padding: 12px;
    }

    .plugin-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: rgba(255, 255, 255, 0.02);
      border-radius: 8px;
      margin-bottom: 8px;
    }

    .plugin-item:last-child {
      margin-bottom: 0;
    }

    .plugin-item.failed {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.2);
    }

    .plugin-name {
      font-size: 14px;
      color: #e5e7eb;
    }

    .plugin-time {
      font-size: 13px;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 999px;
    }

    .time-fast {
      color: #22c55e;
      background: rgba(34, 197, 94, 0.15);
    }

    .time-medium {
      color: #f59e0b;
      background: rgba(245, 158, 11, 0.15);
    }

    .time-slow {
      color: #ef4444;
      background: rgba(239, 68, 68, 0.15);
    }

    .error-msg {
      font-size: 12px;
      color: #ef4444;
      margin-top: 4px;
    }

    .summary {
      margin: 32px;
      padding: 32px;
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(236, 72, 153, 0.1));
      border-radius: 20px;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
      text-align: center;
    }

    .summary-item h4 {
      font-size: 13px;
      color: #9ca3af;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .summary-value {
      font-size: 28px;
      font-weight: 700;
      background: linear-gradient(135deg, #6366f1, #ec4899);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>插件加载报告</h1>
      <div class="subtitle">Plugin Performance Report</div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon">⏱️</div>
        <div class="stat-value">${(stats.totalLoadTime / 1000).toFixed(2)}</div>
        <div class="stat-label">总耗时(秒)</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">✅</div>
        <div class="stat-value">${success.length}</div>
        <div class="stat-label">成功加载</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">❌</div>
        <div class="stat-value">${failed.length}</div>
        <div class="stat-label">失败数量</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">📊</div>
        <div class="stat-value">${stats.taskCount || 0}</div>
        <div class="stat-label">定时任务</div>
      </div>
    </div>

    ${success.length > 0 ? `
      <div class="highlights">
        <div class="highlight-card fastest">
          <div class="highlight-info">
            <h3>最快加载</h3>
            <div class="highlight-name">${fastest?.name || 'N/A'}</div>
          </div>
          <div class="highlight-time">${fastest?.loadTime.toFixed(1) || '0'}ms</div>
        </div>
        <div class="highlight-card slowest">
          <div class="highlight-info">
            <h3>最慢加载</h3>
            <div class="highlight-name">${slowest?.name || 'N/A'}</div>
          </div>
          <div class="highlight-time">${slowest?.loadTime.toFixed(1) || '0'}ms</div>
        </div>
      </div>
    ` : ''}

    ${packages.length > 0 ? `
      <div class="section">
        <div class="section-header">
          <h2 class="section-title">📦 插件包</h2>
          <span class="section-count">${packages.length} 个</span>
        </div>
        ${packages.map(pkg => `
          <div class="package-card">
            <div class="package-header">
              <div class="package-name">${pkg.name}</div>
              <div class="package-meta">
                <span>📋 ${pkg.plugins.length} 个</span>
                <span>⏱️ ${pkg.totalTime.toFixed(0)}ms</span>
              </div>
            </div>
            <div class="plugin-list">
              ${pkg.plugins.map(p => this.renderPlugin(p)).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    ` : ''}

    ${single.length > 0 ? `
      <div class="section">
        <div class="section-header">
          <h2 class="section-title">📄 插件包</h2>
          <span class="section-count">${single.length} 个</span>
        </div>
        <div class="plugin-list">
          ${single.map(p => this.renderPlugin(p)).join('')}
        </div>
      </div>
    ` : ''}

    ${failed.length > 0 ? `
      <div class="section">
        <div class="section-header">
          <h2 class="section-title">❌ 加载失败</h2>
          <span class="section-count">${failed.length} 个</span>
        </div>
        <div class="plugin-list">
          ${failed.map(p => `
            <div class="plugin-item failed">
              <div>
                <div class="plugin-name">${p.name}</div>
                ${p.error ? `<div class="error-msg">${p.error}</div>` : ''}
              </div>
              <div class="plugin-time time-slow">${p.loadTime.toFixed(1)}ms</div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}

    <div class="summary">
      <div class="summary-grid">
        <div class="summary-item">
          <h4>平均耗时</h4>
          <div class="summary-value">
            ${plugins.length ? (stats.totalLoadTime / plugins.length).toFixed(0) : '0'}ms
          </div>
        </div>
        <div class="summary-item">
          <h4>成功率</h4>
          <div class="summary-value">
            ${plugins.length ? ((success.length / plugins.length) * 100).toFixed(0) : '0'}%
          </div>
        </div>
        <div class="summary-item">
          <h4>慢速插件</h4>
          <div class="summary-value">
            ${success.filter(p => p.loadTime > 100).length}个
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`
  }

  renderPlugin(plugin) {
    const name = plugin.name.includes('/') ? plugin.name.split('/').pop() : plugin.name
    const timeClass = plugin.loadTime < 10 ? 'time-fast' : 
                     plugin.loadTime < 50 ? 'time-medium' : 'time-slow'
    return `
      <div class="plugin-item">
        <div class="plugin-name">${name}</div>
        <div class="plugin-time ${timeClass}">${plugin.loadTime.toFixed(1)}ms</div>
      </div>
    `
  }

  groupPluginsByPackage(plugins) {
    const packages = {}
    plugins.filter(p => p.name.includes('/')).forEach(p => {
      const packageName = p.name.split('/')[0]
      if (!packages[packageName]) {
        packages[packageName] = { name: packageName, plugins: [], totalTime: 0 }
      }
      packages[packageName].plugins.push(p)
      packages[packageName].totalTime += p.loadTime
    })
    return Object.values(packages).sort((a, b) => b.totalTime - a.totalTime)
  }
}