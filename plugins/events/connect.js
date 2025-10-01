import EventListener from "../../lib/listener/listener.js";
import loader from "../../lib/plugins/loader.js";
import cfg from '../../lib/config/config.js';

/**
 * 监听上线事件
 */
export default class onlineEvent extends EventListener {
  constructor() {
    super({
      event: "connect",
    });
    this.key = 'Yz:restart';
    this.maxRetries = 100; // 最大重试次数
    this.retryDelay = 200; // 重试延迟(毫秒)
  }

  async execute(e) {
    if (!Bot.uin.includes(e.self_id))
      Bot.uin.push(e.self_id)
    
    const restart = await redis.get(this.key);
    if (!restart) {
      logger.info('没有检测到重启信息，机器人正常启动');
      return;
    }
    
    try {
      const restartData = JSON.parse(restart);
      const botUin = restartData.uin || Bot.uin[0];
      const isReady = await this.waitForBotReady(botUin);
      
      if (!isReady) {
        logger.error('Bot未能在规定时间内就绪，尝试发送简单消息');
        await this.sendSimpleMessage(restartData);
        await redis.del(this.key);
        return;
      }
      
      const restartCompleteTime = Date.now();
      const restartTime = ((restartCompleteTime - restartData.time) / 1000).toFixed(4);
      
      logger.info(`Bot已就绪，重启耗时${restartTime}秒，准备发送通知...`);
      
      // 发送详细的重启消息
      await this.sendDetailedMessage(restartData, restartTime, botUin);
      
      // 删除重启信息
      await redis.del(this.key);
      logger.info('重启消息发送完成');
      
    } catch (error) {
      logger.error(`处理重启消息失败：${error.message}`);
      logger.error(error.stack);
      
      // 尝试发送简单消息
      try {
        const restartData = JSON.parse(await redis.get(this.key));
        if (restartData) {
          await this.sendSimpleMessage(restartData);
          await redis.del(this.key);
        }
      } catch (innerError) {
        logger.error('发送简单重启消息也失败了');
      }
    }
  }
  
  /**
   * 等待Bot完全就绪
   * @param {string} botUin Bot账号
   * @returns {Promise<boolean>} 是否就绪
   */
  async waitForBotReady(botUin) {
    let retries = 0;
    
    while (retries < this.maxRetries) {
      const bot = Bot[botUin];
      
      if (!bot) {
        retries++;
        await this.delay(this.retryDelay);
        continue;
      }
      
      // 检查Bot是否初始化完成且可以发送消息
      if (bot._ready === true) {
        logger.info(`Bot[${botUin}]已完全就绪`);
        return true;
      }
      
      // 如果Bot正在初始化，等待更长时间
      if (bot._initializing) {
        logger.info(`第${retries + 1}次检查：Bot正在初始化中...`);
        retries++;
        await this.delay(this.retryDelay * 2);
        continue;
      }
      
      // 尝试测试发送能力
      try {
        // 简单测试pickUser方法是否可用
        if (typeof bot.pickUser === 'function') {
          logger.info(`第${retries + 1}次检查：Bot基础功能可用`);
          // 给Bot一点额外时间完成初始化
          await this.delay(500);
          return true;
        }
      } catch (err) {
        logger.warn(`第${retries + 1}次检查：Bot功能测试失败 - ${err.message}`);
      }
      
      retries++;
      await this.delay(this.retryDelay);
    }
    
    logger.warn(`Bot[${botUin}]在${this.maxRetries}次检查后仍未就绪`);
    return false;
  }
  
  /**
   * 发送详细的重启消息
   */
  async sendDetailedMessage(restartData, restartTime, botUin) {
    try {
      const pluginStats = loader.getPluginStats();
      const startupTime = (pluginStats.totalLoadTime / 1000).toFixed(4);
      
      const msgs = [];
      
      // 基础统计信息
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
        time: Math.floor((restartData.time - 5000) / 1000)
      });
      
