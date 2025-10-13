// http.js - HttpApi基类，提供API模块的基本结构
// 标准化注释，提供完整实现

/**
 * HttpApi基类，所有API模块应继承此类
 * @class HttpApi
 */
export default class HttpApi {
  /**
   * 构造函数，初始化API属性
   * @param {Object} [config={}] - 配置
   */
  constructor(config = {}) {
    /** @type {string} API名称 */
    this.name = config.name || '';

    /** @type {string} 描述 */
    this.dsc = config.dsc || '';

    /** @type {number} 优先级 */
    this.priority = config.priority || 100;

    /** @type {boolean} 是否启用 */
    this.enable = config.enable !== false;

    /** @type {Array} 路由列表 */
    this.routes = config.routes || [];

    /** @type {string} 前缀 */
    this.prefix = config.prefix || '';

    /** @type {number} 创建时间 */
    this.createTime = Date.now();
  }

  /**
   * 初始化API，注册路由
   * @param {Object} fastify - Fastify实例
   * @param {Object} bot - Bot实例
   * @returns {Promise<void>}
   */
  async init(fastify, bot) {
    // 子类应重写此方法注册路由
    // 示例：
    // fastify.get('/example', async (req, reply) => { ... });
  }

  /**
   * 停止API
   * @returns {Promise<void>}
   */
  async stop() {
    // 子类可重写此方法清理资源
  }

  /**
   * 获取API信息
   * @returns {Object} 信息对象
   */
  getInfo() {
    return {
      name: this.name,
      dsc: this.dsc,
      priority: this.priority,
      routes: this.routes.length,
      enable: this.enable,
      createTime: this.createTime
    };
  }
}