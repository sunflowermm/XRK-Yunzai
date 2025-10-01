import EventListener from "../../lib/listener/listener.js"

/**
 * 监听上线事件
 */
export default class onlineEvent extends EventListener {
  constructor() {
    super({
      event: "online",
      once: true,
    })
  }

  async execute(e) {
    Bot.makeLog("info", `尽情享受吧QaQ`, 'event')
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
  }
}