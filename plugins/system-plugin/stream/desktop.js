/**
 * 桌面与通用助手工作流（与 tools/chat 一致使用相对路径，便于 StreamLoader 动态 import）
 */
import path from 'path';
import os from 'os';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import AIStream from '../../../lib/aistream/aistream.js';
import { BaseTools } from '../../../lib/utils/base-tools.js';
import { FileUtils } from '../../../lib/utils/file-utils.js';
import si from 'systeminformation';
import { resolveProjectPath, DATA_TRASH_DIR } from '../../../lib/config/config-constants.js';
import { getAistreamConfigOptional } from '../../../lib/utils/aistream-config.js';
import { resolveConfiguredWorkspace } from '../lib/ai-workspace-runtime.js';

const paths = { root: resolveProjectPath(), trash: resolveProjectPath(DATA_TRASH_DIR) };

const IS_WINDOWS = process.platform === 'win32';
const execAsync = promisify(exec);

const execCommand = (command, options = {}) => {
  return new Promise((resolve, reject) => {
    exec(command, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        return reject(error);
      }
      resolve(stdout ?? '');
    });
  });
};

/**
 * 桌面与通用助手工作流
 * 
 * 所有功能都通过 MCP 工具提供：
 * - 系统操作：show_desktop、open_system_tool、lock_screen、power_control
 * - 文件操作：create_folder、open_explorer、open_application
 * - 网络操作：open_browser
 * - 命令执行：cleanup_processes（注意：执行命令请使用 tools 工作流的 run 工具）
 * - 信息读取：screenshot、system_info、disk_space（注意：列出文件请使用 tools 工作流的 list_files 工具）
 */
export default class DesktopStream extends AIStream {
  workspace = resolveConfiguredWorkspace('');
  processCleanupInterval = null;

  constructor() {
    super({
      name: 'desktop',
      description: '桌面与通用助手工作流',
      version: '2.0.0',
      author: 'XRK',
      priority: 100,
      config: {
        enabled: true,
        temperature: 0.8,
        maxTokens: 4000,
        topP: 0.9,
        presencePenalty: 0.6,
        frequencyPenalty: 0.6
      }
    });
  }

  /**
   * 获取工作区路径
   */
  getWorkspace() {
    return this.workspace;
  }

  async init() {
    await super.init();
    const fileCfg = getAistreamConfigOptional().tools?.file ?? {};
    this.workspace = resolveConfiguredWorkspace(fileCfg.workspace ?? '');
    this.tools = new BaseTools(this.workspace);
    this.registerAllFunctions();

    if (IS_WINDOWS) {
      this.processCleanupInterval = setInterval(async () => {
        try {
          await this.tools.autoCleanupProcesses([
            /explorer/i, /System/i, /winlogon/i, /csrss/i, /smss/i,
            /svchost/i, /dwm/i, /wininit/i
          ]);
        } catch (err) {
          Bot.makeLog('debug', `[desktop] autoCleanupProcesses 跳过: ${err?.message || err}`, 'DesktopStream');
        }
      }, 30000);
    }

  }


  requireWindows(context, _operation) {
    if (IS_WINDOWS) return true;
    context.windowsOnly = true;
    return false;
  }

  /**
   * 统一参数获取：支持多种参数名（兼容MCP工具和内部调用）
   */
  getParam(params, ...keys) {
    if (!params) return;
    for (const key of keys) {
      if (params[key] !== undefined) {
        return params[key];
      }
    }
    return;
  }

