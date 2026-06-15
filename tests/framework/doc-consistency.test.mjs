import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 允许描述「已废弃」表述的文档（审计清单、changelog 等） */
const DEPRECATION_DOCS_ALLOWLIST = new Set([
  'docs/文档审查清单.md',
  'docs/框架测试指南.md',
  'CHANGELOG.md',
  '.cursor/skills/xrk-docs-audit/SKILL.md',
  '.cursor/skills/xrk-framework-tests/SKILL.md',
  'docs/runtime-surface.md',
]);

const DOC_FILES = [
  'README.md',
  'AGENTS.md',
  'USER_GUIDE.md',
  'docs/base-classes.md',
  'docs/BASE_CLASSES.md',
  'docs/FACTORY.md',
  'docs/ARCHITECTURE.md',
  'docs/coding-style.md',
  'docs/runtime-surface.md',
  'docs/WORKFLOW_BASE_CLASS.md',
  'docs/reference/DEVICE.md',
  'plugins/system-plugin/SYSTEM-PLUGIN.md',
  '.cursor/skills/xrk-base-layer/SKILL.md',
  '.cursor/skills/xrk-coding-style/SKILL.md',
  '.cursor/skills/xrk-plugin-development/SKILL.md',
  '.cursor/skills/xrk-workflow-stream/SKILL.md',
  '.cursor/skills/xrk-http-api/SKILL.md',
  '.cursor/skills/xrk-config-commonconfig/SKILL.md',
  '.cursor/skills/xrk-project-overview/SKILL.md',
];

const FORBIDDEN_PATTERNS = [
  { name: 'streams 工作流目录（正向错误）', re: /或\s+`?streams\/`?|streams\/\*\.js/ },
  { name: 'stream/device 语音工作流文件', re: /stream\/device\.js/ },
  { name: 'ASRFactory', re: /ASRFactory/ },
  { name: 'TTSFactory', re: /TTSFactory/ },
  { name: 'volcengine_asr 配置', re: /volcengine_asr/ },
  { name: 'volcengine_tts 配置', re: /volcengine_tts/ },
  { name: 'asr_interim WS', re: /asr_interim/ },
  { name: 'play_tts_audio', re: /play_tts_audio/ },
  { name: 'stream 目录列举 device 工作流', re: /stream\/.*chat\/device|chat\/device\/…/ },
];

function readIfExists(rel) {
  const p = path.join(root, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

describe('文档一致性（禁止过时表述）', () => {
  for (const rel of DOC_FILES) {
    describe(rel, () => {
      const text = readIfExists(rel);
      if (!text) {
        it('文件存在', () => assert.fail(`缺少文档: ${rel}`));
        return;
      }
      const allowDeprecation = DEPRECATION_DOCS_ALLOWLIST.has(rel);
      for (const { name, re } of FORBIDDEN_PATTERNS) {
        it(`不含 ${name}`, () => {
          if (allowDeprecation && /ASR|TTS|stream\/device|volcengine_asr|asr_interim|play_tts/.test(name)) {
            return;
          }
          assert.ok(!re.test(text), `${rel} 仍含 ${name}`);
        });
      }
    });
  }
});

describe('Skills 结构', () => {
  const skillDir = path.join(root, '.cursor', 'skills');
  const skills = fs.readdirSync(skillDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('xrk-'));
  for (const ent of skills) {
    it(`${ent.name}/SKILL.md 含权威入口`, () => {
      const text = fs.readFileSync(path.join(skillDir, ent.name, 'SKILL.md'), 'utf8');
      assert.match(text, /权威(入口|文档)/);
    });
  }
});

describe('权威文档存在', () => {
  for (const rel of [
    'docs/coding-style.md',
    'docs/runtime-surface.md',
    'docs/框架测试指南.md',
    'docs/文档审查清单.md',
    '.cursor/skills/SKILL_INDEX.md',
  ]) {
    it(rel, () => {
      assert.ok(fs.existsSync(path.join(root, rel)), `缺少: ${rel}`);
    });
  }
});
