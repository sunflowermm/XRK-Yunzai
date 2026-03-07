import ConfigBase from '../../../lib/commonconfig/commonconfig.js';
import { getServerConfigPath } from '../../../lib/config/config-constants.js';

/** Anthropic 协议兼容 LLM 工厂配置（多运营商） */
export default class AnthropicCompatibleLLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'anthropic_compat_llm',
      displayName: 'Anthropic 协议兼容 LLM 工厂',
      description: 'Anthropic Messages API 兼容运营商集合配置',
      filePath: (c) => getServerConfigPath(c?._port ?? 8086, 'anthropic_compat_llm'),
      fileType: 'yaml',
      schema: {
        fields: {
          providers: {
            type: 'array',
            label: 'Anthropic 兼容运营商列表',
            component: 'ArrayForm',
            itemType: 'object',
            default: [],
            itemSchema: {
              fields: {
                key: { type: 'string', label: '运营商标识', default: '', component: 'Input' },
                label: { type: 'string', label: '展示名称', default: '', component: 'Input' },
                baseUrl: { type: 'string', label: 'API 基础地址', default: 'https://api.anthropic.com/v1', component: 'Input' },
                path: { type: 'string', label: '接口路径', default: '/messages', component: 'Input' },
                apiKey: { type: 'string', label: 'API Key', default: '', component: 'InputPassword' },
                model: { type: 'string', label: '模型', default: '', component: 'Input' },
                maxTokens: { type: 'number', label: 'max_tokens', min: 1, default: 2048, component: 'InputNumber' },
                temperature: { type: 'number', label: 'temperature', min: 0, max: 2, default: 0.7, component: 'InputNumber' },
                timeout: { type: 'number', label: '超时(ms)', min: 1000, default: 360000, component: 'InputNumber' },
                proxy: { type: 'object', label: '代理', component: 'SubForm', fields: { enabled: { type: 'boolean', default: false, component: 'Switch' }, url: { type: 'string', default: '', component: 'Input' } } }
              }
            }
          }
        }
      }
    });
  }
}
