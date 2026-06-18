/**
 * 统一基础工具系统
 * 提供文件操作、文本搜索、命令执行等，供 tools/desktop 工作流使用
 * 安全层对齐 XRK-AGT system-Core（path-guards / InputValidator）
 */
import path from 'path';
import { expandHomePath, normalizeToolsDirPath } from './workspace-run-command.js';
import { FileUtils } from './file-utils.js';
import { exec } from './exec-async.js';
import { getDefaultDesktopDirSync } from './user-dirs.js';
import { isPathInside, realpathSyncOrResolve } from './path-guards.js';
import { readTextFileUnderWorkspaceRoot } from './safe-workspace-read.js';

const IS_WINDOWS = process.platform === 'win32';

const GREP_TEXT_EXTENSIONS = [
  '.txt', '.md', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.yaml', '.yml',
  '.py', '.java', '.cpp', '.c', '.h', '.mdc', '.css', '.html', '.vue', '.jsx'
];

/** 按 1 起始行号截取文件内容，可选行号前缀（便于模型定向修改） */
export function sliceFileLines(content, options = {}) {
  const { startLine, endLine, showLineNumbers = true } = options;
  const lines = String(content ?? '').split('\n');
  const totalLines = lines.length;
  const start = startLine == null ? 1 : Math.max(1, Math.floor(Number(startLine)));
  const end = endLine == null ? totalLines : Math.min(totalLines, Math.floor(Number(endLine)));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start > totalLines) {
    return {
      content: '',
      startLine: start,
      endLine: end,
      totalLines,
      lineCount: 0,
      ranged: startLine != null || endLine != null
    };
  }
  const slice = lines.slice(start - 1, end);
  const width = String(end).length;
  const body = showLineNumbers
    ? slice.map((line, i) => `${String(start + i).padStart(width, ' ')}|${line}`).join('\n')
    : slice.join('\n');
  return {
    content: body,
    startLine: start,
    endLine: end,
    totalLines,
    lineCount: slice.length,
    ranged: startLine != null || endLine != null
  };
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

export class BaseTools {
  workspace = null;
  processRegistry = new Set();

  constructor(workspace = null) {
    this.workspace = workspace || getDefaultDesktopDirSync();
  }

  /** 解析并校验路径位于工作区内 */
  resolvePathInWorkspace(filePath) {
    const resolved = this.resolvePath(filePath);
    const root = realpathSyncOrResolve(this.workspace);
    const target = realpathSyncOrResolve(resolved);
    if (!isPathInside(root, target)) {
      throw new Error(`路径超出工作区: ${filePath}`);
    }
    return target;
  }

  async readFile(filePath, options = {}) {
    const opts = typeof options === 'string' ? { encoding: options } : (options || {});
    try {
      const fullPath = this.resolvePathInWorkspace(filePath);
      const safe = readTextFileUnderWorkspaceRoot(this.workspace, fullPath);
      if (!safe.ok) {
        const reason =
          safe.reason === 'binary'
            ? '二进制文件不可 read，请用 chat.send_file 发送或换文本/Markdown 文件'
            : safe.reason;
        return { success: false, error: reason, path: fullPath };
      }
      const sliced = sliceFileLines(safe.content, {
        startLine: opts.startLine,
        endLine: opts.endLine,
        showLineNumbers: opts.showLineNumbers !== false
      });
      return {
        success: true,
        content: sliced.content,
        fullContent: safe.content,
        path: fullPath,
        ...sliced
      };
    } catch (error) {
      return { success: false, error: error.message, path: filePath };
    }
  }

  /**
   * 按 oldText 精确替换为 newText（须在工作区内唯一，除非 replaceAll）
   */
  async searchReplace(filePath, oldText, newText, options = {}) {
    const { replaceAll = false } = options;
    if (oldText == null || oldText === '') {
      return { success: false, error: 'oldText 不能为空' };
    }
    if (newText == null) {
      return { success: false, error: 'newText 不能省略（可传空字符串）' };
    }
    try {
      const fullPath = this.resolvePathInWorkspace(filePath);
      const existing = FileUtils.readFileSync(fullPath, 'utf8');
      if (existing == null) {
        return { success: false, error: '文件不存在', path: fullPath };
      }
      const count = countOccurrences(existing, oldText);
      if (count === 0) {
        return { success: false, error: '未找到 oldText，请 read 核对片段或扩大上下文', path: fullPath };
      }
      if (!replaceAll && count > 1) {
        return {
          success: false,
          error: `oldText 出现 ${count} 次，请加长上下文使其唯一，或设 replaceAll=true`,
          path: fullPath,
          occurrences: count
        };
      }
      const newContent = replaceAll
        ? existing.split(oldText).join(newText)
        : existing.replace(oldText, newText);
      const ok = await FileUtils.writeFile(fullPath, newContent, 'utf8');
      if (!ok) return { success: false, error: 'search_replace failed', path: fullPath };
      return {
        success: true,
        path: fullPath,
        replacements: replaceAll ? count : 1,
        replaceAll: !!replaceAll
      };
    } catch (error) {
      return { success: false, error: error.message, path: filePath };
    }
  }

