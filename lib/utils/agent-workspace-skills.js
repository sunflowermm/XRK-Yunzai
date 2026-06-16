/**
 * Agent Skills：发现 / 预算 / XML 注入（@mariozechner/pi-coding-agent）。
 */
import os from 'node:os';
import path from 'node:path';
import { formatSkillsForPrompt, loadSkillsFromDir } from '@mariozechner/pi-coding-agent';
import { FileUtils } from './file-utils.js';
import { isPathInside, realpathSyncOrResolve } from './path-guards.js';
import { resolveSkillLimits, resolveSkillRoots } from './skills/config.js';

function resolveContainedSkillPath({ rootRealPath, candidatePath }) {
  const candidateRealPath = realpathSyncOrResolve(candidatePath);
  if (!isPathInside(rootRealPath, candidateRealPath)) return null;
  return candidateRealPath;
}

function listChildDirectories(dir) {
  try {
    const entries = FileUtils.readDirSync(dir, { withFileTypes: true });
    const dirs = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(entry.name);
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          if (FileUtils.statSync(fullPath)?.isDirectory()) dirs.push(entry.name);
        } catch { /* broken symlink */ }
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

function resolveNestedSkillsRoot(dir, opts = {}) {
  const nested = path.join(dir, 'skills');
  try {
    if (!FileUtils.existsSync(nested) || !FileUtils.statSync(nested)?.isDirectory()) {
      return { baseDir: dir };
    }
  } catch {
    return { baseDir: dir };
  }

  const nestedDirs = listChildDirectories(nested);
  const scanLimit = Math.max(0, opts.maxEntriesToScan ?? 100);
  const toScan = scanLimit === 0 ? [] : nestedDirs.slice(0, Math.min(nestedDirs.length, scanLimit));

  for (const name of toScan) {
    const skillMd = path.join(nested, name, 'SKILL.md');
    if (FileUtils.existsSync(skillMd)) {
      return { baseDir: nested };
    }
  }
  return { baseDir: dir };
}

function unwrapLoadedSkills(loaded) {
  if (Array.isArray(loaded)) return loaded;
  if (loaded && typeof loaded === 'object' && 'skills' in loaded) {
    const skills = loaded.skills;
    if (Array.isArray(skills)) return skills;
  }
  return [];
}

function filterLoadedSkillsInsideRoot({ skills, rootRealPath }) {
  return skills.filter((skill) => {
    const baseDirRealPath = resolveContainedSkillPath({
      rootRealPath,
      candidatePath: skill.baseDir,
    });
    if (!baseDirRealPath) return false;
    return Boolean(
      resolveContainedSkillPath({
        rootRealPath: baseDirRealPath,
        candidatePath: skill.filePath,
      }),
    );
  });
}

function loadSkillsForOneRoot(params, limits) {
  const rootDir = path.resolve(params.dir);
  const rootRealPath = realpathSyncOrResolve(rootDir);
  const resolved = resolveNestedSkillsRoot(params.dir, {
    maxEntriesToScan: limits.maxCandidatesPerRoot,
  });
  const baseDir = resolved.baseDir;
  const baseDirRealPath = resolveContainedSkillPath({
    rootRealPath,
    candidatePath: baseDir,
  });
  if (!baseDirRealPath) return [];

  const rootSkillMd = path.join(baseDir, 'SKILL.md');
  if (FileUtils.existsSync(rootSkillMd)) {
    const rootSkillRealPath = resolveContainedSkillPath({
      rootRealPath: baseDirRealPath,
      candidatePath: rootSkillMd,
    });
    if (!rootSkillRealPath) return [];
    try {
      const size = FileUtils.statSync(rootSkillRealPath)?.size ?? 0;
      if (size > limits.maxSkillFileBytes) return [];
    } catch {
      return [];
    }
    const loaded = loadSkillsFromDir({ dir: baseDir, source: params.source });
    return filterLoadedSkillsInsideRoot({
      skills: unwrapLoadedSkills(loaded),
      rootRealPath: baseDirRealPath,
    });
  }

  const childDirs = listChildDirectories(baseDir);
  const maxCandidates = Math.max(0, limits.maxCandidatesPerRoot);
  const limitedChildren = childDirs.slice().sort().slice(0, maxCandidates);

  const loadedSkills = [];
  for (const name of limitedChildren) {
    const skillDir = path.join(baseDir, name);
    const skillDirRealPath = resolveContainedSkillPath({
      rootRealPath: baseDirRealPath,
      candidatePath: skillDir,
    });
    if (!skillDirRealPath) continue;
    const skillMd = path.join(skillDir, 'SKILL.md');
    if (!FileUtils.existsSync(skillMd)) continue;
    const skillMdRealPath = resolveContainedSkillPath({
      rootRealPath: baseDirRealPath,
      candidatePath: skillMd,
    });
    if (!skillMdRealPath) continue;
    try {
      const size = FileUtils.statSync(skillMdRealPath)?.size ?? 0;
      if (size > limits.maxSkillFileBytes) continue;
    } catch {
      continue;
    }

    const loaded = loadSkillsFromDir({ dir: skillDir, source: params.source });
    loadedSkills.push(
      ...filterLoadedSkillsInsideRoot({
        skills: unwrapLoadedSkills(loaded),
        rootRealPath: baseDirRealPath,
      }),
    );

    if (loadedSkills.length >= limits.maxSkillsLoadedPerSource) break;
  }

  if (loadedSkills.length > limits.maxSkillsLoadedPerSource) {
    return loadedSkills
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limits.maxSkillsLoadedPerSource);
  }
  return loadedSkills;
}

