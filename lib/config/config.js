import YAML from 'yaml';
import path from 'path';
import { createRequire } from 'node:module';
import chokidar from 'chokidar';
import { FileUtils } from '../utils/file-utils.js';
import { PORT_CONFIG_FILES, DEFAULT_CONFIG_DIR, SERVER_BOTS_DIR, getServerConfigPath } from './config-constants.js';

const require = createRequire(import.meta.url);

/**
 * 配置管理类
 * 处理服务器配置的加载和更新
 */
class Cfg {
  constructor() {
    this.config = {};
    this._port = null;
    this.watcher = {};
    this._renderer = null;
    this._startTime = Date.now();
    this._initGracePeriod = 2000;

    const cwd = process.cwd();
    this.PATHS = {
      DEFAULT_CONFIG: path.join(cwd, DEFAULT_CONFIG_DIR),
      SERVER_BOTS: path.join(cwd, SERVER_BOTS_DIR),
      RENDERERS: 'renderers'
    };
    const portIndex = process.argv.indexOf('server');
    if (portIndex !== -1 && process.argv[portIndex + 1]) {
      this._port = parseInt(process.argv[portIndex + 1]);
    }

    if (this._port) {
      this.ensureServerConfigDir();
    }
  }

  /**
   * 确保 server_bots 根目录存在，并为当前端口仅复制端口级配置（port 目录内无全局配置 yaml）
   */
  ensureServerConfigDir() {
    const serverBotsRoot = path.join(process.cwd(), SERVER_BOTS_DIR);
    if (!FileUtils.existsSync(serverBotsRoot)) {
      FileUtils.ensureDirSync(serverBotsRoot);
    }
    this.ensurePortConfigs(this._port);
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
    const defbot = this.getdefSet('bot');
    const bot = this.getConfig('bot');
    const merged = { ...defbot, ...bot };

    merged.platform = 2;
    merged.data_dir = path.join(process.cwd(), 'data', 'server_bots', String(this._port));
    if (merged.server) {
      merged.server.port = this._port;
    }

    return merged;
  }

  /**
   * 其他配置快捷获取
   */
  get other() {
    const def = this.getdefSet('other');
    const config = this.getConfig('other');
    return { ...def, ...config };
  }

