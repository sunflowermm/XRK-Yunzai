// http/http.js
import BotUtil from '../common/util.js';

/**
 * Fastify API 基类
 * - 子类可覆写 name/prefix/priority/enable
 * - 通过 this.route()/this.get()/this.post()/this.ws() 注册路由
 * - getInfo() 提供元数据给列表/日志
 */
export default class HttpApi {
  constructor(options = {}) {
    /** 基本元信息 */
    this.name = options.name || this.constructor.name || 'HttpApi';
    this.dsc = options.dsc || '暂无描述';
    this.prefix = options.prefix || '';       // 由 ApiLoader.register 的 prefix 合并
    this.priority = options.priority ?? 100;
    this.enable = options.enable !== false;

    /** 统计 */
    this.routes = [];
    this.createTime = Date.now();

    /** 注入的外部引用 */
    this.fastify = null;
    this.bot = null;
  }

  /**
   * 由 ApiLoader 调用，注入 fastify/bot 并让子类定义路由
   */
  async init(fastify, bot) {
    this.fastify = fastify;
    this.bot = bot;

    if (typeof this.setup === 'function') {
      // 子类可直接实现 setup(fastify, bot) 来完全自定义
      await this.setup(fastify, bot);
      return;
    }
    // 若子类没覆写 setup，可以仅调用 this.get/this.post/this.route 来添加路由
    if (typeof this.register === 'function') {
      await this.register();
    }
  }

  /** 元数据 */
  getInfo() {
    return {
      name: this.name,
      dsc: this.dsc,
      prefix: this.prefix,
      priority: this.priority,
      routes: this.routes.length,
      enable: this.enable !== false,
      createTime: this.createTime,
      key: this.key || ''
    };
  }

  /* -------------------- 路由辅助 -------------------- */

  /**
   * 注册通用路由
   * @param {Object} opt
   * @param {'GET'|'POST'|'PUT'|'DELETE'|'PATCH'|'OPTIONS'|'HEAD'|'ALL'} opt.method
   * @param {string} opt.url
   * @param {Function} opt.handler  (req, reply)
   * @param {Function|Array<Function>} [opt.preHandler]
   * @param {Object} [opt.schema]
   * @param {boolean} [opt.auth]     // false 明确跳过鉴权（默认 undefined：走全局鉴权）
   * @param {Object} [opt.rateLimit] // { max, timeWindow }
   */
  route(opt = {}) {
    if (!this.fastify) throw new Error('Fastify 实例未注入');

    const method = (opt.method || 'GET').toUpperCase();
    const url = opt.url || '/';
    const handler = opt.handler || (async (req, reply) => reply.send({ ok: true }));
    const preHandler = opt.preHandler ? (Array.isArray(opt.preHandler) ? opt.preHandler : [opt.preHandler]) : [];

    // 明确跳过鉴权：路由层额外 onRequest 直接放行（通过装饰 request 标志位）
    if (opt.auth === false) {
      this.fastify.addHook('onRequest', async (req, reply) => {
        // 仅在匹配该路由路径时标记（最省成本）
        if ((req.raw.url || '').split('?')[0] === (this.prefix + url)) {
          req.__skipAuth = true;
        }
      });
    }

    const rl = opt.rateLimit;
    const routeOpts = {
      schema: opt.schema,
      preHandler,
      config: rl ? { rateLimit: rl } : undefined,
      handler
    };

    // 统一注册
    const f = this.fastify;
    switch (method) {
      case 'GET': f.get(url, routeOpts, handler); break;
      case 'POST': f.post(url, routeOpts, handler); break;
      case 'PUT': f.put(url, routeOpts, handler); break;
      case 'DELETE': f.delete(url, routeOpts, handler); break;
      case 'PATCH': f.patch(url, routeOpts, handler); break;
      case 'OPTIONS': f.options(url, routeOpts, handler); break;
      case 'HEAD': f.head(url, routeOpts, handler); break;
      default: f.all(url, routeOpts, handler); break;
    }

    this.routes.push({ method, url });
    BotUtil.makeLog('debug', `  ↳ 路由: [${method}] ${this.prefix}${url}`, this.name);
  }

  get(url, handler, opt = {}) { this.route({ method: 'GET', url, handler, ...opt }); }
  post(url, handler, opt = {}) { this.route({ method: 'POST', url, handler, ...opt }); }
  put(url, handler, opt = {}) { this.route({ method: 'PUT', url, handler, ...opt }); }
  del(url, handler, opt = {}) { this.route({ method: 'DELETE', url, handler, ...opt }); }
  patch(url, handler, opt = {}) { this.route({ method: 'PATCH', url, handler, ...opt }); }
  all(url, handler, opt = {}) { this.route({ method: 'ALL', url, handler, ...opt }); }

  /**
   * 注册 WebSocket 路由（保持与原版同样的分发规则：按 URL 第一段）
   * @param {string} url  如 '/ws/chat'，会提取第一段 'ws'
   * @param {(conn, req, socket, head)=>void} handler
   */
  ws(url, handler) {
    if (!this.bot) throw new Error('Bot 实例未注入');
    const seg = String(url || '/').replace(/^\//, '').split('/')[0] || '';
    if (!seg) throw new Error('WS 路径不合法');

    this.bot.wsf[seg] ||= [];
    this.bot.wsf[seg].push(handler);
    this.routes.push({ method: 'WS', url });
    BotUtil.makeLog('debug', `  ↳ WS: ${url}  (key="${seg}")`, this.name);
  }
}
