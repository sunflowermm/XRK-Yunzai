/**
 * [compat] EventListener — plugins 下 events 目录 → PluginsLoader.deal
 */
export default class EventListener {
  /**
   * @param {Object} options - 监听器配置
   * @param {string} [options.prefix=''] - 事件前缀
   * @param {string} options.event - 监听的事件名（必填）
   * @param {boolean} [options.once=false] - 是否只触发一次
   */
  constructor(options = {}) {
    if (!options.event) {
      throw new Error('EventListener requires options.event');
    }
    this.prefix = options.prefix ?? ''
    this.event = options.event
    this.once = options.once ?? false
  }

  get plugins() {
    return Bot.PluginsLoader
  }

  /**
   * 将事件交给插件加载器处理
   * @param {Object} e - 事件对象
   * @returns {Promise<*>}
   */
  async execute(e) {
    if (this.plugins) return await this.plugins.deal(e)
  }
}
