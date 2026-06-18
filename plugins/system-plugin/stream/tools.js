/**
 * 基础工具工作流
 * 业务层：plugins/system-plugin/stream/
 * MCP 对齐 XRK-AGT system-Core/tools.js
 */
import AIStream from '../../../lib/aistream/aistream.js';
import path from 'path';
import { BaseTools } from '../../../lib/utils/base-tools.js';
import { InputValidator } from '../../../lib/utils/input-validator.js';
import { resolveToolsFileRuntime } from '../../../lib/utils/tools-file-config.js';
import { resolveConfiguredWorkspace } from '../lib/ai-workspace-runtime.js';
import { exec } from '../../../lib/utils/exec-async.js';
import { normalizeToolsRunCommand } from '../../../lib/utils/workspace-run-command.js';

const IS_WINDOWS = process.platform === 'win32';

export default class ToolsStream extends AIStream {
  workspace = resolveConfiguredWorkspace('');
  fileToolsCfg = resolveToolsFileRuntime();

  constructor() {
    super({
      name: 'tools',
      description: '基础工具工作流（read/grep/search_replace/write/modify_file/list_files/run）',
      version: '1.1.0',
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
    this.fileToolsCfg = resolveToolsFileRuntime();
    this.workspace = resolveConfiguredWorkspace(this.fileToolsCfg.workspace);
  }

  async init() {
    await super.init();
    this.applyFileToolsConfig();
    this.tools = new BaseTools(this.workspace);
    this.registerAllFunctions();
  }

  _packReadSuccess(result, { truncatedByMax = false, maxChars } = {}) {
    const fullLen = result.fullContent?.length ?? result.content?.length ?? 0;
    const rangeNote = result.ranged
      ? `行 ${result.startLine}-${result.endLine} / 共 ${result.totalLines} 行`
      : `共 ${result.totalLines ?? '?'} 行`;
    const previewLimit = Math.min(this.fileToolsCfg.readRawPreviewChars, maxChars);
    let content = result.content;
    let truncated = truncatedByMax;
    if (typeof content === 'string' && content.length > maxChars) {
      content = content.slice(0, maxChars);
      truncated = true;
    }
    const preview =
      typeof content === 'string' && content.length > previewLimit
        ? `${content.slice(0, previewLimit)}\n…(预览截断；可缩小 startLine/endLine 或 grep 定位)`
        : content;
    const rawLines = [
      `文件: ${result.path}`,
      rangeNote,
      `字符: ${fullLen}${truncated ? `（返回已截断至 ${maxChars}）` : ''}`,
      '',
      preview
    ];
    return {
      success: true,
      raw: rawLines.join('\n'),
      data: {
        filePath: result.path,
        fileName: path.basename(result.path),
        content,
        startLine: result.startLine,
        endLine: result.endLine,
        totalLines: result.totalLines,
        lineCount: result.lineCount,
        ranged: !!result.ranged,
        size: fullLen,
        returnedChars: typeof content === 'string' ? content.length : 0,
        truncated,
        maxReadChars: maxChars
      }
    };
  }

  registerAllFunctions() {
    this.registerMCPTool('read', {
      description:
        '读取工作区文本文件。可选 startLine/endLine（1 起始，含首尾）只看部分行；返回带行号前缀，便于 search_replace。不传行号则读全文件（大文件会截断）。',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '文件路径（相对工作区）' },
          startLine: { type: 'integer', description: '起始行号（1 起始，可选）' },
          endLine: { type: 'integer', description: '结束行号（含，可选）' },
          showLineNumbers: { type: 'boolean', description: '是否带行号前缀', default: true }
        },
        required: ['filePath']
      },
      handler: async (args = {}) => {
        const { filePath, startLine, endLine, showLineNumbers } = args;
        if (!filePath) return { success: false, error: '文件路径不能为空' };
        let result = await this.tools.readFile(filePath, { startLine, endLine, showLineNumbers });
        if (!result.success) result = await this.trySearchAndReadFile(filePath, { startLine, endLine, showLineNumbers });
        if (result.success) {
          return this._packReadSuccess(result, { maxChars: this.fileToolsCfg.maxReadChars });
        }
        return { success: false, error: result.error || `未找到文件: ${filePath}` };
      },
      enabled: true
    });

