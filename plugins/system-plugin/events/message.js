import EventListener from '../../../lib/listener/listener.js'

/** 监听 message 事件（OneBot/device/stdin 等 adapter 发 message.* 后经此进入事件链） */
export default class messageEvent extends EventListener {
  constructor() {
    super({ event: 'message' })
  }
}