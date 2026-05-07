import GPTGodLLMClient from './GPTGodLLMClient.js';
import VolcengineLLMClient from './VolcengineLLMClient.js';
import XiaomiMiMoLLMClient from './XiaomiMiMoLLMClient.js';
import OpenAILLMClient from './OpenAILLMClient.js';
import GeminiLLMClient from './GeminiLLMClient.js';
import AnthropicLLMClient from './AnthropicLLMClient.js';
import AzureOpenAILLMClient from './AzureOpenAILLMClient.js';
import OpenAICompatibleLLMClient from './OpenAICompatibleLLMClient.js';
import OpenAIResponsesCompatibleLLMClient from './OpenAIResponsesCompatibleLLMClient.js';
import OpenAIPathCompatLLMClient from './OpenAIPathCompatLLMClient.js';
import OllamaCompatibleLLMClient from './OllamaCompatibleLLMClient.js';
import GeminiCompatibleLLMClient from './GeminiCompatibleLLMClient.js';
import AnthropicCompatibleLLMClient from './AnthropicCompatibleLLMClient.js';
import AzureOpenAICompatibleLLMClient from './AzureOpenAICompatibleLLMClient.js';

const builtinProviders = new Map([
  ['gptgod', (config) => new GPTGodLLMClient(config)],
  ['volcengine', (config) => new VolcengineLLMClient(config)],
  ['xiaomimimo', (config) => new XiaomiMiMoLLMClient(config)],
  ['openai', (config) => new OpenAILLMClient(config)],
  ['gemini', (config) => new GeminiLLMClient(config)],
  ['anthropic', (config) => new AnthropicLLMClient(config)],
  ['azure_openai', (config) => new AzureOpenAILLMClient(config)]
]);

const compatFactories = [
  { configKey: 'openai_compat_llm', factoryType: 'openai_compat_llm', defaultProtocol: 'openai', clientClass: OpenAICompatibleLLMClient },
  { configKey: 'openai_responses_compat_llm', factoryType: 'openai_responses_compat_llm', defaultProtocol: 'openai-response', clientClass: OpenAIResponsesCompatibleLLMClient },
  { configKey: 'newapi_compat_llm', factoryType: 'newapi_compat_llm', defaultProtocol: 'new-api', clientClass: OpenAIPathCompatLLMClient },
  { configKey: 'cherryin_compat_llm', factoryType: 'cherryin_compat_llm', defaultProtocol: 'cherryin', clientClass: OpenAIPathCompatLLMClient },
  { configKey: 'ollama_compat_llm', factoryType: 'ollama_compat_llm', defaultProtocol: 'ollama', clientClass: OllamaCompatibleLLMClient },
  { configKey: 'gemini_compat_llm', factoryType: 'gemini_compat_llm', defaultProtocol: 'gemini', clientClass: GeminiCompatibleLLMClient },
  { configKey: 'anthropic_compat_llm', factoryType: 'anthropic_compat_llm', defaultProtocol: 'anthropic', clientClass: AnthropicCompatibleLLMClient },
  { configKey: 'azure_openai_compat_llm', factoryType: 'azure_openai_compat_llm', defaultProtocol: 'azure-openai', clientClass: AzureOpenAICompatibleLLMClient }
];

function normalizeProviderKey(name) {
  return (name || '').toString().trim().toLowerCase();
}

function normalizeProtocol(value) {
  const protocol = normalizeProviderKey(value);
  if (protocol === 'openai-responses') return 'openai-response';
  return protocol;
}

/** 内置 Map 插入顺序的第一个 key；业务层 registerProvider 追加时默认仍指向最初注册项 */
function firstBuiltinProviderKey() {
  const k = builtinProviders.keys().next().value;
  return k ?? null;
}

function resolveDefaultProvider() {
  const aistream = global.cfg?.aistream || {};
  const llm = aistream.llm || {};
  const p = normalizeProviderKey(llm.Provider || llm.provider);
  if (p) return p;
  return firstBuiltinProviderKey();
}

function getBuiltinProviderConfig(key) {
  return key ? (global.cfg?.[`${key}_llm`] || null) : null;
}

