/**
 * [compat] Handler — 经典 Yunzai 插件 handler 契约
 * 对外：add / del / call / callAll / has（形状勿改）
 */
const events = {}

const Handler = {
  add(cfg) {
    const { ns, fn, self, priority = 500 } = cfg
    const key = cfg.key || cfg.event
    if (!key || !fn) return
    Handler.del(ns, key)
    Bot.makeLog('mark', `[Handler][Reg]: [${ns}][${key}]`, 'PluginsHandler')
    events[key] = events[key] || []
    events[key].push({ priority, fn, ns, self, key })
    events[key].sort((a, b) => a.priority - b.priority)
  },

  del(ns, key = '') {
    if (!key) {
      for (const k of Object.keys(events)) Handler.del(ns, k)
      return
    }
    if (!events[key]) return
    events[key] = events[key].filter(h => h.ns !== ns)
    if (!events[key].length) delete events[key]
    else events[key].sort((a, b) => a.priority - b.priority)
  },

  async callAll(key, e, args) {
    // 与经典实现一致：暂时屏蔽
    // return Handler.call(key, e, args, true)
  },

  async call(key, e, args, allHandler = false) {
    const list = events[key]
    if (!list?.length) return
    let ret
    for (const obj of list) {
      let done = true
      const reject = (msg = '') => {
        if (msg) Bot.makeLog('mark', `[Handler][Reject]: [${obj.ns}][${key}] ${msg}`, 'PluginsHandler')
        done = false
      }
      try {
        ret = await obj.fn.call(obj.self, e, args, reject)
      } catch (error) {
        Bot.makeLog('error', `[Handler][Error]: [${obj.ns}][${key}]`, 'PluginsHandler', error)
        done = false
      }
      if (done && !allHandler) {
        Bot.makeLog('mark', `[Handler][Done]: [${obj.ns}][${key}]`, 'PluginsHandler')
        return ret
      }
    }
    return ret
  },

  has(key) {
    return !!events[key]?.length
  },
}

export default Handler
