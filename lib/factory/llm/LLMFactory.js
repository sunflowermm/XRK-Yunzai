import GPTGodLLMClient from './GPTGodLLMClient.js';
import VolcengineLLMClient from './VolcengineLLMClient.js';
import DeepSeekLLMClient from './DeepSeekLLMClient.js';
import XiaomiMiMoLLMClient from './XiaomiMiMoLLMClient.js';
import OpenAILLMClient from './OpenAILLMClient.js';
import GeminiLLMClient from './GeminiLLMClient.js';
import AnthropicLLMClient from './AnthropicLLMClient.js';
import AzureOpenAILLMClient from './AzureOpenAILLMClient.js';
import { LLM_FACTORY_REGISTRY } from './factory-registry.js';
import cfg from '../../config/config.js';

const builtinClientFactories = new Map([
  ['gptgod', (config) => new GPTGodLLMClient(config)],
  ['volcengine', (config) => new VolcengineLLMClient(config)],
  ['deepseek', (config) => new DeepSeekLLMClient(config)],
  ['xiaomimimo', (config) => new XiaomiMiMoLLMClient(config)],
  ['openai', (config) => new OpenAILLMClient(config)],
  ['gemini', (config) => new GeminiLLMClient(config)],
  ['anthropic', (config) => new AnthropicLLMClient(config)],
  ['azure_openai', (config) => new AzureOpenAILLMClient(config)]
]);

/** configKey → 侧栏工厂 id（anthropic_compat_llm → anthropic_compat） */
export function resolveFactoryId(configKey = '') {
  const key = String(configKey || '').trim();
  if (!key) return '';
  if (key.endsWith('_llm')) return key.slice(0, -4);
  return key;
}

function readFactoryCfg(configKey) {
  if (!configKey) return { providers: [] };
  const raw = typeof cfg?.getConfig === 'function' ? (cfg.getConfig(configKey) || {}) : {};
  if (!raw || typeof raw !== 'object') return { providers: [] };
  if (!Array.isArray(raw.providers)) return { ...raw, providers: [] };
  return raw;
}

function normalizeProviderKey(name) {
  return (name || '').toString().trim().toLowerCase();
}

function resolveDefaultProvider() {
  return normalizeProviderKey(cfg?.aistream?.llm?.Provider || cfg?.aistream?.llm?.provider);
}

function normalizeProtocol(value) {
  const protocol = normalizeProviderKey(value);
  if (protocol === 'openai-responses') return 'openai-response';
  return protocol;
}

function getProviderEntries() {
  const entries = [];

  for (const factory of LLM_FACTORY_REGISTRY) {
    const factoryCfg = readFactoryCfg(factory.configKey);
    const providerList = factoryCfg.providers;

    for (const providerEntry of providerList) {
      const key = normalizeProviderKey(providerEntry.key || providerEntry.provider);
      if (!key) continue;

      const protocol = normalizeProtocol(
        providerEntry.protocol || factory.protocol || factory.defaultProtocol
      );

      entries.push({
        key,
        protocol,
        factory,
        entry: providerEntry
      });
    }
  }

  return entries;
}

export default class LLMFactory {
  static registerProvider(name, factoryFn) {
    builtinClientFactories.set(String(name).toLowerCase(), factoryFn);
  }

  static listProviders() {
    return getProviderEntries().map((x) => x.key);
  }

  static listFactories() {
    return LLM_FACTORY_REGISTRY.map((factory) => ({
      configKey: factory.configKey,
      id: resolveFactoryId(factory.configKey),
      displayName: factory.displayName || resolveFactoryId(factory.configKey),
      factoryType: factory.factoryType,
      protocol: factory.protocol || factory.defaultProtocol || null
    }));
  }

