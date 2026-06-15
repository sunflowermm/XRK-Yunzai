import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const SYSTEM_PLUGIN_DIR = path.join(root, 'plugins', 'system-plugin');

/** 框架基准：与 git 入库的 system-plugin 各子目录 .js 数量一致 */
export const SYSTEM_PLUGIN_BASELINE = Object.freeze({
  http: 10,
  stream: 7,
  plugin: 12,
  events: 5,
  adapter: 5,
});

/**
 * @param {'http'|'stream'|'plugin'|'events'|'adapter'} subdir
 * @returns {string[]} 相对路径或 basename 列表（仅 .js）
 */
export function listSystemPluginJs(subdir) {
  const glob = `plugins/system-plugin/${subdir}/*.js`;
  try {
    const out = execSync(`git ls-files -z -- "${glob}"`, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\0')
      .filter(Boolean)
      .map((p) => path.basename(p.replace(/^"|"$/g, '')));
  } catch {
    const dir = path.join(SYSTEM_PLUGIN_DIR, subdir);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  }
}

export function systemPluginStreamBasenames() {
  return listSystemPluginJs('stream').map((f) => f.replace(/\.js$/, ''));
}
