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

      // 发送重启成功消息
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

      // 截图 - 使用正确的完整路径
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
      
      // 清理临时HTML文件
      setTimeout(async () => {
        try {
          await fs.unlink(htmlPath)
        } catch (err) {
          // 忽略删除错误
        }
      }, 5000)
      
    } catch (error) {
      logger.error(`发送插件加载报告失败：${error}`)
    }
  }

  /**
   * 生成插件加载HTML报告
   */
  async generatePluginLoadHTML(stats) {
    try {
      const dataDir = path.join(process.cwd(), 'temp')
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
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: rgba(255, 255, 255, 0.95);
      border-radius: 16px;
      padding: 30px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(10px);
    }

    .header {
      text-align: center;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 2px solid #e0e6ed;
    }

    .header h1 {
      font-size: 28px;
      color: #2c3e50;
      margin-bottom: 8px;
      font-weight: 600;
    }

    .header .subtitle {
      font-size: 14px;
      color: #95a5a6;
      font-weight: 400;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 15px;
      margin-bottom: 30px;
    }

    .stat-card {
      background: linear-gradient(135deg, #667eea, #764ba2);
      padding: 20px;
      border-radius: 12px;
      color: white;
      text-align: center;
      transition: transform 0.2s;
    }

    .stat-card:hover {
      transform: translateY(-2px);
    }

    .stat-card .label {
      font-size: 12px;
      opacity: 0.9;
      margin-bottom: 5px;
    }

    .stat-card .value {
      font-size: 26px;
      font-weight: bold;
      margin-bottom: 3px;
    }

    .stat-card .unit {
      font-size: 12px;
      opacity: 0.8;
    }

    .highlight-cards {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
      margin-bottom: 30px;
    }

    .highlight-card {
      padding: 15px 20px;
      border-radius: 10px;
      color: white;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .fastest {
      background: linear-gradient(135deg, #56ab2f, #a8e063);
    }

    .slowest {
      background: linear-gradient(135deg, #ee5a6f, #ff6b6b);
    }

    .highlight-card h3 {
      font-size: 14px;
      margin-bottom: 4px;
      opacity: 0.95;
    }

    .highlight-card .plugin-name {
      font-size: 16px;
      font-weight: 600;
    }

    .highlight-card .time {
      font-size: 18px;
      font-weight: bold;
    }

    .section {
      margin-bottom: 25px;
    }

    .section-title {
      font-size: 18px;
      color: #2c3e50;
      margin-bottom: 15px;
      padding-left: 12px;
      border-left: 4px solid #667eea;
      font-weight: 600;
    }

    .plugin-package {
      background: #f7f9fc;
      border-radius: 10px;
      padding: 15px;
      margin-bottom: 15px;
      border: 1px solid #e0e6ed;
    }

    .package-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      padding-bottom: 10px;
      border-bottom: 1px dashed #dee2e6;
    }

    .package-name {
      font-size: 16px;
      font-weight: 600;
      color: #2c3e50;
    }

    .package-stats {
      display: flex;
      gap: 12px;
      font-size: 12px;
    }

    .package-stats span {
      padding: 3px 8px;
      background: white;
      border-radius: 12px;
      color: #667eea;
      border: 1px solid #667eea;
    }

    .plugin-list {
      display: grid;
      gap: 8px;
    }

    .plugin-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 15px;
      background: white;
      border-radius: 8px;
      transition: all 0.2s;
      border-left: 3px solid transparent;
    }

    .plugin-item:hover {
      transform: translateX(2px);
      border-left-color: #667eea;
      box-shadow: 0 2px 8px rgba(102, 126, 234, 0.1);
    }

    .plugin-item.failed {
      background: #fff5f5;
      border-left-color: #e74c3c;
    }

    .plugin-name {
      font-size: 14px;
      color: #2c3e50;
      flex: 1;
    }

    .plugin-time {
      font-size: 14px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 12px;
      min-width: 80px;
      text-align: center;
    }

    .time-fast {
      color: #27ae60;
      background: #e8f8f5;
    }

    .time-medium {
      color: #f39c12;
      background: #fef5e7;
    }

    .time-slow {
      color: #e74c3c;
      background: #fadbd8;
    }

    .error-msg {
      font-size: 11px;
      color: #e74c3c;
      margin-top: 4px;
      padding: 3px 8px;
      background: #ffe8e8;
      border-radius: 4px;
      display: inline-block;
    }

    .summary {
      background: linear-gradient(135deg, #f093fb, #f5576c);
      color: white;
      padding: 20px;
      border-radius: 12px;
      margin-top: 25px;
      text-align: center;
    }

    .summary-title {
      font-size: 16px;
      margin-bottom: 12px;
      font-weight: 600;
    }

    .summary-content {
      display: flex;
      justify-content: space-around;
      flex-wrap: wrap;
      gap: 15px;
    }

    .summary-item .label {
      font-size: 12px;
      opacity: 0.9;
      margin-bottom: 4px;
    }

    .summary-item .value {
      font-size: 20px;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🚀 插件加载报告</h1>
      <div class="subtitle">XRK-Yunzai Plugin Load Report</div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">总加载耗时</div>
        <div class="value">${(stats.totalLoadTime / 1000).toFixed(3)}</div>
        <div class="unit">秒</div>
      </div>
      <div class="stat-card">
        <div class="label">成功加载</div>
        <div class="value">${successPlugins.length}</div>
        <div class="unit">个插件</div>
      </div>
      <div class="stat-card">
        <div class="label">失败数量</div>
        <div class="value">${failedPlugins.length}</div>
        <div class="unit">个插件</div>
      </div>
      <div class="stat-card">
        <div class="label">定时任务</div>
        <div class="value">${stats.taskCount || 0}</div>
        <div class="unit">个任务</div>
      </div>
    </div>

    ${successPlugins.length > 0 ? `
      <div class="highlight-cards">
        <div class="highlight-card fastest">
          <div>
            <h3>⚡ 最快加载</h3>
            <div class="plugin-name">${successPlugins[successPlugins.length - 1].name}</div>
          </div>
          <div class="time">${successPlugins[successPlugins.length - 1].loadTime.toFixed(2)} ms</div>
        </div>
        <div class="highlight-card slowest">
          <div>
            <h3>🐌 最慢加载</h3>
            <div class="plugin-name">${successPlugins[0].name}</div>
          </div>
          <div class="time">${successPlugins[0].loadTime.toFixed(2)} ms</div>
        </div>
      </div>
    ` : ''}

    ${packageStats.length > 0 ? `
      <div class="section">
        <h2 class="section-title">📦 插件包 (${packageStats.length})</h2>
        ${packageStats.map(pkg => `
          <div class="plugin-package">
            <div class="package-header">
              <div class="package-name">${pkg.name}</div>
              <div class="package-stats">
                <span>${pkg.count} 个</span>
                <span>${pkg.totalTime.toFixed(1)} ms</span>
                <span>均值 ${(pkg.totalTime / pkg.count).toFixed(1)} ms</span>
              </div>
            </div>
            <div class="plugin-list">
              ${pkg.plugins.map(plugin => {
                const timeClass = plugin.loadTime < 10 ? 'time-fast' : 
                                 plugin.loadTime < 50 ? 'time-medium' : 'time-slow'
                return `
                  <div class="plugin-item">
                    <div class="plugin-name">${plugin.name.split('/').pop()}</div>
                    <div class="plugin-time ${timeClass}">${plugin.loadTime.toFixed(2)} ms</div>
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
        <h2 class="section-title">📄 单文件插件 (${singleFilePlugins.length})</h2>
        <div class="plugin-list">
          ${singleFilePlugins.map(plugin => {
            const timeClass = plugin.loadTime < 10 ? 'time-fast' : 
                             plugin.loadTime < 50 ? 'time-medium' : 'time-slow'
            return `
              <div class="plugin-item">
                <div class="plugin-name">${plugin.name}</div>
                <div class="plugin-time ${timeClass}">${plugin.loadTime.toFixed(2)} ms</div>
              </div>
            `
          }).join('')}
        </div>
      </div>
    ` : ''}

    ${failedPlugins.length > 0 ? `
      <div class="section">
        <h2 class="section-title">❌ 加载失败 (${failedPlugins.length})</h2>
        <div class="plugin-list">
          ${failedPlugins.map(plugin => `
            <div class="plugin-item failed">
              <div>
                <div class="plugin-name">${plugin.name}</div>
                ${plugin.error ? `<div class="error-msg">${plugin.error}</div>` : ''}
              </div>
              <div class="plugin-time time-slow">${plugin.loadTime.toFixed(2)} ms</div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}

    <div class="summary">
      <div class="summary-title">📊 统计摘要</div>
      <div class="summary-content">
        <div class="summary-item">
          <div class="label">平均耗时</div>
          <div class="value">${(stats.totalLoadTime / stats.plugins.length).toFixed(1)} ms</div>
        </div>
        <div class="summary-item">
          <div class="label">成功率</div>
          <div class="value">${((successPlugins.length / stats.plugins.length) * 100).toFixed(1)}%</div>
        </div>
        <div class="summary-item">
          <div class="label">慢速插件</div>
          <div class="value">${successPlugins.filter(p => p.loadTime > 100).length} 个</div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
      `

      await fs.writeFile(htmlPath, html, 'utf-8')
      logger.mark(`插件加载报告HTML已生成: ${htmlPath}`)
      
      return htmlPath
    } catch (error) {
      logger.error(`生成HTML报告失败: ${error}`)
      return null
    }
  }
}