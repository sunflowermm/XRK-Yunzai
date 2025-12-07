import AIStream from '../../lib/aistream/aistream.js';
import BotUtil from '../../lib/common/util.js';
import { parseEmotionFromText, normalizeEmotion } from '../../components/util/emotionUtil.js';
import { EMOTION_KEYWORDS } from '../../components/config/deviceConfig.js';
import cfg from '../../lib/config/config.js';
import { WorkflowManager } from '../../lib/aistream/workflow-manager.js';
import fs from 'fs';
import path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execAsync = promisify(exec);

/**
 * 设备工作流（增强版）
 * - 解析响应中的表情标记并驱动设备显示/表情与TTS
 * - 支持 [开心]、[开心}、[惊讶] 等简写
 * - 返回 { text, emotion } 给调用方（emotion为英文代码，如'happy'）
 * - 集成记忆系统、推理调优、润色功能
 */
export default class DeviceStream extends AIStream {
  constructor() {
    super({
      name: 'device',
      description: '设备工作流（增强版）',
      version: '2.0.0',
      author: 'XRK',
      priority: 5,
      config: {
        enabled: true,
        temperature: 0.7,
        maxTokens: 4000,
        topP: 0.9,
        presencePenalty: 0.3,
        frequencyPenalty: 0.3
      },
      embedding: {
        enabled: false
      }
    });

    // 润色配置
    const polishCfg = cfg.kuizai?.ai?.responsePolish || {};
    this.responsePolishConfig = {
      enabled: polishCfg.enabled ?? true,
      maxTokens: polishCfg.maxTokens || 400,
      temperature: polishCfg.temperature ?? 0.3,
      instructions: polishCfg.instructions || `你是设备语音助手回复润色器，只能做轻微整理：
1. 删除舞台提示、括号或方括号里未执行的工具描述
2. 保留原意，语气自然，像正常对话，尽量简短
3. 不要添加新信息，只输出纯文本`
    };

    // 推理调优配置
    this.reasoningConfig = {
      enabled: cfg.kuizai?.ai?.reasoning?.enabled ?? false,
      maxIterations: cfg.kuizai?.ai?.reasoning?.maxIterations || 3,
      temperature: cfg.kuizai?.ai?.reasoning?.temperature || 0.8
    };

    // 确保functions已初始化
    if (!this.functions) {
      this.functions = new Map();
    }

    // 创建工作流管理器（用于记忆系统等扩展功能）
    this.workflowManager = new DeviceWorkflowManager(this);

    // 注册工作助手功能
    this.registerAllFunctions();
  }

