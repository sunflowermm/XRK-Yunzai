import YAML from 'yaml';
import path from 'path';
import { HotReloadBase } from '../utils/hot-reload-base.js';
import { FileUtils } from '../utils/file-utils.js';
import { ObjectUtils } from '../utils/object-utils.js';
import { tryParseJson } from '../utils/json-utils.js';
import {
  PORT_CONFIG_FILES,
  DEFAULT_CONFIG_DIR,
  SERVER_BOTS_DIR,
  GLOBAL_CONFIG_FILES,
  getServerConfigPath,
  resolveProjectPath,
} from './config-constants.js';

/**
 * 配置管理类
 * 处理服务器配置的加载和更新
 */
class Cfg {
  config = {};
  _port = null;
  watcher = {};
  _renderer = null;
  _startTime = Date.now();
  _initGracePeriod = 2000;
  PATHS = {
    DEFAULT_CONFIG: resolveProjectPath(DEFAULT_CONFIG_DIR),
    SERVER_BOTS: resolveProjectPath(SERVER_BOTS_DIR),
    RENDERERS: resolveProjectPath('renderers'),
  };

  constructor() {
    const portIndex = process.argv.indexOf('server');
    if (portIndex !== -1 && process.argv[portIndex + 1]) {
      this._port = parseInt(process.argv[portIndex + 1], 10);
    }

    if (this._port) {
      this.ensureServerConfigDir();
    }
  }

  /**
   * 绑定运行端口（与 Bot.run 对齐，避免 argv 与 options.port 不一致）
   * @param {number} port
   */
  setPort(port) {
    const p = Number(port);
    if (!Number.isFinite(p) || p <= 0) return;
    this._port = p;
    this.ensureServerConfigDir();
  }

  /**
   * 确保 server_bots 根目录存在，并初始化全局 + 当前端口级配置
   */
  ensureServerConfigDir() {
    if (!FileUtils.existsSync(this.PATHS.SERVER_BOTS)) {
      FileUtils.ensureDirSync(this.PATHS.SERVER_BOTS);
    }
    this.ensureGlobalConfigs();
    if (this._port) {
      this.ensurePortConfigs(this._port);
    }
  }

  /**
   * 从 default_config 复制全局配置到 data/server_bots/*.yaml
   */
  ensureGlobalConfigs() {
    const defaultConfigDir = this.PATHS.DEFAULT_CONFIG;
    for (const file of FileUtils.readDirSync(defaultConfigDir)) {
      if (!GLOBAL_CONFIG_FILES.has(file)) continue;
      const target = path.join(this.PATHS.SERVER_BOTS, file);
      if (FileUtils.existsSync(target)) continue;
      FileUtils.copyFileSync(path.join(defaultConfigDir, file), target);
    }
  }

  /**
   * 为指定端口准备端口级配置文件
   * 仅复制 PORT_CONFIG_FILES 中列出的 YAML
   * @param {number} port
   */
  ensurePortConfigs(port) {
    if (!port) return;

    const serverConfigDir = path.join(this.PATHS.SERVER_BOTS, String(port));
    if (!FileUtils.existsSync(serverConfigDir)) {
      FileUtils.ensureDirSync(serverConfigDir);
    }

    const defaultConfigDir = this.PATHS.DEFAULT_CONFIG;
    const files = FileUtils.readDirSync(defaultConfigDir);

    for (const file of files) {
      if (!PORT_CONFIG_FILES.has(file)) continue;

      const target = path.join(serverConfigDir, file);
      if (FileUtils.existsSync(target)) continue;

      FileUtils.copyFileSync(
        path.join(defaultConfigDir, file),
        target
      );
    }
  }

  /**
   * 获取当前配置目录路径
   */
  getConfigDir() {
    return path.join(this.PATHS.SERVER_BOTS, String(this._port));
  }

  /**
   * 获取机器人配置
   */
  get bot() {
    const merged = this.getMergedConfig('bot');
    merged.platform = 2;
    merged.data_dir = path.join(this.PATHS.SERVER_BOTS, String(this._port));
    if (merged.server) {
      merged.server.port = this._port;
    }
    return merged;
  }

