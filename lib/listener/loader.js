import path from 'node:path';
import lodash from 'lodash';
import BotUtil from '../util.js';
import { FileUtils } from '../utils/file-utils.js';
import { PluginDirScanner } from '../utils/plugin-dir-scanner.js';
import { HotReloadBase } from '../utils/hot-reload-base.js';

/**
 * 事件与适配器加载器（支持 events 热重载）
 */
class ListenerLoader {
  loaded = false;
  watcher = null;
  /** 文件绝对路径 → 已注册的 Bot 监听绑定 */
  eventBindings = new Map();

  getEventDirs() {
    try {
      return PluginDirScanner.scanSubdirs('events');
    } catch (err) {
      BotUtil.makeLog('warn', '扫描插件 events 目录失败', 'ListenerLoader', err);
      return [];
    }
  }

  _bindInstance(instance) {
    const bindings = [];
    const mode = instance.once ? 'once' : 'on';

    const register = (type) => {
      const handlerKey = instance[type] ? type : 'execute';
      const handler = instance[handlerKey].bind(instance);
      const eventName = `${instance.prefix}${type}`;
      Bot[mode](eventName, handler);
      bindings.push({ event: eventName, handler });
    };

    if (lodash.isArray(instance.event)) {
      instance.event.forEach(register);
    } else {
      register(instance.event);
    }
    return bindings;
  }

  _unloadEventFile(filePath) {
    const normalized = path.resolve(filePath);
    const bindings = this.eventBindings.get(normalized);
    if (!bindings?.length) return;
    for (const { event, handler } of bindings) {
      Bot.off(event, handler);
    }
    this.eventBindings.delete(normalized);
  }

  async _loadEventFile(filePath, { cacheBust = false } = {}) {
    const normalized = path.resolve(filePath);
    this._unloadEventFile(normalized);

    const listener = await import(FileUtils.toImportUrl(normalized, { cacheBust }));
    if (!listener.default) return false;

    const instance = new listener.default();
    this.eventBindings.set(normalized, this._bindInstance(instance));
    return true;
  }

  async loadEvents() {
    if (this.loaded) return;

    BotUtil.makeLog('info', '加载监听事件中...', 'ListenerLoader');
    let eventCount = 0;

    try {
      for (const { dir } of this.getEventDirs()) {
        for (const filePath of PluginDirScanner.listJsFiles(dir)) {
          BotUtil.makeLog('debug', `加载监听事件 ${filePath}`, 'ListenerLoader');
          try {
            if (await this._loadEventFile(filePath)) eventCount++;
          } catch (err) {
            BotUtil.makeLog('error', `监听事件加载错误 ${filePath}`, 'ListenerLoader', err);
          }
        }
      }
    } catch (error) {
      BotUtil.makeLog('error', '加载事件目录失败', 'ListenerLoader', error);
    }

    this.loaded = true;
    BotUtil.makeLog('info', `加载监听事件[${eventCount}个]`, 'ListenerLoader');
  }

  async loadAdapters() {
    if (!process.argv.includes('server')) return;

    BotUtil.makeLog('info', '加载适配器中...', 'ListenerLoader');
    let adapterCount = 0;

    for (const adapter of Bot.adapter) {
      try {
        BotUtil.makeLog('debug', `加载适配器 ${adapter.name}(${adapter.id})`, 'ListenerLoader');
        await adapter.load();
        adapterCount++;
      } catch (err) {
        BotUtil.makeLog('error', `适配器加载错误 ${adapter.name}(${adapter.id})`, 'ListenerLoader', err);
      }
    }

    BotUtil.makeLog('info', `加载适配器[${adapterCount}个]`, 'ListenerLoader');
  }

  async watch(enable = true) {
    if (!enable) {
      if (this.watcher) {
        await this.watcher.close();
        this.watcher = null;
      }
      BotUtil.makeLog('info', '事件监视已停止', 'ListenerLoader');
      return;
    }

    if (this.watcher) return;

    const dirs = this.getEventDirs().map(({ dir }) => dir);
    if (!dirs.length) return;

    this.watcher = await HotReloadBase.watchModuleDirs({
      loggerName: 'ListenerLoader',
      dirs,
      debounceMs: 300,
      jsOnly: true,
      onAdd: async (filePath) => {
        BotUtil.makeLog('debug', `检测到新事件文件: ${path.basename(filePath)}`, 'ListenerLoader');
        try {
          await this._loadEventFile(filePath, { cacheBust: true });
        } catch (err) {
          BotUtil.makeLog('error', `热加载事件失败 ${filePath}`, 'ListenerLoader', err);
        }
      },
      onChange: async (filePath) => {
        BotUtil.makeLog('debug', `检测到事件文件变更: ${path.basename(filePath)}`, 'ListenerLoader');
        try {
          await this._loadEventFile(filePath, { cacheBust: true });
        } catch (err) {
          BotUtil.makeLog('error', `热重载事件失败 ${filePath}`, 'ListenerLoader', err);
        }
      },
      onUnlink: async (filePath) => {
        BotUtil.makeLog('debug', `检测到事件文件删除: ${path.basename(filePath)}`, 'ListenerLoader');
        this._unloadEventFile(filePath);
      },
    });
  }

  async load() {
    await this.loadEvents();
    await this.loadAdapters();
  }
}

export default new ListenerLoader();
