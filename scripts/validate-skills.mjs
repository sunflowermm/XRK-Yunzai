#!/usr/bin/env node
/**
 * 校验 .cursor/skills 下各 SKILL.md 的 YAML frontmatter（name、description）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsRoot = path.join(root, '.cursor', 'skills');

function parseFrontmatter(text) {
  const cleaned = text.replace(/^\uFEFF/, '');
  if (!cleaned.startsWith('---')) return null;
  const lines = cleaned.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const fm = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const idx = lines[i].indexOf(':');
    if (idx === -1) continue;
    const key = lines[i].slice(0, idx).trim();
    const val = lines[i].slice(idx + 1).trim();
    if (key) fm[key] = val;
  }
  return fm;
}

let failed = 0;
const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
for (const ent of entries) {
  if (!ent.isDirectory()) continue;
  const skillPath = path.join(skillsRoot, ent.name, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    console.error(`[skip] ${ent.name}: 无 SKILL.md`);
    continue;
  }
  const fm = parseFrontmatter(fs.readFileSync(skillPath, 'utf8'));
  if (!fm?.name || !fm?.description) {
    console.error(`[fail] ${skillPath}: 缺少 name 或 description frontmatter`);
    failed++;
    continue;
  }
  if (fm.name !== ent.name) {
    console.error(`[fail] ${skillPath}: name "${fm.name}" 与目录 "${ent.name}" 不一致`);
    failed++;
    continue;
  }
  console.log(`[ok] ${ent.name}`);
}

if (failed > 0) {
  process.exit(1);
}
console.log('validate-skills: 全部通过');
