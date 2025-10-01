import EventListener from "../../lib/listener/listener.js"
import cfg from "../../lib/config/config.js"
import { takeScreenshot } from "../../lib/common/takeScreenshot.js"
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import loader from '../../lib/plugins/loader.js'

/**
 * 监听连接事件（理论上属于各类适配器的上线的事件）
 * 处理上线消息（与icqq无关）
 * 同时为NCQQ连接添加全局Bot函数
 */
export default class connectEvent extends EventListener {
  constructor() {
    super({
      event: "connect"
    })

    this.key = 'Yz:restart'
  }

  async execute(e) {
    if (!Bot.uin.includes(e.self_id))
      Bot.uin.push(e.self_id)

    const currentUin = e?.self_id || Bot.uin[0]
    if (!currentUin) {
      logger.debug('无法获取机器人QQ号，跳过重启消息发送')
      return
    }

    let restart = await redis.get(`${this.key}:${currentUin}`)
    if (!restart) {
      logger.debug('没有检测到重启信息，机器人正常启动')
      return
    }

    try {
      restart = JSON.parse(restart)
      let time = restart.time || new Date().getTime()
      time = (new Date().getTime() - time) / 1000

      // 发送重启成功消息，使用四位小数
      let restartMsg = `重启成功，耗时 ${time.toFixed(4)} 秒`
      
      if (restart.isGroup) {
        await Bot[currentUin].pickGroup(restart.id).sendMsg(restartMsg)
      } else {
        await Bot[currentUin].pickUser(restart.id).sendMsg(restartMsg)
      }

      // 生成并发送插件加载报告
      await this.sendPluginLoadReport(currentUin, restart)

      await redis.del(`${this.key}:${currentUin}`)
    } catch (error) {
      logger.error(`发送重启消息失败：${error}`)
    }

    if (!Bot.uin.includes(e.self_id))
      Bot.uin.push(e.self_id)
    
    if (!cfg.bot.online_msg_exp) return
    const key = `Yz:OnlineMsg:${e.self_id}`
    if (await redis.get(key)) return
    redis.set(key, "1", { EX: cfg.bot.online_msg_exp * 60 })
    Bot.sendMasterMsg(`欢迎使用【XRK-MultiBot v${cfg.package.version}】\n【向日葵妈咪妈咪哄】安装原神适配器和向日葵插件\n【#状态】查看运行状态\n【#日志】查看运行日志\n【#重启】重新启动\n【#更新】拉取 Git 更新\n【#全部更新】更新全部插件\n【#更新日志】查看更新日志`)
  }

  /**
   * 发送插件加载报告
   */
  async sendPluginLoadReport(currentUin, restart) {
    try {
      // 获取插件加载统计信息
      const stats = loader.getPluginStats()
      
      if (!stats || !stats.plugins || stats.plugins.length === 0) {
        logger.debug('没有插件加载统计信息')
        return
      }

      // 生成HTML报告
      const htmlPath = await this.generatePluginLoadHTML(stats)
      
      if (!htmlPath || !existsSync(htmlPath)) {
        logger.error('生成HTML报告失败')
        return
      }

      const screenshotConfig = {
        type: 'png',
        fullPage: true,
        waitUntil: 'networkidle0',
        deviceScaleFactor: 2,
        quality: 100,
        omitBackground: false
      }
      
      const screenshotPath = await takeScreenshot(htmlPath, 'plugin_load_report', screenshotConfig)
      
      if (!screenshotPath || !existsSync(screenshotPath)) {
        logger.error('生成截图失败')
        return
      }

      // 发送截图
      if (restart.isGroup) {
        await Bot[currentUin].pickGroup(restart.id).sendMsg([segment.image(screenshotPath)])
      } else {
        await Bot[currentUin].pickUser(restart.id).sendMsg([segment.image(screenshotPath)])
      }

      // 清理临时文件
      setTimeout(async () => {
        try {
          if (existsSync(htmlPath)) await fs.unlink(htmlPath)
          if (existsSync(screenshotPath)) await fs.unlink(screenshotPath)
        } catch (err) {
          logger.debug('清理临时文件失败:', err)
        }
      }, 5000)

      logger.mark('插件加载报告发送成功')
    } catch (error) {
      logger.error(`发送插件加载报告失败：${error}`)
    }
  }

