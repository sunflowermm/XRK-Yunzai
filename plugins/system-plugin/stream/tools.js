/**
 * 基础工具工作流
 * 业务层：plugins/system-plugin/stream/
 * MCP 对齐 XRK-AGT system-Core/tools.js
 */
import AIStream from '../../../lib/aistream/aistream.js';
import path from 'path';
import { BaseTools } from '../../../lib/utils/base-tools.js';
import { InputValidator } from '../../../lib/utils/input-validator.js';
import { getDefaultDesktopDirSync } from '../../../lib/utils/user-dirs.js';
import { getAistreamConfigOptional } from '../../../lib/utils/aistream-config.js';
import { exec } from '../../../lib/utils/exec-async.js';

const IS_WINDOWS = process.platform === 'win32';

export default class ToolsStream extends AIStream {
  workspace = getDefaultDesktopDirSync();
  fileToolsCfg = {
    maxReadChars: 500_000,
    grepMaxResults: 100,
    runEnabled: true,
    runTimeoutMs: 120_000,
    maxCommandOutputChars: 200_000
  };

  constructor() {
    super({
      name: 'tools',
      description: '基础工具工作流（read/grep/write/delete_file/modify_file/list_files/run）',
      version: '1.0.6',
      author: 'XRK',
      priority: 200,
      config: {
        enabled: true,
        temperature: 0.3,
        maxTokens: 2000,
        topP: 0.9
      }
    });
  }

  applyFileToolsConfig() {
    const fileCfg = getAistreamConfigOptional().tools?.file ?? {};
    this.fileToolsCfg = {
      maxReadChars:
        typeof fileCfg.maxReadChars === 'number' && Number.isFinite(fileCfg.maxReadChars)
          ? Math.max(1000, Math.floor(fileCfg.maxReadChars))
          : 500_000,
      grepMaxResults:
        typeof fileCfg.grepMaxResults === 'number' && Number.isFinite(fileCfg.grepMaxResults)
          ? Math.min(500, Math.max(1, Math.floor(fileCfg.grepMaxResults)))
          : 100,
      runEnabled: fileCfg.runEnabled !== false,
      runTimeoutMs:
        typeof fileCfg.runTimeoutMs === 'number' && Number.isFinite(fileCfg.runTimeoutMs)
          ? Math.max(1000, Math.floor(fileCfg.runTimeoutMs))
          : 120_000,
      maxCommandOutputChars:
        typeof fileCfg.maxCommandOutputChars === 'number' && Number.isFinite(fileCfg.maxCommandOutputChars)
          ? Math.max(1000, Math.floor(fileCfg.maxCommandOutputChars))
          : 200_000
    };
    if (typeof fileCfg.workspace === 'string' && fileCfg.workspace.trim()) {
      this.workspace = fileCfg.workspace.trim();
    }
  }

  async init() {
    await super.init();
    this.applyFileToolsConfig();
    this.tools = new BaseTools(this.workspace);
    this.registerAllFunctions();
  }

