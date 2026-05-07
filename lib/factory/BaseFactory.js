/**
 * 工厂基类：提供商注册与创建
 */
export default class BaseFactory {
  constructor(providers = new Map(), factoryName = 'Factory') {
    this.providers = providers;
    this.factoryName = factoryName;
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

  /**
   * 设备级客户端创建（ASR/TTS 等）：校验启用与 provider 后调用注册表
   * @param {string} kindLabel - 错误信息用标签，如 ASR、TTS
   * @param {string} deviceId
   * @param {Object} config
   * @param {*} Bot
   * @returns {*}
   */
  createDeviceClient(kindLabel, deviceId, config, Bot) {
    if (!config?.enabled) throw new Error(`${kindLabel}未启用`);
    const provider = String(config.provider ?? '').toLowerCase();
    if (!provider) throw new Error(`${kindLabel}配置缺少 provider`);
    const factoryFn = this.providers.get(provider);
    if (!factoryFn) throw new Error(`不支持的${kindLabel}提供商: ${config.provider}`);
    return factoryFn(deviceId, config, Bot);
  }
}