  /**
   * 注册所有工作助手功能
   */
  registerAllFunctions() {
    // 1. 文件搜索功能
    this.registerFunction('searchFile', {
      description: '搜索文件',
      prompt: `[搜索文件:路径:关键词] - 在指定路径下搜索文件
示例：[搜索文件:C:\\Users:test.txt] 或 [搜索文件:/home:config]`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[搜索文件:([^:]+):([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'searchFile', 
            params: { 
              searchPath: match[1].trim(),
              keyword: match[2].trim()
            },
            raw: match[0]
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        try {
          const results = await this.searchFiles(params.searchPath, params.keyword);
          return { type: 'text', content: results };
        } catch (error) {
          BotUtil.makeLog('error', `文件搜索失败: ${error.message}`, 'DeviceStream');
          return { type: 'text', content: `搜索失败: ${error.message}` };
        }
      },
      enabled: true
    });

    // 2. 打开软件功能（Windows/Linux）
    this.registerFunction('openApp', {
      description: '打开软件',
      prompt: `[打开软件:软件名或路径] - 打开指定软件
Windows示例：[打开软件:notepad] 或 [打开软件:C:\\Program Files\\App\\app.exe]
Linux示例：[打开软件:gedit] 或 [打开软件:/usr/bin/firefox]`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[打开软件:([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'openApp', 
            params: { app: match[1].trim() },
            raw: match[0]
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        try {
          const result = await this.openApplication(params.app);
          return { type: 'text', content: result };
        } catch (error) {
          BotUtil.makeLog('error', `打开软件失败: ${error.message}`, 'DeviceStream');
          return { type: 'text', content: `打开失败: ${error.message}` };
        }
      },
      enabled: true
    });

    // 3. 整理桌面功能（Windows/Linux）
    this.registerFunction('organizeDesktop', {
      description: '整理桌面',
      prompt: `[整理桌面] - 整理桌面文件，按类型分类到文件夹`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[整理桌面\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ 
            type: 'organizeDesktop', 
            params: {},
            raw: match[0]
          });
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        try {
          const result = await this.organizeDesktop();
          return { type: 'text', content: result };
        } catch (error) {
          BotUtil.makeLog('error', `整理桌面失败: ${error.message}`, 'DeviceStream');
          return { type: 'text', content: `整理失败: ${error.message}` };
        }
      },
      enabled: true
    });

    // 4. Node.js函数调用
    this.registerFunction('callNodeFunction', {
      description: '调用Node.js函数',
      prompt: `[调用函数:函数名:参数JSON] - 执行Node.js函数
示例：[调用函数:Math.max:{"a":1,"b":2}] 或 [调用函数:fs.readFileSync:{"path":"test.txt","encoding":"utf8"}]`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[调用函数:([^:]+):([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          try {
            const funcName = match[1].trim();
            const paramsJson = match[2].trim();
            const params = JSON.parse(paramsJson);
            
            functions.push({ 
              type: 'callNodeFunction', 
              params: { 
                functionName: funcName,
                arguments: params
              },
              raw: match[0]
            });
          } catch (e) {
            BotUtil.makeLog('warn', `解析函数参数失败: ${e.message}`, 'DeviceStream');
          }
        }
        
        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }
        
        return { functions, cleanText };
      },
      handler: async (params, context) => {
        try {
          const result = await this.callNodeFunction(params.functionName, params.arguments);
          return { type: 'text', content: result };
        } catch (error) {
          BotUtil.makeLog('error', `函数调用失败: ${error.message}`, 'DeviceStream');
          return { type: 'text', content: `调用失败: ${error.message}` };
        }
      },
      enabled: true
    });

    // 6. 扩展工作流（记忆系统等）
    this.registerFunction('workflow', {
      description: '调用扩展工作流（记忆系统等）',
      prompt: `[工作流:类型:可选参数] - 触发扩展动作
记忆相关：
- [工作流:memory:长期|用户喜欢原神] - 记住信息（支持长期/短期，默认长期）
- [工作流:memory-recall] - 回忆记忆
- [工作流:memory-forget:要删除的内容] - 删除记忆（支持id:xxx或内容关键词）`,
      parser: (text, context) => {
        const functions = [];
        let cleanText = text;
        const regex = /\[工作流:([^\]:]+)(?::([^\]]+))?\]/g;
        let match;

        while ((match = regex.exec(text))) {
          functions.push({
            type: 'workflow',
            params: {
              workflow: match[1]?.trim(),
              argument: match[2]?.trim()
            },
            raw: match[0]
          });
        }

        if (functions.length > 0) {
          cleanText = text.replace(regex, '').trim();
        }

        return { functions, cleanText };
      },
      handler: async (params, context) => {
        if (!this.workflowManager) {
          return { type: 'text', content: '' };
        }
        
        const enrichedContext = {
          ...context,
          persona: context.question?.persona || context.persona,
          config: context.config || context.question?.config
        };
        
        const result = await this.workflowManager.run(params.workflow, params, enrichedContext);
        return result;
      },
      enabled: true
    });
  }

  /**
   * 系统提示：引导模型优先返回简洁中文，并可选择一个表情指令
   * 集成记忆系统提示和工作助手功能
   */
  buildSystemPrompt(context) {
    const persona = context?.persona || '你是一个简洁友好的设备语音助手，以地道中文回答。';
    const supportedEmotions = Object.keys(EMOTION_KEYWORDS).join(' ');
    
    // 获取系统信息
    const systemInfo = this.getSystemInfo();
    
    // 获取记忆摘要
    const memorySystem = this.getMemorySystem();
    const memorySummary = context?.memorySummary || '';
    const memoryHint = memorySystem?.isEnabled() && memorySummary
      ? `\n【记忆提示】\n${memorySummary}\n`
      : '';

    // 获取功能提示
    const functionsPrompt = this.buildFunctionsPrompt();

    return `【人设】
${persona}
${memoryHint}
【系统信息】
${systemInfo}
【规则】
1. 尽量简洁，优先中文
2. 如需展示表情或动画，请在文本前加一个表情标记（可选）：
   [${supportedEmotions}]
3. 最多一个表情标记
4. 不要输出多余解释
5. 参考记忆提示中的信息，但不要直接重复
${functionsPrompt}`;
  }

