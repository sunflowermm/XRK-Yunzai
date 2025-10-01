import EventListener from "../../lib/listener/listener.js"
import cfg from "../../lib/config/config.js"
import { takeScreenshot } from "../../lib/common/takeScreenshot.js"
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import loader from '../plugins/loader.js'

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

      // 截图
      const screenshotPath = await takeScreenshot(htmlPath, 'plugin_load_report')
      
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

      logger.mark('插件加载报告发送成功')
    } catch (error) {
      logger.error(`发送插件加载报告失败：${error}`)
    }
  }

  /**
   * 生成插件加载HTML报告
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
    @font-face {
      font-family: 'HarmonyOS';
      src: url('./ZCOOLXiaoWei-Regular.ttf') format('truetype');
      font-weight: normal;
      font-style: normal;
    }
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
      font-family: 'HarmonyOS', 'Microsoft YaHei', sans-serif;
    }

    body {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 30px;
      min-height: 100vh;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: rgba(255, 255, 255, 0.98);
      border-radius: 20px;
      padding: 35px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    }

    .header {
      text-align: center;
      margin-bottom: 35px;
      padding-bottom: 25px;
      border-bottom: 3px solid #667eea;
    }

    .header h1 {
      font-size: 36px;
      color: #2c3e50;
      margin-bottom: 12px;
      font-weight: 700;
    }

    .header .subtitle {
      font-size: 16px;
      color: #7f8c8d;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 35px;
    }

    .stat-card {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 25px;
      border-radius: 15px;
      color: white;
      text-align: center;
      box-shadow: 0 8px 20px rgba(102, 126, 234, 0.3);
      transition: transform 0.3s;
    }

    .stat-card:hover {
      transform: translateY(-5px);
    }

    .stat-card .label {
      font-size: 14px;
      opacity: 0.9;
      margin-bottom: 8px;
    }

    .stat-card .value {
      font-size: 32px;
      font-weight: bold;
      margin-bottom: 5px;
    }

    .stat-card .unit {
      font-size: 14px;
      opacity: 0.8;
    }

    .section {
      margin-bottom: 35px;
    }

    .section-title {
      font-size: 24px;
      color: #2c3e50;
      margin-bottom: 20px;
      padding-left: 15px;
      border-left: 5px solid #667eea;
      font-weight: 600;
    }

    .plugin-package {
      background: #f8f9fa;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
      border: 2px solid #e9ecef;
    }

    .package-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
      padding-bottom: 15px;
      border-bottom: 2px dashed #dee2e6;
    }

    .package-name {
      font-size: 20px;
      font-weight: 600;
      color: #495057;
    }

    .package-stats {
      display: flex;
      gap: 20px;
      font-size: 14px;
      color: #6c757d;
    }

    .package-stats span {
      padding: 5px 12px;
      background: white;
      border-radius: 20px;
      border: 1px solid #dee2e6;
    }

    .plugin-list {
      display: grid;
      gap: 12px;
    }

    .plugin-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 15px 20px;
      background: white;
      border-radius: 10px;
      border-left: 4px solid #667eea;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
      transition: all 0.3s;
    }

    .plugin-item:hover {
      transform: translateX(5px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.2);
    }

    .plugin-item.failed {
      border-left-color: #e74c3c;
      background: #fff5f5;
    }

    .plugin-name {
      font-size: 15px;
      color: #2c3e50;
      font-weight: 500;
      flex: 1;
    }

    .plugin-time {
      font-size: 16px;
      font-weight: 600;
      color: #667eea;
      padding: 6px 15px;
      background: #f0f3ff;
      border-radius: 20px;
      min-width: 100px;
      text-align: center;
    }

    .plugin-item.failed .plugin-time {
      color: #e74c3c;
      background: #ffe8e8;
    }

    .plugin-item.slow .plugin-time {
      color: #f39c12;
      background: #fff8e8;
    }

    .error-msg {
      font-size: 12px;
      color: #e74c3c;
      margin-top: 5px;
      padding: 5px 10px;
      background: #ffe8e8;
      border-radius: 5px;
    }

    .summary {
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      color: white;
      padding: 25px;
      border-radius: 15px;
      margin-top: 30px;
      text-align: center;
    }

    .summary-title {
      font-size: 20px;
      margin-bottom: 15px;
      font-weight: 600;
    }

    .summary-content {
      display: flex;
      justify-content: space-around;
      flex-wrap: wrap;
      gap: 20px;
    }

    .summary-item {
      flex: 1;
      min-width: 150px;
    }

    .summary-item .label {
      font-size: 13px;
      opacity: 0.9;
      margin-bottom: 5px;
    }

    .summary-item .value {
      font-size: 24px;
      font-weight: bold;
    }

    .fastest, .slowest {
      padding: 20px;
      border-radius: 12px;
      margin-bottom: 20px;
    }

    .fastest {
      background: linear-gradient(135deg, #a8e063 0%, #56ab2f 100%);
      color: white;
    }

    .slowest {
      background: linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 100%);
      color: white;
    }

    .fastest h3, .slowest h3 {
      margin-bottom: 12px;
      font-size: 18px;
    }

    .time-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      margin-left: 8px;
    }

    .time-badge.fast {
      background: #a8e063;
      color: #2d5016;
    }

    .time-badge.medium {
      background: #f39c12;
      color: white;
    }

    .time-badge.slow {
      background: #e74c3c;
      color: white;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🚀 插件加载详情报告</h1>
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
        <h3>⚡ 最快加载: ${successPlugins[successPlugins.length - 1].name}</h3>
        <div>耗时: ${successPlugins[successPlugins.length - 1].loadTime.toFixed(4)} ms</div>
      </div>
      
      <div class="slowest">
        <h3>🐌 最慢加载: ${successPlugins[0].name}</h3>
        <div>耗时: ${successPlugins[0].loadTime.toFixed(4)} ms</div>
      </div>
    ` : ''}

    ${packageStats.length > 0 ? `
      <div class="section">
        <h2 class="section-title">📦 插件包加载详情 (${packageStats.length} 个)</h2>
        ${packageStats.map(pkg => `
          <div class="plugin-package">
            <div class="package-header">
              <div class="package-name">📁 ${pkg.name}</div>
              <div class="package-stats">
                <span>插件数: ${pkg.count}</span>
                <span>总耗时: ${pkg.totalTime.toFixed(2)} ms</span>
                <span>平均: ${(pkg.totalTime / pkg.count).toFixed(2)} ms</span>
              </div>
            </div>
            <div class="plugin-list">
              ${pkg.plugins.map(plugin => {
                const isSlow = plugin.loadTime > 100
                const timeBadge = plugin.loadTime < 10 ? 'fast' : plugin.loadTime < 50 ? 'medium' : 'slow'
                return `
                  <div class="plugin-item ${isSlow ? 'slow' : ''}">
                    <div class="plugin-name">
                      ${plugin.name}
                      <span class="time-badge ${timeBadge}">${plugin.loadTime < 10 ? '快' : plugin.loadTime < 50 ? '中' : '慢'}</span>
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
        <h2 class="section-title">📄 单文件插件 (${singleFilePlugins.length} 个)</h2>
        <div class="plugin-list">
          ${singleFilePlugins.map(plugin => {
            const isSlow = plugin.loadTime > 100
            const timeBadge = plugin.loadTime < 10 ? 'fast' : plugin.loadTime < 50 ? 'medium' : 'slow'
            return `
              <div class="plugin-item ${isSlow ? 'slow' : ''}">
                <div class="plugin-name">
                  ${plugin.name}
                  <span class="time-badge ${timeBadge}">${plugin.loadTime < 10 ? '快' : plugin.loadTime < 50 ? '中' : '慢'}</span>
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
        <h2 class="section-title">❌ 加载失败 (${failedPlugins.length} 个)</h2>
        <div class="plugin-list">
          ${failedPlugins.map(plugin => `
            <div class="plugin-item failed">
              <div>
                <div class="plugin-name">${plugin.name}</div>
                ${plugin.error ? `<div class="error-msg">错误: ${plugin.error}</div>` : ''}
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
          <div class="label">平均加载时间</div>
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