import ConfigBase from '../../../lib/commonconfig/commonconfig.js';

/**
 * OpenAI 兼容第三方 LLM 配置
 */
export default class OpenAICompatibleLLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'openai_compat_llm',
      displayName: 'OpenAI兼容 LLM配置',
      description: 'OpenAI兼容第三方服务配置，可自定义baseUrl、path、headers等',
      filePath: (cfg) => {
        const port = cfg?._port || cfg?.server?.server?.port || 8086;
        return port ? `data/server_bots/${port}/openai_compat_llm.yaml` : `config/default_config/openai_compat_llm.yaml`;
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
            default: 'https://api.example.com/v1',
            component: 'Input'
          },
          path: {
            type: 'string',
            label: 'API路径',
            default: '/chat/completions',
            component: 'Input'
          },
          apiKey: {
            type: 'string',
            label: 'API密钥',
            description: '第三方服务API密钥',
            default: '',
            component: 'InputPassword'
          },
          authMode: {
            type: 'string',
            label: '认证模式',
            enum: ['bearer', 'header', 'query'],
            default: 'bearer',
            component: 'Select'
          },
          authHeader: {
            type: 'string',
            label: '认证头名称',
            default: 'Authorization',
            component: 'Input'
          },
          headers: {
            type: 'object',
            label: '自定义请求头',
            component: 'SubForm',
            fields: {}
          },
          model: {
            type: 'string',
            label: '模型名称',
            default: 'gpt-3.5-turbo',
            component: 'Input'
          },
          chatModel: {
            type: 'string',
            label: '聊天模型',
            default: 'gpt-3.5-turbo',
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