  /**
   * 其他配置快捷获取
   */
  get other() {
    return this.getMergedConfig('other');
  }

  get redis() {
    return this.getMergedConfig('redis');
  }

  get renderer() {
    if (this._renderer) return this._renderer;

    this._renderer = {};
    const rendererTypes = ['playwright', 'puppeteer'];

    for (const type of rendererTypes) {
      const defaultFile = path.join(this.PATHS.RENDERERS, type, 'config_default.yaml');
      const serverDir = this._port ? path.join(this.getConfigDir(), 'renderers', type) : null;
      const serverFile = serverDir ? path.join(serverDir, 'config.yaml') : null;

      let config = {};
      if (FileUtils.existsSync(defaultFile)) {
        const defaultContent = FileUtils.readFileSync(defaultFile);
        if (defaultContent) {
          try {
            config = YAML.parse(defaultContent);
          } catch (error) {
            Bot.makeLog('error', `[渲染器默认配置解析失败][${type}][${defaultFile}]`, 'Config', error);
          }
        }
      }

      if (serverDir) {
        FileUtils.ensureDirSync(serverDir);
        if (FileUtils.existsSync(serverFile)) {
          const serverContent = FileUtils.readFileSync(serverFile);
          if (serverContent) {
            try {
              const parsed = YAML.parse(serverContent);
              config = ObjectUtils.deepMergeImmutable(config, parsed);
            } catch (error) {
              Bot.makeLog('error', `[渲染器服务器配置解析失败][${type}][${serverFile}]`, 'Config', error);
            }
          }
        } else {
          if (!FileUtils.writeFileSync(serverFile, YAML.stringify(config))) {
            Bot.makeLog('error', `[渲染器默认配置复制失败][${type}]`, 'Config');
          }
        }
      }

      this._renderer[type] = config;

      if (serverFile && FileUtils.existsSync(serverFile)) {
        const watchKey = `renderer.${type}`;
        if (!this.watcher[watchKey]) {
          const watcher = HotReloadBase.createWatcher(serverFile, {
            onChange: () => {
              if (Date.now() - this._startTime < this._initGracePeriod) return;
              delete this._renderer[type];
              this._renderer = null;
              Bot.makeLog('mark', `[修改渲染器配置文件][${type}]`, 'Config');
            }
          });
          this.watcher[watchKey] = watcher;
        }
      }
    }

    const defRenderer = this.getdefSet('renderer') || {};
    const portRenderer = this.getConfig('renderer') || {};
    this._renderer.name = portRenderer.name ?? defRenderer.name ?? 'puppeteer';

    const botCfg = this.bot;
    const puppeteerCfg = this._renderer.puppeteer || {};
    if (botCfg.chromium_path) {
      puppeteerCfg.chromiumPath ||= botCfg.chromium_path;
    }
    if (botCfg.puppeteer_ws) {
      puppeteerCfg.wsEndpoint ||= botCfg.puppeteer_ws;
    }
    if (botCfg.puppeteer_timeout != null && botCfg.puppeteer_timeout !== '' && puppeteerCfg.puppeteerTimeout == null) {
      puppeteerCfg.puppeteerTimeout = botCfg.puppeteer_timeout;
    }
    this._renderer.puppeteer = puppeteerCfg;

    const rendererMetaFile = resolveProjectPath(getServerConfigPath(this._port, 'renderer'));
    if (this._port && FileUtils.existsSync(rendererMetaFile) && !this.watcher['renderer.meta']) {
      this.watcher['renderer.meta'] = HotReloadBase.createWatcher(rendererMetaFile, {
        onChange: () => {
          if (Date.now() - this._startTime < this._initGracePeriod) return;
          this._renderer = null;
          Bot.makeLog('mark', '[修改渲染器选择配置][renderer.yaml]', 'Config');
        }
      });
    }

    return this._renderer;
  }

  get notice() {
    const def = this.getdefSet('notice');
    const config = this.getConfig('notice');
    return { ...def, ...config };
  }

