import path from 'node:path';
import { DEFAULT_SKILL_LIMITS } from './defaults.js';
import { WORKSPACE_SKILLS_DIR } from '../agent-workspace-paths.js';

/** 相对工作区根的技能目录（seed 自 skills/standard） */
export const DEFAULT_WORKSPACE_SKILL_ROOTS = Object.freeze([WORKSPACE_SKILLS_DIR]);

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function uniqueList(list) {
  return [...new Set(list)];
}

/**
 * @param {object} cfg
 * @param {string} [workspaceRoot] - 已解析的工作区绝对路径；相对根均相对此目录
 * @returns {string[]} 绝对路径列表
 */
export function resolveSkillRoots(cfg = {}, workspaceRoot = '') {
  const customSkillRoots = normalizeStringList(cfg.customSkillRoots);
  const rels = customSkillRoots.length ? customSkillRoots : [...DEFAULT_WORKSPACE_SKILL_ROOTS];
  const ws = workspaceRoot ? path.resolve(workspaceRoot) : '';
  const resolved = rels.map((rel) => {
    if (path.isAbsolute(rel)) return path.normalize(rel);
    if (ws) return path.join(ws, rel);
    return rel;
  });
  return uniqueList(resolved);
}

export function resolveSkillLimits(cfg = {}) {
  return {
    maxCandidatesPerRoot: cfg.maxCandidatesPerRoot ?? DEFAULT_SKILL_LIMITS.maxCandidatesPerRoot,
    maxSkillsLoadedPerSource: cfg.maxSkillsLoadedPerSource ?? DEFAULT_SKILL_LIMITS.maxSkillsLoadedPerSource,
    maxSkillsInPrompt: cfg.maxSkillsInPrompt ?? DEFAULT_SKILL_LIMITS.maxSkillsInPrompt,
    maxSkillsPromptChars: cfg.maxSkillsPromptChars ?? DEFAULT_SKILL_LIMITS.maxSkillsPromptChars,
    maxSkillFileBytes: cfg.maxSkillFileBytes ?? DEFAULT_SKILL_LIMITS.maxSkillFileBytes,
  };
}
