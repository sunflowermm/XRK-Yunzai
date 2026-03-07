import ConfigBase from '../../../lib/commonconfig/commonconfig.js';
import { getServerConfigPath } from '../../../lib/config/config-constants.js';

/**
 * Gemini 官方 LLM 工厂配置（与 XRK-AGT 对齐）
 *
 * 配置文件：data/server_bots/{port}/gemini_llm.yaml
 * Google Generative Language API：baseUrl、apiKey、model、temperature/maxTokens 等；Gemini 的 function calling 与 OpenAI 不同，当前默认不注入 MCP tools（enableTools=false）。
 */
export default class GeminiLLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'gemini_llm',
      displayName: 'Gemini LLM 工厂配置（官方）',
      description: 'Google Generative Language API：API 地址与密钥、模型、生成长度与采样参数；关闭后不会被选为默认 provider',
      filePath: (c) => getServerConfigPath(c?._port ?? 8086, 'gemini_llm'),
      fileType: 'yaml',
      schema: {
        fields: {
          baseUrl: {
            type: 'string',
            label: 'API 基础地址',
            description: 'Generative Language API 基础地址',
            default: 'https://generativelanguage.googleapis.com',
            component: 'Input'
          },
          apiKey: {
            type: 'string',
            label: 'API Key',
            description: 'Google API Key（Generative Language）',
            default: '',
            component: 'InputPassword'
          },
          path: {
            type: 'string',
            label: '接口路径（可选）',
            description: '留空则使用 /v1beta/models/{model}:generateContent',
            default: '',
            component: 'Input'
          },
          model: {
            type: 'string',
            label: '模型（model）',
            description: 'Gemini 模型名称，例如 gemini-1.5-flash',
            default: 'gemini-1.5-flash',
            component: 'Input'
          },
          temperature: {
            type: 'number',
            label: '温度（generationConfig.temperature）',
            description: '采样温度，0 越保守、2 越随机',
            min: 0,
            max: 2,
            default: 0.7,
            component: 'InputNumber'
          },
          topP: {
            type: 'number',
            label: 'Top P（generationConfig.topP）',
            description: '核采样参数，0–1',
            min: 0,
            max: 1,
            default: 1.0,
            component: 'InputNumber'
          },
          topK: {
            type: 'number',
            label: 'Top K（generationConfig.topK）',
            description: '可选，高级采样参数',
            min: 0,
            default: 0,
            component: 'InputNumber'
          },
          maxTokens: {
            type: 'number',
            label: '最大输出（generationConfig.maxOutputTokens）',
            description: '单次回答最大 token 数',
            min: 1,
            default: 2048,
            component: 'InputNumber'
          },
          timeout: {
            type: 'number',
            label: '超时时间 (ms)',
            description: '单次 API 请求超时时间',
            min: 1000,
            default: 360000,
            component: 'InputNumber'
          },
          enableTools: {
            type: 'boolean',
            label: '启用工具调用（MCP）',
            description: 'Gemini 协议不同，默认关闭；如需启用需实现 Gemini function calling 适配',
            default: false,
            component: 'Switch'
          },
          enableStream: {
            type: 'boolean',
            label: '启用流式输出',
            description: '是否使用流式返回',
            default: true,
            component: 'Switch'
          },
          headers: {
            type: 'object',
            label: '额外请求头',
            description: '会合并到请求 headers（高级用法）',
            component: 'SubForm',
            fields: {}
          },
          extraBody: {
            type: 'object',
            label: '额外请求体字段',
            description: '原样合并到 payload 顶层（高级用法）',
            component: 'SubForm',
            fields: {}
          },
          proxy: {
            type: 'object',
            label: '代理配置',
            description: '仅影响本机到 Gemini 的 HTTP 请求，不修改系统全局代理；支持 http/https/socks5 标准代理地址',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用代理',
                description: '是否使用代理访问 Gemini',
                default: false,
                component: 'Switch'
              },
              url: {
                type: 'string',
                label: '代理地址',
                description: '例如：http://127.0.0.1:7890 或 http://user:pass@host:port',
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

