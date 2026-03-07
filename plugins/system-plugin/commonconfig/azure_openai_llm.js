import ConfigBase from '../../../lib/commonconfig/commonconfig.js';
import { getServerConfigPath } from '../../../lib/config/config-constants.js';

/**
 * Azure OpenAI 官方 LLM 工厂配置（与 XRK-AGT 对齐）
 *
 * 配置文件：data/server_bots/{port}/azure_openai_llm.yaml
 * Azure OpenAI Chat Completions：Endpoint、API Key、deployment 名、api-version；与 OpenAI 官方接口兼容。
 */
export default class AzureOpenAILLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'azure_openai_llm',
      displayName: 'Azure OpenAI LLM 工厂配置（官方）',
      description: 'Azure OpenAI Chat Completions：Endpoint、API Key、deployment、api-version；关闭后不会被选为默认 provider',
      filePath: (c) => getServerConfigPath(c?._port ?? 8086, 'azure_openai_llm'),
      fileType: 'yaml',
      schema: {
        fields: {
          enabled: { type: 'boolean', label: '启用', description: '关闭后不会被选为默认 provider', default: true, component: 'Switch' },
          baseUrl: { type: 'string', label: 'Azure Endpoint', description: 'https://{resource}.openai.azure.com', default: 'https://{resource}.openai.azure.com', component: 'Input' },
          apiKey: { type: 'string', label: 'API Key', description: 'Azure 资源 API Key', default: '', component: 'InputPassword' },
          deployment: { type: 'string', label: '部署名', description: 'Azure 中的部署名称，对应模型', default: '', component: 'Input' },
          apiVersion: { type: 'string', label: 'api-version', description: 'Azure API 版本，如 2024-02-15-preview', default: '2024-02-15-preview', component: 'Input' },
          model: { type: 'string', label: '模型', description: '与 deployment 对应，如 gpt-4', default: 'gpt-4', component: 'Input' },
          temperature: { type: 'number', label: '温度', description: '采样温度，0 越保守、2 越随机', min: 0, max: 2, default: 0.7, component: 'InputNumber' },
          maxTokens: { type: 'number', label: '最大 Tokens', description: '单次回答最大 token 数', min: 1, default: 4000, component: 'InputNumber' },
          timeout: { type: 'number', label: '超时(ms)', description: '单次 API 请求超时时间', min: 1000, default: 60000, component: 'InputNumber' },
          enableStream: { type: 'boolean', label: '流式输出', description: '是否使用流式返回', default: true, component: 'Switch' },
          enableTools: { type: 'boolean', label: '工具调用', description: '是否启用 MCP/函数调用', default: true, component: 'Switch' },
          proxy: {
            type: 'object',
            label: '代理',
            description: '仅影响本机到 Azure OpenAI 的 HTTP 出口',
            component: 'SubForm',
            fields: {
              enabled: { type: 'boolean', label: '启用代理', description: '是否使用代理访问 Azure OpenAI', default: false, component: 'Switch' },
              http: { type: 'string', label: 'HTTP 代理', description: '如 http://127.0.0.1:7890', default: '', component: 'Input' },
              https: { type: 'string', label: 'HTTPS 代理', description: '如 http://127.0.0.1:7890', default: '', component: 'Input' }
            }
          }
        }
      }
    });
  }
}

