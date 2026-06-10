/**
 * 事件监听基类
 *
 * 统一经 Bot.PluginsLoader 走事件链（所有 adapter 消息/通知/请求均经此入口）。
 *
 * 文件路径: lib/listener/listener.js
 * 监听器存放路径: plugins/<插件根>/events/
 *
 * @class EventListener
 * @example
 * import EventListener from '../../lib/listener/listener.js';
 *
 * export default class MyListener extends EventListener {
 *   constructor() {
 *     super({ prefix: '', event: 'message.post_type', once: false });
 *   }
 * }
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
