import ConfigBase from '../../lib/commonconfig/commonconfig.js';

/**
 * Anthropic (Claude) LLM 配置
 */
export default class AnthropicLLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'anthropic_llm',
      displayName: 'Anthropic LLM配置',
      description: 'Anthropic Claude Messages API配置',
      filePath: (cfg) => {
        const port = cfg?._port || cfg?.server?.server?.port || 8086;
        return port ? `data/server_bots/${port}/anthropic_llm.yaml` : `config/default_config/anthropic_llm.yaml`;
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
            default: 'https://api.anthropic.com/v1',
            component: 'Input'
          },
          apiKey: {
            type: 'string',
            label: 'API密钥',
            description: 'Anthropic API密钥',
            default: '',
            component: 'InputPassword'
          },
          model: {
            type: 'string',
            label: '模型名称',
            default: 'claude-3-5-sonnet-20241022',
            component: 'Input'
          },
          chatModel: {
            type: 'string',
            label: '聊天模型',
            default: 'claude-3-5-sonnet-20241022',
            component: 'Input'
          },
          temperature: {
            type: 'number',
            label: '温度参数',
            min: 0,
            max: 1,
            step: 0.1,
            default: 1,
            component: 'InputNumber'
          },
          maxTokens: {
            type: 'number',
            label: '最大Token数',
            min: 1,
            default: 4096,
            component: 'InputNumber'
          },
          max_tokens: {
            type: 'number',
            label: '最大Token数（兼容字段）',
            min: 1,
            default: 4096,
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
