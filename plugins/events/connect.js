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
      
      // 发送启动消息
      if (cfg.bot.online_msg_exp) {
        const key = `Yz:OnlineMsg:${e.self_id}`
        if (!(await redis.get(key))) {
          redis.set(key, "1", { EX: cfg.bot.online_msg_exp * 60 })
          await this.sendWelcomeMessage(currentUin)
        }
      }
      return
    }

    try {
      restart = JSON.parse(restart)
      let time = restart.time || new Date().getTime()
      time = (new Date().getTime() - time) / 1000

      // 发送简单的重启成功消息
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
  }

  /**
   * 发送欢迎消息（使用HTML）
   */
  async sendWelcomeMessage(currentUin) {
    try {
      const htmlPath = await this.generateWelcomeHTML()
      
      if (!htmlPath || !existsSync(htmlPath)) {
        // 如果HTML生成失败，发送文本消息
        Bot.sendMasterMsg(`欢迎使用【XRK-MultiBot v${cfg.package.version}】\n【向日葵妈咪妈咪哄】安装原神适配器和向日葵插件\n【#状态】查看运行状态\n【#日志】查看运行日志\n【#重启】重新启动\n【#更新】拉取 Git 更新\n【#全部更新】更新全部插件\n【#更新日志】查看更新日志`)
        return
      }

      // 截图
      const screenshotPath = await takeScreenshot(htmlPath, 'welcome_message', {
        width: 600,
        height: 420,
        deviceScaleFactor: 2,
        fullPage: false
      })
      
      if (!screenshotPath || !existsSync(screenshotPath)) {
        // 截图失败，发送文本消息
        Bot.sendMasterMsg(`欢迎使用【XRK-MultiBot v${cfg.package.version}】\n【向日葵妈咪妈咪哄】安装原神适配器和向日葵插件\n【#状态】查看运行状态\n【#日志】查看运行日志\n【#重启】重新启动\n【#更新】拉取 Git 更新\n【#全部更新】更新全部插件\n【#更新日志】查看更新日志`)
        return
      }

      Bot.sendMasterMsg([segment.image(screenshotPath)])
      logger.mark('欢迎消息发送成功')
      
      // 清理临时HTML文件
      setTimeout(async () => {
        try {
          await fs.unlink(htmlPath)
        } catch (err) {
          // 忽略删除错误
        }
      }, 5000)
      
    } catch (error) {
      logger.error(`发送欢迎消息失败：${error}`)
      // 发送文本消息作为备用
      Bot.sendMasterMsg(`欢迎使用【XRK-MultiBot v${cfg.package.version}】\n【#状态】查看运行状态\n【#日志】查看运行日志\n【#重启】重新启动`)
    }
  }

  /**
   * 生成欢迎消息HTML
   */
  async generateWelcomeHTML() {
    try {
      const dataDir = path.join(process.cwd(), 'data')
      if (!existsSync(dataDir)) {
        await fs.mkdir(dataDir, { recursive: true })
      }

      const timestamp = Date.now()
      const htmlPath = path.join(dataDir, `welcome_${timestamp}.html`)

      const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome</title>
  <style>
    @font-face {
      font-family: 'CustomFont';
      src: url('./fonts/font.ttf') format('truetype');
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'CustomFont', -apple-system, 'Microsoft YaHei', sans-serif;
      width: 600px;
      height: 420px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
    }

    .container {
      width: 100%;
      height: 100%;
      background: rgba(255, 255, 255, 0.95);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 30px;
      position: relative;
      backdrop-filter: blur(10px);
    }

    .particles {
      position: absolute;
      width: 100%;
      height: 100%;
      top: 0;
      left: 0;
      pointer-events: none;
    }

    .particle {
      position: absolute;
      width: 4px;
      height: 4px;
      background: rgba(102, 126, 234, 0.3);
      border-radius: 50%;
      animation: float 15s infinite;
    }

    @keyframes float {
      0%, 100% {
        transform: translateY(0) translateX(0);
        opacity: 0;
      }
      10% {
        opacity: 1;
      }
      90% {
        opacity: 1;
      }
      100% {
        transform: translateY(-100vh) translateX(50px);
        opacity: 0;
      }
    }

    .logo {
      width: 80px;
      height: 80px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      border-radius: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 20px;
      box-shadow: 0 10px 25px rgba(102, 126, 234, 0.3);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% {
        transform: scale(1);
      }
      50% {
        transform: scale(1.05);
      }
    }

    .logo-text {
      color: white;
      font-size: 36px;
      font-weight: bold;
    }

    .title {
      font-size: 24px;
      color: #2c3e50;
      margin-bottom: 8px;
      font-weight: 600;
      text-align: center;
      background: linear-gradient(135deg, #667eea, #764ba2);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .version {
      font-size: 14px;
      color: #7f8c8d;
      margin-bottom: 25px;
      font-weight: 400;
    }

    .commands {
      width: 100%;
      max-width: 400px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 10px;
    }

    .command {
      background: linear-gradient(135deg, rgba(102, 126, 234, 0.1), rgba(118, 75, 162, 0.1));
      padding: 12px 16px;
      border-radius: 10px;
      border: 1px solid rgba(102, 126, 234, 0.2);
      transition: all 0.3s;
      cursor: pointer;
    }

    .command:hover {
      transform: translateY(-2px);
      box-shadow: 0 5px 15px rgba(102, 126, 234, 0.2);
      background: linear-gradient(135deg, rgba(102, 126, 234, 0.15), rgba(118, 75, 162, 0.15));
    }

    .command-tag {
      font-size: 13px;
      color: #667eea;
      font-weight: 600;
      margin-bottom: 2px;
    }

    .command-desc {
      font-size: 11px;
      color: #7f8c8d;
      font-weight: 400;
    }

    .footer {
      position: absolute;
      bottom: 15px;
      font-size: 11px;
      color: #95a5a6;
      text-align: center;
    }

    .special {
      grid-column: span 2;
      background: linear-gradient(135deg, #f093fb, #f5576c);
      border: none;
    }

    .special .command-tag {
      color: white;
    }

    .special .command-desc {
      color: rgba(255, 255, 255, 0.9);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="particles">
      ${Array(20).fill().map((_, i) => `
        <div class="particle" style="
          left: ${Math.random() * 100}%;
          animation-delay: ${Math.random() * 15}s;
          animation-duration: ${15 + Math.random() * 10}s;
        "></div>
      `).join('')}
    </div>

    <div class="logo">
      <div class="logo-text">XK</div>
    </div>

    <h1 class="title">XRK-MultiBot</h1>
    <div class="version">Version ${cfg.package.version}</div>

    <div class="commands">
      <div class="command special">
        <div class="command-tag">向日葵妈咪妈咪哄</div>
        <div class="command-desc">安装原神适配器和向日葵插件</div>
      </div>
      
      <div class="command">
        <div class="command-tag">#状态</div>
        <div class="command-desc">查看运行状态</div>
      </div>
      
      <div class="command">
        <div class="command-tag">#日志</div>
        <div class="command-desc">查看运行日志</div>
      </div>
      
      <div class="command">
        <div class="command-tag">#重启</div>
        <div class="command-desc">重新启动</div>
      </div>
      
      <div class="command">
        <div class="command-tag">#更新</div>
        <div class="command-desc">拉取Git更新</div>
      </div>
      
      <div class="command">
        <div class="command-tag">#全部更新</div>
        <div class="command-desc">更新全部插件</div>
      </div>
      
      <div class="command">
        <div class="command-tag">#更新日志</div>
        <div class="command-desc">查看更新记录</div>
      </div>
    </div>

    <div class="footer">
      Powered by XRK-Yunzai
    </div>
  </div>
</body>
</html>
      `

      await fs.writeFile(htmlPath, html, 'utf-8')
      return htmlPath
    } catch (error) {
      logger.error(`生成欢迎HTML失败: ${error}`)
      return null
    }
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

      // 截图 - 优化分辨率设置
      const screenshotPath = await takeScreenshot(htmlPath, 'plugin_load_report', {
        width: 800,
        height: 1200,
        deviceScaleFactor: 1.5, // 降低缩放比例以减少资源占用
        fullPage: false,
        type: 'jpeg',
        quality: 90 // 稍微降低图片质量以减小文件大小
      })
      
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
      const dataDir = path.join(process.cwd(), 'data')
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

      // 找出最快和最慢的插件
      const fastestPlugin = successPlugins[successPlugins.length - 1]
      const slowestPlugin = successPlugins[0]

      const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>插件加载报告</title>
  <style>
    @font-face {
      font-family: 'CustomFont';
      src: url('./fonts/font.ttf') format('truetype');
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'CustomFont', -apple-system, 'Microsoft YaHei', sans-serif;
      background: #0f0f1e;
      width: 800px;
      padding: 0;
      position: relative;
      overflow-x: hidden;
    }

    /* 动态背景效果 */
    .bg-animation {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      z-index: -1;
    }

    .bg-gradient {
      position: absolute;
      width: 200%;
      height: 200%;
      background: radial-gradient(circle at 20% 50%, rgba(120, 119, 198, 0.3), transparent 50%),
                  radial-gradient(circle at 80% 80%, rgba(255, 119, 198, 0.2), transparent 50%),
                  radial-gradient(circle at 40% 20%, rgba(119, 198, 255, 0.2), transparent 50%);
      animation: rotate 20s linear infinite;
    }

    @keyframes rotate {
      from {
        transform: rotate(0deg) translate(-50%, -50%);
      }
      to {
        transform: rotate(360deg) translate(-50%, -50%);
      }
    }

    .container {
      background: rgba(17, 17, 35, 0.85);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      position: relative;
      z-index: 1;
      min-height: 100vh;
    }

    /* 光效动画 */
    .glow-line {
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 2px;
      background: linear-gradient(90deg, 
        transparent, 
        rgba(120, 119, 198, 0.8), 
        rgba(255, 119, 198, 0.8),
        transparent);
      animation: glow-move 3s linear infinite;
    }

    @keyframes glow-move {
      0% {
        left: -100%;
      }
      100% {
        left: 100%;
      }
    }

    .header {
      padding: 40px 30px;
      text-align: center;
      position: relative;
      background: linear-gradient(135deg, rgba(120, 119, 198, 0.1), rgba(255, 119, 198, 0.1));
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }

    .header::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, #7877c6, #ff77c6, transparent);
      animation: shimmer 2s infinite;
    }

    @keyframes shimmer {
      0%, 100% {
        opacity: 0.5;
      }
      50% {
        opacity: 1;
      }
    }

    .header h1 {
      font-size: 32px;
      font-weight: 800;
      background: linear-gradient(135deg, #7877c6, #ff77c6, #77c6ff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 10px;
      text-shadow: 0 0 30px rgba(120, 119, 198, 0.5);
      letter-spacing: 2px;
    }

    .header .subtitle {
      font-size: 14px;
      color: rgba(255, 255, 255, 0.6);
      font-weight: 300;
      letter-spacing: 3px;
      text-transform: uppercase;
    }

    /* 统计卡片网格 */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 15px;
      padding: 30px;
    }

    .stat-card {
      background: linear-gradient(135deg, rgba(120, 119, 198, 0.1), rgba(255, 255, 255, 0.05));
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 20px;
      text-align: center;
      position: relative;
      overflow: hidden;
      transition: all 0.3s;
    }

    .stat-card::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(circle, rgba(120, 119, 198, 0.3), transparent 70%);
      opacity: 0;
      transition: opacity 0.3s;
    }

    .stat-card:hover::before {
      opacity: 1;
    }

    .stat-card:hover {
      transform: translateY(-5px);
      border-color: rgba(120, 119, 198, 0.5);
    }

    .stat-icon {
      width: 40px;
      height: 40px;
      margin: 0 auto 10px;
      background: linear-gradient(135deg, #7877c6, #ff77c6);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
    }

    .stat-card .label {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.5);
      margin-bottom: 5px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .stat-card .value {
      font-size: 28px;
      font-weight: bold;
      background: linear-gradient(135deg, #7877c6, #ff77c6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 2px;
    }

    .stat-card .unit {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.4);
    }

    /* 高亮卡片 */
    .highlight-section {
      padding: 0 30px 30px;
    }

    .highlight-cards {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }

    .highlight-card {
      background: linear-gradient(135deg, #1a1a3e, #2a2a4e);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 20px;
      padding: 25px;
      position: relative;
      overflow: hidden;
    }

    .highlight-card::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: linear-gradient(135deg, transparent, rgba(255, 255, 255, 0.05));
      pointer-events: none;
    }

    .fastest {
      background: linear-gradient(135deg, #1a3e1a, #2a4e2a);
      border-color: rgba(86, 171, 47, 0.3);
    }

    .slowest {
      background: linear-gradient(135deg, #3e1a1a, #4e2a2a);
      border-color: rgba(238, 90, 111, 0.3);
    }

    .highlight-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }

    .highlight-icon {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      background: linear-gradient(135deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.05));
    }

    .fastest .highlight-icon {
      background: linear-gradient(135deg, #56ab2f, #a8e063);
    }

    .slowest .highlight-icon {
      background: linear-gradient(135deg, #ee5a6f, #ff6b6b);
    }

    .highlight-card h3 {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.6);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 4px;
    }

    .highlight-card .plugin-name {
      font-size: 18px;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.9);
    }

    .highlight-card .time {
      font-size: 24px;
      font-weight: bold;
      margin-top: 8px;
    }

    .fastest .time {
      color: #a8e063;
    }

    .slowest .time {
      color: #ff6b6b;
    }

    /* 内容区域 */
    .content {
      padding: 30px;
    }

    .section {
      margin-bottom: 30px;
    }

    .section-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 20px;
    }

    .section-icon {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, rgba(120, 119, 198, 0.2), rgba(255, 119, 198, 0.2));
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
    }

    .section-title {
      font-size: 20px;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.9);
      flex: 1;
    }

    .section-count {
      font-size: 14px;
      color: rgba(255, 255, 255, 0.5);
      background: rgba(255, 255, 255, 0.05);
      padding: 4px 12px;
      border-radius: 20px;
    }

    /* 插件包样式 */
    .plugin-package {
      background: linear-gradient(135deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01));
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      margin-bottom: 16px;
      overflow: hidden;
      transition: all 0.3s;
    }

    .plugin-package:hover {
      border-color: rgba(120, 119, 198, 0.3);
      background: linear-gradient(135deg, rgba(120, 119, 198, 0.05), rgba(255, 255, 255, 0.02));
    }

    .package-header {
      padding: 18px 20px;
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .package-name {
      font-size: 16px;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.9);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .package-name::before {
      content: '📦';
      font-size: 18px;
    }

    .package-stats {
      display: flex;
      gap: 8px;
    }

    .package-stats span {
      font-size: 11px;
      padding: 4px 10px;
      background: rgba(120, 119, 198, 0.15);
      color: rgba(255, 255, 255, 0.7);
      border-radius: 12px;
      border: 1px solid rgba(120, 119, 198, 0.3);
    }

    .plugin-list {
      padding: 12px;
    }

    /* 插件项样式 */
    .plugin-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 12px;
      margin-bottom: 8px;
      transition: all 0.3s;
      position: relative;
    }

    .plugin-item::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3px;
      background: linear-gradient(to bottom, #7877c6, #ff77c6);
      border-radius: 3px 0 0 3px;
      opacity: 0;
      transition: opacity 0.3s;
    }

    .plugin-item:hover {
      background: rgba(255, 255, 255, 0.04);
      transform: translateX(4px);
      border-color: rgba(120, 119, 198, 0.3);
    }

    .plugin-item:hover::before {
      opacity: 1;
    }

    .plugin-item:last-child {
      margin-bottom: 0;
    }

    .plugin-item.failed {
      background: rgba(238, 90, 111, 0.1);
      border-color: rgba(238, 90, 111, 0.3);
    }

    .plugin-name {
      font-size: 14px;
      color: rgba(255, 255, 255, 0.8);
      flex: 1;
    }

    .plugin-time {
      font-size: 13px;
      font-weight: 600;
      padding: 5px 12px;
      border-radius: 20px;
      min-width: 80px;
      text-align: center;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid;
    }

    .time-fast {
      color: #a8e063;
      border-color: rgba(168, 224, 99, 0.3);
      background: rgba(168, 224, 99, 0.1);
    }

    .time-medium {
      color: #ffd93d;
      border-color: rgba(255, 217, 61, 0.3);
      background: rgba(255, 217, 61, 0.1);
    }

    .time-slow {
      color: #ff6b6b;
      border-color: rgba(255, 107, 107, 0.3);
      background: rgba(255, 107, 107, 0.1);
    }

    /* 错误信息样式 */
    .error-msg {
      font-size: 11px;
      color: #ff6b6b;
      margin-top: 6px;
      padding: 4px 10px;
      background: rgba(255, 107, 107, 0.1);
      border: 1px solid rgba(255, 107, 107, 0.2);
      border-radius: 6px;
      display: inline-block;
    }

    /* 摘要部分 */
    .summary {
      margin: 30px;
      background: linear-gradient(135deg, #7877c6, #ff77c6);
      border-radius: 20px;
      padding: 30px;
      text-align: center;
      position: relative;
      overflow: hidden;
    }

    .summary::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(circle, rgba(255, 255, 255, 0.1), transparent);
      animation: rotate 10s linear infinite;
    }

    .summary-title {
      font-size: 18px;
      margin-bottom: 20px;
      font-weight: 600;
      color: white;
      text-transform: uppercase;
      letter-spacing: 2px;
      position: relative;
    }

    .summary-content {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
      position: relative;
    }

    .summary-item {
      background: rgba(255, 255, 255, 0.15);
      backdrop-filter: blur(10px);
      border-radius: 12px;
      padding: 15px;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }

    .summary-item .label {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.8);
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .summary-item .value {
      font-size: 24px;
      font-weight: bold;
      color: white;
    }

    /* 进度条 */
    .progress-bar {
      width: 100%;
      height: 8px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 4px;
      overflow: hidden;
      margin-top: 8px;
    }

    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #7877c6, #ff77c6);
      border-radius: 4px;
      animation: progress-animation 2s ease-out;
    }

    @keyframes progress-animation {
      from {
        width: 0;
      }
    }

    /* 响应式滚动条美化 */
    ::-webkit-scrollbar {
      width: 8px;
    }

    ::-webkit-scrollbar-track {
      background: rgba(255, 255, 255, 0.05);
    }

    ::-webkit-scrollbar-thumb {
      background: linear-gradient(135deg, #7877c6, #ff77c6);
      border-radius: 4px;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: linear-gradient(135deg, #9897d6, #ff97d6);
    }
  </style>
</head>
<body>
  <div class="bg-animation">
    <div class="bg-gradient"></div>
  </div>
  
  <div class="container">
    <div class="glow-line"></div>
    
    <div class="header">
      <h1>🚀 插件加载报告</h1>
      <div class="subtitle">Plugin Performance Analytics</div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon">⏱️</div>
        <div class="label">总加载耗时</div>
        <div class="value">${(stats.totalLoadTime / 1000).toFixed(3)}</div>
        <div class="unit">秒</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">✅</div>
        <div class="label">成功加载</div>
        <div class="value">${successPlugins.length}</div>
        <div class="unit">个插件</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">❌</div>
        <div class="label">失败数量</div>
        <div class="value">${failedPlugins.length}</div>
        <div class="unit">个插件</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">📊</div>
        <div class="label">定时任务</div>
        <div class="value">${stats.taskCount || 0}</div>
        <div class="unit">个任务</div>
      </div>
    </div>

    ${successPlugins.length > 0 ? `
      <div class="highlight-section">
        <div class="highlight-cards">
          <div class="highlight-card fastest">
            <div class="highlight-header">
              <div class="highlight-icon">⚡</div>
              <div>
                <h3>最快加载</h3>
                <div class="plugin-name">${fastestPlugin?.name || 'N/A'}</div>
              </div>
            </div>
            <div class="time">${fastestPlugin?.loadTime.toFixed(2) || '0'} ms</div>
          </div>
          
          <div class="highlight-card slowest">
            <div class="highlight-header">
              <div class="highlight-icon">🐌</div>
              <div>
                <h3>最慢加载</h3>
                <div class="plugin-name">${slowestPlugin?.name || 'N/A'}</div>
              </div>
            </div>
            <div class="time">${slowestPlugin?.loadTime.toFixed(2) || '0'} ms</div>
          </div>
        </div>
      </div>
    ` : ''}

    <div class="content">
      ${packageStats.length > 0 ? `
        <div class="section">
          <div class="section-header">
            <div class="section-icon">📦</div>
            <h2 class="section-title">插件包</h2>
            <span class="section-count">${packageStats.length} 个</span>
          </div>
          
          ${packageStats.map(pkg => `
            <div class="plugin-package">
              <div class="package-header">
                <div class="package-name">${pkg.name}</div>
                <div class="package-stats">
                  <span>📋 ${pkg.count} 个</span>
                  <span>⏱️ ${pkg.totalTime.toFixed(1)} ms</span>
                  <span>📊 均值 ${(pkg.totalTime / pkg.count).toFixed(1)} ms</span>
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
          <div class="section-header">
            <div class="section-icon">📄</div>
            <h2 class="section-title">单文件插件</h2>
            <span class="section-count">${singleFilePlugins.length} 个</span>
          </div>
          
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
          <div class="section-header">
            <div class="section-icon">❌</div>
            <h2 class="section-title">加载失败</h2>
            <span class="section-count">${failedPlugins.length} 个</span>
          </div>
          
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
    </div>

    <div class="summary">
      <div class="summary-title">📊 统计摘要</div>
      <div class="summary-content">
        <div class="summary-item">
          <div class="label">平均耗时</div>
          <div class="value">${stats.plugins.length > 0 ? (stats.totalLoadTime / stats.plugins.length).toFixed(1) : '0'} ms</div>
        </div>
        <div class="summary-item">
          <div class="label">成功率</div>
          <div class="value">${stats.plugins.length > 0 ? ((successPlugins.length / stats.plugins.length) * 100).toFixed(1) : '0'}%</div>
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${stats.plugins.length > 0 ? ((successPlugins.length / stats.plugins.length) * 100) : 0}%"></div>
          </div>
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