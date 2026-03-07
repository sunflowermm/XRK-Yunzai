/**
 * 配置常量定义（与 XRK-AGT 对齐）
 * 统一管理路径、全局/端口级配置分类，避免底层重复字符串与逻辑。
 *
 * 与 XRK-AGT 一致：
 * - 全局配置（不随端口变化）：存储在 data/server_bots/{configName}.yaml
 * - 端口级配置（随端口变化）：存储在 data/server_bots/{port}/{configName}.yaml
 * - 默认/模板配置：config/default_config/*.yaml，用于初次生成或合并基准
 */

/** 默认配置目录（相对项目根），作为全局与端口级配置的模板/基准 */
export const DEFAULT_CONFIG_DIR = 'config/default_config';
/** 端口级配置根目录（相对项目根）；全局配置存于该目录下根级 yaml，端口级存于 {port}/ 子目录 */
export const SERVER_BOTS_DIR = 'data/server_bots';
/** 日志目录（相对项目根） */
export const LOGS_DIR = 'logs';
/** PM2 配置目录（相对项目根） */
export const PM2_CONFIG_DIR = 'config/pm2';

/**
 * 全局配置名列表（不随端口变化，与 XRK-AGT GLOBAL_CONFIGS 对齐）
 * 存储位置：data/server_bots/{configName}.yaml
 */
export const GLOBAL_CONFIG_NAMES = [
  'device',
  'monitor',
  'notice',
  'redis',
  'db',
  'aistream'
];

/**
 * 端口级配置名列表（随端口变化）
 * 存储位置：data/server_bots/{port}/{configName}.yaml
 */
export const PORT_CONFIG_NAMES = [
  'bot',
  'other',
  'server',
  'group'
];

/**
 * 判断是否为全局配置
 * @param {string} configName - 配置名
 * @returns {boolean}
 */
export function isGlobalConfig(configName) {
  return GLOBAL_CONFIG_NAMES.includes(configName);
}

/**
 * 获取全局配置文件的相对路径（不随端口变化）
 * @param {string} configName - 配置名
 * @returns {string} 相对路径，如 data/server_bots/device.yaml
 */
export function getGlobalConfigPath(configName) {
  return `${SERVER_BOTS_DIR}/${configName}.yaml`;
}

/**
 * 解析配置路径：默认/模板 或 覆盖路径（全局/端口级）
 * 与 XRK-AGT 一致：port 为空时返回默认配置路径；有 port 时全局配置返回 server_bots 根下 yaml，端口级返回 server_bots/{port}/ 下 yaml。
 *
 * @param {number|null|undefined} port - 端口；null/undefined 表示取默认配置路径
 * @param {string} configName - 配置名（如 bot、device、server）
 * @returns {string} 相对项目根的路径，如 data/server_bots/8086/bot.yaml、data/server_bots/device.yaml 或 config/default_config/bot.yaml
 */
export function getServerConfigPath(port, configName) {
  if (port === null || port === undefined) {
    return `${DEFAULT_CONFIG_DIR}/${configName}.yaml`;
  }
  if (isGlobalConfig(configName)) {
    return getGlobalConfigPath(configName);
  }
  return `${SERVER_BOTS_DIR}/${port}/${configName}.yaml`;
}

/** 需要为每个端口单独生成的配置文件（仅端口级）；port 目录内不会出现全局配置的 yaml */
export const PORT_CONFIG_FILES = new Set(
  PORT_CONFIG_NAMES.map((name) => `${name}.yaml`)
);

/** 默认配置目录下的配置名列表（端口级 + 全局，由 PORT + GLOBAL 推导，单源） */
export const DEFAULT_CONFIG_NAMES = [...PORT_CONFIG_NAMES, ...GLOBAL_CONFIG_NAMES];

/**
 * 已在 commonconfig 中注册的系统配置（system-plugin commonconfig 的 configFiles 键）
 * 由 PORT + GLOBAL + renderer 推导；default_config 与 schema 对齐，写入时与已有内容合并。
 */
export const SYSTEM_CONFIG_NAMES = [...PORT_CONFIG_NAMES, ...GLOBAL_CONFIG_NAMES, 'renderer'];

/**
 * 工厂类配置文件名后缀（LLM/ASR/TTS 等），不通过 commonconfig 表单编辑，由各 Factory 与 cfg.getLLMConfig 等读取
 * 如：volcengine_llm.yaml、openai_llm.yaml、volcengine_asr.yaml、volcengine_tts.yaml、*_compat_llm.yaml
 */
export const FACTORY_CONFIG_SUFFIXES = ['_llm', '_asr', '_tts', '_compat_llm'];
