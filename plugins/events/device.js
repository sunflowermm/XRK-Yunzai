import EventListener from '../listener/listener.js'

export default class devicesEvent extends EventListener {
  constructor () {
    super({ event: 'device' })
  }

  async execute (e) {
    this.plugins.deal(e)
  }
}
