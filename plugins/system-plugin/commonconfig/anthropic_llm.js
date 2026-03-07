import ConfigBase from '../../../lib/commonconfig/commonconfig.js';
import { getServerConfigPath } from '../../../lib/config/config-constants.js';

/**
 * Anthropic 官方 LLM 工厂配置（与 XRK-AGT 对齐）
 *
 * 配置文件：data/server_bots/{port}/anthropic_llm.yaml
 * Claude Messages API：baseUrl、apiKey、model、maxTokens/temperature 等；本实现默认不注入 MCP tools。
 */
export default class AnthropicLLMConfig extends ConfigBase {
  constructor() {
    super({
      name: 'anthropic_llm',
      displayName: 'Anthropic LLM 工厂配置（官方）',
      description: 'Claude / Messages API：API 地址与密钥、模型、生成长度与采样参数；关闭后不会被选为默认 provider',
      filePath: (c) => getServerConfigPath(c?._port ?? 8086, 'anthropic_llm'),
      fileType: 'yaml',
      schema: {
        fields: {
          baseUrl: {
            type: 'string',
            label: 'API 基础地址',
            description: 'Anthropic API 基础地址',
            default: 'https://api.anthropic.com/v1',
            component: 'Input'
          },
          apiKey: {
            type: 'string',
            label: 'API Key',
            description: 'Anthropic API Key',
            default: '',
            component: 'InputPassword'
          },
          path: {
            type: 'string',
            label: '接口路径',
            description: 'Messages API 路径，默认 /messages',
            default: '/messages',
            component: 'Input'
          },
          model: {
            type: 'string',
            label: '模型（model）',
            description: '如 claude-3-5-sonnet-latest、claude-3-opus',
            default: 'claude-3-5-sonnet-latest',
            component: 'Input'
          },
          anthropicVersion: {
            type: 'string',
            label: 'anthropic-version',
            description: 'API 版本头，如 2023-06-01',
            default: '2023-06-01',
            component: 'Input'
          },
          temperature: {
            type: 'number',
            label: '温度',
            description: '采样温度，0 越保守、2 越随机',
            min: 0,
            max: 2,
            default: 0.7,
            component: 'InputNumber'
          },
          maxTokens: {
            type: 'number',
            label: '最大 Tokens',
            description: '单次回答最大 token 数',
            min: 1,
            default: 2048,
            component: 'InputNumber'
          },
          enableTools: {
            type: 'boolean',
            label: '启用工具调用（MCP）',
            description: 'Anthropic 协议不同，本实现默认不注入 MCP tools',
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
            description: '会合并到请求 body 顶层（高级用法）',
            component: 'SubForm',
            fields: {}
          },
          proxy: {
            type: 'object',
            label: '代理配置',
            description: '仅影响本机到 Anthropic 的 HTTP 请求，不修改系统全局代理；支持 http/https/socks5 标准代理地址',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用代理',
                description: '是否使用代理访问 Anthropic',
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

