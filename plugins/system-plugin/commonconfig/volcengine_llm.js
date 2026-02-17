import ConfigBase from '../../../lib/commonconfig/commonconfig.js';

/**
 * 火山引擎 LLM 工厂配置管理（文本）
 * 管理火山引擎大语言模型（LLM 文本聊天）相关配置
 * 识图配置已经拆分到 volcengine_vision.yaml / volcengine_vision.js
 * 支持前端编辑，配置文件位于 data/server_bots/{port}/volcengine_llm.yaml
 */
export default class VolcengineLLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'volcengine_llm',
      displayName: '火山引擎 LLM 工厂配置（文本）',
      description: '火山引擎豆包大语言模型文本聊天配置',
      filePath: (cfg) => {
        const port = cfg?._port ?? 8086;
        return port ? `data/server_bots/${port}/volcengine_llm.yaml` : `config/default_config/volcengine_llm.yaml`;
      },
      fileType: 'yaml',
      schema: {
        fields: {
          enabled: {
            type: 'boolean',
            label: '启用该提供商',
            description: '关闭后不会被选择为默认提供商',
            default: true,
            component: 'Switch'
          },
          baseUrl: {
            type: 'string',
            label: 'API 基础地址',
            description: '火山引擎豆包 API 基础地址',
            default: 'https://ark.cn-beijing.volces.com/api/v3',
            component: 'Input'
          },
          apiKey: {
            type: 'string',
            label: 'API Key',
            description: '火山引擎 API Key',
            default: '',
            component: 'InputPassword'
          },
          model: {
            type: 'string',
            label: '模型（model）',
            description: '可填模型名称（如 doubao-pro-4k 等）或推理接入点 ID（如 ep-xxxxx），两者均是 model 字段的取值形式',
            default: '',
            component: 'Input'
          },
          temperature: {
            type: 'number',
            label: '温度',
            description: '生成文本的随机性，范围 0-2',
            min: 0,
            max: 2,
            default: 0.8,
            component: 'InputNumber'
          },
          maxTokens: {
            type: 'number',
            label: '最大 Tokens',
            description: '生成文本的最大长度',
            min: 1,
            default: 4000,
            component: 'InputNumber'
          },
          topP: {
            type: 'number',
            label: 'Top P',
            description: '核采样参数，范围 0-1',
            min: 0,
            max: 1,
            default: 0.9,
            component: 'InputNumber'
          },
          presencePenalty: {
            type: 'number',
            label: 'Presence Penalty',
            description: '存在惩罚（-2 到 2），控制模型重复已出现的内容',
            min: -2,
            max: 2,
            default: 0,
            component: 'InputNumber'
          },
          frequencyPenalty: {
            type: 'number',
            label: 'Frequency Penalty',
            description: '频率惩罚（-2 到 2），控制模型重复高频词汇',
            min: -2,
            max: 2,
            default: 0,
            component: 'InputNumber'
          },
          timeout: {
            type: 'number',
            label: '超时时间 (ms)',
            description: 'API 请求超时时间',
            min: 1000,
            default: 60000,
            component: 'InputNumber'
          },
          path: {
            type: 'string',
            label: '接口路径',
            description: 'API 接口路径',
            default: '/chat/completions',
            component: 'Input'
          },
          enableTools: {
            type: 'boolean',
            label: '启用工具调用',
            description: '开启后会自动注入 MCP 工具列表（无需手写 tools）',
            default: true,
            component: 'Switch'
          },
          toolChoice: {
            type: 'string',
            label: '工具选择模式',
            description: 'tool_choice（auto/none/required），豆包支持',
            default: 'auto',
            component: 'Input'
          },
          parallelToolCalls: {
            type: 'boolean',
            label: '并行工具调用',
            description: 'parallel_tool_calls（豆包支持）',
            default: true,
            component: 'Switch'
          },
          maxToolRounds: {
            type: 'number',
            label: '最大工具轮次',
            description: '多轮 tool calling 的最大轮次',
            min: 1,
            max: 20,
            default: 5,
            component: 'InputNumber'
          },
          enableStream: {
            type: 'boolean',
            label: '启用流式输出',
            description: '是否启用流式输出（默认启用，所有运营商均支持）',
            default: true,
            component: 'Switch'
          },
          headers: {
            type: 'object',
            label: '额外请求头',
            description: '可选：额外请求头（会与 Authorization 一起发送）',
            default: {},
            component: 'SubForm',
            fields: {}
          },
          extraBody: {
            type: 'object',
            label: '额外请求体字段',
            description: '可选：原样合并到请求 body 顶层（用于火山扩展字段）',
            default: {},
            component: 'SubForm',
            fields: {}
          },
          proxy: {
            type: 'object',
            label: '代理配置',
            description: '仅影响本机请求火山 API 的 HTTP 出口',
            component: 'SubForm',
            default: { enabled: false, url: '' },
            fields: {
              enabled: { type: 'boolean', label: '启用代理', default: false, component: 'Switch' },
              url: { type: 'string', label: '代理地址', description: '如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080', default: '', component: 'Input' }
            }
          }
        }
      }
    });
  }
}

