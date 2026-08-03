import { getServerConfigPath } from '../../../../lib/config/config-constants.js';
import { LLM_FACTORY_REGISTRY } from '../../../../lib/factory/llm/factory-registry.js';
import { buildLlmProvidersFromPreset } from './llm-provider-fields.js';

/**
 * LLM 工厂子配置写法：一份 meta，挂到 llm_factories 多文件下。
 * YAML 仍是 data/server_bots/{port}/<name>.yaml（与 LLMFactory.configKey 一致）。
 */
export function llmFactoryConfigFiles() {
  const map = {};
  for (const row of LLM_FACTORY_REGISTRY) {
    const name = row.configKey;
    map[name] = {
      name,
      displayName: row.configDisplayName || row.displayName || name,
      description: row.description || `${row.displayName || name}（providers[]）`,
      filePath: (runtimeConfig) => {
        const port = runtimeConfig?._port ?? runtimeConfig?.port ?? 8086;
        return getServerConfigPath(port, name);
      },
      fileType: 'yaml',
      schema: {
        fields: {
          providers: buildLlmProvidersFromPreset(row.preset)
        }
      }
    };
  }
  return map;
}
