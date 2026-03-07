import ConfigBase from '../../../lib/commonconfig/commonconfig.js';
import { getServerConfigPath } from '../../../lib/config/config-constants.js';

/**
 * OpenAI Chat Completions 协议兼容 LLM 工厂配置（与 XRK-AGT 一致：多运营商 providers 数组）
 *
 * 配置文件：data/server_bots/{port}/openai_compat_llm.yaml
 * 每个 provider 的 key 可在 aistream.llm.Provider 或前端下拉中选用；支持 MCP 工具调用与流式输出。
 */
export default class OpenAICompatibleLLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'openai_compat_llm',
      displayName: 'OpenAI Chat 协议兼容 LLM 工厂',
      description: 'OpenAI Chat Completions 兼容运营商集合：自建网关、第三方 API 等，每项 key 作为独立 provider 供工作流与前端选择',
      filePath: (c) => getServerConfigPath(c?._port ?? 8086, 'openai_compat_llm'),
      fileType: 'yaml',
      schema: {
        fields: {
          providers: {
            type: 'array',
            label: 'Chat 协议运营商列表',
            description: '每个元素为一家兼容 OpenAI 协议的运营商，key 需唯一且用于 aistream.llm.Provider 或前端下拉',
            component: 'ArrayForm',
            itemType: 'object',
            default: [],
            itemSchema: {
              fields: {
                key: { type: 'string', label: '运营商标识', description: '唯一 key，如 volcengine、openai-cn、my-gateway，供 aistream 与前端引用', default: '', component: 'Input' },
                label: { type: 'string', label: '展示名称', description: '给用户看的名称，如「火山·豆包」「自建 OpenAI 网关」', default: '', component: 'Input' },
                protocol: { type: 'string', label: '协议类型', description: '固定为 openai（Chat Completions）', enum: ['openai'], default: 'openai', component: 'Select' },
                baseUrl: { type: 'string', label: 'API 基础地址', description: '完整基础 URL，通常以 /v1 结尾', default: '', component: 'Input' },
                path: { type: 'string', label: '接口路径', description: '相对 baseUrl，默认 /chat/completions', default: '/chat/completions', component: 'Input' },
                apiKey: { type: 'string', label: 'API Key', description: 'bearer/api-key 认证时使用；header 模式可用 authHeaderName 指定头名', default: '', component: 'InputPassword' },
                authMode: { type: 'string', label: '认证方式', description: 'bearer=Authorization: Bearer；api-key=api-key 头；header=自定义头名', enum: ['bearer', 'api-key', 'header'], default: 'bearer', component: 'Select' },
                authHeaderName: { type: 'string', label: '自定义认证头名', description: 'authMode=header 时携带 API Key 的请求头名，如 X-Api-Key', default: '', component: 'Input' },
                model: { type: 'string', label: '下游模型名', description: '下游实际模型标识，如 gpt-4o、qwen3-vl-plus', default: '', component: 'Input' },
                temperature: { type: 'number', label: 'temperature', description: '采样温度，0 越保守、2 越随机，推荐 0.5–1.0', min: 0, max: 2, default: 0.7, component: 'InputNumber' },
                maxTokens: { type: 'number', label: '最大输出 tokens', description: '单次回答最大 token 数，过大可能被厂商拒绝', min: 1, default: 4096, component: 'InputNumber' },
                topP: { type: 'number', label: 'top_p', description: '核采样，与 temperature 二选一调整', min: 0, max: 1, default: 1.0, component: 'InputNumber' },
                timeout: { type: 'number', label: '超时(ms)', description: '单次请求超时，超时触发重试或报错', min: 1000, default: 360000, component: 'InputNumber' },
                enableTools: { type: 'boolean', label: '启用 MCP 工具', description: '是否允许该 provider 进行函数/工具调用', default: true, component: 'Switch' },
                toolChoice: { type: 'string', label: 'tool_choice', description: 'OpenAI 的 tool_choice：auto/none 或具体 tool 名', default: 'auto', component: 'Input' },
                parallelToolCalls: { type: 'boolean', label: '并行工具调用', description: '是否允许模型一次返回多个工具调用', default: true, component: 'Switch' },
                maxToolRounds: { type: 'number', label: '最大工具轮次', description: '工具调用与模型回复交替的最大轮数', min: 1, max: 20, default: 7, component: 'InputNumber' },
                enableStream: { type: 'boolean', label: '启用流式', description: '是否使用 SSE 流式返回', default: true, component: 'Switch' },
                headers: { type: 'object', label: '额外请求头', description: '每次请求附加的 HTTP 头（键值对）', component: 'SubForm', fields: {} },
                extraBody: { type: 'object', label: '额外请求体', description: '合并进请求体的额外字段', component: 'SubForm', fields: {} },
                proxy: {
                  type: 'object',
                  label: '代理配置',
                  description: '请求走 HTTP(S) 代理时填写',
                  component: 'SubForm',
                  fields: {
                    enabled: { type: 'boolean', label: '启用代理', default: false, component: 'Switch' },
                    url: { type: 'string', label: '代理地址', description: '如 http://127.0.0.1:7890', default: '', component: 'Input' }
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
