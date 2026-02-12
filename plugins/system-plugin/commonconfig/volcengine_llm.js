import ConfigBase from '../../../lib/commonconfig/commonconfig.js';

/**
 * 火山引擎 LLM 配置
 */
export default class VolcengineLLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'volcengine_llm',
      displayName: '火山引擎 LLM配置',
      description: '火山引擎豆包大模型配置',
      filePath: (cfg) => {
        const port = cfg?._port || cfg?.server?.server?.port || 8086;
        return port ? `data/server_bots/${port}/volcengine_llm.yaml` : `config/default_config/volcengine_llm.yaml`;
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
            default: 'https://ark.cn-beijing.volces.com/api/v3',
            component: 'Input'
          },
          apiKey: {
            type: 'string',
            label: 'API密钥',
            description: '火山引擎API密钥',
            default: '',
            component: 'InputPassword'
          },
          model: {
            type: 'string',
            label: '模型名称',
            default: 'ep-20241220101210-xxxxx',
            component: 'Input'
          },
          chatModel: {
            type: 'string',
            label: '聊天模型',
            default: 'ep-20241220101210-xxxxx',
            component: 'Input'
          },
          temperature: {
            type: 'number',
            label: '温度参数',
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
            default: 4000,
            component: 'InputNumber'
          },
          max_tokens: {
            type: 'number',
            label: '最大Token数（兼容字段）',
            min: 1,
            default: 4000,
            component: 'InputNumber'
          },
          topP: {
            type: 'number',
            label: 'Top P',
            min: 0,
            max: 1,
            step: 0.1,
            default: 0.9,
            component: 'InputNumber'
          },
          top_p: {
            type: 'number',
            label: 'Top P（兼容字段）',
            min: 0,
            max: 1,
            step: 0.1,
            default: 0.9,
            component: 'InputNumber'
          },
          timeout: {
            type: 'number',
            label: '请求超时',
            min: 1000,
            default: 60000,
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
            default: false,
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
