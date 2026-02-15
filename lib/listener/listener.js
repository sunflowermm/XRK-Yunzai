/**
 * 事件监听基类，统一使用 Bot.PluginsLoader 走事件链（所有 adapter 消息/通知/请求均经此入口）
 */
export default class EventListener {
  constructor(data) {
    this.prefix = data.prefix ?? ''
    this.event = data.event
    this.once = data.once ?? false
  }

  get plugins() {
    return Bot.PluginsLoader
  }

  async execute(e) {
    if (this.plugins) return await this.plugins.deal(e)
  }
}