import lodash from "lodash"
import BotUtil from "../util.js"
import { FileUtils } from "../utils/file-utils.js"
import { PluginDirScanner } from "../utils/plugin-dir-scanner.js"

/**
 * 事件与适配器加载器
 */
class ListenerLoader {
  loaded = false

  /**
   * 收集 plugins/<插件根>/events 目录
   * @returns {Array<{ dir: string, pluginName: string }>}
   */
  getEventDirs() {
    try {
      return PluginDirScanner.scanSubdirs('events');
    } catch (err) {
      BotUtil.makeLog('warn', '扫描插件 events 目录失败', 'ListenerLoader', err);
      return [];
    }
  }

  /**
   * 仅加载监听事件（connect / message 等），不加载适配器。
   */
  async loadEvents() {
    if (this.loaded) return
    BotUtil.makeLog('info', "加载监听事件中...", 'ListenerLoader');
    let eventCount = 0
    try {
      const eventDirs = this.getEventDirs()
      for (const { dir } of eventDirs) {
        const eventFiles = PluginDirScanner.listJsFiles(dir)
        for (const filePath of eventFiles) {
          const displayName = filePath
          BotUtil.makeLog('debug', `加载监听事件 ${displayName}`, 'ListenerLoader');
          try {
            const listener = await import(FileUtils.toImportUrl(filePath))
            if (!listener.default) continue
            const instance = new listener.default()
            const on = instance.once ? "once" : "on"
            if (lodash.isArray(instance.event)) {
              instance.event.forEach((type) => {
                const handler = instance[type] ? type : "execute"
                Bot[on](instance.prefix + type, instance[handler].bind(instance))
              })
            } else {
              const handler = instance[instance.event] ? instance.event : "execute"
              Bot[on](instance.prefix + instance.event, instance[handler].bind(instance))
            }
            eventCount++
          } catch (err) {
            BotUtil.makeLog('error', `监听事件加载错误 ${displayName}`, 'ListenerLoader', err);
          }
        }
      }
    } catch (error) {
      BotUtil.makeLog('error', "加载事件目录失败", 'ListenerLoader', error);
    }
    this.loaded = true
    BotUtil.makeLog('info', `加载监听事件[${eventCount}个]`, 'ListenerLoader');
  }

  /**
   * 加载协议适配器（QQ/WeChat 等），在服务器已监听后调用。
   */
  async loadAdapters() {
    if (!process.argv.includes("server")) return
    BotUtil.makeLog('info', "加载适配器中...", 'ListenerLoader');
    let adapterCount = 0
    for (const adapter of Bot.adapter) {
      try {
        BotUtil.makeLog('debug', `加载适配器 ${adapter.name}(${adapter.id})`, 'ListenerLoader');
        await adapter.load()
        adapterCount++
      } catch (err) {
        BotUtil.makeLog('error', `适配器加载错误 ${adapter.name}(${adapter.id})`, 'ListenerLoader', err)
      }
    }
    BotUtil.makeLog('info', `加载适配器[${adapterCount}个]`, 'ListenerLoader');
  }

  /** 完整加载：先事件后适配器 */
  async load() {
    await this.loadEvents()
    await this.loadAdapters()
  }
}

export default new ListenerLoader()
