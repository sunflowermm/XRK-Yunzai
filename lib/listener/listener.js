/**
 * 事件监听基类，统一使用 Bot.PluginsLoader 走事件链
 */
export default class EventListener {
  constructor(data) {
    this.prefix = data.prefix || ""
    this.event = data.event
    this.once = data.once || false
  }

  get plugins() {
    return global.Bot?.PluginsLoader
  }

  async execute(e) {
    if (this.plugins) await this.plugins.deal(e)
  }
}