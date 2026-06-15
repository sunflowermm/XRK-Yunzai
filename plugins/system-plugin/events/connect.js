import EventListener from "../../../lib/listener/listener.js"
import cfg from "../../../lib/config/config.js"
import Renderer from "../../../lib/renderer/loader.js"
import { toBuffer } from "../../../lib/renderer/screenshot-utils.js"
import path from 'path'
import { FileUtils } from '../../../lib/utils/file-utils.js'
import { resolveProjectPath, DATA_DIR } from "../../../lib/config/config-constants.js"

const RESTART_KEY = 'Yz:restart'

export default class connectEvent extends EventListener {
  static eventSubscribe = {
    connect: async function (e) { await new this().execute(e) }
  }

  dataDir = resolveProjectPath(DATA_DIR)

  constructor() {
    super({ event: "connect" })
    this.renderer = Renderer.getRenderer()
  }

  async execute(e) {
    if (!Bot.uin.includes(e.self_id)) Bot.uin.push(e.self_id)
    const currentUin = e?.self_id || Bot.uin[0]
    if (!currentUin) return

    const restart = await this.getRestartInfo(currentUin)
    if (restart && (!restart.adapter || restart.adapter === e.adapter)) {
      await this.handleRestart(currentUin, restart, e)
    }
    await this.handleNormalStart(e)
  }

  async getRestartInfo(uin) {
    const data = await redis.get(`${RESTART_KEY}:${uin}`)
    if (!data) return null
    try {
      return JSON.parse(data)
    } catch {
      return null
    }
  }

  async handleNormalStart(e) {
    if (!cfg.bot.online_msg_exp) return
    if (e.adapter === 'device') return
    const key = `Yz:connect888Msg:${e.self_id}`
    if (await redis.get(key)) return
    redis.set(key, "1", { EX: cfg.bot.online_msg_exp * 60 })
    await this.sendWelcomeMessage()
  }

  async handleRestart(currentUin, restart, e) {
    const time = ((Date.now() - restart.time) / 1000).toFixed(1)
    const target = (e.adapter === 'device' && typeof e.sendReply === 'function')
      ? { sendMsg: (content) => Promise.resolve(e.sendReply(content)) }
      : (restart.isGroup ? Bot[currentUin].pickGroup(restart.id) : Bot[currentUin].pickUser(restart.id))
    await target.sendMsg(`重启成功，耗时 ${time} 秒`)
    await this.sendPluginLoadReport(target)
    await redis.del(`${RESTART_KEY}:${currentUin}`)
  }

  /** 使用 renderer 截图，返回 Buffer 或路径字符串；兼容返回 { type, file, name } 的渲染器 */
  async takeScreenshot(htmlPath, name, options = {}) {
    if (!this.renderer) return false
    try {
      const raw = await this.renderer.screenshot(name, { tplFile: htmlPath, saveId: name, ...options })
      if (!raw) return false
      if (Buffer.isBuffer(raw)) return raw
      if (typeof raw === 'string') return raw
      const buf = toBuffer(raw)
      if (buf) return buf
      if (raw && typeof raw === 'object') {
        const file = raw.file ?? raw.data
        if (file != null) {
          if (Buffer.isBuffer(file)) return file
          if (typeof file === 'string') return file
          const b = toBuffer(file)
          if (b) return b
          try {
            const fromData = Buffer.from(file)
            if (fromData.length) return fromData
          } catch (err) {
            Bot.makeLog('debug', `[connect] Buffer.from 跳过: ${err?.message || err}`, 'Connect');
          }
        }
      }
      return false
    } catch (err) {
      Bot.makeLog('error', `[connect] 截图失败: ${err.message}`, 'Connect')
      return false
    }
  }

  async sendWelcomeMessage() {
    const htmlPath = await this.generateHTML('welcome', this.getWelcomeHTML())
    const img = await this.takeScreenshot(htmlPath, 'welcome_message', { width: 520, deviceScaleFactor: 3 })
    if (img) Bot.sendMasterMsg([segment.image(img)])
    this.cleanupFile(htmlPath)
  }

  async sendPluginLoadReport(target) {
    const stats = Bot.PluginsLoader?.getPluginStats?.()
    if (!stats) return
    const htmlPath = await this.generateHTML('plugin_load', this.getPluginLoadHTML(stats))
    const img = await this.takeScreenshot(htmlPath, 'plugin_load_report', { width: 800, deviceScaleFactor: 1.5 })
    if (!img) {
      Bot.makeLog('warn', '[connect] 插件加载报告: 截图未得到 img（见上方 takeScreenshot 日志），未发送', 'Connect')
      this.cleanupFile(htmlPath)
      return
    }
    await target.sendMsg([segment.image(img)])
    Bot.makeLog('mark', '[connect] 插件加载报告已 reply 发出', 'Connect')
    this.cleanupFile(htmlPath)
  }

  async generateHTML(prefix, content) {
    const htmlPath = path.join(this.dataDir, `${prefix}_${Date.now()}.html`)
    await FileUtils.writeFile(htmlPath, content, 'utf-8')
    return htmlPath
  }

  cleanupFile(filePath, delay = 5000) {
    setTimeout(
      () => FileUtils.unlink(filePath).catch((err) => {
        Bot.makeLog('debug', `[connect] 清理临时文件失败 ${filePath}: ${err?.message || err}`, 'ConnectEvent');
      }),
      delay
    );
  }

