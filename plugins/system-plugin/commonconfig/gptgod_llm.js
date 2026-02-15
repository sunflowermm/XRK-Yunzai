import ConfigBase from '../../../lib/commonconfig/commonconfig.js';

/**
 * GPTGod LLM 配置
 */
export default class GPTGodLLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'gptgod_llm',
      displayName: 'GPTGod LLM配置',
      description: 'GPTGod大语言模型配置，支持识图功能',
      filePath: (cfg) => {
        const port = cfg?._port ?? 8086;
        return port ? `data/server_bots/${port}/gptgod_llm.yaml` : `config/default_config/gptgod_llm.yaml`;
      },
      fileType: 'yaml',
      schema: {
        fields: {
          enabled: {
            type: 'boolean',
            label: '启用',
            default: true,
            component: 'Switch'
          },
          baseUrl: {
            type: 'string',
            label: 'API地址',
            default: 'https://api.gptgod.online/v1',
            component: 'Input'
          },
          apiKey: {
            type: 'string',
            label: 'API密钥',
            description: 'GPTGod API密钥',
            default: '',
            component: 'InputPassword'
          },
          model: {
            type: 'string',
            label: '模型名称',
            default: 'gemini-exp-1114',
            component: 'Input'
          },
          temperature: {
            type: 'number',
            label: '温度参数',
            description: '控制输出的随机性，范围0-2',
            min: 0,
            max: 2,
            step: 0.1,
            default: 0.8,
            component: 'InputNumber'
          },
          maxTokens: {
            type: 'number',
            label: '最大Token数',
            min: 1,
            default: 6000,
            component: 'InputNumber'
          },
          topP: {
            type: 'number',
            label: 'Top P',
            description: '核采样参数',
            min: 0,
            max: 1,
            step: 0.1,
            default: 0.9,
            component: 'InputNumber'
          },
          presencePenalty: {
            type: 'number',
            label: '存在惩罚',
            min: -2,
            max: 2,
            step: 0.1,
            default: 0.6,
            component: 'InputNumber'
          },
          frequencyPenalty: {
            type: 'number',
            label: '频率惩罚',
            min: -2,
            max: 2,
            step: 0.1,
            default: 0.6,
            component: 'InputNumber'
          },
          timeout: {
            type: 'number',
            label: '请求超时',
            description: '请求超时时间（毫秒）',
            min: 1000,
            default: 360000,
            component: 'InputNumber'
          },
          enableStream: {
            type: 'boolean',
            label: '启用流式输出',
            default: true,
            component: 'Switch'
          },
          enableTools: {
            type: 'boolean',
            label: '启用工具调用',
            default: true,
            component: 'Switch'
          },
          proxy: {
            type: 'object',
            label: '代理配置',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用代理',
                default: false,
                component: 'Switch'
              },
              http: {
                type: 'string',
                label: 'HTTP代理',
                default: '',
                component: 'Input'
              },
              https: {
                type: 'string',
                label: 'HTTPS代理',
                default: '',
                component: 'Input'
              }
            }
          }
        }
      }
    });
  }
}
