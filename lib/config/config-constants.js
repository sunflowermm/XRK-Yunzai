/**
 * 配置常量定义（与 XRK-AGT 对齐）
 * 统一管理路径、端口级配置、默认配置分类，避免底层重复字符串与逻辑
 */

/** 默认配置目录（相对项目根） */
export const DEFAULT_CONFIG_DIR = 'config/default_config';
/** 端口级配置根目录（相对项目根） */
export const SERVER_BOTS_DIR = 'data/server_bots';
/** 日志目录（相对项目根） */
export const LOGS_DIR = 'logs';
/** PM2 配置目录（相对项目根） */
export const PM2_CONFIG_DIR = 'config/pm2';

/**
 * 解析端口级配置路径或默认配置路径
 * @param {number|null|undefined} port - 端口，无则用默认配置
 * @param {string} configName - 配置名（如 bot、volcengine_llm）
 * @returns {string} 相对路径，如 data/server_bots/8086/bot.yaml 或 config/default_config/bot.yaml
 */
export function getServerConfigPath(port, configName) {
  return port ? `${SERVER_BOTS_DIR}/${port}/${configName}.yaml` : `${DEFAULT_CONFIG_DIR}/${configName}.yaml`;
}

/** 需要为每个端口单独生成的配置文件（端口级配置）；不在此列表中的 YAML 仅作为全局默认存在，不会被复制到端口目录 */
export const PORT_CONFIG_FILES = new Set([
  'bot.yaml',
  'other.yaml',
  'group.yaml',
  'notice.yaml',
  'server.yaml'
]);

/** 默认配置目录下的配置名列表（仅作文档/扩展用，实际复制逻辑以 PORT_CONFIG_FILES 为准） */
export const DEFAULT_CONFIG_NAMES = [
  'bot',
  'other',
  'group',
  'notice',
  'server',
  'aistream',
  'device',
  'db',
  'monitor',
  'redis'
];

/**
 * 已在 commonconfig 中注册的系统配置（system-plugin/commonconfig/system.js 的 configFiles 键）
 * 与 config/default_config/*.yaml 一一对应；schema 应覆盖对应 yaml 的全部顶层字段，写入时与已有内容合并以保留未在 schema 中的字段
 */
export const SYSTEM_CONFIG_NAMES = [
  'bot',
  'other',
  'server',
  'device',
  'group',
  'notice',
  'redis',
  'db',
  'aistream',
  'monitor',
  'renderer'
];

/**
 * 工厂类配置文件名后缀（LLM/ASR/TTS 等），不通过 commonconfig 表单编辑，由各 Factory 与 cfg.getLLMConfig 等读取
 * 如：volcengine_llm.yaml、openai_llm.yaml、volcengine_asr.yaml、volcengine_tts.yaml、*_compat_llm.yaml
 */
export const FACTORY_CONFIG_SUFFIXES = ['_llm', '_asr', '_tts', '_compat_llm'];
