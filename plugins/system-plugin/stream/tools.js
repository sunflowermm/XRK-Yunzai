/**
 * 基础工具工作流
 * 业务层：plugins/system-plugin/stream/
 */
import AIStream from '../../../lib/aistream/aistream.js';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { BaseTools } from '../../../lib/utils/base-tools.js';

const execAsync = promisify(exec);
const IS_WINDOWS = process.platform === 'win32';

export default class ToolsStream extends AIStream {
  constructor() {
    super({
      name: 'tools',
      description: '基础工具工作流（read/grep/write/run）',
      version: '1.0.5',
      author: 'XRK',
      priority: 200,
      config: {
        enabled: true,
        temperature: 0.3,
        maxTokens: 2000,
        topP: 0.9
      }
    });
    this.workspace = path.join(os.homedir(), 'Desktop');
    this.tools = new BaseTools(this.workspace);
  }

  async init() {
    await super.init();
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
          return {
            success: true,
            data: {
              filePath: result.path,
              fileName: path.basename(result.path),
              content: result.content,
              size: result.content.length
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
          maxResults: 50
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
      description: '写入文件内容（完全覆盖）。文件不存在时自动创建。',
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
      description: '执行系统命令。在工作区目录下执行。',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', description: '要执行的命令' } },
        required: ['command']
      },
      handler: async (args = {}) => {
        if (!IS_WINDOWS) return { success: false, error: 'run 命令仅在 Windows 上支持' };
        const { command } = args;
        if (!command) return { success: false, error: '命令不能为空' };
        try {
          const output = await this.executeCommand(command);
          return {
            success: true,
            data: { command, output, message: '命令执行成功' }
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
    const fullCommand = this.buildFullCommand(command, this.workspace);
    const { stdout } = await execAsync(fullCommand, {
      maxBuffer: 10 * 1024 * 1024,
      cwd: this.workspace,
      shell: IS_WINDOWS ? 'cmd.exe' : undefined
    });
    return (stdout ?? '').trim();
  }

  buildFullCommand(command, workspace) {
    const isPowerShellCmd = /^(Get-|Set-|New-|Remove-|Test-|Invoke-|Start-|Stop-)/i.test(command);
    if (IS_WINDOWS) {
      return isPowerShellCmd
        ? `powershell -NoProfile -Command "Set-Location '${workspace}'; ${command.replace(/"/g, '`"')}"`
        : `cd /d "${workspace}" && ${command}`;
    }
    return `cd "${workspace}" && ${command}`;
  }

  buildSystemPrompt() {
    return `【基础工具说明】
所有功能都通过 MCP 工具提供：
- read：读取文件内容
- grep：在文件中搜索文本
- write：写入文件内容（覆盖）
- list_files：列出目录中的文件
- run：执行命令（工作区：桌面）`;
  }
}
