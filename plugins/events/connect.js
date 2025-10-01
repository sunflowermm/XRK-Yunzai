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
      // 发送欢迎消息
      await this.sendWelcomeMessage(currentUin, e)
      return
    }

    try {
      restart = JSON.parse(restart)
      let time = restart.time || new Date().getTime()
      time = (new Date().getTime() - time) / 1000

      // 生成并发送重启报告（包含插件加载信息）
      await this.sendRestartReport(currentUin, restart, time)

      await redis.del(`${this.key}:${currentUin}`)
    } catch (error) {
      logger.error(`发送重启消息失败：${error}`)
    }

    if (!Bot.uin.includes(e.self_id))
      Bot.uin.push(e.self_id)
  }

  /**
   * 发送欢迎消息（HTML格式）
   */
  async sendWelcomeMessage(currentUin, e) {
    if (!cfg.bot.online_msg_exp) return
    const key = `Yz:OnlineMsg:${e.self_id}`
    if (await redis.get(key)) return
    redis.set(key, "1", { EX: cfg.bot.online_msg_exp * 60 })

    try {
      const htmlPath = await this.generateWelcomeHTML()
      if (!htmlPath || !existsSync(htmlPath)) {
        // 降级到文本消息
        Bot.sendMasterMsg(`欢迎使用【XRK-MultiBot v${cfg.package.version}】\n【向日葵妈咪妈咪哄】安装原神适配器和向日葵插件\n【#状态】查看运行状态\n【#日志】查看运行日志\n【#重启】重新启动\n【#更新】拉取 Git 更新\n【#全部更新】更新全部插件\n【#更新日志】查看更新日志`)
        return
      }

      const screenshotPath = await takeScreenshot(htmlPath, 'welcome_message')
      if (screenshotPath && existsSync(screenshotPath)) {
        Bot.sendMasterMsg([segment.image(screenshotPath)])
        logger.mark('欢迎消息发送成功')
      }

      // 清理临时文件
      setTimeout(async () => {
        try {
          await fs.unlink(htmlPath)
        } catch (err) {}
      }, 5000)
    } catch (error) {
      logger.error(`发送欢迎消息失败：${error}`)
    }
  }

  /**
   * 发送重启报告
   */
  async sendRestartReport(currentUin, restart, time) {
    try {
      const stats = loader.getPluginStats()
      const htmlPath = await this.generateRestartReportHTML(time, stats)
      
      if (!htmlPath || !existsSync(htmlPath)) {
        // 降级到文本消息
        let restartMsg = `重启成功，耗时 ${time.toFixed(4)} 秒`
        if (restart.isGroup) {
          await Bot[currentUin].pickGroup(restart.id).sendMsg(restartMsg)
        } else {
          await Bot[currentUin].pickUser(restart.id).sendMsg(restartMsg)
        }
        return
      }

      const screenshotPath = await takeScreenshot(htmlPath, 'restart_report')
      
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

      logger.mark('重启报告发送成功')
      
      // 清理临时文件
      setTimeout(async () => {
        try {
          await fs.unlink(htmlPath)
        } catch (err) {}
      }, 5000)
      
    } catch (error) {
      logger.error(`发送重启报告失败：${error}`)
    }
  }

  /**
   * 生成欢迎消息HTML
   */
  async generateWelcomeHTML() {
    try {
      const dataDir = path.join(process.cwd(), 'temp')
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
  <title>欢迎使用 XRK-MultiBot</title>
  <style>
    @font-face {
      font-family: 'CustomFont';
      src: url('file:///${path.join(process.cwd(), 'data/fonts/font.ttf').replace(/\\/g, '/')}');
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'CustomFont', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
      position: relative;
      overflow: hidden;
    }

    body::before {
      content: '';
      position: absolute;
      width: 200%;
      height: 200%;
      background: radial-gradient(circle, rgba(255,255,255,0.1) 1px, transparent 1px);
      background-size: 50px 50px;
      animation: moveBackground 20s linear infinite;
    }

    @keyframes moveBackground {
      0% { transform: translate(0, 0); }
      100% { transform: translate(50px, 50px); }
    }

    .container {
      max-width: 800px;
      width: 100%;
      background: rgba(255, 255, 255, 0.98);
      border-radius: 24px;
      padding: 50px 40px;
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.2);
      position: relative;
      z-index: 1;
      backdrop-filter: blur(20px);
    }

    .header {
      text-align: center;
      margin-bottom: 40px;
      position: relative;
    }

    .logo {
      font-size: 72px;
      margin-bottom: 20px;
      animation: float 3s ease-in-out infinite;
    }

    @keyframes float {
      0%, 100% { transform: translateY(0px); }
      50% { transform: translateY(-10px); }
    }

    .header h1 {
      font-size: 36px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 12px;
      font-weight: 700;
      letter-spacing: 1px;
    }

    .version {
      display: inline-block;
      padding: 6px 16px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: white;
      border-radius: 20px;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.5px;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
    }

    .welcome-text {
      text-align: center;
      font-size: 18px;
      color: #555;
      margin-bottom: 35px;
      line-height: 1.6;
    }

    .commands {
      display: grid;
      gap: 16px;
      margin-bottom: 30px;
    }

    .command-item {
      display: flex;
      align-items: center;
      padding: 20px 24px;
      background: linear-gradient(135deg, #f8f9ff, #fff);
      border-radius: 16px;
      border: 2px solid transparent;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      cursor: pointer;
      position: relative;
      overflow: hidden;
    }

    .command-item::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 0;
      height: 100%;
      background: linear-gradient(90deg, rgba(102, 126, 234, 0.1), rgba(118, 75, 162, 0.1));
      transition: width 0.4s ease;
    }

    .command-item:hover {
      transform: translateX(8px);
      border-color: #667eea;
      box-shadow: 0 8px 25px rgba(102, 126, 234, 0.2);
    }

    .command-item:hover::before {
      width: 100%;
    }

    .command-icon {
      font-size: 32px;
      margin-right: 20px;
      min-width: 40px;
      text-align: center;
      position: relative;
      z-index: 1;
    }

    .command-content {
      flex: 1;
      position: relative;
      z-index: 1;
    }

    .command-name {
      font-size: 18px;
      font-weight: 600;
      color: #2c3e50;
      margin-bottom: 4px;
    }

    .command-desc {
      font-size: 14px;
      color: #7f8c8d;
    }

    .footer {
      text-align: center;
      padding-top: 25px;
      border-top: 2px solid #f0f0f0;
    }

    .footer-text {
      font-size: 14px;
      color: #95a5a6;
      margin-bottom: 12px;
    }

    .social-links {
      display: flex;
      justify-content: center;
      gap: 15px;
    }

    .social-link {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: linear-gradient(135deg, #667eea, #764ba2);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      transition: transform 0.3s ease;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
    }

    .social-link:hover {
      transform: translateY(-3px) scale(1.1);
    }

    .decorative-circle {
      position: absolute;
      border-radius: 50%;
      background: linear-gradient(135deg, rgba(102, 126, 234, 0.1), rgba(118, 75, 162, 0.1));
      z-index: 0;
    }

    .circle-1 {
      width: 150px;
      height: 150px;
      top: -50px;
      right: -50px;
    }

    .circle-2 {
      width: 100px;
      height: 100px;
      bottom: -30px;
      left: -30px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="decorative-circle circle-1"></div>
    <div class="decorative-circle circle-2"></div>
    
    <div class="header">
      <div class="logo">🚀</div>
      <h1>XRK-MultiBot</h1>
      <span class="version">v${cfg.package.version}</span>
    </div>

    <div class="welcome-text">
      欢迎使用向日葵多功能机器人框架<br>
      以下是常用命令，助您快速上手
    </div>

    <div class="commands">
      <div class="command-item">
        <div class="command-icon">📊</div>
        <div class="command-content">
          <div class="command-name">#状态</div>
          <div class="command-desc">查看机器人运行状态和系统信息</div>
        </div>
      </div>

      <div class="command-item">
        <div class="command-icon">📝</div>
        <div class="command-content">
          <div class="command-name">#日志</div>
          <div class="command-desc">查看最近的运行日志和错误信息</div>
        </div>
      </div>

      <div class="command-item">
        <div class="command-icon">🔄</div>
        <div class="command-content">
          <div class="command-name">#重启</div>
          <div class="command-desc">重新启动机器人服务</div>
        </div>
      </div>

      <div class="command-item">
        <div class="command-icon">⬆️</div>
        <div class="command-content">
          <div class="command-name">#更新</div>
          <div class="command-desc">拉取最新的 Git 更新</div>
        </div>
      </div>

      <div class="command-item">
        <div class="command-icon">🔧</div>
        <div class="command-content">
          <div class="command-name">#全部更新</div>
          <div class="command-desc">更新所有已安装的插件</div>
        </div>
      </div>

      <div class="command-item">
        <div class="command-icon">📋</div>
        <div class="command-content">
          <div class="command-name">#更新日志</div>
          <div class="command-desc">查看版本更新记录</div>
        </div>
      </div>
    </div>

    <div class="footer">
      <div class="footer-text">✨ 向日葵妈咪妈咪哄 · 原神适配器 · 多功能插件 ✨</div>
      <div class="social-links">
        <div class="social-link">💬</div>
        <div class="social-link">🌟</div>
        <div class="social-link">📦</div>
      </div>
    </div>
  </div>
</body>
</html>
      `

      await fs.writeFile(htmlPath, html, 'utf-8')
      logger.mark(`欢迎消息HTML已生成: ${htmlPath}`)
      
      return htmlPath
    } catch (error) {
      logger.error(`生成欢迎消息HTML失败: ${error}`)
      return null
    }
  }

  /**
   * 生成重启报告HTML（整合插件加载信息）
   */
  async generateRestartReportHTML(restartTime, stats) {
    try {
      const dataDir = path.join(process.cwd(), 'temp')
      if (!existsSync(dataDir)) {
        await fs.mkdir(dataDir, { recursive: true })
      }

      const timestamp = Date.now()
      const htmlPath = path.join(dataDir, `restart_report_${timestamp}.html`)

      if (!stats || !stats.plugins || stats.plugins.length === 0) {
        // 简化版本，只显示重启信息
        const html = this.generateSimpleRestartHTML(restartTime)
        await fs.writeFile(htmlPath, html, 'utf-8')
        return htmlPath
      }

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
  <title>重启报告</title>
  <style>
    @font-face {
      font-family: 'CustomFont';
      src: url('file:///${path.join(process.cwd(), 'data/fonts/font.ttf').replace(/\\/g, '/')}');
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'CustomFont', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
      min-height: 100vh;
      padding: 30px 20px;
      position: relative;
      overflow-x: hidden;
    }

    body::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: 
        radial-gradient(circle at 20% 50%, rgba(255, 255, 255, 0.1) 0%, transparent 50%),
        radial-gradient(circle at 80% 80%, rgba(255, 255, 255, 0.1) 0%, transparent 50%);
      pointer-events: none;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: rgba(255, 255, 255, 0.98);
      border-radius: 28px;
      padding: 45px 40px;
      box-shadow: 
        0 40px 100px rgba(0, 0, 0, 0.3),
        0 0 0 1px rgba(255, 255, 255, 0.3),
        inset 0 1px 0 rgba(255, 255, 255, 0.6);
      position: relative;
      backdrop-filter: blur(30px);
    }

    .header {
      text-align: center;
      margin-bottom: 40px;
      padding-bottom: 30px;
      border-bottom: 3px solid transparent;
      background: linear-gradient(white, white) padding-box,
                  linear-gradient(90deg, #667eea, #764ba2, #f093fb) border-box;
      border-image-slice: 1;
      position: relative;
    }

    .header::after {
      content: '';
      position: absolute;
      bottom: -3px;
      left: 50%;
      transform: translateX(-50%);
      width: 100px;
      height: 3px;
      background: linear-gradient(90deg, #667eea, #764ba2);
      border-radius: 2px;
    }

    .success-badge {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      font-size: 56px;
      margin-bottom: 20px;
      animation: successPulse 2s ease-in-out infinite;
    }

    @keyframes successPulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }

    .header h1 {
      font-size: 38px;
      background: linear-gradient(135deg, #667eea, #764ba2, #f093fb);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 15px;
      font-weight: 800;
      letter-spacing: 1px;
    }

    .restart-time {
      display: inline-block;
      padding: 10px 24px;
      background: linear-gradient(135deg, #56ab2f, #a8e063);
      color: white;
      border-radius: 25px;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0.5px;
      box-shadow: 0 6px 20px rgba(86, 171, 47, 0.4);
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
    }

    .stat-card {
      background: linear-gradient(135deg, #667eea, #764ba2);
      padding: 28px 24px;
      border-radius: 20px;
      color: white;
      text-align: center;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(102, 126, 234, 0.3);
    }

    .stat-card::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%);
      animation: rotate 10s linear infinite;
    }

    @keyframes rotate {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    .stat-card:hover {
      transform: translateY(-8px) scale(1.02);
      box-shadow: 0 15px 40px rgba(102, 126, 234, 0.5);
    }

    .stat-card .icon {
      font-size: 40px;
      margin-bottom: 12px;
      position: relative;
      z-index: 1;
    }

    .stat-card .label {
      font-size: 14px;
      opacity: 0.95;
      margin-bottom: 8px;
      font-weight: 500;
      position: relative;
      z-index: 1;
    }

    .stat-card .value {
      font-size: 32px;
      font-weight: 800;
      margin-bottom: 4px;
      position: relative;
      z-index: 1;
      text-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    .stat-card .unit {
      font-size: 13px;
      opacity: 0.9;
      position: relative;
      z-index: 1;
    }

    .highlight-section {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 40px;
    }

    .highlight-card {
      padding: 25px 30px;
      border-radius: 20px;
      color: white;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: relative;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
      transition: transform 0.3s ease;
    }

    .highlight-card:hover {
      transform: translateY(-5px);
    }

    .highlight-card::before {
      content: '';
      position: absolute;
      top: 0;
      right: 0;
      width: 150px;
      height: 150px;
      background: radial-gradient(circle, rgba(255,255,255,0.2) 0%, transparent 70%);
      border-radius: 50%;
      transform: translate(50%, -50%);
    }

    .fastest {
      background: linear-gradient(135deg, #56ab2f, #a8e063);
    }

    .slowest {
      background: linear-gradient(135deg, #ff6b6b, #ee5a6f);
    }

    .highlight-card .content {
      position: relative;
      z-index: 1;
    }

    .highlight-card h3 {
      font-size: 16px;
      margin-bottom: 8px;
      opacity: 0.95;
      font-weight: 600;
    }

    .highlight-card .plugin-name {
      font-size: 20px;
      font-weight: 700;
      text-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    .highlight-card .time {
      font-size: 28px;
      font-weight: 800;
      position: relative;
      z-index: 1;
      text-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    .section {
      margin-bottom: 35px;
    }

    .section-title {
      font-size: 24px;
      color: #2c3e50;
      margin-bottom: 20px;
      padding-left: 20px;
      border-left: 6px solid #667eea;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .section-title .icon {
      font-size: 28px;
    }

    .plugin-package {
      background: linear-gradient(135deg, #f8f9ff, #ffffff);
      border-radius: 18px;
      padding: 25px;
      margin-bottom: 20px;
      border: 2px solid #e8ecf4;
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.05);
      transition: all 0.3s ease;
    }

    .plugin-package:hover {
      transform: translateX(5px);
      border-color: #667eea;
      box-shadow: 0 8px 25px rgba(102, 126, 234, 0.15);
    }

    .package-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 18px;
      padding-bottom: 15px;
      border-bottom: 2px dashed #dee5ed;
    }

    .package-name {
      font-size: 20px;
      font-weight: 700;
      color: #2c3e50;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .package-name::before {
      content: '📦';
      font-size: 24px;
    }

    .package-stats {
      display: flex;
      gap: 12px;
      font-size: 13px;
      flex-wrap: wrap;
    }

    .package-stats span {
      padding: 6px 14px;
      background: white;
      border-radius: 16px;
      color: #667eea;
      border: 2px solid #667eea;
      font-weight: 600;
      box-shadow: 0 2px 8px rgba(102, 126, 234, 0.2);
      transition: all 0.2s ease;
    }

    .package-stats span:hover {
      background: #667eea;
      color: white;
      transform: translateY(-2px);
    }

    .plugin-list {
      display: grid;
      gap: 10px;
    }

    .plugin-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      background: white;
      border-radius: 14px;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      border-left: 4px solid transparent;
      position: relative;
      overflow: hidden;
    }

    .plugin-item::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      width: 0;
      height: 100%;
      background: linear-gradient(90deg, rgba(102, 126, 234, 0.08), rgba(118, 75, 162, 0.08));
      transition: width 0.4s ease;
    }

    .plugin-item:hover {
      transform: translateX(8px);
      border-left-color: #667eea;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.15);
    }

    .plugin-item:hover::before {
      width: 100%;
    }

    .plugin-item.failed {
      background: linear-gradient(135deg, #fff5f5, #ffe8e8);
      border-left-color: #e74c3c;
    }

    .plugin-item.failed:hover {
      border-left-color: #c0392b;
    }

    .plugin-name {
      font-size: 15px;
      color: #2c3e50;
      flex: 1;
      font-weight: 600;
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .plugin-name::before {
      content: '⚡';
      font-size: 16px;
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .plugin-item:hover .plugin-name::before {
      opacity: 1;
    }

    .plugin-time {
      font-size: 15px;
      font-weight: 700;
      padding: 6px 16px;
      border-radius: 18px;
      min-width: 90px;
      text-align: center;
      position: relative;
      z-index: 1;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      transition: all 0.3s ease;
    }

    .plugin-item:hover .plugin-time {
      transform: scale(1.05);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }

    .time-fast {
      color: #27ae60;
      background: linear-gradient(135deg, #e8f8f5, #d5f4e6);
      border: 2px solid #27ae60;
    }

    .time-medium {
      color: #f39c12;
      background: linear-gradient(135deg, #fef5e7, #fdebd0);
      border: 2px solid #f39c12;
    }

    .time-slow {
      color: #e74c3c;
      background: linear-gradient(135deg, #fadbd8, #f5b7b1);
      border: 2px solid #e74c3c;
    }

    .error-msg {
      font-size: 12px;
      color: #e74c3c;
      margin-top: 6px;
      padding: 6px 12px;
      background: linear-gradient(135deg, #ffe8e8, #ffd4d4);
      border-radius: 8px;
      display: inline-block;
      border-left: 3px solid #e74c3c;
      font-weight: 500;
    }

    .summary {
      background: linear-gradient(135deg, #f093fb, #f5576c);
      color: white;
      padding: 35px 30px;
      border-radius: 20px;
      margin-top: 35px;
      box-shadow: 0 15px 40px rgba(245, 87, 108, 0.3);
      position: relative;
      overflow: hidden;
    }

    .summary::before {
      content: '';
      position: absolute;
      top: -50%;
      right: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%);
      animation: rotate 15s linear infinite;
    }

    .summary-title {
      font-size: 24px;
      margin-bottom: 25px;
      font-weight: 700;
      text-align: center;
      position: relative;
      z-index: 1;
      text-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    .summary-content {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 20px;
      position: relative;
      z-index: 1;
    }

    .summary-item {
      text-align: center;
      padding: 20px;
      background: rgba(255, 255, 255, 0.15);
      border-radius: 16px;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.2);
      transition: all 0.3s ease;
    }

    .summary-item:hover {
      transform: translateY(-5px);
      background: rgba(255, 255, 255, 0.25);
    }

    .summary-item .icon {
      font-size: 36px;
      margin-bottom: 10px;
    }

    .summary-item .label {
      font-size: 13px;
      opacity: 0.95;
      margin-bottom: 8px;
      font-weight: 500;
    }

    .summary-item .value {
      font-size: 28px;
      font-weight: 800;
      text-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    .footer-badge {
      margin-top: 30px;
      padding: 20px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      border-radius: 16px;
      text-align: center;
      color: white;
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 8px 25px rgba(102, 126, 234, 0.3);
    }

    @media (max-width: 768px) {
      .highlight-section {
        grid-template-columns: 1fr;
      }
      
      .stats-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="success-badge">✅ 🎉</div>
      <h1>重启成功</h1>
      <span class="restart-time">⚡ ${restartTime.toFixed(4)} 秒</span>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="icon">⏱️</div>
        <div class="label">插件加载耗时</div>
        <div class="value">${(stats.totalLoadTime / 1000).toFixed(3)}</div>
        <div class="unit">秒</div>
      </div>
      <div class="stat-card">
        <div class="icon">✨</div>
        <div class="label">成功加载</div>
        <div class="value">${successPlugins.length}</div>
        <div class="unit">个插件</div>
      </div>
      <div class="stat-card">
        <div class="icon">❌</div>
        <div class="label">失败数量</div>
        <div class="value">${failedPlugins.length}</div>
        <div class="unit">个插件</div>
      </div>
      <div class="stat-card">
        <div class="icon">⏰</div>
        <div class="label">定时任务</div>
        <div class="value">${stats.taskCount || 0}</div>
        <div class="unit">个任务</div>
      </div>
    </div>

    ${successPlugins.length > 0 ? `
      <div class="highlight-section">
        <div class="highlight-card fastest">
          <div class="content">
            <h3>⚡ 最快加载</h3>
            <div class="plugin-name">${successPlugins[successPlugins.length - 1].name}</div>
          </div>
          <div class="time">${successPlugins[successPlugins.length - 1].loadTime.toFixed(2)} ms</div>
        </div>
        <div class="highlight-card slowest">
          <div class="content">
            <h3>🐌 最慢加载</h3>
            <div class="plugin-name">${successPlugins[0].name}</div>
          </div>
          <div class="time">${successPlugins[0].loadTime.toFixed(2)} ms</div>
        </div>
      </div>
    ` : ''}

    ${packageStats.length > 0 ? `
      <div class="section">
        <h2 class="section-title">
          <span class="icon">📦</span>
          插件包加载详情 (${packageStats.length})
        </h2>
        ${packageStats.map(pkg => `
          <div class="plugin-package">
            <div class="package-header">
              <div class="package-name">${pkg.name}</div>
              <div class="package-stats">
                <span>📊 ${pkg.count} 个</span>
                <span>⏱️ ${pkg.totalTime.toFixed(1)} ms</span>
                <span>📈 均值 ${(pkg.totalTime / pkg.count).toFixed(1)} ms</span>
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
        <h2 class="section-title">
          <span class="icon">📄</span>
          单文件插件 (${singleFilePlugins.length})
        </h2>
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
        <h2 class="section-title">
          <span class="icon">❌</span>
          加载失败 (${failedPlugins.length})
        </h2>
        <div class="plugin-list">
          ${failedPlugins.map(plugin => `
            <div class="plugin-item failed">
              <div>
                <div class="plugin-name">${plugin.name}</div>
                ${plugin.error ? `<div class="error-msg">⚠️ ${plugin.error}</div>` : ''}
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
          <div class="icon">📈</div>
          <div class="label">平均耗时</div>
          <div class="value">${(stats.totalLoadTime / stats.plugins.length).toFixed(1)} ms</div>
        </div>
        <div class="summary-item">
          <div class="icon">✅</div>
          <div class="label">成功率</div>
          <div class="value">${((successPlugins.length / stats.plugins.length) * 100).toFixed(1)}%</div>
        </div>
        <div class="summary-item">
          <div class="icon">🐢</div>
          <div class="label">慢速插件</div>
          <div class="value">${successPlugins.filter(p => p.loadTime > 100).length}</div>
        </div>
        <div class="summary-item">
          <div class="icon">⚡</div>
          <div class="label">极速插件</div>
          <div class="value">${successPlugins.filter(p => p.loadTime < 10).length}</div>
        </div>
      </div>
    </div>

    <div class="footer-badge">
      🎯 XRK-MultiBot · 重启完成 · 所有服务已就绪
    </div>
  </div>
</body>
</html>
      `

      await fs.writeFile(htmlPath, html, 'utf-8')
      logger.mark(`重启报告HTML已生成: ${htmlPath}`)
      
      return htmlPath
    } catch (error) {
      logger.error(`生成重启报告HTML失败: ${error}`)
      return null
    }
  }

  /**
   * 生成简化版重启HTML（无插件信息）
   */
  generateSimpleRestartHTML(restartTime) {
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>重启成功</title>
  <style>
    @font-face {
      font-family: 'CustomFont';
      src: url('file:///${path.join(process.cwd(), 'data/fonts/font.ttf').replace(/\\/g, '/')}');
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'CustomFont', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
      position: relative;
      overflow: hidden;
    }

    body::before {
      content: '';
      position: absolute;
      width: 200%;
      height: 200%;
      background: radial-gradient(circle, rgba(255,255,255,0.1) 1px, transparent 1px);
      background-size: 50px 50px;
      animation: moveBackground 20s linear infinite;
    }

    @keyframes moveBackground {
      0% { transform: translate(0, 0); }
      100% { transform: translate(50px, 50px); }
    }

    .container {
      max-width: 600px;
      width: 100%;
      background: rgba(255, 255, 255, 0.98);
      border-radius: 28px;
      padding: 60px 40px;
      box-shadow: 0 40px 100px rgba(0, 0, 0, 0.3);
      text-align: center;
      position: relative;
      z-index: 1;
      backdrop-filter: blur(30px);
    }

    .success-icon {
      font-size: 100px;
      margin-bottom: 30px;
      animation: bounce 2s ease-in-out infinite;
    }

    @keyframes bounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-20px); }
    }

    h1 {
      font-size: 42px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 25px;
      font-weight: 800;
    }

    .time-display {
      display: inline-block;
      padding: 20px 40px;
      background: linear-gradient(135deg, #56ab2f, #a8e063);
      color: white;
      border-radius: 30px;
      font-size: 32px;
      font-weight: 800;
      box-shadow: 0 10px 30px rgba(86, 171, 47, 0.4);
      margin-bottom: 30px;
    }

    .message {
      font-size: 18px;
      color: #555;
      line-height: 1.8;
      margin-bottom: 30px;
    }

    .footer {
      padding: 20px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      border-radius: 16px;
      color: white;
      font-size: 16px;
      font-weight: 600;
      box-shadow: 0 8px 25px rgba(102, 126, 234, 0.3);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="success-icon">✅</div>
    <h1>重启成功</h1>
    <div class="time-display">⚡ ${restartTime.toFixed(4)} 秒</div>
    <div class="message">
      机器人已成功重启，所有服务运行正常<br>
      随时准备为您服务
    </div>
    <div class="footer">
      🎯 XRK-MultiBot · 重启完成
    </div>
  </div>
</body>
</html>
    `
  }
}