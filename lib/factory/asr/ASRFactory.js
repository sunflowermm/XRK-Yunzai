/**
 * ASR 工厂：统一创建各平台 ASR 客户端
 */
import VolcengineASRClient from './VolcengineASRClient.js';
import BaseFactory from '../BaseFactory.js';

const providers = new Map([
  ['volcengine', (deviceId, config, Bot) => new VolcengineASRClient(deviceId, config, Bot)]
]);
const baseFactory = new BaseFactory(providers, 'ASR');

export default class ASRFactory {
  static registerProvider(name, factoryFn) {
    baseFactory.registerProvider(name, factoryFn);
  }

  static listProviders() {
    return baseFactory.listProviders();
  }

  static isProviderSupported(provider) {
    return baseFactory.isProviderSupported(provider);
  }

  static createClient(deviceId, config, Bot) {
    if (!config?.enabled) throw new Error('ASR未启用');
    const provider = String(config.provider ?? '').toLowerCase();
    if (!provider) throw new Error('ASR配置缺少 provider');
    const factory = baseFactory.providers.get(provider);
    if (!factory) throw new Error(`不支持的ASR提供商: ${config.provider}`);
    return factory(deviceId, config, Bot);
  }
}
