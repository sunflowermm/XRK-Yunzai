/**
 * TRSS / 传统 Yunzai 第三方插件配置兼容层（makeConfig）
 *
 * 路径固定为 `config/<name>.yaml`（相对项目根），供 zmd-plugin、miao-plugin 等历史插件使用。
 * 新插件优先 CommonConfig（plugins/<名>/commonconfig/）；本模块禁止删除。
 */
import YAML from 'yaml';
import cfg from '../config/config.js';
import { resolveProjectPath } from '../config/config-constants.js';
import BotUtil from '../util.js';
import { FileUtils } from '../utils/file-utils.js';
import { ObjectUtils } from '../utils/object-utils.js';
import { HotReloadBase } from '../utils/hot-reload-base.js';

/** @type {Map<string, { config: object, configSave: Function, configFile: string, watcher?: import('chokidar').FSWatcher }>} */
const cache = new Map();

/** 配置文件变更时重新 merge 到内存对象（与 TRSS watcher 行为一致） */
export async function watcher() {
  try {
    Bot.makeLog('debug', `配置文件 ${this.configFile} 发生变化`, 'PluginConfig');
    const absPath = resolveProjectPath(this.configFile);
    const text = FileUtils.readFileSync(absPath, 'utf8');
    const configData = YAML.parse(text) ?? {};
    ObjectUtils.deepMerge(this.config, configData);
  } catch (err) {
    Bot.makeLog('error', `配置文件 ${this.configFile} 读取失败: ${err.message}`, 'PluginConfig', err);
  }
}

/**
 * 创建/加载插件 YAML 配置（TRSS 兼容 API）
 * @param {string} name 配置文件名（不含扩展名），写入 config/<name>.yaml
 * @param {object} [config={}] 默认配置（会被文件内容与 keep 深度合并）
 * @param {object} [keep={}] 强制覆盖项
 * @param {object} [opts={}]
 * @param {boolean} [opts.watch] 是否监听文件变化，默认跟随 cfg.bot.file_watch
 * @param {function} [opts.replacer] 保存前 YAML 文本变换
 * @returns {Promise<{ config: object, configSave: function, configFile: string, watcher?: import('chokidar').FSWatcher }>}
 */
export default async function makeConfig(name, config = {}, keep = {}, opts = {}) {
  if (cache.has(name)) return cache.get(name);

  const configFile = `config/${name}.yaml`;
  const absPath = resolveProjectPath(configFile);

  const writeConfigFile = async () => {
    const text = typeof opts.replacer === 'function'
      ? await opts.replacer(YAML.stringify(config))
      : YAML.stringify(config);
    FileUtils.writeFileSync(absPath, text, 'utf8');
  };

  const configSave = BotUtil.debounce(writeConfigFile, 500);

  const ret = { config, configSave, configFile };
  cache.set(name, ret);

  let configData;
  try {
    if (FileUtils.existsSync(absPath)) {
      configData = YAML.parse(FileUtils.readFileSync(absPath, 'utf8')) ?? {};
      ObjectUtils.deepMerge(config, configData);
    }
  } catch (err) {
    Bot.makeLog('debug', `配置文件 ${configFile} 读取失败: ${err.message}`, 'PluginConfig');
  }

  ObjectUtils.deepMerge(config, keep);

  if (YAML.stringify(config) !== YAML.stringify(configData ?? {})) {
    await writeConfigFile();
  }

  const shouldWatch = typeof opts.watch === 'boolean' ? opts.watch : cfg.bot?.file_watch !== false;
  if (shouldWatch) {
    ret.watcher = HotReloadBase.createWatcher(
      absPath,
      { onChange: () => watcher.call(ret) },
      { debounceMs: 5000, loggerName: 'PluginConfig' },
    );
  }

  return ret;
}
