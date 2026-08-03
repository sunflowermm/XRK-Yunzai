import EventListener from '../../../lib/listener/listener.js'

/** [compat] request → PluginsLoader.deal */
export default class requestEvent extends EventListener {
  constructor() {
    super({ event: 'request' })
  }
}
