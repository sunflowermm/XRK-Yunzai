/**
 * 统一基础工具系统
 * 提供文件操作、文本搜索、命令执行等，供 tools/desktop 工作流使用
 */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { FileUtils } from './file-utils.js';

const execAsync = promisify(exec);
const IS_WINDOWS = process.platform === 'win32';

export class BaseTools {
  constructor(workspace = null) {
    this.workspace = workspace || path.join(os.homedir(), 'Desktop');
    this.processRegistry = new Set();
  }

  async readFile(filePath, encoding = 'utf8') {
    const fullPath = this.resolvePath(filePath);
    try {
      const content = await fs.readFile(fullPath, encoding);
      return { success: true, content, path: fullPath };
    } catch (error) {
      return { success: false, error: error.message, path: fullPath };
    }
  }

  async writeFile(filePath, content, encoding = 'utf8') {
    const fullPath = this.resolvePath(filePath);
    try {
      await FileUtils.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, content, encoding);
      return { success: true, path: fullPath };
    } catch (error) {
      return { success: false, error: error.message, path: fullPath };
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
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
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
      } catch {
        // ignore
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
      try {
        const content = await fs.readFile(file, 'utf8');
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
      } catch {
        return [];
      }
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
      const entries = await fs.readdir(targetDir, { withFileTypes: true });
      const items = [];
      for (const entry of entries) {
        if (!includeHidden && entry.name.startsWith('.')) continue;
        const fullPath = path.join(targetDir, entry.name);
        const stats = await fs.stat(fullPath);
        if (type === 'files' && !stats.isFile()) continue;
        if (type === 'dirs' && !stats.isDirectory()) continue;
        items.push({
          name: entry.name,
          path: fullPath,
          type: stats.isDirectory() ? 'directory' : 'file',
          size: stats.isFile() ? stats.size : null,
          modified: stats.mtime
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
      const result = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024
      });
      return {
        success: true,
        stdout: result.stdout || '',
        stderr: result.stderr || ''
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        stderr: error.stderr || '',
        stdout: error.stdout || ''
      };
    }
  }

  getRegisteredProcesses() {
    return Array.from(this.processRegistry);
  }

  async cleanupProcesses() {
    if (!IS_WINDOWS) return { success: true, killed: [] };
    const killed = [];
    for (const pid of this.processRegistry) {
      try {
        await execAsync(`taskkill /F /PID ${pid}`, { timeout: 5000 });
        killed.push(pid);
        this.processRegistry.delete(pid);
      } catch {
        this.processRegistry.delete(pid);
      }
    }
    return { success: true, killed };
  }

  async autoCleanupProcesses(excludePatterns = []) {
    if (!IS_WINDOWS) return { success: true, killed: [] };
    try {
      const { stdout } = await execAsync('tasklist /FO CSV /NH', { encoding: 'utf8' });
      const lines = stdout.split('\n').filter(line => line.trim());
      const processes = lines.map(line => {
        const parts = line.match(/"([^"]+)"/g);
        if (!parts || parts.length < 2) return null;
        return {
          name: parts[0].replace(/"/g, ''),
          pid: parseInt(parts[1].replace(/"/g, ''), 10)
        };
      }).filter(Boolean);
      const killed = [];
      for (const proc of processes) {
        if (excludePatterns.some(p => p.test(proc.name))) continue;
        if (/System|explorer/i.test(proc.name)) continue;
      }
      return { success: true, killed };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}
