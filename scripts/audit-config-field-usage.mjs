/**
 * 粗粒度审计：default_config yaml 字段是否在 lib/plugins 代码中有引用痕迹
 * 用法：node scripts/audit-config-field-usage.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { fileURLToPath } from 'node:url';
import { GLOBAL_CONFIG_NAMES, PORT_CONFIG_NAMES } from '../lib/config/config-constants.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanRoots = ['lib', 'plugins'].map((d) => path.join(root, d));

function collectCode() {
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === 'www') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(ent.name)) files.push(p);
    }
  };
  for (const d of scanRoots) walk(d);
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

function collectYamlKeys(obj, prefix = '') {
  const keys = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return keys;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    keys.push(p);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...collectYamlKeys(v, p));
    }
  }
  return keys;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {string} fieldPath relative to config root */
function hasCodeReference(fieldPath, configName, code) {
  const leaf = fieldPath.split('.').pop();
  const candidates = new Set([
    fieldPath,
    `${configName}.${fieldPath}`,
    `server.${fieldPath}`,
    `cfg.${configName}`,
    leaf
  ]);

  if (configName === 'server') {
    candidates.add(`cfg.server.${fieldPath}`);
    candidates.add(`server.${fieldPath}`);
  }
  if (configName === 'aistream') {
    candidates.add(`getCrawlConfigSection().${fieldPath}`);
    candidates.add(fieldPath.replace(/^crawl\./, ''));
  }
  if (configName === 'monitor') {
    candidates.add(`monitorConfig.${fieldPath}`);
    candidates.add(`config?.${fieldPath.split('.')[0]}`);
  }

  for (const c of candidates) {
    if (!c || c.length < 2) continue;
    if (code.includes(c)) return true;
    if (new RegExp(escapeRe(c)).test(code)) return true;
  }
  return false;
}

const code = collectCode();
const names = [...PORT_CONFIG_NAMES, ...GLOBAL_CONFIG_NAMES];
const unused = [];
const used = [];

for (const name of names) {
  const yamlFile = path.join(root, 'config/default_config', `${name}.yaml`);
  const data = yaml.parse(fs.readFileSync(yamlFile, 'utf8'));
  for (const keyPath of collectYamlKeys(data)) {
    const full = `${name}.${keyPath}`;
    if (hasCodeReference(keyPath, name, code)) used.push(full);
    else unused.push(full);
  }
}

console.log(`Checked ${used.length + unused.length} yaml field paths`);
console.log(`Used (heuristic): ${used.length}`);
console.log(`Uncertain / no direct ref: ${unused.length}\n`);

if (unused.length) {
  console.log('=== Fields with weak or no code reference ===');
  for (const u of unused.sort()) console.log(`  ? ${u}`);
}