      // 插件详情
      if (pluginStats.plugins && pluginStats.plugins.length > 0) {
        const sortedPlugins = pluginStats.plugins.sort((a, b) => b.loadTime - a.loadTime);
        
        let pluginListMsg = ['📦 插件加载详情', '━━━━━━━━━━━━━━'];
        
        sortedPlugins.forEach((plugin, index) => {
          const loadTimeMs = plugin.loadTime.toFixed(2);
          const icon = plugin.loadTime > 100 ? '⚠️' : '✅';
          pluginListMsg.push(`${icon} [${plugin.name}] ${loadTimeMs}ms`);
        });
        
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
          time: Math.floor((restartData.time - 3000) / 1000)
        });
      }
      
      // 优化建议
      const suggestions = [];
      if (pluginStats.plugins.some(p => p.loadTime > 200)) {
        suggestions.push('• 部分插件加载缓慢，建议检查初始化逻辑');
      }
      if (pluginStats.totalPlugins > 50) {
        suggestions.push('• 插件数量较多，可考虑精简未使用的插件');
      }
      if (parseFloat(startupTime) > 10) {
        suggestions.push('• 启动时间较长，建议优化插件加载流程');
      }
      
      if (suggestions.length > 0) {
        msgs.push({
          message: ['💡 优化建议', '━━━━━━━━━━━━━━', ...suggestions].join('\n'),
          nickname: '性能分析',
          user_id: String(botUin),
          time: Math.floor((restartData.time - 1000) / 1000)
        });
      }
      
      // 发送消息
      const target = restartData.isGroup ? 
        Bot[botUin].pickGroup(restartData.id) : 
        Bot[botUin].pickUser(restartData.id);
      
      if (target && typeof target.makeForwardMsg === 'function') {
        const forwardMsg = await target.makeForwardMsg(msgs);
        await target.sendMsg(forwardMsg);
        logger.info('详细重启消息发送成功');
      } else {
        // 降级为简单消息
        await this.sendSimpleMessage(restartData, restartTime);
      }
      
    } catch (error) {
      logger.error(`发送详细消息失败：${error.message}`);
      // 降级为简单消息
      await this.sendSimpleMessage(restartData, restartTime);
    }
    if (!cfg.bot.online_msg_exp) return
    const key = `Yz:OnlineMsg:${e.self_id}`
    if (await redis.get(key)) return
    redis.set(key, "1", { EX: cfg.bot.online_msg_exp * 60 })
    Bot.sendMasterMsg(`欢迎使用【XRK-MultiBot v${cfg.package.version}】\n【向日葵妈咪妈咪哄】安装原神适配器和向日葵插件\n【#状态】查看运行状态\n【#日志】查看运行日志\n【#重启】重新启动\n【#更新】拉取 Git 更新\n【#全部更新】更新全部插件\n【#更新日志】查看更新日志`)
  }
  
  /**
   * 发送简单的重启消息
   */
  async sendSimpleMessage(restartData, restartTime = null) {
    try {
      const botUin = restartData.uin || Bot.uin[0];
      const bot = Bot[botUin];
      
      if (!bot) {
        logger.error(`Bot[${botUin}]不存在，无法发送消息`);
        return;
      }
      
      let message = '✅ 重启成功';
      if (restartTime) {
        message += `，耗时${restartTime}秒`;
      }
      
      const target = restartData.isGroup ? 
        bot.pickGroup(restartData.id) : 
        bot.pickUser(restartData.id);
      
      if (target && typeof target.sendMsg === 'function') {
        await target.sendMsg(message);
        logger.info('简单重启消息发送成功');
      } else {
        logger.error('目标对象不可用');
      }
      
    } catch (error) {
      logger.error(`发送简单消息失败：${error.message}`);
    }
  }
  
  /**
   * 延迟函数
   * @param {number} ms 延迟毫秒数
   * @returns {Promise}
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
    