  get server() {
    const def = this.getdefSet('server');
    const config = this.getConfig('server');
    return { ...def, ...config };
  }

  get device() {
    const def = this.getdefSet('device');
    const config = this.getConfig('device');
    return { ...def, ...config };
  }

  get db() {
    const def = this.getdefSet('db');
    const config = this.getConfig('db');
    return { ...def, ...config };
  }

  get monitor() {
    const def = this.getdefSet('monitor');
    const config = this.getConfig('monitor');
    return { ...def, ...config };
  }
  
  /**
   * 获取主人QQ号
   */
  get masterQQ() {
    let masterQQ = this.other.masterQQ ?? [];
    if (!Array.isArray(masterQQ)) {
      masterQQ = [masterQQ];
    }
    return masterQQ.map(qq => {
      if (typeof qq === 'number') return qq;
      if (typeof qq === 'string' && /^\d+$/.test(qq)) return Number(qq);
      return qq;
    });
  }

  /**
   * 获取主人映射对象，用于向后兼容
   * 返回 {bot_uin: [masterQQ数组]} 结构
   */
  get master() {
    const masters = {};
    const masterList = this.masterQQ.map(qq => String(qq));

    if (Bot && Array.isArray(Bot.uin)) {
      for (const botUin of Bot.uin) {
        masters[botUin] = masterList;
      }
    } else {
      const currentBotUin = this.bot.account?.uin ?? 'current_bot';
      masters[currentBotUin] = masterList;
    }

    return masters;
  }

  /**
   * 获取package.json信息
   */
  get package() {
    if (this._package) return this._package;
    const content = FileUtils.readFileSync('package.json');
    if (!content) throw new Error('package.json 未找到');
    const parsed = tryParseJson(content);
    if (!parsed) throw new Error('package.json 解析失败');
    this._package = parsed;
    return this._package;
  }
  /** 当 aistream.enabled 为 false 时，StreamLoader 不加载工作流；此处仍返回合并配置供 LLMFactory 等使用。与 default_config/aistream.yaml、commonconfig aistream schema 对齐。 */
  get aistream() {
    return this.getMergedConfig('aistream');
  }

  /**
   * 深合并 default_config 模板与 data 实际配置（运行时读取用）
   * getConfig 仅返回 data 层；getter 应使用本方法。
   * @param {string} name
   * @returns {Object}
   */
  getMergedConfig(name) {
    const def = this.getdefSet(name) || {};
    const stored = this.getConfig(name) || {};
    return ObjectUtils.deepMergeImmutable(def, stored);
  }

  /**
   * 获取默认配置
   * @param {string} name - 配置名称
   */
  getdefSet(name) {
    const key = `default.${name}`;
    if (this.config[key]) return this.config[key];

    const file = resolveProjectPath(getServerConfigPath(null, name));
    const content = FileUtils.readFileSync(file);
    if (content) {
      try {
        this.config[key] = YAML.parse(content);
      } catch (error) {
        Bot.makeLog('error', `[默认配置解析失败][${file}]`, 'Config', error);
        this.config[key] = {};
      }
    } else {
      this.config[key] = {};
    }
    return this.config[key];
  }

  /**
   * 获取服务器配置（仅 data 层，不合并 default_config；运行时用 getMergedConfig）
   * @param {string} name - 配置名称
   */
  getConfig(name) {
    if (this._port == null || this._port === undefined) {
      return this.getdefSet(name);
    }

    const key = `server.${this._port}.${name}`;
    if (this.config[key]) return this.config[key];

    const relPath = getServerConfigPath(this._port, name);
    if (relPath.startsWith(`${DEFAULT_CONFIG_DIR}/`)) {
      return this.getdefSet(name);
    }

    const file = resolveProjectPath(relPath);
    const defaultFile = resolveProjectPath(getServerConfigPath(null, name));

    const content = FileUtils.readFileSync(file);
    if (content) {
      try {
        this.config[key] = YAML.parse(content);
        this.watch(file, name, key);
        return this.config[key];
      } catch (error) {
        Bot.makeLog('error', `[配置文件解析失败][${file}]`, 'Config', error);
      }
    }

    const defaultContent = FileUtils.readFileSync(defaultFile);
    if (defaultContent) {
      try {
        const defaultConfig = YAML.parse(defaultContent);
        this.config[key] = defaultConfig;
        FileUtils.ensureDirSync(path.dirname(file));
        FileUtils.writeFileSync(file, YAML.stringify(defaultConfig));
        this.watch(file, name, key);
        return this.config[key];
      } catch (error) {
        Bot.makeLog('error', `[默认配置复制失败][${name}]`, 'Config', error);
      }
    }

    this.config[key] = {};
    return this.config[key];
  }

