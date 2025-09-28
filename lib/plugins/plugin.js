const stateArr = {}
const SymbolTimeout = Symbol("Timeout")
const SymbolResolve = Symbol("Resolve")

let Common
try {
  Common = (await import("#miao")).Common
} catch {}

export default class plugin {
  /**
   * 插件基类构造函数
   * @param {Object} options - 插件配置选项
   * @param {string} options.name - 插件名称
   * @param {string} options.dsc - 插件描述
   * @param {Object} options.handler - handler配置
   * @param {string} options.namespace - 命名空间
   * @param {string} options.event - 执行事件，默认message
   * @param {number|string} options.priority - 优先级
   * @param {Object|Array} options.task - 定时任务配置
   * @param {Array} options.rule - 命令规则配置
   * @param {boolean} options.bypassThrottle - 是否绕过节流
   */
  constructor({
    name = "your-plugin",
    dsc = "无",
    bypassThrottle = false,
    handler,
    namespace,
    event = "message",
    priority = 5000,
    task = { name: "", fnc: "", cron: "" },
    rule = []
  }) {
    this.name = name
    this.dsc = dsc
    this.event = event
    this.priority = priority
    this.task = task
    this.rule = rule
    this.bypassThrottle = bypassThrottle
    
    if (handler) {
      this.handler = handler
      this.namespace = namespace || ""
    }
  }

  /**
   * 发送回复消息
   * @param {string|Array} msg - 消息内容
   * @param {boolean} quote - 是否引用回复
   * @param {Object} data - 附加数据
   * @returns {Promise|boolean}
   */
  reply(msg = "", quote = false, data = {}) {
    if (!this.e?.reply || !msg) return false
    return this.e.reply(msg, quote, data)
  }

  /**
   * 标记消息需要重新解析
   * 用于插件修改消息后通知loader重新解析
   */
  markNeedReparse() {
    if (this.e) {
      this.e._needReparse = true
    }
  }

  /**
   * 生成上下文键值
   * @param {boolean} isGroup - 是否群聊
   * @returns {string}
   */
  conKey(isGroup = false) {
    const selfId = this.e?.self_id || ''
    const targetId = isGroup ? 
      (this.group_id || this.e?.group_id || '') : 
      (this.user_id || this.e?.user_id || '')
    return `${this.name}.${selfId}.${targetId}`
  }

  /**
   * 设置上下文
   * @param {string} type - 执行方法
   * @param {boolean} isGroup - 是否群聊
   * @param {number} time - 超时时间(秒)
   * @param {string} timeout - 超时提示
   * @returns {Object}
   */
  setContext(type, isGroup = false, time = 120, timeout = "操作超时已取消") {
    const key = this.conKey(isGroup)
    if (!stateArr[key]) stateArr[key] = {}
    stateArr[key][type] = this.e
    
    if (time > 0) {
      stateArr[key][type][SymbolTimeout] = setTimeout(() => {
        if (!stateArr[key]?.[type]) return
        
        const state = stateArr[key][type]
        const resolve = state[SymbolResolve]
        
        delete stateArr[key][type]
        if (!Object.keys(stateArr[key]).length) delete stateArr[key]
        
        resolve ? resolve(false) : this.reply(timeout, true)
      }, time * 1000)
    }
    
    return stateArr[key][type]
  }

  /**
   * 获取上下文
   * @param {string} type - 类型
   * @param {boolean} isGroup - 是否群聊
   * @returns {Object|null}
   */
  getContext(type, isGroup = false) {
    const key = this.conKey(isGroup)
    if (!stateArr[key]) return null
    return type ? stateArr[key][type] : stateArr[key]
  }

  /**
   * 结束上下文
   * @param {string} type - 类型
   * @param {boolean} isGroup - 是否群聊
   */
  finish(type, isGroup = false) {
    const key = this.conKey(isGroup)
    const context = stateArr[key]?.[type]
    
    if (context) {
      const timeout = context[SymbolTimeout]
      const resolve = context[SymbolResolve]
      
      if (timeout) clearTimeout(timeout)
      if (resolve) resolve(true)
      
      delete stateArr[key][type]
      if (!Object.keys(stateArr[key]).length) delete stateArr[key]
    }
  }

  /**
   * 等待上下文响应
   * @param {...any} args - 参数
   * @returns {Promise}
   */
  awaitContext(...args) {
    return new Promise(resolve => {
      const context = this.setContext("resolveContext", ...args)
      if (context) context[SymbolResolve] = resolve
    })
  }

  /**
   * 解析上下文
   * @param {Object} context - 上下文
   */
  resolveContext(context) {
    const key = this.conKey(false)
    const storedContext = stateArr[key]?.["resolveContext"]
    const resolve = storedContext?.[SymbolResolve]
    
    this.finish("resolveContext")
    if (resolve && context) resolve(this.e)
  }

  /**
   * 渲染图片
   * @param {string} plugin - 插件名
   * @param {string} tpl - 模板名
   * @param {Object} data - 数据
   * @param {Object} cfg - 配置
   * @returns {Promise}
   */
  async renderImg(plugin, tpl, data, cfg) {
    const renderCfg = { ...(cfg || {}), e: this.e }
    return Common?.render(plugin, tpl, data, renderCfg)
  }
}