import ConfigBase from '../../../lib/commonconfig/commonconfig.js';
import { getServerConfigPath } from '../../../lib/config/config-constants.js';

/**
 * GPTGod LLM 工厂配置（与 XRK-AGT 对齐）
 *
 * 配置文件：data/server_bots/{port}/gptgod_llm.yaml
 * GPTGod 大语言模型：OpenAI 兼容，支持多模态、tools/tool_choice/parallel_tool_calls。
 */
export default class GPTGodLLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'gptgod_llm',
      displayName: 'GPTGod LLM 配置',
      description: 'GPTGod 大语言模型：baseUrl、apiKey、model、tools 及 OpenAI 标准参数；支持识图与工具调用',
      filePath: (c) => getServerConfigPath(c?._port ?? 8086, 'gptgod_llm'),
      fileType: 'yaml',
      schema: {
        fields: {
          enabled: {
            type: 'boolean',
            label: '启用',
            description: '关闭后不会被选为默认 provider',
            default: true,
            component: 'Switch'
          },
          baseUrl: {
            type: 'string',
            label: 'API 地址',
            description: 'GPTGod API 基础地址',
            default: 'https://api.gptgod.online/v1',
            component: 'Input'
          },
          path: {
            type: 'string',
            label: '接口路径',
            description: 'Chat Completions 路径，默认 /chat/completions',
            default: '/chat/completions',
            component: 'Input'
          },
          apiKey: {
            type: 'string',
            label: 'API 密钥',
            description: 'GPTGod API 密钥',
            default: '',
            component: 'InputPassword'
          },
          model: {
            type: 'string',
            label: '模型名称',
            description: 'GPTGod 提供的模型标识',
            default: 'gemini-exp-1114',
            component: 'Input'
          },
          temperature: {
            type: 'number',
            label: '温度',
            description: '控制输出的随机性，0-2',
            min: 0,
            max: 2,
            step: 0.1,
            default: 0.8,
            component: 'InputNumber'
          },
          maxTokens: {
            type: 'number',
            label: '最大 Token 数',
            description: '单次回答最大 token 数',
            min: 1,
            default: 6000,
            component: 'InputNumber'
          },
          topP: {
            type: 'number',
            label: 'Top P',
            description: '核采样参数，0-1',
            min: 0,
            max: 1,
            step: 0.1,
            default: 0.9,
            component: 'InputNumber'
          },
          presencePenalty: {
            type: 'number',
            label: '存在惩罚',
            description: '-2 到 2，减少重复已出现内容',
            min: -2,
            max: 2,
            step: 0.1,
            default: 0.6,
            component: 'InputNumber'
          },
          frequencyPenalty: {
            type: 'number',
            label: '频率惩罚',
            description: '-2 到 2，减少重复高频词',
            min: -2,
            max: 2,
            step: 0.1,
            default: 0.6,
            component: 'InputNumber'
          },
          stop: {
            type: 'string',
            label: '停止序列',
            description: '遇到时停止生成，多个用逗号分隔或 JSON 数组',
            default: '',
            component: 'Input'
          },
          seed: {
            type: 'number',
            label: '随机种子',
            description: '可复现输出（部分模型支持）',
            default: null,
            component: 'InputNumber'
          },
          timeout: {
            type: 'number',
            label: '请求超时',
            description: '毫秒',
            min: 1000,
            default: 360000,
            component: 'InputNumber'
          },
          enableStream: {
            type: 'boolean',
            label: '启用流式输出',
            description: 'SSE 流式返回',
            default: true,
            component: 'Switch'
          },
          enableTools: {
            type: 'boolean',
            label: '启用工具调用',
            description: 'MCP 或 config.tools 标准 OpenAI 格式',
            default: true,
            component: 'Switch'
          },
          toolChoice: {
            type: 'string',
            label: 'tool_choice',
            description: 'auto/none 或具体工具名',
            default: 'auto',
            component: 'Input'
          },
          parallelToolCalls: {
            type: 'boolean',
            label: '并行工具调用',
            description: 'parallel_tool_calls',
            default: true,
            component: 'Switch'
          },
          maxToolRounds: {
            type: 'number',
            label: '最大工具轮次',
            description: '工具调用与回复交替的最大轮数',
            min: 1,
            max: 20,
            default: 5,
            component: 'InputNumber'
          },
          headers: {
            type: 'object',
            label: '额外请求头',
            description: '合并到请求 headers',
            component: 'SubForm',
            fields: {}
          },
          extraBody: {
            type: 'object',
            label: '额外请求体',
            description: '合并到请求 body 顶层',
            component: 'SubForm',
            fields: {}
          },
          proxy: {
            type: 'object',
            label: '代理配置',
            description: '仅影响本机请求 GPTGod 的 HTTP 出口',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用代理',
                default: false,
                component: 'Switch'
              },
              url: {
                type: 'string',
                label: '代理地址',
                description: '如 http://127.0.0.1:7890',
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
