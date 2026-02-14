import { WorkflowManager } from '../aistream/workflow-manager.js';

const stateArr = {}
const SymbolTimeout = Symbol("Timeout")
const SymbolResolve = Symbol("Resolve")

let globalWorkflowManager = null;

/**
 * 插件基类
 * 
 * 提供工作流集成、上下文管理、消息回复等功能。
 * 所有插件都应继承此类。
 * 
 * 文件路径: lib/plugins/plugin.js
 * 插件存放路径: plugins/
 * 
 * @class plugin
 * @example
 * import plugin from '../../lib/plugins/plugin.js';
 * 
 * export default class MyPlugin extends plugin {
 *   constructor() {
 *     super({
 *       name: 'my-plugin',
 *       dsc: '我的插件',
 *       event: 'message',
 *       rule: [{ reg: '^#测试$', fnc: 'test' }]
 *     });
 *   }
 * 
 *   async test(e) {
 *     return this.reply('测试成功');
 *   }
 * }
 */
export default class plugin {
  constructor(options = {}) {
    this.name = options.name || "your-plugin"
    this.dsc = options.dsc || "无"
    this.event = options.event || "message"
    this.priority = options.priority || 5000
    this.task = options.task || { name: "", fnc: "", cron: "" }
    this.rule = options.rule || []
    this.bypassThrottle = options.bypassThrottle || false
    
    if (options.handler) {
      this.handler = options.handler
      this.namespace = options.namespace || ""
    }
  }

  /**
   * 获取工作流实例
   * @param {string} name - 工作流名称
   * @returns {AIStream|null} 工作流实例
   */
  getStream(name) {
    return Bot.StreamLoader?.getStream(name) ?? null;
  }

  getAllStreams() {
    const list = Bot.StreamLoader?.getAllStreams?.();
    return list ? new Map((list || []).map(s => [s.name, s])) : new Map();
  }

  getWorkflowManager() {
    if (!globalWorkflowManager) {
      globalWorkflowManager = new WorkflowManager();
      const streams = Bot.StreamLoader?.getAllStreams?.() ?? [];
      for (const stream of streams) {
        const name = stream.name;
        if (!name) continue;
        globalWorkflowManager.registerWorkflow(name, async (params, context) => {
          const { e, question, config } = context;
          return await stream.execute(e || params.e, question || params.question, config || {});
        }, {
          description: stream.description || '',
          enabled: stream.config?.enabled !== false,
          priority: stream.priority || 100
        });
      }
    }
    return globalWorkflowManager;
  }

  /**
   * 调用单个工作流
   * @param {string} name - 工作流名称
   * @param {Object} params - 参数
   * @param {Object} context - 上下文（可选，会自动使用this.e）
   * @returns {Promise<Object>} 结果
   */
  async callWorkflow(name, params = {}, context = {}) {
    const manager = this.getWorkflowManager();
    const finalContext = {
      e: context.e || this.e,
      question: context.question || params.question,
      config: context.config || params.config || {}
    };
    return await manager.run(name, params, finalContext);
  }

  /**
   * 同时调用多个工作流（并行）
   * @param {Array<string|Object>} workflows - 工作流列表
   * @param {Object} sharedParams - 共享参数
   * @param {Object} context - 上下文（可选，会自动使用this.e）
   * @returns {Promise<Array>} 结果数组
   */
  async callWorkflows(workflows, sharedParams = {}, context = {}) {
    const manager = this.getWorkflowManager();
    const finalContext = {
      e: context.e || this.e,
      question: context.question || sharedParams.question,
      config: context.config || sharedParams.config || {}
    };
    return await manager.runMultiple(workflows, sharedParams, finalContext);
  }

  /**
   * 顺序调用多个工作流（串行）
   * @param {Array<string|Object>} workflows - 工作流列表
   * @param {Object} sharedParams - 共享参数
   * @param {Object} context - 上下文（可选，会自动使用this.e）
   * @returns {Promise<Array>} 结果数组
   */
  async callWorkflowsSequential(workflows, sharedParams = {}, context = {}) {
    const manager = this.getWorkflowManager();
    const finalContext = {
      e: context.e || this.e,
      question: context.question || sharedParams.question,
      config: context.config || sharedParams.config || {}
    };
    return await manager.runSequential(workflows, sharedParams, finalContext);
  }

  /**
   * 直接执行工作流（简化调用）
   * @param {string} streamName - 工作流名称
   * @param {string|Object} question - 问题
   * @param {Object} config - 配置（可选）
   * @returns {Promise<string>} 结果
   */
  async executeWorkflow(streamName, question, config = {}) {
    const stream = this.getStream(streamName);
    if (!stream) {
      return `工作流 "${streamName}" 未找到`;
    }
    
    const e = this.e;
    return await stream.execute(e, question, config || {});
  }

  /**
   * 回复消息
   */
  reply(msg = "", quote = false, data = {}) {
    if (!this.e?.reply || !msg) return false
    return this.e.reply(msg, quote, data)
  }

  /**
   * 标记需要重新解析
   */
  markNeedReparse() {
    if (this.e) {
      this.e._needReparse = true
    }
  }

  /**
   * 获取上下文键
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
   */
  getContext(type, isGroup = false) {
    const key = this.conKey(isGroup)
    if (!stateArr[key]) return null
    return type ? stateArr[key][type] : stateArr[key]
  }

  /**
   * 结束上下文
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
   * 等待上下文
   */
  awaitContext(...args) {
    return new Promise(resolve => {
      const context = this.setContext("resolveContext", ...args)
      if (context) context[SymbolResolve] = resolve
    })
  }

  /**
   * 解析上下文
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
   */
  async renderImg(plugin, tpl, data, cfg) {
    try {
      const Common = (await import("#miao")).Common
      if (Common?.render) {
        const renderCfg = { ...(cfg || {}), e: this.e }
        return Common.render(plugin, tpl, data, renderCfg)
      }
    } catch {
      // 渲染失败，返回 null
    }
    return null
  }
}