  async writeFile(filePath, content, encoding = 'utf8') {
    try {
      const fullPath = this.resolvePathInWorkspace(filePath);
      const ok = await FileUtils.writeFile(fullPath, content, encoding);
      if (!ok) {
        return { success: false, error: 'write failed', path: fullPath };
      }
      return { success: true, path: fullPath };
    } catch (error) {
      return { success: false, error: error.message, path: filePath };
    }
  }

  async deleteFile(filePath) {
    try {
      const fullPath = this.resolvePathInWorkspace(filePath);
      const ok = await FileUtils.unlink(fullPath);
      if (!ok) return { success: false, error: 'delete failed', path: fullPath };
      return { success: true, path: fullPath };
    } catch (error) {
      return { success: false, error: error.message, path: filePath };
    }
  }

  async modifyFile(filePath, content, options = {}) {
    const { mode = 'append', lineNumber } = options;
    try {
      const fullPath = this.resolvePathInWorkspace(filePath);
      let fileContent = '';
      const existing = FileUtils.readFileSync(fullPath, 'utf8');
      if (existing == null) {
        if (mode === 'line') {
          return { success: false, error: '文件不存在，无法替换指定行' };
        }
        if (mode === 'append' || mode === 'prepend') {
          fileContent = '';
        } else {
          return { success: false, error: `未知模式: ${mode}` };
        }
      } else {
        fileContent = existing;
      }

      let newContent = '';
      if (mode === 'line') {
        if (lineNumber === undefined || lineNumber === null || lineNumber < 1) {
          return { success: false, error: 'line 模式须指定 lineNumber（从 1 开始）' };
        }
        const lines = fileContent.split('\n');
        if (lineNumber > lines.length) {
          return { success: false, error: `行号 ${lineNumber} 超出文件行数 ${lines.length}` };
        }
        lines[lineNumber - 1] = content;
        newContent = lines.join('\n');
      } else if (mode === 'append') {
        newContent = fileContent + (fileContent && !fileContent.endsWith('\n') ? '\n' : '') + content;
      } else if (mode === 'prepend') {
        newContent = content + (fileContent && !fileContent.startsWith('\n') ? '\n' : '') + fileContent;
      } else if (mode === 'replace') {
        return {
          success: false,
          error: 'replace 已移除：整文件用 write，片段用 search_replace，单行用 mode=line'
        };
      } else {
        return { success: false, error: `未知模式: ${mode}（支持 line / append / prepend）` };
      }

      const ok = await FileUtils.writeFile(fullPath, newContent, 'utf8');
      if (!ok) return { success: false, error: 'modify failed', path: fullPath };
      return { success: true, path: fullPath, mode, lineNumber: mode === 'line' ? lineNumber : undefined };
    } catch (error) {
      return { success: false, error: error.message, path: filePath };
    }
  }