function getCompatProviderEntries() {
  const entries = [];
  for (const factory of compatFactories) {
    const factoryCfg = global.cfg?.[factory.configKey] || {};
    const providerList = Array.isArray(factoryCfg.providers) ? factoryCfg.providers : [];
    const defaults = { ...factoryCfg };
    delete defaults.providers;

    for (const providerEntry of providerList) {
      const key = normalizeProviderKey(providerEntry.key || providerEntry.provider);
      if (!key) continue;
      const protocol = normalizeProtocol(providerEntry.protocol || defaults.protocol) || factory.defaultProtocol;
      entries.push({
        key,
        protocol,
        factory,
        defaults,
        entry: providerEntry
      });
    }
  }
  return entries;
}

export default class LLMFactory {
  /** @returns {string|null} 当前 builtinProviders 按注册顺序的第一个 key */
  static firstBuiltinProviderKey() {
    return firstBuiltinProviderKey();
  }

  /** @returns {string[]} 内置提供商 key 列表（不含 compat），顺序即注册顺序 */
  static listBuiltinProviderKeys() {
    return Array.from(builtinProviders.keys());
  }

  static registerProvider(name, factoryFn) {
    builtinProviders.set(String(name).toLowerCase(), factoryFn);
  }

  static listProviders() {
    const builtin = Array.from(builtinProviders.keys());
    const compat = getCompatProviderEntries().map((x) => x.key);
    return Array.from(new Set([...builtin, ...compat]));
  }

  static hasProvider(name) {
    return !!this.getProviderConfig(name);
  }

  static resolveProvider(input = {}, options = {}) {
    const allowDefaultAliases = options.allowDefaultAliases !== false;
    const isDefaultAlias = (v) => {
      const s = normalizeProviderKey(v);
      return s === 'default' || s === 'auto';
    };

    const candidates = [
      input.provider,
      input.model,
      input.llm,
      input.profile,
      input.defaultProvider,
      resolveDefaultProvider()
    ];

    for (const candidate of candidates) {
      const key = normalizeProviderKey(candidate);
      if (!key) continue;
      if (allowDefaultAliases && isDefaultAlias(key)) continue;
      if (this.hasProvider(key)) return key;
    }

    return null;
  }

  static getProviderConfig(providerName) {
    const key = normalizeProviderKey(providerName);
    if (!key) return null;

    const builtinDefaults = getBuiltinProviderConfig(key);
    if (builtinDefaults || builtinProviders.has(key)) {
      return {
        provider: key,
        factoryType: 'builtin',
        protocol: key,
        ...(builtinDefaults || {})
      };
    }

    const compat = getCompatProviderEntries().find((x) => x.key === key);
    if (!compat) return null;

    return {
      ...compat.defaults,
      ...compat.entry,
      provider: key,
      protocol: compat.protocol,
      factoryType: compat.factory.factoryType,
      _clientClass: compat.factory.clientClass
    };
  }

  static createClient(config = {}) {
    const provider = this.resolveProvider(config, { allowDefaultAliases: true });
    if (!provider) {
      throw new Error('未指定LLM提供商，请在 aistream.yaml 中配置 llm.Provider');
    }

    const builtinFactory = builtinProviders.get(provider);
    if (builtinFactory) {
      const merged = {
        ...(getBuiltinProviderConfig(provider) || {}),
        ...config,
        provider
      };
      return builtinFactory(merged);
    }

    const resolved = this.getProviderConfig(provider);
    if (!resolved) {
      throw new Error(`不支持的LLM提供商: ${provider}`);
    }

    const ClientClass = resolved._clientClass || OpenAICompatibleLLMClient;

    // 避免上游传入的 undefined 覆盖 provider 默认配置（与 XRK-AGT 对齐）
    const sanitizedConfig = {};
    for (const [k, value] of Object.entries(config || {})) {
      if (value !== undefined) sanitizedConfig[k] = value;
    }

    const { _clientClass, ...clientConfig } = {
      ...resolved,
      ...sanitizedConfig,
      provider,
      protocol: normalizeProtocol(sanitizedConfig.protocol || resolved.protocol) || resolved.protocol
    };

    return new ClientClass(clientConfig);
  }
}
