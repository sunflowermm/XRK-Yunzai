import ConfigBase from '../../../lib/commonconfig/commonconfig.js';
import { getServerConfigPath } from '../../../lib/config/config-constants.js';

/**
 * OpenAI Chat Completions 协议兼容 LLM 工厂配置（与 XRK-AGT 一致：多运营商 providers 数组）
 * 配置文件：data/server_bots/{port}/openai_compat_llm.yaml
 */
export default class OpenAICompatibleLLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'openai_compat_llm',
      displayName: 'OpenAI Chat 协议兼容 LLM 工厂',
      description: 'OpenAI Chat Completions 兼容运营商集合配置，支持多运营商与 MCP 工具调用',
      filePath: (c) => getServerConfigPath(c?._port ?? 8086, 'openai_compat_llm'),
      fileType: 'yaml',
      schema: {
        fields: {
          providers: {
            type: 'array',
            label: 'Chat 协议运营商列表',
            component: 'ArrayForm',
            itemType: 'object',
            default: [],
            itemSchema: {
              fields: {
                key: { type: 'string', label: '运营商标识', description: '用于 aistream.llm.Provider 或前端下拉引用的唯一 key', default: '', component: 'Input' },
                label: { type: 'string', label: '展示名称', default: '', component: 'Input' },
                protocol: { type: 'string', label: '协议类型', enum: ['openai'], default: 'openai', component: 'Select' },
                baseUrl: { type: 'string', label: 'API 基础地址', default: '', component: 'Input' },
                path: { type: 'string', label: '接口路径', default: '/chat/completions', component: 'Input' },
                apiKey: { type: 'string', label: 'API Key', default: '', component: 'InputPassword' },
                authMode: { type: 'string', label: '认证方式', enum: ['bearer', 'api-key', 'header'], default: 'bearer', component: 'Select' },
                authHeaderName: { type: 'string', label: '自定义认证头名', default: '', component: 'Input' },
                model: { type: 'string', label: '下游模型名', default: '', component: 'Input' },
                temperature: { type: 'number', label: 'temperature', min: 0, max: 2, default: 0.7, component: 'InputNumber' },
                maxTokens: { type: 'number', label: '最大输出 tokens', min: 1, default: 4096, component: 'InputNumber' },
                topP: { type: 'number', label: 'top_p', min: 0, max: 1, default: 1.0, component: 'InputNumber' },
                timeout: { type: 'number', label: '超时(ms)', min: 1000, default: 360000, component: 'InputNumber' },
                enableTools: { type: 'boolean', label: '启用 MCP 工具', default: true, component: 'Switch' },
                toolChoice: { type: 'string', label: 'tool_choice', default: 'auto', component: 'Input' },
                parallelToolCalls: { type: 'boolean', label: '并行工具调用', default: true, component: 'Switch' },
                maxToolRounds: { type: 'number', label: '最大工具轮次', min: 1, max: 20, default: 7, component: 'InputNumber' },
                enableStream: { type: 'boolean', label: '启用流式', default: true, component: 'Switch' },
                headers: { type: 'object', label: '额外请求头', component: 'SubForm', fields: {} },
                extraBody: { type: 'object', label: '额外请求体', component: 'SubForm', fields: {} },
                proxy: {
                  type: 'object',
                  label: '代理配置',
                  component: 'SubForm',
                  fields: {
                    enabled: { type: 'boolean', label: '启用代理', default: false, component: 'Switch' },
                    url: { type: 'string', label: '代理地址', default: '', component: 'Input' }
                  }
                }
              }
            }
          }
        }
      }
    });
  }
}