  async searchFiles(pattern, options = {}) {
    const { maxDepth = 3, fileExtensions = null, caseSensitive = false } = options;
    const results = [];
    const searchPattern = caseSensitive
      ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const searchDir = async (dir, depth = 0) => {
      if (depth > maxDepth) return;
      const entries = await FileUtils.readDir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await searchDir(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (fileExtensions && !fileExtensions.includes(ext)) continue;
          if (searchPattern.test(entry.name) || searchPattern.test(fullPath)) {
            results.push(fullPath);
          }
        }
      }
    };
    await searchDir(this.workspace);
    return results;
  }

  async grep(pattern, filePath = null, options = {}) {
    const {
      caseSensitive = false,
      maxResults = 100,
      lineNumbers = true,
      contextBefore = 0,
      contextAfter = 0
    } = options;
    const ctxBefore = Math.max(0, Math.min(5, Math.floor(Number(contextBefore) || 0)));
    const ctxAfter = Math.max(0, Math.min(5, Math.floor(Number(contextAfter) || 0)));
    const searchPattern = caseSensitive
      ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const searchInFile = async (file) => {
      const content = await FileUtils.readFile(file, 'utf8');
      if (content == null) return [];
      const lines = content.split('\n');
      const matches = [];
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        if (!searchPattern.test(lines[i])) continue;
        const lineNo = i + 1;
        const snippetStart = Math.max(0, i - ctxBefore);
        const snippetEnd = Math.min(lines.length - 1, i + ctxAfter);
        const snippetLines = [];
        for (let j = snippetStart; j <= snippetEnd; j++) {
          const prefix = j === i ? '>' : ' ';
          snippetLines.push(`${prefix}${j + 1}|${lines[j]}`);
        }
        matches.push({
          file,
          line: lineNumbers ? lineNo : undefined,
          content: lines[i].trim(),
          snippet: snippetLines.join('\n')
        });
      }
      return matches;
    };

    if (filePath) {
      const fullPath = this.resolvePathInWorkspace(filePath);
      const matches = await searchInFile(fullPath);
      return { success: true, matches };
    }
    const textFiles = await this.searchFiles('', { fileExtensions: GREP_TEXT_EXTENSIONS });
    const allMatches = [];
    for (const file of textFiles) {
      const matches = await searchInFile(file);
      allMatches.push(...matches);
      if (allMatches.length >= maxResults) break;
    }
    return { success: true, matches: allMatches.slice(0, maxResults) };
  }

  async listDir(dirPath = null, options = {}) {
    const { includeHidden = false, type = 'all', maxDepth = 1 } = options;
    const workspaceRoot = realpathSyncOrResolve(this.workspace);
    const targetDir = dirPath ? this.resolvePathInWorkspace(dirPath) : workspaceRoot;
    const depthLimit = Math.max(1, Math.min(8, Math.floor(Number(maxDepth) || 1)));

    try {
      const items = [];
      const walk = async (dirAbs, depth) => {
        if (depth > depthLimit) return;
        const entries = await FileUtils.readDir(dirAbs, { withFileTypes: true });
        for (const entry of entries) {
          if (!includeHidden && entry.name.startsWith('.')) continue;
          const fullPath = path.join(dirAbs, entry.name);
          const isDir = entry.isDirectory();
          const isFile = entry.isFile();
          if (type === 'files' && !isFile) {
            if (isDir && depth < depthLimit) await walk(fullPath, depth + 1);
            continue;
          }
          if (type === 'dirs' && !isDir) continue;
          let size = null;
          let modified = null;
          const stats = FileUtils.statSync(fullPath);
          if (stats) {
            size = stats.isFile() ? stats.size : null;
            modified = stats.mtime;
          }
          let relPath = fullPath;
          try {
            relPath = path.relative(workspaceRoot, fullPath).split(path.sep).join('/');
          } catch {
            /* keep abs */
          }
          items.push({
            name: entry.name,
            path: fullPath,
            relPath,
            type: isDir ? 'directory' : 'file',
            size,
            modified
          });
          if (isDir && depth < depthLimit) await walk(fullPath, depth + 1);
        }
      };
      await walk(targetDir, 1);
      items.sort((a, b) => String(a.relPath).localeCompare(String(b.relPath), 'zh-CN'));
      return { success: true, items, path: targetDir, maxDepth: depthLimit };
    } catch (error) {
      return { success: false, error: error.message, path: targetDir };
    }
  }

  resolvePath(filePath) {
    const raw = String(filePath ?? '').trim();
    if (!raw) return this.workspace;
    const expanded = expandHomePath(raw);
    if (path.isAbsolute(expanded)) return path.normalize(expanded);
    const rel = normalizeToolsDirPath(expanded, this.workspace);
    if (!rel || rel === '.') return this.workspace;
    return path.join(this.workspace, rel);
  }

  async executeCommand(command, options = {}) {
    const { cwd = this.workspace, timeout = 30000 } = options;
    try {
      const { stdout, stderr } = await exec(command, {
        cwd,
        timeout,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
      return { success: true, stdout, stderr };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        stdout: error.stdout || '',
        stderr: error.stderr || '',
        code: error.code
      };
    }
  }

  registerProcess(pid) {
    if (typeof pid === 'number' && pid > 0) this.processRegistry.add(pid);
  }

  getRegisteredProcesses() {
    return Array.from(this.processRegistry);
  }

  async cleanupProcesses() {
    const killed = [];
    for (const pid of this.processRegistry) {
      try {
        if (IS_WINDOWS) {
          await exec(`taskkill /F /PID ${pid}`, { timeout: 5000 });
        } else {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            /* ESRCH */
          }
        }
        killed.push(pid);
        this.processRegistry.delete(pid);
      } catch {
        this.processRegistry.delete(pid);
      }
    }
    return { success: true, killed };
  }

  async autoCleanupProcesses(excludePatterns = []) {
    if (!IS_WINDOWS) {
      for (const pid of [...this.processRegistry]) {
        try {
          process.kill(pid, 0);
        } catch {
          this.processRegistry.delete(pid);
        }
      }
      return { success: true, killed: [], note: '非 Windows：仅清理已登记且已退出的 PID' };
    }

    void excludePatterns;
    try {
      const { stdout } = await exec('tasklist /FO CSV /NH', { encoding: 'utf8' });
      const lines = stdout.split('\n').filter((line) => line.trim());
      const processes = lines.map((line) => {
        const parts = line.match(/"([^"]+)"/g);
        if (!parts || parts.length < 2) return null;
        return {
          name: parts[0].replace(/"/g, ''),
          pid: parseInt(parts[1].replace(/"/g, ''), 10)
        };
      }).filter(Boolean);

      const killed = [];
      for (const proc of processes) {
        if (excludePatterns.some((p) => p.test(proc.name))) continue;
        if (/explorer|System|winlogon|csrss|smss|svchost|dwm|wininit/i.test(proc.name)) continue;
        void proc;
      }
      return { success: true, killed };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}
