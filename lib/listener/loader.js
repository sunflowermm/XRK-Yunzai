import fs from "node:fs/promises"
import path from "node:path"
import lodash from "lodash"

/**
 * 加载监听事件
 */
class ListenerLoader {
  /**
   * 收集所有事件目录：plugins/<插件根>/events
   */
  async getEventDirs() {
    const dirs = []
    const pluginsRoot = "./plugins"

    try {
      const entries = await fs.readdir(pluginsRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith(".")) continue

        const dir = path.join(pluginsRoot, entry.name, "events")
        try {
          await fs.access(dir)
          dirs.push({
            dir,
            importBase: `../../plugins/${entry.name}/events`
          })
        } catch {
          // 无 events 子目录则忽略
        }
      }
    } catch {
      // plugins 不存在时忽略
    }

    return dirs
  }

  /**
   * 监听事件加载
   */
  async load() {
    Bot.makeLog('info', "加载监听事件中...", 'ListenerLoader');
    let eventCount = 0

    try {
      const eventDirs = await this.getEventDirs()

      for (const { dir, importBase } of eventDirs) {
        const files = await fs.readdir(dir)
        const eventFiles = files.filter(file => file.endsWith(".js"))

        for (const file of eventFiles) {
          const displayName = path.join(dir, file)
          Bot.makeLog('debug', `加载监听事件 ${displayName}`, 'ListenerLoader');
          try {
            const listener = await import(`${importBase}/${file}`)
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
            Bot.makeLog('error', `监听事件加载错误 ${displayName}`, 'ListenerLoader', err);
          }
        }
      }
    } catch (error) {
      Bot.makeLog('error', "加载事件目录失败", 'ListenerLoader', error);
    }

    Bot.makeLog('info', `加载监听事件[${eventCount}个]`, 'ListenerLoader');

    if (process.argv.includes("server")) {
      Bot.makeLog('info', "加载适配器中...", 'ListenerLoader');
      let adapterCount = 0
      for (const adapter of Bot.adapter) {
        try {
          Bot.makeLog('debug', `加载适配器 ${adapter.name}(${adapter.id})`, 'ListenerLoader');
          await adapter.load()
          adapterCount++
        } catch (err) {
          Bot.makeLog('error', `适配器加载错误 ${adapter.name}(${adapter.id})`, 'ListenerLoader', err)
        }
      }
      Bot.makeLog('info', `加载适配器[${adapterCount}个]`, 'ListenerLoader');
    } else { }
  }
}

export default new ListenerLoader()