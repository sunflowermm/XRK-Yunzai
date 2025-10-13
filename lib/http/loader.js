// http/loader.js
import path from 'node:path';
import fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import HttpApi from './http.js';
import BotUtil from '../common/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class ApiLoader {
  constructor() {
    /** @type {Map<string, HttpApi>} */
    this.apis = new Map();
    /** @type {Array<HttpApi>} */
    this.priority = [];
    /** @type {Record<string, any>} */
    this.watcher = {};
    this.loaded = false;
    this.fastify = null;
    this.bot = null;
    /** @type {Map<string, Array>} 路由映射（留作扩展） */
    this.routeMap = new Map();
  }

  async load() {
    const start = Date.now();
    BotUtil.makeLog('mark', '━━━━━ 开始加载API模块 ━━━━━', 'ApiLoader');

    const apiDir = path.join(process.cwd(), 'plugins/api');
    try {
      await fs.mkdir(apiDir, { recursive: true });
      const files = await this.getApiFiles(apiDir);

      if (files.length === 0) {
        BotUtil.makeLog('warn', '未找到任何API模块文件', 'ApiLoader');
        this.loaded = true;
        return this.apis;
      }

      let successCount = 0;
      let failCount = 0;

      for (const file of files) {
        const ok = await this.loadApi(file);
        if (ok) successCount++; else failCount++;
      }

      this.sortByPriority();
      this.loaded = true;
      const cost = Date.now() - start;

      BotUtil.makeLog('info', `✓ 加载完成: ${successCount} 成功, ${failCount} 失败, 耗时 ${cost}ms`, 'ApiLoader');
      BotUtil.makeLog('mark', '━━━━━━━━━━━━━━━━━━━━━━━', 'ApiLoader');
      return this.apis;
    } catch (e) {
      BotUtil.makeLog('error', `加载失败: ${e.message}`, 'ApiLoader');
      throw e;
    }
  }

  async getApiFiles(dir, fileList = []) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
        await this.getApiFiles(full, fileList);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        if (!entry.name.startsWith('.') && !entry.name.startsWith('_')) fileList.push(full);
      }
    }
    return fileList;
  }

  async loadApi(filePath) {
    try {
      const key = path.relative(path.join(process.cwd(), 'plugins/api'), filePath).replace(/\\/g, '/').replace(/\.js$/, '');
      if (this.apis.has(key)) await this.unloadApi(key);

      const fileUrl = `file://${filePath}?t=${Date.now()}`;
      const mod = await import(fileUrl);
      if (!mod.default) {
        BotUtil.makeLog('warn', `✗ 无效模块: ${key} (缺少 default 导出)`, 'ApiLoader');
        return false;
      }

      let apiInstance;
      if (typeof mod.default === 'function') {
        try { apiInstance = new mod.default(); }
        catch { BotUtil.makeLog('warn', `✗ 无法实例化: ${key}`, 'ApiLoader'); return false; }
      } else if (typeof mod.default === 'object' && mod.default !== null) {
        apiInstance = new HttpApi(mod.default);
      } else {
        BotUtil.makeLog('warn', `✗ 导出类型错误: ${key}`, 'ApiLoader');
        return false;
      }

      if (!(apiInstance instanceof HttpApi)) {
        if (typeof apiInstance.getInfo !== 'function') {
          apiInstance.getInfo = function () {
            return {
              name: this.name || key,
              dsc: this.dsc || '暂无描述',
              priority: this.priority || 100,
              routes: this.routes ? this.routes.length : 0,
              enable: this.enable !== false,
              createTime: this.createTime || Date.now()
            };
          };
        }
      }

      apiInstance.key = key;
      apiInstance.filePath = filePath;
      this.apis.set(key, apiInstance);

      const info = apiInstance.getInfo();
      const flag = info.enable !== false ? '✓' : '○';
      BotUtil.makeLog('debug', `${flag} 加载: ${info.name} [优先级:${info.priority}] [路由:${info.routes || 0}]`, 'ApiLoader');
      return true;
    } catch (e) {
      const rel = path.relative(process.cwd(), filePath);
      BotUtil.makeLog('error', `✗ 加载失败: ${rel}`, 'ApiLoader');
      BotUtil.makeLog('error', e.message, 'ApiLoader');
      return false;
    }
  }

  async unloadApi(key) {
    const api = this.apis.get(key);
    if (!api) return false;
    try {
      if (typeof api.stop === 'function') await api.stop();
      this.routeMap.delete(key);
      this.apis.delete(key);
      BotUtil.makeLog('debug', `✓ 卸载: ${api.name || key}`, 'ApiLoader');
      return true;
    } catch {
      BotUtil.makeLog('error', `✗ 卸载失败: ${api.name || key}`, 'ApiLoader');
      return false;
    }
  }

  sortByPriority() {
    this.priority = Array.from(this.apis.values())
      .filter(a => a && a.enable !== false)
      .sort((a, b) => (b.priority || 100) - (a.priority || 100));
    BotUtil.makeLog('debug', `✓ 排序完成: ${this.priority.length} 个活动API`, 'ApiLoader');
  }

  async register(fastify, bot) {
    this.fastify = fastify;
    this.bot = bot;

    BotUtil.makeLog('mark', '━━━━━ 开始注册API路由 ━━━━━', 'ApiLoader');

    let registeredCount = 0, skippedCount = 0, failedCount = 0;

    for (const api of this.priority) {
      try {
        if (!api || api.enable === false) { skippedCount++; continue; }
        const apiName = api.name || api.key || 'undefined';

        if (typeof api.init === 'function') {
          await fastify.register(async (f) => { await api.init(f, bot); }, { prefix: api.prefix || '' });
          registeredCount++;
          const info = api.getInfo();
          BotUtil.makeLog('info', `✓ 注册: ${apiName} [优先级:${info.priority}] [路由:${info.routes || 0}]`, 'ApiLoader');
        } else {
          BotUtil.makeLog('warn', `✗ API缺少init方法: ${apiName}`, 'ApiLoader');
          failedCount++;
        }
      } catch (e) {
        const apiName = api?.name || api?.key || 'undefined';
        BotUtil.makeLog('error', `✗ 注册失败: ${apiName}`, 'ApiLoader');
        BotUtil.makeLog('error', e.message, 'ApiLoader');
        failedCount++;
      }
    }

    BotUtil.makeLog('info', `✓ 注册完成: ${registeredCount} 成功, ${skippedCount} 跳过, ${failedCount} 失败`, 'ApiLoader');
    BotUtil.makeLog('mark', '━━━━━━━━━━━━━━━━━━━━━━━', 'ApiLoader');
  }

  async changeApi(key) {
    const api = this.apis.get(key);
    if (!api) {
      BotUtil.makeLog('warn', `✗ API不存在: ${key}`, 'ApiLoader');
      return false;
    }
    try {
      const apiName = api.name || key;
      BotUtil.makeLog('info', `⟳ 重载中: ${apiName}`, 'ApiLoader');
      const ok = await this.loadApi(api.filePath);
      if (!ok) {
        BotUtil.makeLog('error', `✗ 重载失败: ${apiName} (加载失败)`, 'ApiLoader');
        return false;
      }
      this.sortByPriority();
      BotUtil.makeLog('warn', `⚠ ${apiName} 已重新加载，但路由需要重启服务器才能生效`, 'ApiLoader');
      BotUtil.makeLog('info', `✓ 重载成功: ${apiName}`, 'ApiLoader');
      return true;
    } catch (e) {
      const apiName = api?.name || key;
      BotUtil.makeLog('error', `✗ 重载失败: ${apiName}`, 'ApiLoader');
      BotUtil.makeLog('error', e.message, 'ApiLoader');
      return false;
    }
  }

  getApiList() {
    const list = [];
    for (const api of this.apis.values()) {
      if (!api) continue;
      try {
        if (typeof api.getInfo === 'function') list.push(api.getInfo());
        else list.push({
          name: api.name || api.key || 'undefined',
          dsc: api.dsc || '暂无描述',
          priority: api.priority || 100,
          routes: api.routes ? api.routes.length : 0,
          enable: api.enable !== false,
          createTime: api.createTime || Date.now(),
          key: api.key || ''
        });
      } catch (e) {
        BotUtil.makeLog('error', `获取API信息失败: ${api?.name || api?.key || 'undefined'}`, 'ApiLoader');
      }
    }
    return list.sort((a, b) => (b.priority || 100) - (a.priority || 100));
  }

  getApi(key) { return this.apis.get(key) || null; }
  hasApi(key) { return this.apis.has(key); }
  getApiKeys() { return Array.from(this.apis.keys()); }
  getEnabledCount() { return this.priority.length; }
  getTotalCount() { return this.apis.size; }
  isLoaded() { return this.loaded; }

  async watch(enable = true) {
    if (!enable) {
      for (const key of Object.keys(this.watcher)) {
        const w = this.watcher[key];
        if (w && typeof w.close === 'function') await w.close();
      }
      this.watcher = {};
      BotUtil.makeLog('info', '✓ 文件监视已停止', 'ApiLoader');
      return;
    }

    const apiDir = path.join(process.cwd(), 'plugins/api');
    try {
      const { watch } = await import('chokidar');
      this.watcher.api = watch(apiDir, {
        ignored: /(^|[\/\\])\../,
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
      });

      this.watcher.api.on('add', async (filePath) => {
        if (!filePath.endsWith('.js')) return;
        BotUtil.makeLog('info', `➕ 检测到新文件: ${path.basename(filePath)}`, 'ApiLoader');
        const ok = await this.loadApi(filePath);
        if (ok) {
          this.sortByPriority();
          BotUtil.makeLog('warn', '⚠ 新API已加载，需要重启服务器才能注册路由', 'ApiLoader');
        }
      });

      this.watcher.api.on('change', async (filePath) => {
        if (!filePath.endsWith('.js')) return;
        const key = path.relative(apiDir, filePath).replace(/\\/g, '/').replace(/\.js$/, '');
        BotUtil.makeLog('info', `📝 检测到文件修改: ${path.basename(filePath)}`, 'ApiLoader');
        await this.changeApi(key);
      });

      this.watcher.api.on('unlink', async (filePath) => {
        if (!filePath.endsWith('.js')) return;
        const key = path.relative(apiDir, filePath).replace(/\\/g, '/').replace(/\.js$/, '');
        BotUtil.makeLog('info', `🗑️  检测到文件删除: ${path.basename(filePath)}`, 'ApiLoader');
        await this.unloadApi(key);
        this.sortByPriority();
        BotUtil.makeLog('warn', '⚠ API已卸载，需要重启服务器才能移除路由', 'ApiLoader');
      });

      this.watcher.api.on('error', (error) => {
        BotUtil.makeLog('error', '文件监视错误', 'ApiLoader');
        BotUtil.makeLog('error', error.message, 'ApiLoader');
      });

      BotUtil.makeLog('info', '✓ 文件监视已启动', 'ApiLoader');
      BotUtil.makeLog('warn', '⚠ Fastify热重载受限，建议开发时使用nodemon等工具自动重启', 'ApiLoader');
    } catch (e) {
      BotUtil.makeLog('error', '启动文件监视失败', 'ApiLoader');
      BotUtil.makeLog('error', e.message, 'ApiLoader');
    }
  }

  getStats() {
    return {
      total: this.getTotalCount(),
      enabled: this.getEnabledCount(),
      disabled: this.getTotalCount() - this.getEnabledCount(),
      loaded: this.loaded,
      watching: Object.keys(this.watcher).length > 0
    };
  }

  async cleanup() {
    BotUtil.makeLog('info', '开始清理API资源...', 'ApiLoader');
    await this.watch(false);
    const keys = Array.from(this.apis.keys());
    for (const key of keys) await this.unloadApi(key);
    this.apis.clear();
    this.priority = [];
    this.routeMap.clear();
    this.loaded = false;
    this.fastify = null;
    this.bot = null;
    BotUtil.makeLog('info', '✓ API资源清理完成', 'ApiLoader');
  }
}

export default new ApiLoader();
