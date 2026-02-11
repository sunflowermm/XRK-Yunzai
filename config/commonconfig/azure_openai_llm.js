import ConfigBase from '../../lib/commonconfig/commonconfig.js';

/**
 * Azure OpenAI LLM 配置
 */
export default class AzureOpenAILLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'azure_openai_llm',
      displayName: 'Azure OpenAI LLM配置',
      description: 'Azure OpenAI配置，支持deployment和api-version',
      filePath: (cfg) => {
        const port = cfg?._port || cfg?.server?.server?.port || 8086;
        return port ? `data/server_bots/${port}/azure_openai_llm.yaml` : `config/default_config/azure_openai_llm.yaml`;
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
            default: 'https://{resource}.openai.azure.com',
            component: 'Input'
          },
          apiKey: {
            type: 'string',
            label: 'API密钥',
            description: 'Azure OpenAI API密钥',
            default: '',
            component: 'InputPassword'
          },
          deployment: {
            type: 'string',
            label: '部署名称',
            description: 'Azure OpenAI部署名称',
            default: '',
            component: 'Input'
          },
          apiVersion: {
            type: 'string',
            label: 'API版本',
            default: '2024-02-15-preview',
            component: 'Input'
          },
          model: {
            type: 'string',
            label: '模型名称',
            default: 'gpt-4',
            component: 'Input'
          },
          chatModel: {
            type: 'string',
            label: '聊天模型',
            default: 'gpt-4',
            component: 'Input'
          },
          temperature: {
            type: 'number',
            label: '温度参数',
            min: 0,
            max: 2,
            step: 0.1,
            default: 0.7,
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