  /**
   * 生成插件加载HTML报告（优化版）
   */
  async generatePluginLoadHTML(stats) {
    try {
      const dataDir = './data'
      if (!existsSync(dataDir)) {
        await fs.mkdir(dataDir, { recursive: true })
      }

      const timestamp = Date.now()
      const htmlPath = path.join(dataDir, `plugin_load_${timestamp}.html`)

      // 按加载时间排序
      const sortedPlugins = [...stats.plugins].sort((a, b) => b.loadTime - a.loadTime)
      
      // 分类统计
      const successPlugins = sortedPlugins.filter(p => p.success)
      const failedPlugins = sortedPlugins.filter(p => !p.success)
      
      // 区分单文件插件和插件包
      const singleFilePlugins = successPlugins.filter(p => !p.name.includes('/'))
      const packagePlugins = successPlugins.filter(p => p.name.includes('/'))
      
      // 按插件包分组
      const pluginsByPackage = {}
      packagePlugins.forEach(p => {
        const packageName = p.name.split('/')[0]
        if (!pluginsByPackage[packageName]) {
          pluginsByPackage[packageName] = []
        }
        pluginsByPackage[packageName].push(p)
      })

      // 计算每个插件包的总耗时
      const packageStats = Object.entries(pluginsByPackage).map(([name, plugins]) => ({
        name,
        plugins,
        totalTime: plugins.reduce((sum, p) => sum + p.loadTime, 0),
        count: plugins.length
      })).sort((a, b) => b.totalTime - a.totalTime)

      const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>插件加载报告</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Inter', 'Microsoft YaHei', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 40px 20px;
      min-height: 100vh;
      line-height: 1.6;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 24px;
      padding: 48px;
      box-shadow: 0 25px 80px rgba(0, 0, 0, 0.25);
      animation: fadeInUp 0.6s ease;
    }

    @keyframes fadeInUp {
      from {
        opacity: 0;
        transform: translateY(30px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .header {
      text-align: center;
      margin-bottom: 48px;
      padding-bottom: 32px;
      border-bottom: 2px solid #e0e7ff;
      position: relative;
    }

    .header::after {
      content: '';
      position: absolute;
      bottom: -2px;
      left: 50%;
      transform: translateX(-50%);
      width: 120px;
      height: 4px;
      background: linear-gradient(90deg, #667eea, #764ba2);
      border-radius: 2px;
    }

    .header h1 {
      font-size: 42px;
      font-weight: 700;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 12px;
      letter-spacing: -0.5px;
    }

    .header .subtitle {
      font-size: 16px;
      color: #64748b;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 2px;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 24px;
      margin-bottom: 48px;
    }

    .stat-card {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 32px 28px;
      border-radius: 20px;
      color: white;
      text-align: center;
      box-shadow: 0 10px 30px rgba(102, 126, 234, 0.3);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    }

    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0) 100%);
      opacity: 0;
      transition: opacity 0.3s;
    }

    .stat-card:hover {
      transform: translateY(-8px) scale(1.02);
      box-shadow: 0 20px 40px rgba(102, 126, 234, 0.4);
    }

    .stat-card:hover::before {
      opacity: 1;
    }

    .stat-card .label {
      font-size: 13px;
      opacity: 0.95;
      margin-bottom: 12px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .stat-card .value {
      font-size: 40px;
      font-weight: 700;
      margin-bottom: 8px;
      line-height: 1;
    }

    .stat-card .unit {
      font-size: 14px;
      opacity: 0.9;
      font-weight: 400;
    }

    .section {
      margin-bottom: 48px;
      animation: fadeIn 0.6s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .section-title {
      font-size: 28px;
      color: #1e293b;
      margin-bottom: 28px;
      padding-left: 20px;
      border-left: 6px solid #667eea;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .plugin-package {
      background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
      border-radius: 16px;
      padding: 28px;
      margin-bottom: 24px;
      border: 2px solid #e2e8f0;
      transition: all 0.3s;
    }

    .plugin-package:hover {
      border-color: #cbd5e1;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
    }

    .package-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 20px;
      border-bottom: 2px dashed #cbd5e1;
    }

    .package-name {
      font-size: 22px;
      font-weight: 700;
      color: #334155;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .package-stats {
      display: flex;
      gap: 16px;
      font-size: 14px;
      color: #64748b;
      flex-wrap: wrap;
    }

    .package-stats span {
      padding: 8px 16px;
      background: white;
      border-radius: 12px;
      border: 1.5px solid #e2e8f0;
      font-weight: 600;
      transition: all 0.2s;
    }

    .package-stats span:hover {
      background: #f8fafc;
      border-color: #cbd5e1;
    }

    .plugin-list {
      display: grid;
      gap: 14px;
    }

    .plugin-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 18px 24px;
      background: white;
      border-radius: 14px;
      border-left: 5px solid #667eea;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .plugin-item:hover {
      transform: translateX(8px);
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.15);
      border-left-width: 6px;
    }

    .plugin-item.failed {
      border-left-color: #ef4444;
      background: #fef2f2;
    }

    .plugin-item.slow {
      border-left-color: #f59e0b;
    }

    .plugin-name {
      font-size: 16px;
      color: #1e293b;
      font-weight: 600;
      flex: 1;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .plugin-time {
      font-size: 17px;
      font-weight: 700;
      color: #667eea;
      padding: 8px 20px;
      background: #eef2ff;
      border-radius: 12px;
      min-width: 120px;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }

    .plugin-item.failed .plugin-time {
      color: #ef4444;
      background: #fee2e2;
    }

    .plugin-item.slow .plugin-time {
      color: #f59e0b;
      background: #fef3c7;
    }

    .time-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 6px 14px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .time-badge.fast {
      background: linear-gradient(135deg, #10b981, #059669);
      color: white;
    }

    .time-badge.medium {
      background: linear-gradient(135deg, #f59e0b, #d97706);
      color: white;
    }

    .time-badge.slow {
      background: linear-gradient(135deg, #ef4444, #dc2626);
      color: white;
    }

    .error-msg {
      font-size: 13px;
      color: #dc2626;
      margin-top: 8px;
      padding: 8px 14px;
      background: #fee2e2;
      border-radius: 8px;
      border-left: 3px solid #ef4444;
      font-family: 'Courier New', monospace;
    }

    .summary {
      background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
      color: white;
      padding: 36px 32px;
      border-radius: 20px;
      margin-top: 40px;
      text-align: center;
      box-shadow: 0 15px 40px rgba(139, 92, 246, 0.3);
    }

    .summary-title {
      font-size: 24px;
      margin-bottom: 24px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .summary-content {
      display: flex;
      justify-content: space-around;
      flex-wrap: wrap;
      gap: 32px;
    }

    .summary-item {
      flex: 1;
      min-width: 180px;
    }

    .summary-item .label {
      font-size: 14px;
      opacity: 0.95;
      margin-bottom: 8px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .summary-item .value {
      font-size: 32px;
      font-weight: 700;
      line-height: 1;
    }

    .fastest, .slowest {
      padding: 28px 32px;
      border-radius: 18px;
      margin-bottom: 24px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
      transition: transform 0.3s;
    }

    .fastest:hover, .slowest:hover {
      transform: scale(1.02);
    }

    .fastest {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white;
    }

    .slowest {
      background: linear-gradient(135deg, #f43f5e 0%, #e11d48 100%);
      color: white;
    }

    .fastest h3, .slowest h3 {
      margin-bottom: 14px;
      font-size: 20px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .fastest div, .slowest div {
      font-size: 16px;
      font-weight: 600;
      opacity: 0.95;
    }

    @media (max-width: 768px) {
      .container {
        padding: 28px 20px;
      }
      
      .header h1 {
        font-size: 32px;
      }
      
      .stats-grid {
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 16px;
      }
      
      .stat-card {
        padding: 24px 20px;
      }
      
      .package-header {
        flex-direction: column;
        align-items: flex-start;
        gap: 16px;
      }
      
      .plugin-item {
        flex-direction: column;
        align-items: flex-start;
        gap: 12px;
      }
      
      .plugin-time {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🚀 插件加载性能报告</h1>
      <div class="subtitle">Plugin Load Performance Report</div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">总加载耗时</div>
        <div class="value">${(stats.totalLoadTime / 1000).toFixed(4)}</div>
        <div class="unit">秒</div>
      </div>
      <div class="stat-card">
        <div class="label">成功加载</div>
        <div class="value">${successPlugins.length}</div>
        <div class="unit">个插件</div>
      </div>
      <div class="stat-card">
        <div class="label">定时任务</div>
        <div class="value">${stats.taskCount || 0}</div>
        <div class="unit">个任务</div>
      </div>
      <div class="stat-card">
        <div class="label">扩展插件</div>
        <div class="value">${stats.extendedCount || 0}</div>
        <div class="unit">个插件</div>
      </div>
    </div>

    ${successPlugins.length > 0 ? `
      <div class="fastest">
        <h3>⚡ 最快加载</h3>
        <div>${successPlugins[successPlugins.length - 1].name} - ${successPlugins[successPlugins.length - 1].loadTime.toFixed(4)} ms</div>
      </div>
      
      <div class="slowest">
        <h3>🐌 最慢加载</h3>
        <div>${successPlugins[0].name} - ${successPlugins[0].loadTime.toFixed(4)} ms</div>
      </div>
    ` : ''}

    ${packageStats.length > 0 ? `
      <div class="section">
        <h2 class="section-title">📦 插件包加载详情</h2>
        ${packageStats.map(pkg => `
          <div class="plugin-package">
            <div class="package-header">
              <div class="package-name">📁 ${pkg.name}</div>
              <div class="package-stats">
                <span>📊 ${pkg.count} 个插件</span>
                <span>⏱️ ${pkg.totalTime.toFixed(2)} ms</span>
                <span>📈 平均 ${(pkg.totalTime / pkg.count).toFixed(2)} ms</span>
              </div>
            </div>
            <div class="plugin-list">
              ${pkg.plugins.map(plugin => {
                const isSlow = plugin.loadTime > 100
                const timeBadge = plugin.loadTime < 10 ? 'fast' : plugin.loadTime < 50 ? 'medium' : 'slow'
                const badgeText = plugin.loadTime < 10 ? '⚡ 快' : plugin.loadTime < 50 ? '📊 中' : '🐌 慢'
                return `
                  <div class="plugin-item ${isSlow ? 'slow' : ''}">
                    <div class="plugin-name">
                      ${plugin.name}
                      <span class="time-badge ${timeBadge}">${badgeText}</span>
                    </div>
                    <div class="plugin-time">${plugin.loadTime.toFixed(4)} ms</div>
                  </div>
                `
              }).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    ` : ''}

    ${singleFilePlugins.length > 0 ? `
      <div class="section">
        <h2 class="section-title">📄 单文件插件</h2>
        <div class="plugin-list">
          ${singleFilePlugins.map(plugin => {
            const isSlow = plugin.loadTime > 100
            const timeBadge = plugin.loadTime < 10 ? 'fast' : plugin.loadTime < 50 ? 'medium' : 'slow'
            const badgeText = plugin.loadTime < 10 ? '⚡ 快' : plugin.loadTime < 50 ? '📊 中' : '🐌 慢'
            return `
              <div class="plugin-item ${isSlow ? 'slow' : ''}">
                <div class="plugin-name">
                  ${plugin.name}
                  <span class="time-badge ${timeBadge}">${badgeText}</span>
                </div>
                <div class="plugin-time">${plugin.loadTime.toFixed(4)} ms</div>
              </div>
            `
          }).join('')}
        </div>
      </div>
    ` : ''}

    ${failedPlugins.length > 0 ? `
      <div class="section">
        <h2 class="section-title">❌ 加载失败</h2>
        <div class="plugin-list">
          ${failedPlugins.map(plugin => `
            <div class="plugin-item failed">
              <div style="flex: 1;">
                <div class="plugin-name">${plugin.name}</div>
                ${plugin.error ? `<div class="error-msg">❗ ${plugin.error}</div>` : ''}
              </div>
              <div class="plugin-time">${plugin.loadTime.toFixed(4)} ms</div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}

    <div class="summary">
      <div class="summary-title">📊 加载统计摘要</div>
      <div class="summary-content">
        <div class="summary-item">
          <div class="label">平均时间</div>
          <div class="value">${(stats.totalLoadTime / stats.plugins.length).toFixed(2)} ms</div>
        </div>
        <div class="summary-item">
          <div class="label">成功率</div>
          <div class="value">${((successPlugins.length / stats.plugins.length) * 100).toFixed(1)}%</div>
        </div>
        <div class="summary-item">
          <div class="label">慢速插件</div>
          <div class="value">${successPlugins.filter(p => p.loadTime > 100).length}</div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
      `

      await fs.writeFile(htmlPath, html, 'utf-8')
      logger.mark(`插件加载报告已生成: ${htmlPath}`)
      
      return htmlPath
    } catch (error) {
      logger.error(`生成HTML报告失败: ${error}`)
      return null
    }
  }
}