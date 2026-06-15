import ConfigBase from '../../../../lib/commonconfig/commonconfig.js';
import { getServerConfigPath } from '../../../../lib/config/config-constants.js';
import {
  buildLlmFactoryDefinitionsMap,
  LLM_FACTORY_CONFIG_KEYS
} from '../../../../lib/factory/llm/factory-registry.js';
import { buildLlmProvidersFromPreset } from './llm-provider-fields.js';

export const LLM_FACTORY_DEFINITIONS = buildLlmFactoryDefinitionsMap();
export { LLM_FACTORY_CONFIG_KEYS };

/**
 * @param {string} name - 如 openai_llm
 * @returns {typeof ConfigBase}
 */
export function createLlmFactoryConfigClass(name) {
  const def = LLM_FACTORY_DEFINITIONS[name];
  if (!def) {
    throw new Error(`未知 LLM 工厂 CommonConfig: ${name}`);
  }

  return class extends ConfigBase {
    constructor() {
      super({
        name,
        displayName: def.displayName,
        description: def.description,
        filePath: (c) => getServerConfigPath(c?._port ?? 8086, name),
        fileType: 'yaml',
        schema: {
          fields: {
            providers: buildLlmProvidersFromPreset(def.preset)
          }
        }
      });
    }
  };
}
