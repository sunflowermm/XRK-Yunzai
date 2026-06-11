import path from 'path';
import { FileUtils } from './file-utils.js';
import { PLUGINS_DIR, RENDERERS_DIR, resolveProjectPath } from '../config/config-constants.js';

/**
 * 统一扫描 plugins/<插件名>/<子目录>/ 与 plugins/<子目录>/（共享目录）
 */
export class PluginDirScanner {
  /**
   * @param {string} subdir - 子目录名，如 http、stream、events、adapter
   * @param {object} [options]
   * @param {string} [options.pluginsRoot]
   * @returns {Array<{ pluginName: string, dir: string }>}
   */
  static scanSubdirs(subdir, options = {}) {
    const pluginsRoot = path.resolve(options.pluginsRoot ?? resolveProjectPath(PLUGINS_DIR));
    const results = [];
    if (!FileUtils.existsSync(pluginsRoot)) return results;

    for (const entry of FileUtils.readDirSync(pluginsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.resolve(pluginsRoot, entry.name, subdir);
      if (!FileUtils.existsSync(dir)) continue;
      results.push({ pluginName: entry.name, dir });
    }
    return results;
  }

  /**
   * @param {string} subdir
   * @param {string} [pluginsRoot]
   * @returns {string[]}
   */
  static listSubdirPaths(subdir, pluginsRoot) {
    return this.scanSubdirs(subdir, { pluginsRoot }).map((e) => e.dir);
  }

  /**
   * 工作流目录：仅 plugins/<名>/stream/（规范不扫 streams/）
   * @param {string} [pluginsRoot]
   * @returns {string[]}
   */
  static listStreamDirs(pluginsRoot) {
    const root = path.resolve(pluginsRoot ?? resolveProjectPath(PLUGINS_DIR));
    if (!FileUtils.existsSync(root)) return [];
    const dirs = [];
    for (const entry of FileUtils.readDirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.resolve(root, entry.name, 'stream');
      if (FileUtils.existsSync(dir)) dirs.push(dir);
    }
    return dirs;
  }

  /**
   * plugins/<插件名>/ 根目录列表
   * @param {string} [pluginsRoot]
   * @returns {string[]}
   */
  static listPluginRoots(pluginsRoot) {
    const root = path.resolve(pluginsRoot ?? resolveProjectPath(PLUGINS_DIR));
    if (!FileUtils.existsSync(root)) return [];
    return FileUtils.readDirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.resolve(root, e.name));
  }

  /**
   * plugins/<subdir>/ 共享目录（如 plugins/adapter/）
   * @param {string} subdir
   * @param {string} [pluginsRoot]
   * @returns {string|null}
   */
  static getSharedSubdir(subdir, pluginsRoot) {
    const dir = path.resolve(pluginsRoot ?? resolveProjectPath(PLUGINS_DIR), subdir);
    return FileUtils.existsSync(dir) ? dir : null;
  }

  /**
   * 列举目录下 .js 文件（非递归）
   * @param {string} dir
   * @param {object} [options]
   * @param {string[]} [options.exclude] - 文件名需排除的子串
   * @returns {string[]}
   */
  static listJsFiles(dir, options = {}) {
    const exclude = options.exclude ?? ['.test.', '.spec.'];
    if (!FileUtils.existsSync(dir)) return [];
    return FileUtils.readDirSync(dir, { withFileTypes: true })
      .filter((e) => {
        if (!e.isFile() || !e.name.endsWith('.js') || e.name.startsWith('.')) return false;
        return !exclude.some((pat) => e.name.includes(pat));
      })
      .map((e) => path.resolve(dir, e.name));
  }

  /**
   * 协议适配器 .js 入口：plugins/adapter/ 与 plugins/<名>/adapter/
   * @param {string} [pluginsRoot]
   * @returns {string[]}
   */
  static listAdapterFiles(pluginsRoot) {
    const files = [];
    const shared = this.getSharedSubdir('adapter', pluginsRoot);
    if (shared) files.push(...this.listJsFiles(shared));
    for (const { dir } of this.scanSubdirs('adapter', { pluginsRoot })) {
      files.push(...this.listJsFiles(dir));
    }
    return files;
  }

  /**
   * 渲染器入口：renderers/<名>/index.js 与 plugins/<名>/renderer/index.js
   * @param {string} [cwd]
   * @returns {Array<{ name: string, rendererPath: string, configDir: string }>}
   */
  static listRendererEntries(cwd) {
    const projectRoot = cwd ?? resolveProjectPath();
    const results = [];
    const renderersRoot = path.resolve(projectRoot, RENDERERS_DIR);
    if (FileUtils.existsSync(renderersRoot)) {
      for (const entry of FileUtils.readDirSync(renderersRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const configDir = path.join(renderersRoot, entry.name);
        results.push({
          name: entry.name,
          rendererPath: path.join(configDir, 'index.js'),
          configDir,
        });
      }
    }
    for (const pluginRoot of this.listPluginRoots(path.join(projectRoot, PLUGINS_DIR))) {
      const rendererDir = path.join(pluginRoot, 'renderer');
      if (!FileUtils.existsSync(rendererDir)) continue;
      results.push({
        name: path.basename(pluginRoot),
        rendererPath: path.join(rendererDir, 'index.js'),
        configDir: rendererDir,
      });
    }
    return results;
  }
}

export default PluginDirScanner;
