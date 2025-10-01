import EventListener from "../../lib/listener/listener.js"
import cfg from "../../lib/config/config.js"
import loader from "../../lib/plugins/loader.js"

/**
 * 监听连接事件（理论上属于各类适配器的上线的事件）
 * 处理上线消息并发送插件加载报告
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
      await this.sendOnlineMessage(e)
      return
    }

    try {
      restart = JSON.parse(restart)
      
      // 计算重启耗时（精确到小数点后4位）
      const restartTime = ((new Date().getTime() - restart.time) / 1000).toFixed(4)
      
      // 获取插件加载统计
      const stats = loader.getPluginStats()
      
      // 构建重启报告消息
      let msg = [`✅ 重启成功`]
      msg.push(`⏱️ 重启耗时：${restartTime}秒`)
      msg.push(`━━━━━━━━━━━━━━━`)
      msg.push(`📊 插件加载报告`)
      msg.push(`━━━━━━━━━━━━━━━`)
      
      // 统计插件包和单文件插件
      const pluginPackages = new Map()
      const singlePlugins = []
      
      if (stats.plugins && Array.isArray(stats.plugins)) {
        stats.plugins.forEach(plugin => {
          const parts = plugin.name.split('/')
          if (parts.length > 1) {
            const packageName = parts[0]
            if (!pluginPackages.has(packageName)) {
              pluginPackages.set(packageName, {
                files: [],
                totalTime: 0,
                success: 0,
                failed: 0
              })
            }
            const pkg = pluginPackages.get(packageName)
            pkg.files.push(plugin)
            pkg.totalTime += plugin.loadTime || 0
            if (plugin.success) {
              pkg.success++
            } else {
              pkg.failed++
            }
          } else {
            // 单文件插件
            singlePlugins.push(plugin)
          }
        })
      }
      
      // 添加插件包信息
      if (pluginPackages.size > 0) {
        msg.push(`📦 插件包加载情况：`)
        for (const [name, info] of pluginPackages) {
          const status = info.failed === 0 ? '✅' : '⚠️'
          const loadTime = (info.totalTime / 1000).toFixed(3)
          msg.push(`  ${status} ${name}`)
          msg.push(`     ├ 文件数：${info.files.length}个`)
          msg.push(`     ├ 成功：${info.success}个${info.failed > 0 ? ` / 失败：${info.failed}个` : ''}`)
          msg.push(`     └ 耗时：${loadTime}秒`)
        }
      }
      
      if (singlePlugins.length > 0) {
        msg.push(`📄 单文件插件：${singlePlugins.length}个`)
        const successCount = singlePlugins.filter(p => p.success).length
        const failedCount = singlePlugins.filter(p => !p.success).length
        if (successCount > 0) msg.push(`  ✅ 成功加载：${successCount}个`)
        if (failedCount > 0) {
          msg.push(`  ❌ 加载失败：${failedCount}个`)
          singlePlugins.filter(p => !p.success).forEach(p => {
            msg.push(`     - ${p.name}`)
          })
        }
      }
      
      msg.push(`━━━━━━━━━━━━━━━`)
      msg.push(`📈 加载统计`)
      msg.push(`  • 插件总数：${stats.totalPlugins || 0}个`)
      msg.push(`  • 定时任务：${stats.taskCount || 0}个`)
      msg.push(`  • 扩展插件：${stats.extendedCount || 0}个`)
      msg.push(`  • 总加载耗时：${((stats.totalLoadTime || 0) / 1000).toFixed(4)}秒`)
      
      // 添加系统信息
      const memUsage = process.memoryUsage()
      const memoryMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2)
      msg.push(`━━━━━━━━━━━━━━━`)
      msg.push(`💾 内存使用：${memoryMB}MB`)
      msg.push(`🤖 Bot版本：${cfg.package?.version || '未知'}`)
      
      // 发送重启报告
      const msgText = msg.join('\n')
      
      if (restart.isGroup) {
        await Bot[currentUin].pickGroup(restart.id).sendMsg(msgText)
      } else {
        await Bot[currentUin].pickUser(restart.id).sendMsg(msgText)
      }
      
      // 删除重启标记
      await redis.del(`${this.key}:${currentUin}`)
      
      // 记录日志
      logger.mark(`[重启完成] 耗时${restartTime}秒，加载插件${stats.totalPlugins}个`)
      
    } catch (error) {
      logger.error(`发送重启消息失败：${error}`)
      logger.error(error.stack)
      
      try {
        const simpleMsg = `重启成功（报告生成失败）`
        if (restart.isGroup) {
          await Bot[currentUin].pickGroup(restart.id).sendMsg(simpleMsg)
        } else {
          await Bot[currentUin].pickUser(restart.id).sendMsg(simpleMsg)
        }
        await redis.del(`${this.key}:${currentUin}`)
      } catch (err) {
        logger.error('发送简单重启消息也失败了')
      }
    }
  }
  
  /**
   * 发送普通上线消息
   */
  async sendOnlineMessage(e) {
    if (!cfg.bot.online_msg_exp) return
    
    const key = `Yz:OnlineMsg:${e.self_id}`
    if (await redis.get(key)) return
    
    redis.set(key, "1", { EX: cfg.bot.online_msg_exp * 60 })
    
    // 获取插件统计信息
    const stats = loader.getPluginStats()
    
    const onlineMsg = [
      `🌻 欢迎使用【XRK-MultiBot v${cfg.package.version}】`,
      `━━━━━━━━━━━━━━━`,
      `📊 系统状态`,
      `  • 插件数量：${stats.totalPlugins || 0}个`,
      `  • 定时任务：${stats.taskCount || 0}个`,
      `  • 扩展插件：${stats.extendedCount || 0}个`,
      `━━━━━━━━━━━━━━━`,
      `💡 常用命令`,
      `  【#状态】查看运行状态`,
      `  【#日志】查看运行日志`,
      `  【#重启】重新启动`,
      `  【#更新】拉取 Git 更新`,
      `  【#全部更新】更新全部插件`,
      `  【#更新日志】查看更新日志`,
      `━━━━━━━━━━━━━━━`,
      `🌻 【向日葵妈咪妈咪哄】`,
      `   安装原神适配器和向日葵插件`
    ].join('\n')
    
    Bot.sendMasterMsg(onlineMsg)
  }
}