  static listModelProfiles(filter = {}) {
    const rows = getProviderEntries().map(({ key, protocol, factory, entry }) => ({
      key,
      factory: resolveFactoryId(factory.configKey),
      factoryConfigKey: factory.configKey,
      factoryDisplayName: factory.displayName || resolveFactoryId(factory.configKey),
      factoryType: factory.factoryType,
      protocol,
      label: entry.label || key,
      description: `配置来源: ${factory.configKey}.providers[]`,
      tags: [],
      model: entry.model || entry.chatModel || entry.deployment || null,
      baseUrl: entry.baseUrl || null,
      maxTokens: entry.maxTokens ?? entry.max_tokens ?? null,
      temperature: entry.temperature ?? null,
      hasApiKey: Boolean(String(entry.apiKey || '').trim()),
      capabilities: [
        ...(entry.enableStream !== false ? ['stream'] : []),
        ...(entry.enableTools === true ? ['tools'] : [])
      ],
      source: `${factory.configKey}.providers[]`
    }));

    let result = rows;
    if (filter.protocol) {
      const protos = Array.isArray(filter.protocol) ? filter.protocol : [filter.protocol];
      const set = new Set(protos.map((p) => normalizeProtocol(p)));
      result = result.filter((row) => set.has(normalizeProtocol(row.protocol)));
    }
    if (filter.hasApiKey === true) {
      result = result.filter((row) => row.hasApiKey);
    }
    if (filter.capability) {
      result = result.filter((row) => row.capabilities?.includes(filter.capability));
    }
    if (filter.factory) {
      const factories = Array.isArray(filter.factory) ? filter.factory : [filter.factory];
      const set = new Set(factories.map((f) => normalizeProviderKey(f)));
      result = result.filter((row) => set.has(normalizeProviderKey(row.factory)));
    }
    return result;
  }

  static listVendors(profiles = null) {
    const rows = profiles ?? this.listModelProfiles();
    const vendorMap = new Map(
      this.listFactories().map((factory) => [
        factory.id,
        {
          id: factory.id,
          label: factory.displayName,
          configKey: factory.configKey,
          factoryType: factory.factoryType,
          protocol: factory.protocol,
          endpoints: []
        }
      ])
    );
    for (const p of rows) {
      const bucket = vendorMap.get(p.factory);
      if (!bucket) continue;
      bucket.endpoints.push({
        key: p.key,
        label: p.label,
        model: p.model,
        baseUrl: p.baseUrl,
        protocol: p.protocol,
        hasApiKey: p.hasApiKey,
        capabilities: p.capabilities
      });
    }
    const order = this.listFactories().map((f) => f.id);
    return [...vendorMap.values()].sort(
      (a, b) => (order.indexOf(a.id) === -1 ? order.length : order.indexOf(a.id))
        - (order.indexOf(b.id) === -1 ? order.length : order.indexOf(b.id))
    );
  }

  static hasProvider(name) {
    return !!this.getProviderConfig(name);
  }

  static resolveProvider(input = {}, options = {}) {
    const allowDefaultAliases = options.allowDefaultAliases !== false;
    const useAistreamDefault = options.useAistreamDefault !== false;
    const isDefaultAlias = (v) => {
      const s = normalizeProviderKey(v);
      return s === 'default' || s === 'auto';
    };

    const candidates = [
      input.provider,
      input.model,
      input.llm,
      input.profile,
      input.defaultProvider
    ];
    if (useAistreamDefault) {
      candidates.push(resolveDefaultProvider());
    }

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

    const matched = getProviderEntries().find((x) => x.key === key);
    if (!matched) return null;

    const { factory, entry, protocol } = matched;

    return {
      ...entry,
      provider: key,
      protocol,
      factoryType: factory.factoryType,
      factory: resolveFactoryId(factory.configKey),
      _clientClass: factory.clientClass || null
    };
  }

  static createClient(config = {}) {
    const useAistreamDefault = config.useAistreamDefault !== false;
    const provider = this.resolveProvider(config, {
      allowDefaultAliases: config.allowDefaultAliases !== false,
      useAistreamDefault
    });
    if (!provider) {
      const hint = useAistreamDefault
        ? '请在各工厂 providers[] 中添加端点，并在 aistream.yaml 配置 llm.Provider'
        : '请在各工厂 providers[] 中添加端点，并在请求中指定 provider';
      throw new Error(`未指定 LLM 提供商：${hint}`);
    }

    const resolved = this.getProviderConfig(provider);
    if (!resolved) {
      throw new Error(`不支持的 LLM 提供商: ${provider}`);
    }

    const sanitizedConfig = {};
    for (const [k, value] of Object.entries(config || {})) {
      if (value !== undefined) sanitizedConfig[k] = value;
    }

    const clientConfig = {
      ...resolved,
      ...sanitizedConfig,
      provider,
      protocol: normalizeProtocol(sanitizedConfig.protocol || resolved.protocol) || resolved.protocol
    };

    const { _clientClass, factoryType, ...rest } = clientConfig;

    if (factoryType === 'compat' && _clientClass) {
      return new _clientClass(rest);
    }

    const builtinFactory = builtinClientFactories.get(rest.protocol);
    if (builtinFactory) {
      return builtinFactory(rest);
    }

    throw new Error(`无法创建 LLM 客户端: provider=${provider}, protocol=${rest.protocol}`);
  }
}