function compactSkillPaths(skills) {
  const home = os.homedir();
  if (!home) return skills;
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  return skills.map((s) => ({
    ...s,
    filePath: s.filePath.startsWith(prefix) ? `~/${s.filePath.slice(prefix.length)}` : s.filePath,
  }));
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatSkillsCompact(skills) {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return '';
  const lines = [
    '\n\nThe following skills provide specialized instructions for specific tasks.',
    "Use the read tool to load a skill's file when the task matches its name.",
    'tools.run executes with the agent workspace as cwd: use workspace-relative paths (e.g. docs/report.py), not ~/… or redundant cd into the workspace.',
    '',
    '<available_skills>',
  ];
  for (const skill of visible) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

function applySkillsPromptLimits(skills, limits) {
  const byCount = skills.slice(0, Math.max(0, limits.maxSkillsInPrompt));
  let skillsForPrompt = byCount;
  let compact = false;

  const fitsFull = (s) => formatSkillsForPrompt(s).length <= limits.maxSkillsPromptChars;
  const compactBudget = limits.maxSkillsPromptChars;
  const fitsCompact = (s) => formatSkillsCompact(s).length <= compactBudget;

  if (!fitsFull(skillsForPrompt)) {
    if (fitsCompact(skillsForPrompt)) {
      compact = true;
    } else {
      compact = true;
      let lo = 0;
      let hi = skillsForPrompt.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fitsCompact(skillsForPrompt.slice(0, mid))) lo = mid;
        else hi = mid - 1;
      }
      skillsForPrompt = skillsForPrompt.slice(0, lo);
    }
  }

  return { skillsForPrompt, compact };
}

export function buildSkillsPromptFromWorkspace(workspaceRootResolved, cfg = {}) {
  const limits = resolveSkillLimits(cfg);
  const skillRoots = resolveSkillRoots(cfg);

  const merged = new Map();
  for (const rel of skillRoots) {
    const abs = path.isAbsolute(rel) ? path.normalize(rel) : path.join(workspaceRootResolved, rel);
    if (!FileUtils.existsSync(abs) || !FileUtils.statSync(abs)?.isDirectory()) continue;
    const slug = String(rel).replace(/[^\w.-]+/g, '_');
    const loaded = loadSkillsForOneRoot({ dir: abs, source: `xrk-${slug}` }, limits);
    for (const skill of loaded) {
      merged.set(skill.name, skill);
    }
  }

  const resolvedSkills = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (resolvedSkills.length === 0) return '';

  const promptSkills = compactSkillPaths(resolvedSkills);
  const { skillsForPrompt, compact } = applySkillsPromptLimits(promptSkills, limits);
  const totalSkills = resolvedSkills.length;
  const maxChars = limits.maxSkillsPromptChars;

  const buildCombined = (subsetSkills, useCompact) => {
    if (!Array.isArray(subsetSkills) || subsetSkills.length === 0) return '';
    const included = subsetSkills.length;
    const isTruncated = included < totalSkills;

    const note = isTruncated
      ? `⚠️ Skills truncated: included ${included} of ${totalSkills}${useCompact ? ' (compact format, descriptions omitted)' : ''}.`
      : useCompact
        ? '⚠️ Skills catalog using compact format (descriptions omitted).'
        : '';

    const xml = useCompact ? formatSkillsCompact(subsetSkills) : formatSkillsForPrompt(subsetSkills);
    return [note, xml].filter(Boolean).join('\n');
  };

  const initial = buildCombined(skillsForPrompt, compact);
  if (initial.length <= maxChars) return initial;

  const modes = compact ? [true] : [false, true];
  for (const useCompact of modes) {
    const direct = buildCombined(skillsForPrompt, useCompact);
    if (direct.length <= maxChars) return direct;

    let lo = 0;
    let hi = skillsForPrompt.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const subset = skillsForPrompt.slice(0, mid);
      const combined = buildCombined(subset, useCompact);
      if (combined.length <= maxChars) lo = mid;
      else hi = mid - 1;
    }

    const best = buildCombined(skillsForPrompt.slice(0, lo), useCompact);
    if (best.length > 0) return best;
  }

  return '';
}
