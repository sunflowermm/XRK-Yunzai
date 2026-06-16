/**
 * 统一基础工具系统
 * 提供文件操作、文本搜索、命令执行等，供 tools/desktop 工作流使用
 * 安全层对齐 XRK-AGT system-Core（path-guards / InputValidator）
 */
import path from 'path';
import { FileUtils } from './file-utils.js';
import { exec } from './exec-async.js';
import { getDefaultDesktopDirSync } from './user-dirs.js';
import { isPathInside, realpathSyncOrResolve } from './path-guards.js';
import { readTextFileUnderWorkspaceRoot } from './safe-workspace-read.js';

const IS_WINDOWS = process.platform === 'win32';

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

  async readFile(filePath, encoding = 'utf8') {
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
      return { success: true, content: safe.content, path: fullPath };
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
    const { mode = 'replace', lineNumber } = options;
    try {
      const fullPath = this.resolvePathInWorkspace(filePath);
      let fileContent = '';
      const existing = FileUtils.readFileSync(fullPath, 'utf8');
      if (existing == null) {
        if (mode === 'replace') {
          fileContent = '';
        } else {
          return { success: false, error: '文件不存在，无法使用 append 或 prepend 模式' };
        }
      } else {
        fileContent = existing;
      }

      let newContent = '';
      if (mode === 'replace') {
        if (lineNumber !== undefined && lineNumber > 0) {
          const lines = fileContent.split('\n');
          if (lineNumber > lines.length) {
            return { success: false, error: `行号 ${lineNumber} 超出文件行数 ${lines.length}` };
          }
          lines[lineNumber - 1] = content;
          newContent = lines.join('\n');
        } else {
          newContent = content;
        }
      } else if (mode === 'append') {
        newContent = fileContent + (fileContent && !fileContent.endsWith('\n') ? '\n' : '') + content;
      } else if (mode === 'prepend') {
        newContent = content + (fileContent && !fileContent.startsWith('\n') ? '\n' : '') + fileContent;
      } else {
        return { success: false, error: `未知模式: ${mode}` };
      }

      const ok = await FileUtils.writeFile(fullPath, newContent, 'utf8');
      if (!ok) return { success: false, error: 'modify failed', path: fullPath };
      return { success: true, path: fullPath, mode };
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
    const { caseSensitive = false, maxResults = 100, lineNumbers = true } = options;
    const searchPattern = caseSensitive
      ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const searchInFile = async (file) => {
      const content = await FileUtils.readFile(file, 'utf8');
      if (content == null) return [];
      const lines = content.split('\n');
      const matches = [];
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        if (searchPattern.test(lines[i])) {
          matches.push({
            file,
            line: lineNumbers ? i + 1 : undefined,
            content: lines[i].trim()
          });
        }
      }
      return matches;
    };

    if (filePath) {
      const fullPath = this.resolvePathInWorkspace(filePath);
      const matches = await searchInFile(fullPath);
      return { success: true, matches };
    }
    const textFiles = await this.searchFiles('', {
      fileExtensions: ['.txt', '.md', '.js', '.json', '.py', '.java', '.cpp', '.c', '.h']
    });
    const allMatches = [];
    for (const file of textFiles) {
      const matches = await searchInFile(file);
      allMatches.push(...matches);
      if (allMatches.length >= maxResults) break;
    }
    return { success: true, matches: allMatches.slice(0, maxResults) };
  }

  async listDir(dirPath = null, options = {}) {
    const { includeHidden = false, type = 'all' } = options;
    const targetDir = dirPath ? this.resolvePathInWorkspace(dirPath) : realpathSyncOrResolve(this.workspace);
    try {
      const entries = await FileUtils.readDir(targetDir, { withFileTypes: true });
      const items = [];
      for (const entry of entries) {
        if (!includeHidden && entry.name.startsWith('.')) continue;
        const fullPath = path.join(targetDir, entry.name);
        const isDir = entry.isDirectory();
        const isFile = entry.isFile();
        if (type === 'files' && !isFile) continue;
        if (type === 'dirs' && !isDir) continue;
        let size = null;
        let modified = null;
        if (isFile || isDir) {
          const stats = FileUtils.statSync(fullPath);
          if (!stats) continue;
          size = stats.isFile() ? stats.size : null;
          modified = stats.mtime;
        }
        items.push({
          name: entry.name,
          path: fullPath,
          type: isDir ? 'directory' : 'file',
          size,
          modified
        });
      }
      return { success: true, items, path: targetDir };
    } catch (error) {
      return { success: false, error: error.message, path: targetDir };
    }
  }

  resolvePath(filePath) {
    if (path.isAbsolute(filePath)) return filePath;
    return path.join(this.workspace, filePath);
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
