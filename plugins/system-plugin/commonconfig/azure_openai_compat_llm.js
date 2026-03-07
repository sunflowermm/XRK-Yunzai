import ConfigBase from '../../../lib/commonconfig/commonconfig.js';
import { getServerConfigPath } from '../../../lib/config/config-constants.js';

/**
 * Azure OpenAI 协议兼容 LLM 工厂配置（与 XRK-AGT 对齐）
 * 配置文件：data/server_bots/{port}/azure_openai_compat_llm.yaml
 * Azure OpenAI Chat Completions 兼容运营商集合，每项 key 作为 provider；endpoint、apiKey、deployment、apiVersion 等。
 */
export default class AzureOpenAICompatibleLLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'azure_openai_compat_llm',
      displayName: 'Azure OpenAI 协议兼容 LLM 工厂',
      description: 'Azure OpenAI Chat Completions 兼容运营商集合：每项 key 为独立 provider，endpoint/deployment/apiVersion 等',
      filePath: (c) => getServerConfigPath(c?._port ?? 8086, 'azure_openai_compat_llm'),
      fileType: 'yaml',
      schema: {
        fields: {
          providers: {
            type: 'array',
            label: 'Azure OpenAI 兼容运营商列表',
            description: '每个元素为一家 Azure OpenAI 部署，key 需唯一且供 aistream 与前端引用',
            component: 'ArrayForm',
            itemType: 'object',
            default: [],
            itemSchema: {
              fields: {
                key: { type: 'string', label: '运营商标识', description: '唯一 key，供 aistream.llm.Provider 或前端下拉引用', default: '', component: 'Input' },
                label: { type: 'string', label: '展示名称', description: '给用户看的名称', default: '', component: 'Input' },
                baseUrl: { type: 'string', label: 'API 基础地址', description: 'Azure Endpoint，如 https://{resource}.openai.azure.com', default: '', component: 'Input' },
                deployment: { type: 'string', label: '部署名(deployment)', description: 'Azure 中的部署名称，对应模型', default: '', component: 'Input' },
                apiVersion: { type: 'string', label: 'api-version', description: 'Azure API 版本，如 2024-02-15-preview', default: '', component: 'Input' },
                apiKey: { type: 'string', label: 'API Key', description: 'Azure 资源 API Key', default: '', component: 'InputPassword' },
                model: { type: 'string', label: '模型', description: '可选，与 deployment 对应', default: '', component: 'Input' },
                maxTokens: { type: 'number', label: 'max_tokens', description: '单次回答最大 token 数', min: 1, default: 4096, component: 'InputNumber' },
                temperature: { type: 'number', label: 'temperature', description: '采样温度，0 越保守、2 越随机', min: 0, max: 2, default: 0.7, component: 'InputNumber' },
                timeout: { type: 'number', label: '超时(ms)', description: '单次请求超时时间', min: 1000, default: 360000, component: 'InputNumber' },
                proxy: { type: 'object', label: '代理', description: '请求走 HTTP(S) 代理时填写', component: 'SubForm', fields: { enabled: { type: 'boolean', label: '启用代理', description: '是否使用代理访问该运营商', default: false, component: 'Switch' }, url: { type: 'string', label: '代理地址', description: '如 http://127.0.0.1:7890', default: '', component: 'Input' } } }
              }
            }
          }
        }
      }
    });
  }
}
