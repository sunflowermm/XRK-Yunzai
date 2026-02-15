import EventListener from '../../../lib/listener/listener.js'

/** 监听 notice 事件（各类 adapter 通知经此进入事件链） */
export default class noticeEvent extends EventListener {
  constructor() {
    super({ event: 'notice' })
  }
}
