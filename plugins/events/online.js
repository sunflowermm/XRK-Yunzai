import EventListener from "../../lib/listener/listener.js";
import loader from "../../lib/plugins/loader.js";

/**
 * 监听上线事件
 */
export default class onlineEvent extends EventListener {
  constructor() {
    super({
      event: "online",
      once: true,
    });
    this.key = 'Yz:restart';
  }

  async execute(e) {
    Bot.makeLog("info", `尽情享受吧QaQ`, 'event');
    
    // 获取重启信息（不指定具体uin）
    let restart = await redis.get(this.key);
    if (!restart) {
      logger.info('没有检测到重启信息，机器人正常启动');
      return;
    }
    
    try {
      restart = JSON.parse(restart);
      
      // 计算重启耗时（精确到小数点后四位）
      const restartTime = ((Date.now() - restart.time) / 1000).toFixed(4);
      
      // 获取插件加载统计信息
      const pluginStats = loader.getPluginStats();
      const startupTime = (pluginStats.totalLoadTime / 1000).toFixed(4);
      
      // 构建插件加载信息消息列表
      const msgs = [];
      const botUin = restart.uin || Bot.uin[0];
      
      // 添加启动统计消息
      msgs.push({
        message: [
          `📊 启动统计`,
          `━━━━━━━━━━━━━━`,
          `🚀 重启耗时：${restartTime}秒`,
          `⚙️ 系统加载：${startupTime}秒`, 
          `📦 插件总数：${pluginStats.totalPlugins}个`,
          `📋 定时任务：${pluginStats.taskCount}个`,
          `🔌 扩展插件：${pluginStats.extendedCount}个`
        ].join('\n'),
        nickname: '系统信息',
        user_id: String(botUin),
        time: Math.floor((restart.time - 5000) / 1000)
      });
      
      // 添加插件详细加载信息
      if (pluginStats.plugins && pluginStats.plugins.length > 0) {
        // 按加载时间排序
        const sortedPlugins = pluginStats.plugins.sort((a, b) => b.loadTime - a.loadTime);
        
        // 构建插件列表消息
        let pluginListMsg = ['📦 插件加载详情', '━━━━━━━━━━━━━━'];
        
        sortedPlugins.forEach((plugin, index) => {
          const loadTimeMs = plugin.loadTime.toFixed(2);
          const icon = plugin.loadTime > 100 ? '⚠️' : '✅';
          pluginListMsg.push(`${icon} [${plugin.name}] ${loadTimeMs}ms`);
        });
        
        // 添加统计信息
        pluginListMsg.push('━━━━━━━━━━━━━━');
        const avgLoadTime = (pluginStats.plugins.reduce((sum, p) => sum + p.loadTime, 0) / pluginStats.plugins.length).toFixed(2);
        const slowPlugins = pluginStats.plugins.filter(p => p.loadTime > 100).length;
        
        pluginListMsg.push(`📈 平均加载：${avgLoadTime}ms`);
        if (slowPlugins > 0) {
          pluginListMsg.push(`⚠️ 慢速加载：${slowPlugins}个`);
        }
        
        msgs.push({
          message: pluginListMsg.join('\n'),
          nickname: '插件管理器',
          user_id: String(botUin),
          time: Math.floor((restart.time - 3000) / 1000)
        });
      }
      
      // 添加性能优化建议
      const suggestions = [];
      if (pluginStats.plugins.some(p => p.loadTime > 200)) {
        suggestions.push('• 部分插件加载缓慢，建议检查初始化逻辑');
      }
      if (pluginStats.totalPlugins > 50) {
        suggestions.push('• 插件数量较多，可考虑精简未使用的插件');
      }
      if (startupTime > 10) {
        suggestions.push('• 启动时间较长，建议优化插件加载流程');
      }
      
      if (suggestions.length > 0) {
        msgs.push({
          message: ['💡 优化建议', '━━━━━━━━━━━━━━', ...suggestions].join('\n'),
          nickname: '性能分析',
          user_id: String(botUin),
          time: Math.floor((restart.time - 1000) / 1000)
        });
      }
      
      // 创建转发消息
      let forwardMsg;
      const target = restart.isGroup ? 
        Bot[botUin]?.pickGroup(restart.id) : 
        Bot[botUin]?.pickUser(restart.id);
      
      if (target?.makeForwardMsg) {
        forwardMsg = await target.makeForwardMsg(msgs);
        await target.sendMsg(forwardMsg);
      }
      
      // 发送重启成功的简单消息
      const simpleMsg = `✅ 重启成功，耗时${restartTime}秒`;
      if (restart.isGroup) {
        await Bot[botUin].pickGroup(restart.id).sendMsg(simpleMsg);
      } else {
        await Bot[botUin].pickUser(restart.id).sendMsg(simpleMsg);
      }
      
      // 删除重启信息
      await redis.del(this.key);
      
    } catch (error) {
      logger.error(`发送重启消息失败：${error}`);
      logger.error(error.stack);
      
      // 尝试发送简单消息
      try {
        const restart = JSON.parse(await redis.get(this.key));
        if (restart) {
          const target = restart.isGroup ? 
            Bot[restart.uin].pickGroup(restart.id) : 
            Bot[restart.uin].pickUser(restart.id);
          await target.sendMsg('✅ 重启成功');
          await redis.del(this.key);
        }
      } catch (innerError) {
        logger.error('发送简单重启消息也失败了');
      }
    }
  }
}