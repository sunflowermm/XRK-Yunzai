/**
 * 工厂基类：提供商注册与创建
 *
 * LLM 等工厂均继承此类，统一 registerProvider / listProviders / createClient 契约。
 *
 * 文件路径: lib/factory/BaseFactory.js
 *
 * @abstract
 * @class BaseFactory
 * @example
 * class MyFactory extends BaseFactory {
 *   constructor() {
 *     super(new Map(), 'MyFactory');
 *     this.registerProvider('default', (config) => new MyClient(config));
 *   }
 *   createClient(provider, config) { ... }
 * }
 */
import { ObjectUtils } from '../utils/object-utils.js';

export default class BaseFactory {
  providers = new Map();
  factoryName = 'Factory';

  /**
   * @param {Map|Object} [providersOrOptions] - 提供商 Map，或 { providers, factoryName }
   * @param {string} [factoryName='Factory']
   */
  constructor(providersOrOptions, factoryName) {
    if (ObjectUtils.isPlainObject(providersOrOptions) && !(providersOrOptions instanceof Map)) {
      if (providersOrOptions.providers) this.providers = providersOrOptions.providers;
      if (providersOrOptions.factoryName) this.factoryName = providersOrOptions.factoryName;
    } else if (providersOrOptions instanceof Map) {
      this.providers = providersOrOptions;
    }
    if (factoryName) this.factoryName = factoryName;
  }

  /**
   * 注册提供商
   * @param {string} name - 提供商名称
   * @param {Function} factoryFn - 工厂函数
   * @throws {Error} 如果参数无效
   */
  registerProvider(name, factoryFn) {
    if (!name || typeof factoryFn !== 'function') {
      throw new Error(`注册${this.factoryName}提供商时必须提供名称和工厂函数`);
    }
    this.providers.set(String(name).toLowerCase(), factoryFn);
  }

  /**
   * 列出所有已注册的提供商
   * @returns {Array<string>} 提供商名称列表
   */
  listProviders() {
    return Array.from(this.providers.keys());
  }

  /**
   * 检查提供商是否支持
   * @param {string} provider - 提供商名称
   * @returns {boolean} 是否支持
   */
  isProviderSupported(provider) {
    return this.providers.has(String(provider).toLowerCase());
  }

  /**
   * 创建客户端（子类需要实现）
   * @param {...any} args - 参数
   * @returns {*} 客户端实例
   * @throws {Error} 如果提供商不存在
   */
  createClient(..._args) {
    throw new Error('子类必须实现 createClient 方法');
  }
}
