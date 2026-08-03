import EventListener from '../../../lib/listener/listener.js'

/** [compat] message → PluginsLoader.deal */
export default class messageEvent extends EventListener {
  constructor() {
    super({ event: 'message' })
  }
}