  /**
   * 获取系统信息
   */
  getSystemInfo() {
    const platform = os.platform();
    const arch = os.arch();
    const hostname = os.hostname();
    const cpus = os.cpus();
    const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
    const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
    const uptime = Math.floor(os.uptime() / 3600);
    
    let platformName = '未知系统';
    if (platform === 'win32') {
      platformName = 'Windows';
    } else if (platform === 'darwin') {
      platformName = 'macOS';
    } else if (platform === 'linux') {
      platformName = 'Linux';
    }
    
    return `操作系统: ${platformName} (${arch})
主机名: ${hostname}
CPU核心数: ${cpus.length}
总内存: ${totalMem}GB
可用内存: ${freeMem}GB
系统运行时间: ${uptime}小时`;
  }

  /**
   * 构建消息（增强版：集成记忆系统，支持历史上下文）
   */
  async buildChatContext(e, question) {
    const text = typeof question === 'string' ? question : (question?.text || question?.content || '');
    const history = question?.history || [];
    
    // 获取记忆摘要
    const memorySummary = await this.buildMemorySummary(e || { device_id: question?.deviceId });
    
    const messages = [
      { 
        role: 'system', 
        content: this.buildSystemPrompt({ 
          persona: question?.persona,
          memorySummary
        }) 
      }
    ];
    
    // 如果有历史上下文，添加到消息中
    if (Array.isArray(history) && history.length > 0) {
      // 转换历史消息格式：确保role为'user'或'assistant'
      history.forEach(msg => {
        if (msg.role && msg.text) {
          const role = msg.role === 'user' ? 'user' : (msg.role === 'assistant' ? 'assistant' : 'user');
          messages.push({
            role,
            content: msg.text
          });
        }
      });
    }
    
    // 添加当前用户消息
    messages.push({ role: 'user', content: text || '你好' });
    
    return messages;
  }

  /**
   * 推理调优：多轮思考优化回复
   */
  async reasoningOptimize(messages, apiConfig) {
    if (!this.reasoningConfig.enabled) {
      return null;
    }

    try {
      const reasoningPrompt = `请对以下对话进行推理思考，优化回复质量：
1. 分析用户意图
2. 考虑上下文和记忆
3. 生成更合适的回复

对话：
${messages.map(m => `${m.role}: ${m.content}`).join('\n')}

请输出优化后的回复（只输出回复内容，不要输出思考过程）：`;

      const reasoningMessages = [
        { role: 'system', content: '你是一个推理优化助手，帮助优化AI回复质量。' },
        { role: 'user', content: reasoningPrompt }
      ];

      const optimized = await this.callAI(reasoningMessages, {
        ...apiConfig,
        temperature: this.reasoningConfig.temperature
      });

      return optimized;
    } catch (error) {
      BotUtil.makeLog('debug', `推理调优失败: ${error.message}`, 'DeviceStream');
      return null;
    }
  }

  /**
   * 润色回复
   */
  async polishResponse(text, persona = '') {
    if (!this.responsePolishConfig?.enabled || !text) {
      return text;
    }

    try {
      const messages = [
        {
          role: 'system',
          content: `${persona || '你是设备语音助手'}\n\n${this.responsePolishConfig.instructions}`
        },
        {
          role: 'user',
          content: text
        }
      ];

      const polished = await this.callAI(messages, {
        maxTokens: this.responsePolishConfig.maxTokens,
        temperature: this.responsePolishConfig.temperature
      });

      return polished ? polished.trim() : text;
    } catch (error) {
      BotUtil.makeLog('debug', `润色失败: ${error.message}`, 'DeviceStream');
      return text;
    }
  }

