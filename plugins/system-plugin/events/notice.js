import EventListener from '../../../lib/listener/listener.js'

/** [compat] notice → PluginsLoader.deal */
export default class noticeEvent extends EventListener {
  constructor() {
    super({ event: 'notice' })
  }
}
