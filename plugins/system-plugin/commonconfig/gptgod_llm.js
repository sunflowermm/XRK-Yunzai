import ConfigBase from '../../../lib/commonconfig/commonconfig.js';
import { getServerConfigPath } from '../../../lib/config/config-constants.js';

/**
 * GPTGod LLM 工厂配置（与 XRK-AGT 对齐）
 *
 * 配置文件：data/server_bots/{port}/gptgod_llm.yaml
 * GPTGod 大语言模型：API 地址、密钥、模型、temperature/maxTokens 等；支持识图（多模态）。
 */
export default class GPTGodLLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'gptgod_llm',
      displayName: 'GPTGod LLM 配置',
      description: 'GPTGod 大语言模型：baseUrl、apiKey、model 及生成长度与采样参数；支持识图；关闭后不会被选为默认 provider',
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
            label: 'API地址',
            description: 'GPTGod API 基础地址',
            default: 'https://api.gptgod.online/v1',
            component: 'Input'
          },
          apiKey: {
            type: 'string',
            label: 'API密钥',
            description: 'GPTGod API密钥',
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
            label: '温度参数',
            description: '控制输出的随机性，范围0-2',
            min: 0,
            max: 2,
            step: 0.1,
            default: 0.8,
            component: 'InputNumber'
          },
          maxTokens: {
            type: 'number',
            label: '最大Token数',
            description: '单次回答最大 token 数',
            min: 1,
            default: 6000,
            component: 'InputNumber'
          },
          topP: {
            type: 'number',
            label: 'Top P',
            description: '核采样参数',
            min: 0,
            max: 1,
            step: 0.1,
            default: 0.9,
            component: 'InputNumber'
          },
          presencePenalty: {
            type: 'number',
            label: '存在惩罚',
            description: '存在惩罚（-2 到 2），减少重复已出现内容',
            min: -2,
            max: 2,
            step: 0.1,
            default: 0.6,
            component: 'InputNumber'
          },
          frequencyPenalty: {
            type: 'number',
            label: '频率惩罚',
            description: '频率惩罚（-2 到 2），减少重复高频词',
            min: -2,
            max: 2,
            step: 0.1,
            default: 0.6,
            component: 'InputNumber'
          },
          timeout: {
            type: 'number',
            label: '请求超时',
            description: '请求超时时间（毫秒）',
            min: 1000,
            default: 360000,
            component: 'InputNumber'
          },
          enableStream: {
            type: 'boolean',
            label: '启用流式输出',
            description: '是否使用 SSE 流式返回',
            default: true,
            component: 'Switch'
          },
          enableTools: {
            type: 'boolean',
            label: '启用工具调用',
            description: '是否启用 MCP/函数调用',
            default: true,
            component: 'Switch'
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
                description: '是否使用代理访问 GPTGod',
                default: false,
                component: 'Switch'
              },
              http: {
                type: 'string',
                label: 'HTTP代理',
                description: '如 http://127.0.0.1:7890',
                default: '',
                component: 'Input'
              },
              https: {
                type: 'string',
                label: 'HTTPS代理',
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
