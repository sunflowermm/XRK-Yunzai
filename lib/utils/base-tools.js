/**
 * 统一基础工具系统
 * 提供文件操作、文本搜索、命令执行等，供 tools/desktop 工作流使用
 */
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { FileUtils } from './file-utils.js';

const execAsync = promisify(exec);
const IS_WINDOWS = process.platform === 'win32';

export class BaseTools {
  workspace = null;
  processRegistry = new Set();

  constructor(workspace = null) {
    this.workspace = workspace || path.join(os.homedir(), 'Desktop');
  }

  async readFile(filePath, encoding = 'utf8') {
    const fullPath = this.resolvePath(filePath);
    const content = await FileUtils.readFile(fullPath, encoding);
    if (content == null) {
      return { success: false, error: 'read failed', path: fullPath };
    }
    return { success: true, content, path: fullPath };
  }

  async writeFile(filePath, content, encoding = 'utf8') {
    const fullPath = this.resolvePath(filePath);
    const ok = await FileUtils.writeFile(fullPath, content, encoding);
    if (!ok) {
      return { success: false, error: 'write failed', path: fullPath };
    }
    return { success: true, path: fullPath };
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
      const fullPath = this.resolvePath(filePath);
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
    const targetDir = dirPath ? this.resolvePath(dirPath) : this.workspace;
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
      const { stdout, stderr } = await execAsync(command, {
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

  async killAllRegisteredProcesses() {
    const killed = [];
    for (const pid of this.processRegistry) {
      try {
        process.kill(pid);
        killed.push(pid);
        this.processRegistry.delete(pid);
      } catch {
        this.processRegistry.delete(pid);
      }
    }
    return { success: true, killed };
  }

  /** 清理 processRegistry 中已退出的子进程记录 */
  async autoCleanupProcesses(excludePatterns = []) {
    void excludePatterns;
    const stale = [];
    for (const pid of [...this.processRegistry]) {
      try {
        process.kill(pid, 0);
      } catch {
        stale.push(pid);
        this.processRegistry.delete(pid);
      }
    }
    return { success: true, killed: stale };
  }
}