  /**
   * 统一文件名安全处理
   */
  sanitizeFileName(fileName) {
    if (!fileName) return '';
    return fileName.replace(/[<>:"/\\|?*]/g, '_');
  }


  /**
   * 注册所有MCP工具
   */
  registerAllFunctions() {
    this.registerMCPTool('show_desktop', {
      description: '回到桌面（最小化所有窗口）。仅 Windows 系统支持。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        if (!this.requireWindows(context, '回桌面功能')) {
          return this.errorResponse('WINDOWS_ONLY', '此功能仅在Windows系统上可用');
        }

        try {
          await execAsync('powershell -Command "(New-Object -ComObject shell.application).MinimizeAll()"', { timeout: 5000 });
          return this.successResponse({ message: '已回到桌面' });
        } catch (err) {
          Bot.makeLog('error', `[desktop] 回桌面失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('SHOW_DESKTOP_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('open_system_tool', {
      description: '打开Windows系统内置工具。支持：notepad（记事本）、calc（计算器）、taskmgr（任务管理器）。仅 Windows 系统支持。',
      inputSchema: {
        type: 'object',
        properties: {
          tool: {
            type: 'string',
            description: '工具名称',
            enum: ['notepad', 'calc', 'taskmgr']
          }
        },
        required: ['tool']
      },
      handler: async (args = {}, context = {}) => {
        if (!this.requireWindows(context, '打开系统工具功能')) {
          return this.errorResponse('WINDOWS_ONLY', '此功能仅在Windows系统上可用');
        }

        const { tool } = args;
        if (!tool) {
          return this.errorResponse('INVALID_PARAM', '工具名称不能为空');
        }

        const toolNames = { notepad: '记事本', calc: '计算器', taskmgr: '任务管理器' };

        try {
          await execCommand(`start "" ${tool}`, { shell: 'cmd.exe' });
          return this.successResponse({ 
            message: `已打开${toolNames[tool] || '应用'}`,
            tool: toolNames[tool] || tool
          });
        } catch (err) {
          Bot.makeLog('error', `[desktop] 打开系统工具失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('OPEN_SYSTEM_TOOL_FAILED', err.message);
        }
      },
      enabled: true
    });
    this.registerMCPTool('screenshot', {
      description: '截取屏幕截图。保存为PNG文件，QQ群聊中会自动发送。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        try {
          const screenshot = (await import('screenshot-desktop')).default;

          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
          const screenshotDir = path.join(paths.trash, 'screenshot');
          await FileUtils.ensureDir(screenshotDir);

          const filename = `screenshot_${timestamp}.png`;
          const screenshotPath = path.join(screenshotDir, filename);

          const img = await screenshot({ screen: -1 });
          await FileUtils.writeFileBuffer(screenshotPath, img);

          const stats = await FileUtils.stat(screenshotPath);
          if (stats.size === 0) {
            throw new Error('截屏文件为空');
          }

          // 记录到当前工作流上下文，方便后续继续使用
          if (context.stream) {
            context.stream.context = context.stream.context || {};
            context.stream.context.screenshotPath = screenshotPath;
            context.stream.context.screenshotSize = stats.size;
          }

          // 如果是从 QQ 事件触发的，并且有 e，可直接把图片发回去
          const e = context.e;
          if (e && typeof e.reply === 'function') {
            try {
              const seg = segment;
              await e.reply([seg.image(screenshotPath)]);
            } catch (err) {
              Bot.makeLog(
                'warn',
                `[desktop.screenshot] 截图发送到会话失败: ${err.message}`,
                'DesktopStream'
              );
            }
          }

          Bot.makeLog('info', `截图成功: ${screenshotPath} (${stats.size} bytes)`, 'DesktopStream');
          
          return this.successResponse({
            filePath: screenshotPath,
            fileName: filename,
            size: stats.size
          });
        } catch (err) {
          Bot.makeLog('error', `[desktop] 截屏失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('SCREENSHOT_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('lock_screen', {
      description: '锁定电脑屏幕。仅 Windows 系统支持。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        if (!this.requireWindows(context, '锁屏功能')) {
          return this.errorResponse('WINDOWS_ONLY', '此功能仅在Windows系统上可用');
        }

        try {
          await execCommand('rundll32.exe user32.dll,LockWorkStation');
          return this.successResponse({ message: '屏幕已锁定' });
        } catch (err) {
          Bot.makeLog('error', `[desktop] 锁屏失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('LOCK_SCREEN_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('system_info', {
      description: '查看系统信息。返回CPU和内存使用情况。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        try {
          // 使用systeminformation库获取系统信息（跨平台）
          const [cpu, mem] = await Promise.all([
            si.currentLoad(),
            si.mem()
          ]);

          const cpuUsage = cpu.currentLoad ? cpu.currentLoad.toFixed(1) : '0.0';
          const memTotal = mem.total / 1024 / 1024 / 1024;
          const memFree = mem.free / 1024 / 1024 / 1024;
          const memUsed = mem.used / 1024 / 1024 / 1024;
          const memUsedPercent = ((memUsed / memTotal) * 100).toFixed(1);

          const systemInfo = {
            cpu: `${cpuUsage}%`,
            memory: {
              usedPercent: `${memUsedPercent}%`,
              freeGB: `${memFree.toFixed(2)}GB`,
              totalGB: `${memTotal.toFixed(2)}GB`,
              usedGB: `${memUsed.toFixed(2)}GB`
            }
          };

          if (context.stream) {
            context.stream.context = context.stream.context || {};
            context.stream.context.systemInfo = systemInfo;
          }

          return this.successResponse(systemInfo);
        } catch (err) {
          Bot.makeLog('error', `[desktop] 获取系统信息失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('SYSTEM_INFO_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('get_time', {
      description: '获取当前时间。支持多种格式（ISO、本地格式、时间戳、Unix时间戳）和时区设置。',
      inputSchema: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['iso', 'locale', 'timestamp', 'unix'],
            description: '时间格式: iso(ISO 8601), locale(本地格式), timestamp(毫秒时间戳), unix(秒时间戳)',
            default: 'locale'
          },
          timezone: {
            type: 'string',
            description: '时区（可选，例如: Asia/Shanghai, America/New_York）'
          }
        },
        required: []
      },
      handler: async (args = {}, context = {}) => {
        try {
          const { format = 'locale', timezone } = args;
          const now = new Date();
          const options = timezone ? { timeZone: timezone } : {};

          let result;
          switch (format) {
            case 'iso':
              result = {
                format: 'iso',
                time: now.toISOString(),
                timestamp: now.getTime(),
                unix: Math.floor(now.getTime() / 1000)
              };
              break;
            case 'timestamp':
              result = {
                format: 'timestamp',
                timestamp: now.getTime(),
                unix: Math.floor(now.getTime() / 1000),
                iso: now.toISOString()
              };
              break;
            case 'unix':
              result = {
                format: 'unix',
                unix: Math.floor(now.getTime() / 1000),
                timestamp: now.getTime(),
                iso: now.toISOString()
              };
              break;
            case 'locale':
            default:
              result = {
                format: 'locale',
                time: now.toLocaleString('zh-CN', options),
                date: now.toLocaleDateString('zh-CN', options),
                timeOnly: now.toLocaleTimeString('zh-CN', options),
                timestamp: now.getTime(),
                unix: Math.floor(now.getTime() / 1000),
                iso: now.toISOString()
              };
          }

          return this.successResponse(result);
        } catch (err) {
          Bot.makeLog('error', `[desktop] 获取时间失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('GET_TIME_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('open_browser', {
      description: '打开浏览器访问网页。在默认浏览器中打开指定的URL，支持跨平台。',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '网页URL（必须包含协议，如 https://）'
          }
        },
        required: ['url']
      },
      handler: async (args = {}, _context = {}) => {
        const url = this.getParam(args, 'url');
        if (!url) {
          return this.errorResponse('INVALID_PARAM', 'URL不能为空');
        }

        const commands = {
          win32: `start "" "${url}"`,
          darwin: `open "${url}"`,
          linux: `xdg-open "${url}"`
        };

        try {
          const command = commands[process.platform] || commands.linux;
          await execCommand(command, { shell: IS_WINDOWS ? 'cmd.exe' : undefined });
          return this.successResponse({ message: `已打开浏览器访问: ${url}`, url });
        } catch (err) {
          Bot.makeLog('error', `[desktop] 打开浏览器失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('OPEN_BROWSER_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('power_control', {
      description: '关机或重启电脑',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: '操作类型：shutdown（60秒后关机）、shutdown_now（立即关机）、restart（60秒后重启）、cancel（取消关机/重启）',
            enum: ['shutdown', 'shutdown_now', 'restart', 'cancel']
          }
        },
        required: ['action']
      },
      handler: async (args = {}, context = {}) => {
        if (!this.requireWindows(context, '关机/重启功能')) {
          return this.errorResponse('WINDOWS_ONLY', '此功能仅在Windows系统上可用');
        }

        const commands = {
          shutdown: { cmd: 'shutdown /s /t 60', delay: 60 },
          shutdown_now: { cmd: 'shutdown /s /t 0', delay: 0 },
          restart: { cmd: 'shutdown /r /t 60', delay: 60 },
          cancel: { cmd: 'shutdown /a' }
        };

        const { action } = args;
        if (!action) {
          return this.errorResponse('INVALID_PARAM', '操作类型不能为空');
        }

        const config = commands[action];
        if (!config) {
          return this.errorResponse('INVALID_PARAM', `不支持的操作类型: ${action}`);
        }

        try {
          await execCommand(config.cmd);
          return this.successResponse({ 
            message: action === 'cancel' ? '已取消关机/重启' : `已执行${action}操作`,
            action,
            delay: config.delay
          });
        } catch (err) {
          Bot.makeLog('error', `[desktop] 电源控制失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('POWER_CONTROL_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('create_folder', {
      description: '在桌面创建文件夹',
      inputSchema: {
        type: 'object',
        properties: {
          folderName: {
            type: 'string',
            description: '文件夹名称'
          }
        },
        required: ['folderName']
      },
      handler: async (args = {}, context = {}) => {
        if (!this.requireWindows(context, '创建文件夹功能')) {
          return this.errorResponse('WINDOWS_ONLY', '此功能仅在Windows系统上可用');
        }

        const { folderName } = args;
        if (!folderName) {
          return this.errorResponse('INVALID_PARAM', '文件夹名称不能为空');
        }

        try {
          const workspace = this.getWorkspace();
          const safeName = this.sanitizeFileName(folderName);
          const folderPath = path.join(workspace, safeName);

          await FileUtils.ensureDir(folderPath);

          return this.successResponse({ 
            message: `已创建文件夹: ${safeName}`,
            folderPath,
            folderName: safeName
          });
        } catch (err) {
          Bot.makeLog('error', `[desktop] 创建文件夹失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('CREATE_FOLDER_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('open_explorer', {
      description: '打开文件管理器',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, _context = {}) => {
        const commands = {
          win32: 'explorer',
          darwin: 'open .',
          linux: 'xdg-open .'
        };

        try {
          const command = commands[process.platform] || commands.linux;
          await execCommand(command);
          return this.successResponse({ message: '已打开文件管理器' });
        } catch (err) {
          Bot.makeLog('error', `[desktop] 打开资源管理器失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('OPEN_EXPLORER_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('disk_space', {
      description: '查看各磁盘的使用情况',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        try {
          // 使用systeminformation库获取磁盘空间（跨平台）
          const fsSize = await si.fsSize();
          const disks = [];

          for (const disk of fsSize) {
            const totalGB = disk.size / 1024 / 1024 / 1024; // GB
            const usedGB = disk.used / 1024 / 1024 / 1024; // GB
            const freeGB = (disk.size - disk.used) / 1024 / 1024 / 1024; // GB
            const usedPercent = ((disk.used / disk.size) * 100).toFixed(1);

            disks.push({
              mount: disk.mount,
              usedPercent: parseFloat(usedPercent),
              freeGB: parseFloat(freeGB.toFixed(2)),
              totalGB: parseFloat(totalGB.toFixed(2)),
              usedGB: parseFloat(usedGB.toFixed(2)),
              display: `${disk.mount} ${usedPercent}% 已用 (${freeGB.toFixed(2)}GB / ${totalGB.toFixed(2)}GB 可用)`
            });
          }

          if (context.stream) {
            context.stream.context = context.stream.context || {};
            context.stream.context.diskSpace = disks.length > 0 ? disks.map(d => d.display) : null;
          }

          return this.successResponse({
            disks,
            count: disks.length
          });
        } catch (err) {
          Bot.makeLog('error', `[desktop] 获取磁盘空间失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('DISK_SPACE_FAILED', err.message);
        }
      },
      enabled: true
    });


    this.registerMCPTool('open_application', {
      description: '打开应用程序',
      inputSchema: {
        type: 'object',
        properties: {
          appName: {
            type: 'string',
            description: '要打开的应用程序名称或路径'
          }
        },
        required: ['appName']
      },
      handler: async (args = {}, context = {}) => {
        if (!this.requireWindows(context, '打开软件')) {
          return this.errorResponse('WINDOWS_ONLY', '此功能仅在Windows系统上可用');
        }

        const { appName } = args;
        if (!appName) {
          return this.errorResponse('INVALID_PARAM', '应用程序名称不能为空');
        }

        try {
          const workspace = this.getWorkspace();
          const files = await FileUtils.readDir(workspace);
          let shortcutPath = null;

          for (const file of files) {
            if (file.endsWith('.lnk') && file.toLowerCase().includes(appName.toLowerCase())) {
              shortcutPath = path.join(workspace, file);
              break;
            }
          }

          if (shortcutPath) {
            await execAsync(`start "" "${shortcutPath}"`, { shell: 'cmd.exe' });
            return this.successResponse({ 
              message: `已打开应用程序: ${appName}`,
              appName,
              shortcutPath
            });
          } else {
            try {
              const child = spawn(appName, [], {
                detached: true,
                stdio: 'ignore',
                shell: true
              });
              child.unref();
            } catch (spawnErr) {
              Bot.makeLog('debug', `[desktop] spawn 回退 start: ${spawnErr?.message || spawnErr}`, 'DesktopStream');
              await execAsync(`start "" "${appName}"`, { shell: 'cmd.exe' });
            }
            return this.successResponse({ 
              message: `已打开应用程序: ${appName}`,
              appName
            });
          }
        } catch (err) {
          Bot.makeLog('error', `[desktop] 打开应用程序失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('OPEN_APPLICATION_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('cleanup_processes', {
      description: '清理无用进程',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, _context = {}) => {
        try {
          const result = await this.tools.cleanupProcesses();
          return this.successResponse({ 
            message: '进程清理完成',
            killed: result.killed || [],
            count: (result.killed || []).length
          });
        } catch (err) {
          Bot.makeLog('error', `[desktop] 清理进程失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('CLEANUP_PROCESSES_FAILED', err.message);
        }
      },
      enabled: true
    });
  }

  buildSystemPrompt(context) {
    const { question, e } = context;
    const persona =
      (question && (question.persona || question.PERSONA)) ||
      '你是一个智能桌面助手，帮助用户完成文件操作、系统管理等任务。';
    const now = new Date().toLocaleString('zh-CN');
    const isMaster = e?.isMaster === true;
    const workspace = this.getWorkspace();

    return `【人设】
${persona}
【工作区】
工作区：${workspace}
- 文件操作默认在此目录进行

【工具说明】
所有功能都通过MCP工具调用协议提供，包括：
- 系统操作：show_desktop, open_system_tool, lock_screen, power_control
- 文件操作：create_folder, open_explorer, open_application
- 网络操作：open_browser
- 命令执行：cleanup_processes（注意：执行命令请使用 tools 工作流的 run 工具）
- 信息读取：screenshot, system_info, disk_space（注意：列出文件请使用 tools 工作流的 list_files 工具）

【时间】
${now}
${isMaster ? '【权限】\n你拥有主人权限，可以执行所有系统操作。\n\n' : ''}【规则】
1. 执行功能时必须回复文本内容，不要只执行不回复
2. 优先使用MCP工具执行操作
3. 文件操作默认在工作区进行
`;
  }

  async buildChatContext(e, question) {
    const messages = [];

    messages.push({
      role: 'system',
      content: this.buildSystemPrompt({ e, question })
    });

    const text = typeof question === 'string'
      ? question
      : (question?.content ?? question?.text ?? '');

    // 从事件中提取图片（OneBot segments / device segments）
    // Web 客户端通过 WS -> http/device.js 会把 payload.message 作为 e.message 透传到工作流
    const images = [];
    if (e && Array.isArray(e.message)) {
      for (const seg of e.message) {
        if (!seg || typeof seg !== 'object') continue;
        if (seg.type !== 'image') continue;
        const url = seg.url || seg.data?.url || seg.data?.file;
        if (url) images.push(url);
      }
    }

    const userName =
      question?.userName ||
      question?.username ||
      e?.sender?.card ||
      e?.sender?.nickname ||
      '用户';

    const userId = question?.userId || e?.user_id || '';
    const prefix = userId ? `${userName}(${userId}): ` : `${userName}: `;

    // 多模态：若存在图片，则按 {text, images} 结构交给 LLM 工厂统一转各家协议
    if (images.length > 0) {
      messages.push({
        role: 'user',
        content: {
          text: `${prefix}${text}`,
          images
        }
      });
    } else {
      messages.push({
        role: 'user',
        content: `${prefix}${text}`
      });
    }

    return messages;
  }

  async cleanup() {
    if (this.processCleanupInterval) {
      clearInterval(this.processCleanupInterval);
      this.processCleanupInterval = null;
    }

    if (this.tools) {
      await this.tools.cleanupProcesses();
    }

    await super.cleanup();
  }
}