  /**
   * 执行设备工作流并解析输出（增强版：集成记忆、推理、润色、功能调用）
   * 如果提供了deviceBot，会直接调用emotion()切换表情
   */
  async execute(deviceId, question, apiConfig, deviceInfo = {}, persona = '', deviceBot = null) {
    try {
      // 构建事件对象（用于记忆系统）
      const e = {
        device_id: deviceId,
        user_id: deviceInfo?.user_id || 'device_user',
        self_id: deviceId
      };

      const context = { e, question, config: apiConfig, deviceBot, persona };

      // 构建消息（包含记忆）
      const messages = await this.buildChatContext(e, { 
        text: question, 
        persona,
        deviceId
      });

      // 调用AI
      let response = await this.callAI(messages, apiConfig);
      if (!response) {
        return null;
      }

      // 推理调优（可选）
      if (this.reasoningConfig.enabled) {
        const optimized = await this.reasoningOptimize(messages, apiConfig);
        if (optimized) {
          response = optimized;
        }
      }

      // 预处理响应
      const preprocessed = await this.preprocessResponse(response, context);
      const parseSource = preprocessed ?? response;

      // 解析功能调用（包括表情和工具）
      const { timeline, cleanText: parsedText } = this.parseFunctions(parseSource, context);
      const actionTimeline = timeline?.length ? timeline : [{ type: 'text', content: parsedText || response }];
      
      // 执行功能调用
      let finalText = await this.runActionTimeline(actionTimeline, context);
      if (!finalText && parsedText) {
        finalText = parsedText;
      }

      // 先解析表情并移除表情标记（和chat.js一样）
      const { emotion, cleanText: rawText } = this.parseEmotion(finalText || response);
      
      // 使用cleanText（已移除表情标记），如果没有cleanText则使用finalText
      finalText = (rawText && rawText.trim()) || (finalText && finalText.trim()) || response.trim();
      
      // 润色（可选，对已移除表情标记的文本进行润色）
      if (this.responsePolishConfig?.enabled && finalText) {
        finalText = await this.polishResponse(finalText, persona);
      }

      // 如果提供了deviceBot，直接调用emotion()切换表情
      if (emotion && deviceBot?.emotion) {
        try {
          await deviceBot.emotion(emotion);
        } catch (e) {
          BotUtil.makeLog('error', `[工作流] 表情切换失败: ${e.message}`, 'DeviceStream');
        }
      }

      // 记录到记忆系统（可选，记录重要对话）
      if (finalText && this.getMemorySystem()?.isEnabled() && question?.length > 10) {
        const memorySystem = this.getMemorySystem();
        const { ownerId, scene } = memorySystem.extractScene(e);
        
        // 异步记录，不阻塞返回
        memorySystem.remember({
          ownerId,
          scene,
          layer: 'short',
          content: `用户: ${question.substring(0, 100)} | 助手: ${finalText.substring(0, 100)}`,
          metadata: { deviceId, type: 'conversation' },
          authorId: deviceId
        }).catch(() => {});
      }
      
      return {
        text: finalText || '',
        emotion  // emotion已经是英文代码（如'happy'）
      };
    } catch (err) {
      BotUtil.makeLog('error', `设备工作流失败: ${err.message}`, 'DeviceStream');
      return null;
    }
  }

  /**
   * 预处理响应（用于功能调用前的处理）
   */
  async preprocessResponse(response, context) {
    return response;
  }

  /**
   * 解析表情指令，兼容 ] 或 }
   * 使用统一的表情处理工具
   * 返回的emotion为英文代码（如'happy'）
   * 示例：
   *  [开心]你好 → emotion='happy', text='你好'
   *  [惊讶}哇 → emotion='surprise', text='哇'
   */
  parseEmotion(text) {
    return parseEmotionFromText(text);
  }

