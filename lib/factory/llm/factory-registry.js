import OpenAICompatibleLLMClient from './OpenAICompatibleLLMClient.js';
import OpenAIResponsesCompatibleLLMClient from './OpenAIResponsesCompatibleLLMClient.js';
import OpenAIPathCompatLLMClient from './OpenAIPathCompatLLMClient.js';
import OllamaCompatibleLLMClient from './OllamaCompatibleLLMClient.js';
import GeminiCompatibleLLMClient from './GeminiCompatibleLLMClient.js';
import AnthropicCompatibleLLMClient from './AnthropicCompatibleLLMClient.js';
import AzureOpenAICompatibleLLMClient from './AzureOpenAICompatibleLLMClient.js';

/** LLM 工厂唯一注册表（LLMFactory + CommonConfig 共用） */
export const LLM_FACTORY_REGISTRY = [
  {
    configKey: 'gptgod_llm',
    factoryType: 'builtin',
    protocol: 'gptgod',
    preset: 'gptgod',
    displayName: 'GPTGod（官方）',
    configDisplayName: 'GPTGod LLM 工厂配置',
    description: 'GPTGod 大语言模型（OpenAI Chat Completions 兼容），通过 providers[] 管理多端点'
  },
  {
    configKey: 'volcengine_llm',
    factoryType: 'builtin',
    protocol: 'volcengine',
    preset: 'volcengine',
    displayName: '火山引擎（官方）',
    configDisplayName: '火山引擎 LLM 工厂配置（文本）',
    description: '火山引擎豆包大语言模型，通过 providers[] 管理多 API / 多模型端点'
  },
  {
    configKey: 'deepseek_llm',
    factoryType: 'builtin',
    protocol: 'deepseek',
    preset: 'deepseek',
    displayName: 'DeepSeek（官方）',
    configDisplayName: 'DeepSeek LLM 工厂配置',
    description: 'DeepSeek 官方大语言模型，通过 providers[] 管理多 API / 多模型端点'
  },
  {
    configKey: 'xiaomimimo_llm',
    factoryType: 'builtin',
    protocol: 'xiaomimimo',
    preset: 'xiaomimimo',
    displayName: '小米 MiMo（官方）',
    configDisplayName: '小米 MiMo LLM 工厂配置',
    description: '小米 MiMo 大语言模型，通过 providers[] 管理多 API / 多模型端点'
  },
  {
    configKey: 'openai_llm',
    factoryType: 'builtin',
    protocol: 'openai',
    preset: 'openai',
    displayName: 'OpenAI（官方）',
    configDisplayName: 'OpenAI LLM 工厂配置',
    description: 'OpenAI 官方 Chat Completions，通过 providers[] 管理多端点'
  },
  {
    configKey: 'gemini_llm',
    factoryType: 'builtin',
    protocol: 'gemini',
    preset: 'gemini',
    displayName: 'Gemini（官方）',
    configDisplayName: 'Gemini LLM 工厂配置',
    description: 'Google Gemini 大语言模型，通过 providers[] 管理多端点'
  },
  {
    configKey: 'anthropic_llm',
    factoryType: 'builtin',
    protocol: 'anthropic',
    preset: 'anthropic',
    displayName: 'Anthropic（官方）',
    configDisplayName: 'Anthropic LLM 工厂配置',
    description: 'Anthropic Claude Messages API，通过 providers[] 管理多端点'
  },
  {
    configKey: 'azure_openai_llm',
    factoryType: 'builtin',
    protocol: 'azure_openai',
    preset: 'azure_openai',
    displayName: 'Azure OpenAI（官方）',
    configDisplayName: 'Azure OpenAI LLM 工厂配置',
    description: 'Azure OpenAI 部署，通过 providers[] 管理多端点'
  },
  {
    configKey: 'openai_compat_llm',
    factoryType: 'compat',
    defaultProtocol: 'openai',
    preset: 'openai_compat',
    displayName: 'OpenAI Chat 兼容',
    configDisplayName: 'OpenAI Chat 协议兼容 LLM 工厂',
    description: 'OpenAI Chat Completions 兼容网关，通过 providers[] 注册多个运营商 key',
    clientClass: OpenAICompatibleLLMClient
  },
  {
    configKey: 'openai_responses_compat_llm',
    factoryType: 'compat',
    defaultProtocol: 'openai-response',
    preset: 'openai_responses_compat',
    displayName: 'OpenAI Responses 兼容',
    configDisplayName: 'OpenAI Responses 兼容 LLM 工厂',
    description: 'OpenAI Responses 协议兼容端点，通过 providers[] 管理',
    clientClass: OpenAIResponsesCompatibleLLMClient
  },
  {
    configKey: 'newapi_compat_llm',
    factoryType: 'compat',
    defaultProtocol: 'new-api',
    preset: 'newapi_compat',
    displayName: 'New API 兼容',
    configDisplayName: 'New API 兼容 LLM 工厂',
    description: 'New API 兼容网关，通过 providers[] 管理多端点',
    clientClass: OpenAIPathCompatLLMClient
  },
  {
    configKey: 'cherryin_compat_llm',
    factoryType: 'compat',
    defaultProtocol: 'cherryin',
    preset: 'cherryin_compat',
    displayName: 'CherryIN 兼容',
    configDisplayName: 'CherryIN 兼容 LLM 工厂',
    description: 'CherryIN 兼容网关，通过 providers[] 管理多端点',
    clientClass: OpenAIPathCompatLLMClient
  },
  {
    configKey: 'ollama_compat_llm',
    factoryType: 'compat',
    defaultProtocol: 'ollama',
    preset: 'ollama_compat',
    displayName: 'Ollama 兼容',
    configDisplayName: 'Ollama 兼容 LLM 工厂',
    description: 'Ollama 本地/远程实例，通过 providers[] 管理多端点',
    clientClass: OllamaCompatibleLLMClient
  },
  {
    configKey: 'gemini_compat_llm',
    factoryType: 'compat',
    defaultProtocol: 'gemini',
    preset: 'gemini_compat',
    displayName: 'Gemini 兼容',
    configDisplayName: 'Gemini 兼容 LLM 工厂',
    description: 'Gemini 协议兼容网关，通过 providers[] 管理多端点',
    clientClass: GeminiCompatibleLLMClient
  },
  {
    configKey: 'anthropic_compat_llm',
    factoryType: 'compat',
    defaultProtocol: 'anthropic',
    preset: 'anthropic_compat',
    displayName: 'Anthropic 兼容',
    configDisplayName: 'Anthropic 兼容 LLM 工厂',
    description: 'Anthropic Messages 协议兼容网关，通过 providers[] 管理多端点',
    clientClass: AnthropicCompatibleLLMClient
  },
  {
    configKey: 'azure_openai_compat_llm',
    factoryType: 'compat',
    defaultProtocol: 'azure-openai',
    preset: 'azure_openai_compat',
    displayName: 'Azure OpenAI 兼容',
    configDisplayName: 'Azure OpenAI 兼容 LLM 工厂',
    description: 'Azure OpenAI 协议兼容网关，通过 providers[] 管理多端点',
    clientClass: AzureOpenAICompatibleLLMClient
  }
];

export const LLM_FACTORY_CONFIG_KEYS = LLM_FACTORY_REGISTRY.map((row) => row.configKey);

export function getLlmFactoryRegistryEntry(configKey) {
  return LLM_FACTORY_REGISTRY.find((row) => row.configKey === configKey) ?? null;
}

/** CommonConfig createLlmFactoryConfigClass 使用的定义表 */
export function buildLlmFactoryDefinitionsMap() {
  return Object.fromEntries(
    LLM_FACTORY_REGISTRY.map((row) => [
      row.configKey,
      {
        displayName: row.configDisplayName,
        description: row.description,
        preset: row.preset
      }
    ])
  );
}
