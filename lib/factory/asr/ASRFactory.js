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
    return baseFactory.createDeviceClient('ASR', deviceId, config, Bot);
  }
}
