import EventListener from "../listener/listener.js"
import cfg from "../config/config.js"

/**
 * 监听连接事件（理论上属于各类适配器的上线的事件）
 * 处理上线消息（与icqq无关）
 * 同时为NCQQ连接添加全局Bot函数
 */
export default class connectEvent extends EventListener {
  constructor() {
    super({ 
      event: "connect",
      once: true
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
      
      let msg = `重启成功，耗时${time.toFixed(2)}秒`
      
      if (restart.isGroup) {
        await Bot[currentUin].pickGroup(restart.id).sendMsg(msg)
      } else {
        await Bot[currentUin].pickUser(restart.id).sendMsg(msg)
      }
      await redis.del(`${this.key}:${currentUin}`)
    } catch (error) {
      logger.error(`发送重启消息失败：${error}`)
    }

    if (!cfg.bot.online_msg_exp) return
    const key = `Yz:loginMsg:${e.self_id}`
    if (await redis.get(key)) return
    redis.set(key, "1", { EX: cfg.bot.online_msg_exp * 60 })
  }
}