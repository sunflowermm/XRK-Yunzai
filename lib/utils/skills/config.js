import { DEFAULT_SKILL_LIMITS } from './defaults.js';

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function uniqueList(list) {
  return [...new Set(list)];
}

export function resolveSkillRoots(cfg = {}) {
  const customSkillRoots = normalizeStringList(cfg.customSkillRoots);
  return uniqueList(customSkillRoots);
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
