import EventListener from "../../lib/listener/listener.js"
import cfg from "../../lib/config/config.js"

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
    if (!cfg.bot.online_msg_exp) return
    const key = `Yz:loginMsg:${e.self_id}`
    if (await redis.get(key)) return
    redis.set(key, "1", { EX: cfg.bot.online_msg_exp * 60 })
    for (const i of cfg.masterQQ || [])
      e.bot
        .pickFriend(i)
        .sendMsg(
          `欢迎使用【XRK-MultiBot v${cfg.package.version}】\n【向日葵妈咪妈咪哄】安装原神适配器和向日葵插件\n【#状态】查看运行状态\n【#日志】查看运行日志\n【#重启】重新启动\n【#更新】拉取 Git 更新\n【#全部更新】更新全部插件\n【#更新日志】查看更新日志`,
        )
  }
}
    
