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
     Bot.makeLog("info", `葵崽Online事件已触发`, 'event')
  }
}