  /**
   * 获取群组配置
   * @param {string|number} groupId - 群组ID
   */
  getGroup(groupId = '') {
    const config = this.getConfig('group');
    const defCfg = this.getdefSet('group');
    const groupIdStr = String(groupId);

    if (groupIdStr && config[groupIdStr]) {
      return { ...defCfg.default, ...config.default, ...config[groupIdStr] };
    }

    return { ...defCfg.default, ...config.default };
  }

  /**
   * 设置并保存配置（与 XRK-AGT 对齐：全局配置写 server_bots 根，端口级写 server_bots/{port}/）
   * @param {string} name - 配置名称
   * @param {object} data - 要保存的数据
   */
  setConfig(name, data) {
    const port = this._port;
    if (port == null) {
      Bot.makeLog('error', `[配置保存失败][${name}] 未设置端口，禁止写入默认模板`, 'Config');
      return false;
    }
    const key = `server.${port}.${name}`;
    const relPath = getServerConfigPath(port, name);
    const file = resolveProjectPath(relPath);

    const dir = path.dirname(file);
    if (!FileUtils.existsSync(dir)) {
      FileUtils.ensureDirSync(dir);
    }

    this.config[key] = data;

    if (FileUtils.writeFileSync(file, YAML.stringify(data))) {
      Bot.makeLog('mark', `[保存配置文件][${name}]`, 'Config');
      return true;
    }

    Bot.makeLog('error', `[配置保存失败][${name}]`, 'Config');
    return false;
  }

  /**
   * 更新other配置
   * @param {object} data - 要更新的数据
   */
  setOther(data) {
    return this.setConfig('other', data);
  }

  /**
   * 更新group配置
   * @param {object} data - 要更新的数据
   */
  setGroup(data) {
    return this.setConfig('group', data);
  }

  /**
   * 清除指定配置的缓存（供 CommonConfig 保存后调用，确保 LLMFactory 等读取到最新数据）
   * @param {string} name - 配置名称（如 openai_compat_llm）
   */
  clearConfig(name) {
    if (!name) return;
    const serverKey = `server.${this._port}.${name}`;
    delete this.config[serverKey];
  }

  /**
   * 监控配置文件变化
   * @param {string} file - 文件路径
   * @param {string} name - 配置名称
   * @param {string} key - 缓存键
   */
  watch(file, name, key) {
    if (this.watcher[key]) return;

    const watcher = HotReloadBase.createWatcher(file, {
      onChange: () => {
        if (Date.now() - this._startTime < this._initGracePeriod) {
          return;
        }

        delete this.config[key];

        Bot.makeLog('mark', `[修改配置文件][${name}]`, 'Config');

        if (this[`change_${name}`]) {
          this[`change_${name}`]();
        }
      }
    });

    this.watcher[key] = watcher;
  }

  /**
   * Bot配置变更处理
   */
  async change_bot() {
    try {
      const log = await import('./log.js');
      log.default();
    } catch (error) {
      Bot.makeLog('error', '[Bot配置变更处理失败]', 'Config', error);
    }
  }

  /**
   * 销毁所有文件监控器
   */
  destroy() {
    for (const key in this.watcher) {
      this.watcher[key]?.close();
    }
    this.watcher = {};
    this.config = {};
  }
}

export default new Cfg();