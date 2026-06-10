import chokidar from 'chokidar';
import path from 'path';
import crypto from 'crypto';
import lodash from 'lodash';
import BotUtil from '../util.js';
import { FileUtils } from './file-utils.js';

/** 默认忽略：隐藏文件、依赖目录（避免 node_modules 循环符号链接 ELOOP） */
const DEFAULT_IGNORED = [
  /(^|[/\\])\../,
  /(^|[/\\])node_modules([/\\]|$)/,
];

/** 监视器可忽略的 FS 错误（目录重建、坏链等），只记一次 debug */
const BENIGN_WATCH_ERRORS = new Set(['EPERM', 'ELOOP', 'ENOENT']);

/**
 * 热重载基类：统一 chokidar 监视、debounce、内容哈希去重
 */
export class HotReloadBase {
  constructor(options = {}) {
    this.loggerName = options.loggerName || 'HotReload';
    this.watcher = null;
  }

  getFileKey(filePath) {
    return path.basename(filePath, path.extname(filePath));
  }

  /**
   * 创建 chokidar 监听器（PluginsLoader / Renderer 等复用）
   * @param {string|string[]} patterns
   * @param {Object} handlers - { onAdd?, onChange?, onUnlink?, onError? }
   * @param {Object} [options]
   * @param {number} [options.debounceMs=0]
   * @param {Object} [options.awaitWriteFinish]
   * @param {RegExp} [options.ignored]
   * @param {Object|null} [options.hashStore] - 内容 MD5 去重 Map
   * @param {Function} [options.hashKeyFn]
   * @param {string} [options.loggerName]
   * @returns {import('chokidar').FSWatcher}
   */
  static createWatcher(patterns, handlers = {}, options = {}) {
    const {
      debounceMs = 0,
      awaitWriteFinish = { stabilityThreshold: 300, pollInterval: 100 },
      ignored = DEFAULT_IGNORED,
      ignoreInitial = true,
      persistent = true,
      hashStore = null,
      hashKeyFn = (filePath) => filePath,
      loggerName = 'HotReload'
    } = options;

    const watcher = chokidar.watch(patterns, {
      persistent,
      ignoreInitial,
      ignored,
      awaitWriteFinish
    });

    const wrap = (fn) => (debounceMs > 0 ? lodash.debounce(fn, debounceMs) : fn);

    const shouldProcessChange = async (filePath) => {
      if (!hashStore) return true;
      const content = await FileUtils.readFile(filePath, 'utf8');
      if (content === null) return false;
      const hash = crypto.createHash('md5').update(content).digest('hex');
      const key = hashKeyFn(filePath);
      if (hashStore[key] === hash) return false;
      hashStore[key] = hash;
      return true;
    };

    if (handlers.onChange) {
      watcher.on('change', wrap(async (filePath) => {
        try {
          if (!(await shouldProcessChange(filePath))) return;
          await handlers.onChange(filePath);
        } catch (error) {
          BotUtil.makeLog('error', `文件变更处理失败: ${filePath}`, loggerName, error);
        }
      }));
    }

    if (handlers.onAdd) {
      watcher.on('add', wrap(async (filePath) => {
        try {
          await handlers.onAdd(filePath);
        } catch (error) {
          BotUtil.makeLog('error', `文件添加处理失败: ${filePath}`, loggerName, error);
        }
      }));
    }

    if (handlers.onUnlink) {
      watcher.on('unlink', wrap(async (filePath) => {
        try {
          await handlers.onUnlink(filePath);
        } catch (error) {
          BotUtil.makeLog('error', `文件删除处理失败: ${filePath}`, loggerName, error);
        }
      }));
    }

    const benignNotified = new Set();
    watcher.on('error', (error) => {
      const code = error?.code;
      if (code && BENIGN_WATCH_ERRORS.has(code)) {
        if (!benignNotified.has(code)) {
          benignNotified.add(code);
          const hint = code === 'ELOOP'
            ? 'node_modules 可能存在循环符号链接，已默认忽略 node_modules'
            : '目录可能被占用、正在重建或已删除';
          BotUtil.makeLog(
            'debug',
            `文件监视 ${code}（${hint}，可忽略）: ${Array.isArray(patterns) ? patterns.join(', ') : patterns}`,
            loggerName
          );
        }
        return;
      }
      if (handlers.onError) handlers.onError(error);
      else BotUtil.makeLog('error', '文件监视错误', loggerName, error);
    });

    return watcher;
  }

  /**
   * 启动目录监视（单 watcher，多目录）
   * @param {boolean} enable
   * @param {Object} options
   */
  async watch(enable, options = {}) {
    if (!enable) {
      if (this.watcher) {
        await this.watcher.close();
        this.watcher = null;
      }
      return;
    }

    if (this.watcher) return;

    const { dirs = [], debounceMs = 0, onAdd, onChange, onUnlink } = options;
    if (dirs.length === 0) return;

    this.watcher = HotReloadBase.createWatcher(dirs, { onAdd, onChange, onUnlink }, {
      debounceMs,
      loggerName: this.loggerName,
      awaitWriteFinish: options.awaitWriteFinish
    });

    BotUtil.makeLog('debug', `文件监视已启动: ${dirs.join(', ')}`, this.loggerName);
  }

  static _isJsFile(filePath, jsOnly) {
    return !jsOnly || (typeof filePath === 'string' && filePath.endsWith('.js'));
  }

  /**
   * 监视模块目录（ApiLoader / StreamLoader / ConfigLoader 共用）
   * @param {object} options
   * @param {boolean} [options.enable=true]
   * @param {string} [options.loggerName]
   * @param {string[]} [options.dirs]
   * @param {number} [options.debounceMs=300]
   * @param {boolean} [options.jsOnly=false]
   * @param {Function} [options.onAdd]
   * @param {Function} [options.onChange]
   * @param {Function} [options.onUnlink]
   * @returns {Promise<import('chokidar').FSWatcher|null>}
   */
  static async watchModuleDirs(options = {}) {
    const {
      enable = true,
      loggerName = 'HotReload',
      dirs = [],
      debounceMs = 300,
      jsOnly = false,
      onAdd,
      onChange,
      onUnlink,
    } = options;

    if (!enable) return null;
    if (!dirs.length) {
      BotUtil.makeLog('debug', '未找到监视目录，跳过文件监视', loggerName);
      return null;
    }

    const wrap = (fn) => (fn
      ? async (filePath) => {
        if (!HotReloadBase._isJsFile(filePath, jsOnly)) return;
        await fn(path.resolve(filePath));
      }
      : undefined);

    const hotReload = new HotReloadBase({ loggerName });
    await hotReload.watch(true, {
      dirs,
      debounceMs,
      onAdd: wrap(onAdd),
      onChange: wrap(onChange),
      onUnlink: wrap(onUnlink),
    });
    BotUtil.makeLog('info', '文件监视已启动', loggerName);
    return hotReload.watcher;
  }
}

export default HotReloadBase;
