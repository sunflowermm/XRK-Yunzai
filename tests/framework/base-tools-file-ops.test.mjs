import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sliceFileLines } from '../../lib/utils/base-tools.js';
import { BaseTools } from '../../lib/utils/base-tools.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

describe('sliceFileLines', () => {
  const sample = 'line1\nline2\nline3\nline4';

  it('returns full file with line numbers by default', () => {
    const r = sliceFileLines(sample);
    assert.equal(r.lineCount, 4);
    assert.match(r.content, /^1\|line1/m);
    assert.equal(r.totalLines, 4);
  });

  it('returns line range inclusive', () => {
    const r = sliceFileLines(sample, { startLine: 2, endLine: 3, showLineNumbers: true });
    assert.equal(r.lineCount, 2);
    assert.match(r.content, /2\|line2/);
    assert.match(r.content, /3\|line3/);
    assert.doesNotMatch(r.content, /line1/);
  });

  it('single line via startLine=endLine', () => {
    const r = sliceFileLines(sample, { startLine: 2, endLine: 2 });
    assert.equal(r.lineCount, 1);
    assert.match(r.content, /2\|line2/);
  });
});

describe('BaseTools.searchReplace', () => {
  it('replaces unique oldText', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrk-tools-'));
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'alpha\nbeta\nalpha tail\n', 'utf8');
    const tools = new BaseTools(dir);
    const r = await tools.searchReplace('a.txt', 'beta', 'BETA');
    assert.equal(r.success, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'alpha\nBETA\nalpha tail\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects ambiguous oldText unless replaceAll', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrk-tools-'));
    const file = path.join(dir, 'b.txt');
    fs.writeFileSync(file, 'foo bar foo\n', 'utf8');
    const tools = new BaseTools(dir);
    const r = await tools.searchReplace('b.txt', 'foo', 'x');
    assert.equal(r.success, false);
    assert.match(r.error, /2 次/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
