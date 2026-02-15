import EventListener from '../../../lib/listener/listener.js'

/** 监听 request 事件（加群/好友等请求经此进入事件链） */
export default class requestEvent extends EventListener {
  constructor() {
    super({ event: 'request' })
  }
}