  getWelcomeHTML() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>XRK-Yunzai</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/font-awesome@4.7.0/css/font-awesome.min.css" rel="stylesheet">
  <style>
    @font-face {
      font-family: 'Genshin';
      src: url('./fonts/Genshin.ttf') format('truetype');
      font-weight: normal;
      font-style: normal;
    }

    body {
      font-family: 'Genshin', -apple-system, 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh;
      background: linear-gradient(135deg, #4a6cf7 0%, #764ba2 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      margin: 0;
    }

    .container {
      width: 520px;
      background: rgba(255, 255, 255, 0.98);
      border-radius: 24px;
      box-shadow: 0 15px 40px rgba(0, 0, 0, 0.15);
      overflow: hidden;
      position: relative;
    }

    .header {
      background: linear-gradient(135deg, #667eea, #764ba2);
      padding: 30px 20px;
      text-align: center;
      color: white;
      position: relative;
      overflow: hidden;
    }

    .header::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-image: url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.05'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E");
    }

    .logo {
      width: 80px;
      height: 80px;
      background: white;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 15px;
      position: relative;
      z-index: 1;
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
    }

    .logo-text {
      color: #667eea;
      font-size: 36px;
      font-weight: 700;
      letter-spacing: -1px;
    }

    .title {
      font-size: 28px;
      margin-bottom: 5px;
      position: relative;
      z-index: 1;
    }

    .version {
      font-size: 14px;
      opacity: 0.9;
      position: relative;
      z-index: 1;
    }

    .commands {
      padding: 25px 20px;
    }

    .commands-title {
      font-size: 16px;
      color: #4b5563;
      margin-bottom: 15px;
      padding-left: 5px;
      font-weight: 600;
    }

    .command-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .command {
      background: #f9fafb;
      padding: 16px;
      border-radius: 12px;
      border: 1px solid #e5e7eb;
      transition: all 0.2s ease;
      cursor: pointer;
    }

    .command:hover {
      transform: translateY(-2px);
      box-shadow: 0 5px 15px rgba(102, 126, 234, 0.1);
      border-color: #667eea;
    }

    .command-tag {
      font-size: 14px;
      color: #4c51bf;
      font-weight: 600;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
    }

    .command-tag i {
      margin-right: 6px;
      font-size: 13px;
    }

    .command-desc {
      font-size: 12px;
      color: #6b7280;
      line-height: 1.4;
    }

    .special {
      grid-column: span 2;
      background: linear-gradient(135deg, #667eea, #764ba2);
      border: none;
    }

    .special:hover {
      box-shadow: 0 5px 20px rgba(102, 126, 234, 0.3);
    }

    .special .command-tag,
    .special .command-desc {
      color: white;
    }

    .footer {
      padding: 15px 20px;
      background: #f9fafb;
      border-top: 1px solid #e5e7eb;
      text-align: center;
      font-size: 12px;
      color: #9ca3af;
    }

    .shine-effect {
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: linear-gradient(
        to right,
        rgba(255, 255, 255, 0) 0%,
        rgba(255, 255, 255, 0.1) 50%,
        rgba(255, 255, 255, 0) 100%
      );
      transform: rotate(30deg);
      animation: shine 6s infinite;
    }

    @keyframes shine {
      0% {
        transform: translateX(-100%) rotate(30deg);
      }
      100% {
        transform: translateX(100%) rotate(30deg);
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="shine-effect"></div>
      <div class="logo">
        <div class="logo-text">XRK</div>
      </div>
      <h1 class="title">XRK-Yunzai</h1>
      <div class="version">Version ${cfg.package.version}</div>
    </div>
    
    <div class="commands">
      <div class="commands-title">可用命令</div>
      <div class="command-grid">
        <div class="command special">
          <div class="command-tag">
            <i class="fa fa-magic"></i>向日葵妈咪妈咪哄
          </div>
          <div class="command-desc">安装原神适配器和向日葵插件（本控制台默认主人）</div>
        </div>
        
        <div class="command">
          <div class="command-tag">
            <i class="fa fa-dashboard"></i>#状态
          </div>
          <div class="command-desc">查看运行状态</div>
        </div>
        
        <div class="command">
          <div class="command-tag">
            <i class="fa fa-file-text-o"></i>#日志
          </div>
          <div class="command-desc">查看运行日志</div>
        </div>
        
        <div class="command">
          <div class="command-tag">
            <i class="fa fa-refresh"></i>#重启
          </div>
          <div class="command-desc">重新启动</div>
        </div>
        
        <div class="command">
          <div class="command-tag">
            <i class="fa fa-pull-right"></i>#更新
          </div>
          <div class="command-desc">拉取Git更新</div>
        </div>
        
        <div class="command">
          <div class="command-tag">
            <i class="fa fa-download"></i>#全部更新
          </div>
          <div class="command-desc">更新全部插件</div>
        </div>
        
        <div class="command">
          <div class="command-tag">
            <i class="fa fa-history"></i>#更新日志
          </div>
          <div class="command-desc">查看更新记录</div>
        </div>
      </div>
    </div>
    
    <div class="footer">
      Powered by XRK-Yunzai
    </div>
  </div>
</body>
</html>`
  }

  getPluginLoadHTML(stats) {
    const plugins = [...(stats?.plugins || [])].sort((a, b) => (b.loadTime || 0) - (a.loadTime || 0))
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
          <h2 class="section-title">📄 单JS</h2>
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
          <h2 class="section-title">📦 插件包</h2>
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