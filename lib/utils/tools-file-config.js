/**
 * tools.file 运行时配置 — 单一来源：aistream.tools.file + overrides
 */
import { getAistreamConfigOptional } from './aistream-config.js';

const DEFAULTS = Object.freeze({
  maxReadChars: 500_000,
  readRawPreviewChars: 20_000,
  grepMaxResults: 100,
  runEnabled: true,
  runTimeoutMs: 120_000,
  maxCommandOutputChars: 200_000,
  workspace: ''
});

function pickNumber(value, { min, max, fallback }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  let v = Math.floor(value);
  if (min != null) v = Math.max(min, v);
  if (max != null) v = Math.min(max, v);
  return v;
}

/** @param {object} [overrides] */
export function resolveToolsFileRuntime(overrides = {}) {
  const section = {
    ...(getAistreamConfigOptional().tools?.file ?? {}),
    ...(overrides && typeof overrides === 'object' ? overrides : {})
  };

  return {
    maxReadChars: pickNumber(section.maxReadChars, { min: 1000, fallback: DEFAULTS.maxReadChars }),
    readRawPreviewChars: pickNumber(section.readRawPreviewChars, { min: 2000, fallback: DEFAULTS.readRawPreviewChars }),
    grepMaxResults: pickNumber(section.grepMaxResults, { min: 1, max: 500, fallback: DEFAULTS.grepMaxResults }),
    runEnabled: section.runEnabled !== false,
    runTimeoutMs: pickNumber(section.runTimeoutMs, { min: 1000, fallback: DEFAULTS.runTimeoutMs }),
    maxCommandOutputChars: pickNumber(section.maxCommandOutputChars, { min: 1000, fallback: DEFAULTS.maxCommandOutputChars }),
    workspace: typeof section.workspace === 'string' ? section.workspace.trim() : DEFAULTS.workspace
  };
}
