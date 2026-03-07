import ConfigBase from '../../../lib/commonconfig/commonconfig.js';
import { getServerConfigPath } from '../../../lib/config/config-constants.js';

/**
 * OpenAI Responses 协议兼容 LLM 工厂配置（与 XRK-AGT 对齐）
 * 配置文件：data/server_bots/{port}/openai_responses_compat_llm.yaml
 * OpenAI Responses API 风格运营商集合，每项 key 作为 provider；与 Chat Completions 类似但接口形态为 Responses。
 */
export default class OpenAIResponsesCompatibleLLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'openai_responses_compat_llm',
      displayName: 'OpenAI Responses 协议兼容 LLM 工厂',
      description: 'OpenAI Responses 协议运营商集合：每项 key 为独立 provider，baseUrl/apiKey/model 等',
      filePath: (c) => getServerConfigPath(c?._port ?? 8086, 'openai_responses_compat_llm'),
      fileType: 'yaml',
      schema: {
        fields: {
          providers: {
            type: 'array',
            label: 'Responses 协议运营商列表',
            description: '每个元素为一家 OpenAI Responses 协议运营商，key 需唯一且供 aistream 与前端引用',
            component: 'ArrayForm',
            itemType: 'object',
            default: [],
            itemSchema: {
              fields: {
                key: { type: 'string', label: '运营商标识', description: '唯一 key，供 aistream.llm.Provider 或前端下拉引用', default: '', component: 'Input' },
                label: { type: 'string', label: '展示名称', description: '给用户看的名称', default: '', component: 'Input' },
                baseUrl: { type: 'string', label: 'API 基础地址', description: '完整基础 URL，通常以 /v1 结尾', default: '', component: 'Input' },
                path: { type: 'string', label: '接口路径', description: 'Responses 接口路径，默认 /v1/responses', default: '/v1/responses', component: 'Input' },
                apiKey: { type: 'string', label: 'API Key', description: '下游颁发的密钥', default: '', component: 'InputPassword' },
                model: { type: 'string', label: '模型', description: '下游模型标识', default: '', component: 'Input' },
                temperature: { type: 'number', label: 'temperature', description: '采样温度，0 越保守、2 越随机', min: 0, max: 2, default: 0.7, component: 'InputNumber' },
                maxOutputTokens: { type: 'number', label: 'max_output_tokens', description: '单次回答最大输出 token 数', min: 1, default: 4096, component: 'InputNumber' },
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
