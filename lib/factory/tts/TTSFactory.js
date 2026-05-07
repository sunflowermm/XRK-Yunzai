/**
 * TTS 工厂：统一创建各平台 TTS 客户端
 */
import VolcengineTTSClient from './VolcengineTTSClient.js';
import BaseFactory from '../BaseFactory.js';

const providers = new Map([
  ['volcengine', (deviceId, config, Bot) => new VolcengineTTSClient(deviceId, config, Bot)]
]);
const baseFactory = new BaseFactory(providers, 'TTS');

export default class TTSFactory {
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
    return baseFactory.createDeviceClient('TTS', deviceId, config, Bot);
  }
}