  get redis() {
    const def = this.getdefSet('redis');
    const config = this.getConfig('redis');
    return { ...def, ...config };
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
      const defaultContent = FileUtils.readFileSync(defaultFile);
      if (defaultContent) {
        try {
          config = YAML.parse(defaultContent);
        } catch (error) {
          logger.error(`[渲染器默认配置解析失败][${type}][${defaultFile}]`, error);
        }
      }

      if (serverDir) {
        FileUtils.ensureDirSync(serverDir);
        const serverContent = FileUtils.readFileSync(serverFile);
        if (serverContent) {
          try {
            config = { ...config, ...YAML.parse(serverContent) };
          } catch (error) {
            logger.error(`[渲染器服务器配置解析失败][${type}][${serverFile}]`, error);
          }
        } else {
          if (!FileUtils.writeFileSync(serverFile, YAML.stringify(config))) {
            logger.error(`[渲染器默认配置复制失败][${type}]`);
          }
        }
      }

      this._renderer[type] = config;

      if (serverFile && FileUtils.existsSync(serverFile)) {
        const watchKey = `renderer.${type}`;
        if (!this.watcher[watchKey]) {
          const watcher = chokidar.watch(serverFile, {
            persistent: true,
            ignoreInitial: true
          });
          watcher.on('change', () => {
            if (Date.now() - this._startTime < this._initGracePeriod) return;
            delete this._renderer[type];
            this._renderer = null;
            logger.mark(`[修改渲染器配置文件][${type}]`);
          });
          this.watcher[watchKey] = watcher;
        }
      }
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
    
    try {
      const Bot = require('../bot.js').default;
      if (Array.isArray(Bot?.uin)) {
        for (const botUin of Bot.uin) {
          masters[botUin] = masterList;
        }
      } else {
        const currentBotUin = this.bot.account?.uin ?? 'current_bot';
        masters[currentBotUin] = masterList;
      }
    } catch {
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
    this._package = JSON.parse(content);
    return this._package;
  }
  /** 当 aistream.enabled 为 false 时，StreamLoader 不加载工作流；此处仍返回合并配置供 LLMFactory 等使用。与 default_config/aistream.yaml、commonconfig aistream schema 对齐。 */
  get aistream() {
    const def = this.getdefSet('aistream') || {};
    const config = this.getConfig('aistream') || {};
    return { ...def, ...config };
  }

  /**
   * 获取LLM提供商配置（含内置与兼容工厂，与 LLMFactory 对齐）
   * @param {string} provider - 提供商名称（如 'openai', 'openai-cn', 'anthropic' 等）
   * @returns {Object} 配置对象
   */
  getLLMConfig(provider) {
    if (!provider) return {};
    try {
      const LLMFactory = require('../factory/llm/LLMFactory.js').default;
      const resolved = LLMFactory?.getProviderConfig?.(provider);
      if (resolved && typeof resolved === 'object') {
        const { _clientClass, ...rest } = resolved;
        return rest;
      }
    } catch {}
    const name = `${String(provider).toLowerCase()}_llm`;
    const def = this.getdefSet(name);
    const config = this.getConfig(name);
    return { ...def, ...config };
  }

  /** 获取 ASR 配置（用于 ASRFactory.createClient），缺省 provider 时为 volcengine */
  getASRConfig() {
    const def = this.getdefSet('volcengine_asr');
    const config = this.getConfig('volcengine_asr');
    return { provider: 'volcengine', ...def, ...config };
  }

  /** 获取 TTS 配置（用于 TTSFactory.createClient），缺省 provider 时为 volcengine */
  getTTSConfig() {
    const def = this.getdefSet('volcengine_tts');
    const config = this.getConfig('volcengine_tts');
    return { provider: 'volcengine', ...def, ...config };
  }

  /**
   * 获取所有LLM配置的快捷getter
   * 动态从 LLMFactory.listProviders 获取已注册与兼容工厂的厂商配置
   */
  get llm() {
    try {
      const LLMFactory = require('../factory/llm/LLMFactory.js').default;
      if (LLMFactory?.listProviders) {
        const providers = LLMFactory.listProviders();
        const result = {};
        for (const provider of providers) {
          result[provider] = this.getLLMConfig(provider);
        }
        return result;
      }
    } catch (err) {
      logger.debug(`[LLM] 使用默认厂商列表: ${err?.message || err}`);
    }
    return {
      gptgod: this.getLLMConfig('gptgod'),
      volcengine: this.getLLMConfig('volcengine'),
      xiaomimimo: this.getLLMConfig('xiaomimimo'),
      openai: this.getLLMConfig('openai'),
      gemini: this.getLLMConfig('gemini'),
      anthropic: this.getLLMConfig('anthropic'),
      azure_openai: this.getLLMConfig('azure_openai')
    };
  }

  /**
   * 获取默认配置
   * @param {string} name - 配置名称
   */
  getdefSet(name) {
    const key = `default.${name}`;
    if (this.config[key]) return this.config[key];

    const file = path.join(process.cwd(), getServerConfigPath(null, name));
    const content = FileUtils.readFileSync(file);
    if (content) {
      try {
        this.config[key] = YAML.parse(content);
      } catch (error) {
        logger.error(`[默认配置解析失败][${file}]`, error);
        this.config[key] = {};
      }
    } else {
      this.config[key] = {};
    }
    return this.config[key];
  }

  /**
   * 获取服务器配置（不合并默认配置，由getter负责合并）
   * @param {string} name - 配置名称
   */
  getConfig(name) {
    const key = `server.${this._port}.${name}`;
    if (this.config[key]) return this.config[key];

    const file = path.join(process.cwd(), getServerConfigPath(this._port, name));
    const defaultFile = path.join(process.cwd(), getServerConfigPath(null, name));

    // 读取服务器配置
    const content = FileUtils.readFileSync(file);
    if (content) {
      try {
        this.config[key] = YAML.parse(content);
        this.watch(file, name, key);
        return this.config[key];
      } catch (error) {
        logger.error(`[配置文件解析失败][${file}]`, error);
      }
    }

    // 如果服务器配置不存在，尝试从默认配置复制
    const defaultContent = FileUtils.readFileSync(defaultFile);
    if (defaultContent) {
      try {
        const defaultConfig = YAML.parse(defaultContent);
        this.config[key] = defaultConfig;
        FileUtils.writeFileSync(file, YAML.stringify(defaultConfig));
        this.watch(file, name, key);
        return this.config[key];
      } catch (error) {
        logger.error(`[默认配置复制失败][${name}]`, error);
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
    const key = `server.${port}.${name}`;
    const relPath = getServerConfigPath(port, name);
    const file = path.join(process.cwd(), relPath);

    const dir = path.dirname(file);
    if (!FileUtils.existsSync(dir)) {
      FileUtils.ensureDirSync(dir);
    }

    this.config[key] = data;

    if (FileUtils.writeFileSync(file, YAML.stringify(data))) {
      logger.mark(`[保存配置文件][${name}]`);
      return true;
    }

    logger.error(`[配置保存失败][${name}]`);
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
   * 兼容性方法：某些旧代码可能错误地调用 getOther()，提供此方法避免错误
   * @deprecated 请使用 cfg.other 属性访问
   * @returns {Object} other 配置对象
   */
  getOther() {
    return this.other;
  }

  /**
   * 更新group配置
   * @param {object} data - 要更新的数据
   */
  setGroup(data) {
    return this.setConfig('group', data);
  }

  /**
   * 监控配置文件变化
   * @param {string} file - 文件路径
   * @param {string} name - 配置名称
   * @param {string} key - 缓存键
   */
  watch(file, name, key) {
    if (this.watcher[key]) return;

    const watcher = chokidar.watch(file, {
      persistent: true,
      ignoreInitial: true
    });

    watcher.on('change', () => {
      if (Date.now() - this._startTime < this._initGracePeriod) {
        return;
      }

      delete this.config[key];

      logger.mark(`[修改配置文件][${name}]`);

      if (this[`change_${name}`]) {
        this[`change_${name}`]();
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
      logger.error('[Bot配置变更处理失败]', error);
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