  registerAllFunctions() {
    this.registerMCPTool('read', {
      description: '读取文件内容。支持相对路径和绝对路径，文件不存在时自动在工作区搜索。',
      inputSchema: {
        type: 'object',
        properties: { filePath: { type: 'string', description: '文件路径（相对或绝对路径）' } },
        required: ['filePath']
      },
      handler: async (args = {}) => {
        const { filePath } = args;
        if (!filePath) return { success: false, error: '文件路径不能为空' };
        let result = await this.tools.readFile(filePath);
        if (!result.success) result = await this.trySearchAndReadFile(filePath);
        if (result.success) {
          const maxChars = this.fileToolsCfg.maxReadChars;
          let content = result.content;
          let truncated = false;
          if (typeof content === 'string' && content.length > maxChars) {
            content = content.slice(0, maxChars);
            truncated = true;
          }
          return {
            success: true,
            data: {
              filePath: result.path,
              fileName: path.basename(result.path),
              content,
              size: result.content.length,
              returnedChars: typeof content === 'string' ? content.length : 0,
              truncated,
              maxReadChars: maxChars
            }
          };
        }
        return { success: false, error: result.error || `未找到文件: ${filePath}` };
      },
      enabled: true
    });

    this.registerMCPTool('grep', {
      description: '在文件中搜索文本。支持指定文件或工作区所有文件，不区分大小写。',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '搜索关键词' },
          filePath: { type: 'string', description: '文件路径（可选）' }
        },
        required: ['pattern']
      },
      handler: async (args = {}) => {
        const { pattern, filePath } = args;
        if (!pattern) return { success: false, error: '搜索关键词不能为空' };
        const result = await this.tools.grep(pattern, filePath, {
          caseSensitive: false,
          lineNumbers: true,
          maxResults: this.fileToolsCfg.grepMaxResults
        });
        if (result.success) {
          return {
            success: true,
            data: {
              pattern,
              filePath: filePath || null,
              matches: result.matches,
              count: result.matches.length
            }
          };
        }
        return { success: false, error: `搜索失败: ${pattern}` };
      },
      enabled: true
    });

    this.registerMCPTool('write', {
      description: '写入文件内容（完全覆盖）。文件不存在时自动创建。如需追加请使用 modify_file。',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '文件内容' }
        },
        required: ['filePath', 'content']
      },
      handler: async (args = {}) => {
        const { filePath, content } = args;
        if (!filePath) return { success: false, error: '文件路径不能为空' };
        if (content === undefined) return { success: false, error: '文件内容不能为空' };
        const result = await this.tools.writeFile(filePath, content);
        if (result.success) {
          return { success: true, data: { filePath: result.path, message: '文件写入成功' } };
        }
        return { success: false, error: result.error };
      },
      enabled: true
    });

    this.registerMCPTool('delete_file', {
      description: '删除文件。此操作不可恢复，请谨慎使用。',
      inputSchema: {
        type: 'object',
        properties: { filePath: { type: 'string', description: '文件路径' } },
        required: ['filePath']
      },
      handler: async (args = {}) => {
        const { filePath } = args;
        if (!filePath) return { success: false, error: '文件路径不能为空' };
        const result = await this.tools.deleteFile(filePath);
        if (result.success) {
          return { success: true, data: { filePath: result.path, message: '文件删除成功' } };
        }
        return { success: false, error: result.error };
      },
      enabled: true
    });

    this.registerMCPTool('modify_file', {
      description: '修改文件内容。支持 replace（替换全部或指定行）、append、prepend。',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '要添加或替换的内容' },
          mode: {
            type: 'string',
            enum: ['replace', 'append', 'prepend'],
            default: 'replace'
          },
          lineNumber: { type: 'integer', description: '行号（replace 模式，从 1 开始）' }
        },
        required: ['filePath', 'content']
      },
      handler: async (args = {}) => {
        const { filePath, content, mode = 'replace', lineNumber } = args;
        if (!filePath || content === undefined) {
          return { success: false, error: '文件路径和内容不能为空' };
        }
        const result = await this.tools.modifyFile(filePath, content, { mode, lineNumber });
        if (result.success) {
          return {
            success: true,
            data: {
              filePath: result.path,
              mode,
              message: `文件${mode === 'replace' ? '替换' : mode === 'append' ? '追加' : '插入'}成功`
            }
          };
        }
        return { success: false, error: result.error };
      },
      enabled: true
    });

    this.registerMCPTool('list_files', {
      description: '列出目录中的文件和子目录。',
      inputSchema: {
        type: 'object',
        properties: {
          dirPath: { type: 'string', description: '目录路径（可选）' },
          includeHidden: { type: 'boolean', default: false },
          type: { type: 'string', enum: ['all', 'files', 'dirs'], default: 'all' }
        }
      },
      handler: async (args = {}) => {
        const { dirPath = null, includeHidden = false, type = 'all' } = args;
        const result = await this.tools.listDir(dirPath, { includeHidden, type });
        if (result.success) {
          return {
            success: true,
            data: { path: result.path, items: result.items, count: result.items.length }
          };
        }
        return { success: false, error: result.error };
      },
      enabled: true
    });

    this.registerMCPTool('run', {
      description: '在工作区目录下执行 shell 命令。Windows 支持 CMD/PowerShell；Linux/macOS 使用 /bin/sh。',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', description: '要执行的命令' } },
        required: ['command']
      },
      handler: async (args = {}) => {
        if (!this.fileToolsCfg.runEnabled) {
          return { success: false, error: 'run 已在 aistream.tools.file.runEnabled 中关闭' };
        }
        const { command } = args;
        if (!command) return { success: false, error: '命令不能为空' };
        try {
          const { output, stderr } = await this.executeCommand(command);
          const maxOut = this.fileToolsCfg.maxCommandOutputChars;
          let out = output;
          let truncated = false;
          if (out.length > maxOut) {
            out = out.slice(0, maxOut);
            truncated = true;
          }
          return {
            success: true,
            data: {
              command,
              output: out,
              stderr: stderr ? String(stderr).slice(0, maxOut) : '',
              message: '命令执行完成',
              truncated,
              maxCommandOutputChars: maxOut,
              platform: process.platform
            }
          };
        } catch (err) {
          return { success: false, error: err.message, stderr: err.stderr || '' };
        }
      },
      enabled: true
    });
  }

  async trySearchAndReadFile(filePath) {
    const searchResults = await this.tools.searchFiles(path.basename(filePath), {
      maxDepth: 2,
      fileExtensions: null
    });
    if (searchResults.length === 0) {
      return { success: false, error: `未找到文件: ${filePath}` };
    }
    return await this.tools.readFile(searchResults[0]);
  }

  async executeCommand(command) {
    const safeCommand = InputValidator.validateCommand(command);
    const timeout = this.fileToolsCfg.runTimeoutMs;
    const fullCommand = this.buildFullCommand(safeCommand, this.workspace);
    const opts = {
      maxBuffer: 10 * 1024 * 1024,
      cwd: this.workspace,
      timeout,
      env: { ...process.env }
    };
    if (IS_WINDOWS) {
      opts.shell = 'cmd.exe';
    } else {
      opts.shell = '/bin/sh';
    }
    const { stdout, stderr } = await exec(fullCommand, opts);
    return { output: (stdout ?? '').trim(), stderr: (stderr ?? '').trim() };
  }

  buildFullCommand(command, workspace) {
    const isPowerShellCmd = /^(Get-|Set-|New-|Remove-|Test-|Invoke-|Start-|Stop-)/i.test(command);
    if (IS_WINDOWS) {
      const ws = workspace.replace(/'/g, "''");
      return isPowerShellCmd
        ? `powershell -NoProfile -Command "Set-Location '${ws}'; ${command.replace(/"/g, '`"')}"`
        : `cd /d "${workspace}" && ${command}`;
    }
    const ws = workspace.replace(/'/g, `'\\''`);
    return `cd '${ws}' && ${command}`;
  }

  buildSystemPrompt() {
    return `【基础工具说明】
MCP：read / grep / write / delete_file / modify_file / list_files / run
当前工作区：${this.workspace}
read 受 maxReadChars 截断；run 受 aistream.tools.file 开关与超时约束。`;
  }
}