    this.registerMCPTool('grep', {
      description: '在工作区搜索文本（字面量，非正则元字符）。可指定 filePath；contextBefore/After 附带上下文行（0-5）。',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '搜索关键词' },
          filePath: { type: 'string', description: '限定单个文件（可选）' },
          contextBefore: { type: 'integer', description: '匹配行前上下文行数 0-5', default: 0 },
          contextAfter: { type: 'integer', description: '匹配行后上下文行数 0-5', default: 0 }
        },
        required: ['pattern']
      },
      handler: async (args = {}) => {
        const { pattern, filePath, contextBefore = 0, contextAfter = 0 } = args;
        if (!pattern) return { success: false, error: '搜索关键词不能为空' };
        const result = await this.tools.grep(pattern, filePath, {
          caseSensitive: false,
          lineNumbers: true,
          maxResults: this.fileToolsCfg.grepMaxResults,
          contextBefore,
          contextAfter
        });
        if (result.success) {
          const blocks = result.matches.map((m) => {
            if (m.snippet) {
              return `${m.file}:${m.line}\n${m.snippet}`;
            }
            return `${m.file}:${m.line}: ${m.content}`;
          });
          const head = `pattern="${pattern}"${filePath ? ` file=${filePath}` : ' scope=workspace'} 共 ${result.matches.length} 条`;
          return {
            success: true,
            raw: blocks.length ? `${head}\n\n${blocks.join('\n\n')}` : `${head}\n（无匹配）`,
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

    this.registerMCPTool('search_replace', {
      description:
        '按 oldText 精确替换为 newText（定向改代码，类似补丁）。oldText 须唯一；多处相同则加长上下文或 replaceAll=true。改前先 read 确认片段。',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '文件路径' },
          oldText: { type: 'string', description: '要被替换的原文（含足够上下文）' },
          newText: { type: 'string', description: '替换后的文本（可为空字符串）' },
          replaceAll: { type: 'boolean', description: '是否替换所有匹配', default: false }
        },
        required: ['filePath', 'oldText', 'newText']
      },
      handler: async (args = {}) => {
        const { filePath, oldText, newText, replaceAll = false } = args;
        if (!filePath) return { success: false, error: '文件路径不能为空' };
        const result = await this.tools.searchReplace(filePath, oldText, newText, { replaceAll });
        if (result.success) {
          return {
            success: true,
            raw: `已替换 ${result.replacements} 处${result.replaceAll ? '（全部）' : ''}：${result.path}`,
            data: result
          };
        }
        return { success: false, error: result.error, data: result.occurrences ? { occurrences: result.occurrences } : undefined };
      },
      enabled: true
    });

    this.registerMCPTool('write', {
      description: '整文件写入（覆盖）。新建或重写用此工具；局部改动优先 search_replace。',
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
          return { success: true, raw: `已写入 ${result.path}`, data: { filePath: result.path, message: '文件写入成功' } };
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
          return { success: true, raw: `已删除 ${result.path}`, data: { filePath: result.path, message: '文件删除成功' } };
        }
        return { success: false, error: result.error };
      },
      enabled: true
    });

    this.registerMCPTool('modify_file', {
      description: '追加或替换单行。mode=line 须 lineNumber；append/prepend 追加内容。整文件或片段改动请用 write / search_replace。',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '要写入的内容' },
          mode: {
            type: 'string',
            enum: ['line', 'append', 'prepend'],
            default: 'append'
          },
          lineNumber: { type: 'integer', description: '行号（mode=line 时必填，从 1 开始）' }
        },
        required: ['filePath', 'content']
      },
      handler: async (args = {}) => {
        const { filePath, content, mode = 'append', lineNumber } = args;
        if (!filePath || content === undefined) {
          return { success: false, error: '文件路径和内容不能为空' };
        }
        const result = await this.tools.modifyFile(filePath, content, { mode, lineNumber });
        if (result.success) {
          const msg = mode === 'line'
            ? `第 ${lineNumber} 行已替换`
            : mode === 'append'
              ? '已追加到文件末尾'
              : '已插入到文件开头';
          return {
            success: true,
            raw: `${msg}：${result.path}`,
            data: { filePath: result.path, mode, lineNumber, message: msg }
          };
        }
        return { success: false, error: result.error };
      },
      enabled: true
    });

    this.registerMCPTool('list_files', {
      description: '列出目录内容。maxDepth>1 时递归子目录，返回 relPath 相对工作区路径。',
      inputSchema: {
        type: 'object',
        properties: {
          dirPath: { type: 'string', description: '目录路径（可选，默认工作区根）' },
          includeHidden: { type: 'boolean', default: false },
          type: { type: 'string', enum: ['all', 'files', 'dirs'], default: 'all' },
          maxDepth: { type: 'integer', description: '递归深度，1=仅当前层', default: 1 }
        }
      },
      handler: async (args = {}) => {
        const { dirPath = null, includeHidden = false, type = 'all', maxDepth = 1 } = args;
        const result = await this.tools.listDir(dirPath, { includeHidden, type, maxDepth });
        if (result.success) {
          const lines = result.items.map((item) =>
            `- ${item.relPath || item.name} (${item.type || 'file'}${item.size != null ? `, ${item.size}B` : ''})`
          );
          return {
            success: true,
            raw: `目录: ${result.path}\n深度: ${result.maxDepth}\n共 ${result.items.length} 项:\n${lines.join('\n')}`,
            data: { path: result.path, items: result.items, count: result.items.length, maxDepth: result.maxDepth }
          };
        }
        return { success: false, error: result.error };
      },
      enabled: true
    });

    this.registerMCPTool('run', {
      description:
        '在工作区根目录（cwd）执行 shell 命令。路径请用相对路径（如 docs/foo.py），勿写 cd 到工作区、勿用引号包裹的 ~/绝对路径。Windows 支持 CMD/PowerShell；Linux/macOS 使用 /bin/sh。',
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
          const safeCommand = InputValidator.validateCommand(command);
          const normalized = normalizeToolsRunCommand(safeCommand, this.workspace);
          const { output, stderr } = await this.executeCommand(normalized);
          const maxOut = this.fileToolsCfg.maxCommandOutputChars;
          let out = output;
          let truncated = false;
          if (out.length > maxOut) {
            out = out.slice(0, maxOut);
            truncated = true;
          }
          const errPart = stderr ? String(stderr).slice(0, maxOut) : '';
          const rawParts = [`命令: ${normalized}`, `平台: ${process.platform}`];
          if (normalized !== safeCommand.trim()) {
            rawParts.unshift(`原始命令: ${safeCommand.trim()}`);
          }
          if (out) rawParts.push(`输出:\n${out}`);
          if (errPart) rawParts.push(`stderr:\n${errPart}`);
          if (truncated) rawParts.push(`(stdout 已截断至 ${maxOut} 字符)`);
          return {
            success: true,
            raw: rawParts.join('\n\n'),
            data: {
              command: normalized,
              originalCommand: safeCommand.trim(),
              output: out,
              stderr: errPart,
              truncated,
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

  async trySearchAndReadFile(filePath, readOpts = {}) {
    const searchResults = await this.tools.searchFiles(path.basename(filePath), {
      maxDepth: 2,
      fileExtensions: null
    });
    if (searchResults.length === 0) {
      return { success: false, error: `未找到文件: ${filePath}` };
    }
    return await this.tools.readFile(searchResults[0], readOpts);
  }

  async executeCommand(command) {
    const safeCommand = InputValidator.validateCommand(command);
    const timeout = this.fileToolsCfg.runTimeoutMs;
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
    const runCommand = this.buildFullCommand(safeCommand, this.workspace);
    const { stdout, stderr } = await exec(runCommand, opts);
    return { output: (stdout ?? '').trim(), stderr: (stderr ?? '').trim() };
  }

  buildFullCommand(command, workspace) {
    const isPowerShellCmd = /^(Get-|Set-|New-|Remove-|Test-|Invoke-|Start-|Stop-)/i.test(command);
    if (IS_WINDOWS && isPowerShellCmd) {
      const ws = workspace.replace(/'/g, "''");
      return `powershell -NoProfile -Command "Set-Location '${ws}'; ${command.replace(/"/g, '`"')}"`;
    }
    return command;
  }

  buildSystemPrompt() {
    return `【基础工具说明】
MCP：read（可按行） / grep（可带上下文） / search_replace（定向补丁） / write / modify_file / list_files / run / delete_file
当前工作区：${this.workspace}
改代码推荐：grep 定位 → read(startLine,endLine) 看上下文 → search_replace(oldText,newText) 精确改；整文件用 write。
modify_file 仅 append/prepend/单行 line；勿用已移除的 replace 整文件模式。
list_files 可 maxDepth 递归；read 行号从 1 开始，返回带 N| 前缀。`;
  }
}