  /**
   * 搜索文件
   */
  async searchFiles(searchPath, keyword) {
    try {
      const platform = os.platform();
      let command;
      
      if (platform === 'win32') {
        // Windows: 使用dir命令搜索
        command = `dir /s /b "${searchPath}" | findstr /i "${keyword}"`;
      } else {
        // Linux/Mac: 使用find命令
        command = `find "${searchPath}" -name "*${keyword}*" 2>/dev/null | head -20`;
      }
      
      const { stdout, stderr } = await execAsync(command, { 
        maxBuffer: 10 * 1024 * 1024,
        timeout: 10000
      });
      
      if (stderr && !stdout) {
        return `搜索完成，未找到包含"${keyword}"的文件`;
      }
      
      const files = stdout.split('\n').filter(f => f.trim()).slice(0, 10);
      
      if (files.length === 0) {
        return `未找到包含"${keyword}"的文件`;
      }
      
      return `找到${files.length}个文件：\n${files.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
    } catch (error) {
      throw new Error(`搜索失败: ${error.message}`);
    }
  }

  /**
   * 打开应用程序
   */
  async openApplication(app) {
    try {
      const platform = os.platform();
      let command;
      
      if (platform === 'win32') {
        // Windows: 尝试直接打开，或使用start命令
        if (app.includes('\\') || app.includes('/')) {
          command = `start "" "${app}"`;
        } else {
          command = `start ${app}`;
        }
      } else {
        // Linux/Mac: 使用xdg-open或open
        if (app.includes('/')) {
          command = app;
        } else {
          command = platform === 'darwin' ? `open -a "${app}"` : `xdg-open "${app}"`;
        }
      }
      
      await execAsync(command, { timeout: 5000 });
      return `已打开: ${app}`;
    } catch (error) {
      throw new Error(`打开失败: ${error.message}`);
    }
  }

  /**
   * 整理桌面
   */
  async organizeDesktop() {
    try {
      const platform = os.platform();
      const desktopPath = platform === 'win32' 
        ? path.join(os.homedir(), 'Desktop')
        : path.join(os.homedir(), 'Desktop');
      
      if (!fs.existsSync(desktopPath)) {
        throw new Error('桌面路径不存在');
      }
      
      const files = fs.readdirSync(desktopPath);
      const organized = {
        images: [],
        documents: [],
        videos: [],
        music: [],
        archives: [],
        others: []
      };
      
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
      const docExts = ['.doc', '.docx', '.pdf', '.txt', '.xls', '.xlsx', '.ppt', '.pptx'];
      const videoExts = ['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv'];
      const musicExts = ['.mp3', '.wav', '.flac', '.aac', '.ogg'];
      const archiveExts = ['.zip', '.rar', '.7z', '.tar', '.gz'];
      
      for (const file of files) {
        const filePath = path.join(desktopPath, file);
        const stat = fs.statSync(filePath);
        
        if (stat.isDirectory()) continue;
        
        const ext = path.extname(file).toLowerCase();
        let category = 'others';
        
        if (imageExts.includes(ext)) category = 'images';
        else if (docExts.includes(ext)) category = 'documents';
        else if (videoExts.includes(ext)) category = 'videos';
        else if (musicExts.includes(ext)) category = 'music';
        else if (archiveExts.includes(ext)) category = 'archives';
        
        organized[category].push(file);
      }
      
      // 创建分类文件夹并移动文件
      const categoryNames = {
        images: '图片',
        documents: '文档',
        videos: '视频',
        music: '音乐',
        archives: '压缩包',
        others: '其他'
      };
      
      let movedCount = 0;
      for (const [category, files] of Object.entries(organized)) {
        if (files.length === 0) continue;
        
        const categoryDir = path.join(desktopPath, categoryNames[category]);
        if (!fs.existsSync(categoryDir)) {
          fs.mkdirSync(categoryDir, { recursive: true });
        }
        
        for (const file of files) {
          const srcPath = path.join(desktopPath, file);
          const destPath = path.join(categoryDir, file);
          
          try {
            fs.renameSync(srcPath, destPath);
            movedCount++;
          } catch (e) {
            BotUtil.makeLog('warn', `移动文件失败: ${file} - ${e.message}`, 'DeviceStream');
          }
        }
      }
      
      return `整理完成！已移动${movedCount}个文件到分类文件夹`;
    } catch (error) {
      throw new Error(`整理失败: ${error.message}`);
    }
  }

  /**
   * 获取系统状态信息（类MCP钩子）
   */
  async getSystemStatus() {
    try {
      const cpus = os.cpus();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memUsage = (usedMem / totalMem * 100).toFixed(1);
      const uptime = os.uptime();
      const uptimeHours = Math.floor(uptime / 3600);
      const uptimeMinutes = Math.floor((uptime % 3600) / 60);
      
      // 计算CPU使用率（简化版）
      const cpuUsage = cpus.length > 0 ? '正常' : '未知';
      
      const platform = os.platform();
      let platformName = '未知系统';
      if (platform === 'win32') {
        platformName = 'Windows';
      } else if (platform === 'darwin') {
        platformName = 'macOS';
      } else if (platform === 'linux') {
        platformName = 'Linux';
      }
      
      return `系统状态：
操作系统: ${platformName} (${os.arch()})
主机名: ${os.hostname()}
CPU核心数: ${cpus.length}
内存使用: ${memUsage}% (已用 ${(usedMem / 1024 / 1024 / 1024).toFixed(2)}GB / 总计 ${(totalMem / 1024 / 1024 / 1024).toFixed(2)}GB)
系统运行时间: ${uptimeHours}小时${uptimeMinutes}分钟
Node.js版本: ${process.version}`;
    } catch (error) {
      throw new Error(`获取系统状态失败: ${error.message}`);
    }
  }

  /**
   * 调用Node.js函数
   */
  async callNodeFunction(functionName, args = {}) {
    try {
      // 安全限制：只允许调用部分安全的函数
      const allowedFunctions = {
        'Math.max': Math.max,
        'Math.min': Math.min,
        'Math.round': Math.round,
        'Math.floor': Math.floor,
        'Math.ceil': Math.ceil,
        'Date.now': Date.now,
        'JSON.stringify': JSON.stringify,
        'JSON.parse': JSON.parse
      };
      
      // 解析函数路径（如 fs.readFileSync）
      const parts = functionName.split('.');
      let func;
      
      if (parts.length === 1) {
        func = allowedFunctions[functionName];
        if (!func) {
          throw new Error(`不允许调用函数: ${functionName}`);
        }
      } else if (parts[0] === 'fs' && parts.length === 2) {
        // 允许部分fs操作
        const fsFuncs = ['readFileSync', 'existsSync', 'statSync', 'readdirSync'];
        if (fsFuncs.includes(parts[1])) {
          const fsModule = await import('fs');
          func = fsModule.default[parts[1]] || fsModule[parts[1]];
        } else {
          throw new Error(`不允许调用fs函数: ${parts[1]}`);
        }
      } else {
        throw new Error(`不允许调用函数: ${functionName}`);
      }
      
      if (typeof func !== 'function') {
        throw new Error(`不是函数: ${functionName}`);
      }
      
      // 执行函数
      const result = Array.isArray(args) ? func(...args) : func(args);
      
      // 格式化结果
      if (typeof result === 'object' && result !== null) {
        return JSON.stringify(result, null, 2);
      }
      
      return String(result);
    } catch (error) {
      throw new Error(`函数调用失败: ${error.message}`);
    }
  }
}

/**
 * 设备工作流管理器（扩展WorkflowManager）
 * 处理设备场景特定的工作流，如记忆系统
 */
class DeviceWorkflowManager extends WorkflowManager {
  constructor(stream) {
    super();
    this.stream = stream;
    
    // 注册设备特定的工作流
    this.registerDeviceWorkflows();
  }

  registerDeviceWorkflows() {
    // 记忆相关
    this.registerWorkflow('memory', this.runMemory.bind(this), {
      description: '记住信息',
      enabled: true,
      priority: 30
    });
    this.registerWorkflow('remember', this.runMemory.bind(this));
    
    this.registerWorkflow('memory-recall', this.runMemoryRecall.bind(this), {
      description: '回忆记忆',
      enabled: true,
      priority: 30
    });
    this.registerWorkflow('recall-memory', this.runMemoryRecall.bind(this));
    
    // 删除记忆
    this.registerWorkflow('memory-forget', this.runMemoryForget.bind(this), {
      description: '删除记忆',
      enabled: true,
      priority: 30
    });
    this.registerWorkflow('forget-memory', this.runMemoryForget.bind(this));
    this.registerWorkflow('删除记忆', this.runMemoryForget.bind(this));
  }

  /**
   * 解析记忆参数（设备场景特定）
   */
  parseMemoryArguments(rawArg = '', e) {
    const tokens = rawArg.split('|').map(t => t.trim()).filter(Boolean);
    let layer = null;
    const contentTokens = [];

    const layerMap = new Map([
      ['long', 'long'],
      ['长期', 'long'],
      ['长期记忆', 'long'],
      ['short', 'short'],
      ['短期', 'short'],
      ['临时', 'short']
    ]);

    for (const token of tokens) {
      const key = token.toLowerCase();
      if (!layer && layerMap.has(key)) {
        layer = layerMap.get(key);
        continue;
      }
      contentTokens.push(token);
    }

    const content = contentTokens.join(' ').trim();
    
    // 使用记忆系统的场景提取
    const memorySystem = this.stream.getMemorySystem();
    const { ownerId, scene } = memorySystem.extractScene(e);

    return {
      ownerId,
      scene,
      layer,
      content
    };
  }

  /**
   * 记住信息（使用基类记忆系统）
   */
  async runMemory(params = {}, context = {}) {
    const memorySystem = this.stream.getMemorySystem();
    if (!memorySystem?.isEnabled()) {
      return { type: 'text', content: '记忆系统暂时不可用～' };
    }

    const rawArg = params.argument?.trim();
    if (!rawArg) {
      return { type: 'text', content: '想记住什么呀？内容空空的。' };
    }

    const parsed = this.parseMemoryArguments(rawArg, context.e);
    if (!parsed.content) {
      return { type: 'text', content: '记忆内容还没说清楚，换种说法再来一次？' };
    }

    const saved = await memorySystem.remember({
      ownerId: parsed.ownerId,
      scene: parsed.scene,
      layer: parsed.layer,
      content: parsed.content,
      metadata: {
        deviceId: context.e?.device_id || 'unknown',
        type: 'device_conversation'
      },
      authorId: context.e?.self_id || context.e?.device_id
    });

    if (!saved) {
      return { type: 'text', content: '这条记忆没记住，再试试？' };
    }

    return { type: 'text', content: '记住啦～想看的时候可以叫我回忆。' };
  }

  /**
   * 回忆记忆（使用基类记忆系统）
   */
  async runMemoryRecall(params = {}, context = {}) {
    const memorySystem = this.stream.getMemorySystem();
    if (!memorySystem?.isEnabled()) {
      return { type: 'text', content: '记忆系统暂时不可用～' };
    }

    const summary = await memorySystem.buildSummary(context.e, { preferUser: true });
    if (!summary) {
      return { type: 'text', content: '现在脑子里还没有新的记忆。' };
    }

    return { type: 'text', content: summary };
  }

  /**
   * 删除记忆（AI可以删除自己的记忆）
   */
  async runMemoryForget(params = {}, context = {}) {
    const memorySystem = this.stream.getMemorySystem();
    if (!memorySystem?.isEnabled()) {
      return { type: 'text', content: '记忆系统暂时不可用～' };
    }

    const rawArg = params.argument?.trim();
    if (!rawArg) {
      return { type: 'text', content: '想删除什么记忆呀？说清楚内容或ID。' };
    }

    const { ownerId, scene } = memorySystem.extractScene(context.e);
    
    // 解析参数：支持 memoryId 或 content 关键词
    let memoryId = null;
    let content = null;
    
    // 尝试解析为ID（格式：id:xxx）
    if (rawArg.startsWith('id:')) {
      memoryId = rawArg.substring(3).trim();
    } else if (rawArg.startsWith('ID:')) {
      memoryId = rawArg.substring(3).trim();
    } else {
      // 否则作为内容关键词
      content = rawArg;
    }

    const success = await memorySystem.forget(ownerId, scene, memoryId, content);
    
    if (success) {
      return { type: 'text', content: '记忆已删除～' };
    } else {
      return { type: 'text', content: '没找到要删除的记忆，可能已经删除了？' };
    }
  }
}


