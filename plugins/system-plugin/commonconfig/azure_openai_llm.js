import ConfigBase from '../../../lib/commonconfig/commonconfig.js';

/**
 * Azure OpenAI 官方 LLM 工厂配置管理（文本）
 * 配置文件：data/server_bots/{port}/azure_openai_llm.yaml
 */
export default class AzureOpenAILLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'azure_openai_llm',
      displayName: 'Azure OpenAI LLM 工厂配置（官方）',
      description: 'Azure OpenAI Chat Completions 配置（deployment + api-version）',
      filePath: (cfg) => {
        const port = cfg?._port ?? 8086;
        return port ? `data/server_bots/${port}/azure_openai_llm.yaml` : `config/default_config/azure_openai_llm.yaml`;
      },
      fileType: 'yaml',
      schema: {
        fields: {
          enabled: { type: 'boolean', label: '启用', default: true, component: 'Switch' },
          baseUrl: { type: 'string', label: 'Azure Endpoint', description: 'https://{resource}.openai.azure.com', default: 'https://{resource}.openai.azure.com', component: 'Input' },
          apiKey: { type: 'string', label: 'API Key', default: '', component: 'InputPassword' },
          deployment: { type: 'string', label: '部署名', default: '', component: 'Input' },
          apiVersion: { type: 'string', label: 'api-version', default: '2024-02-15-preview', component: 'Input' },
          model: { type: 'string', label: '模型', default: 'gpt-4', component: 'Input' },
          temperature: { type: 'number', label: '温度', min: 0, max: 2, default: 0.7, component: 'InputNumber' },
          maxTokens: { type: 'number', label: '最大 Tokens', min: 1, default: 4000, component: 'InputNumber' },
          timeout: { type: 'number', label: '超时(ms)', min: 1000, default: 60000, component: 'InputNumber' },
          enableStream: { type: 'boolean', label: '流式输出', default: true, component: 'Switch' },
          enableTools: { type: 'boolean', label: '工具调用', default: true, component: 'Switch' },
          proxy: {
            type: 'object',
            label: '代理',
            component: 'SubForm',
            fields: {
              enabled: { type: 'boolean', label: '启用', default: false, component: 'Switch' },
              http: { type: 'string', label: 'HTTP 代理', default: '', component: 'Input' },
              https: { type: 'string', label: 'HTTPS 代理', default: '', component: 'Input' }
            }
          }
        }
      }
    });
  }
}

