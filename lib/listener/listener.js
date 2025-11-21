import PluginsLoader from "../plugins/loader.js"

/**
 * 事件监听基类
 * 
 * 提供事件监听和处理能力。
 * 所有事件监听器都应继承此类。
 * 
 * 文件路径: lib/listener/listener.js
 * 监听器存放路径: plugins/events/
 * 
 * @class EventListener
 * @example
 * import EventListener from '../../lib/listener/listener.js';
 * 
 * export default class MyListener extends EventListener {
 *   constructor() {
 *     super({
 *       prefix: 'my',
 *       event: 'message',
 *       once: false
 *     });
 *   }
 * 
 *   async execute(e) {
 *     this.plugins.deal(e);
 *   }
 * }
 */
export default class EventListener {
  /**
   * 事件监听构造函数
   * @param {Object} data - 配置对象
   * @param {string} data.prefix - 事件名称前缀
   * @param {string} data.event - 监听的事件
   * @param {boolean} data.once - 是否只监听一次
   */
  constructor(data) {
    this.prefix = data.prefix || ""
    this.event = data.event
    this.once = data.once || false
    this.plugins = PluginsLoader
  }
  
  /**
   * 默认执行方法
   * @param e 事件对象
   */
  async execute(e) {
    this.plugins.deal(e)
  }
}