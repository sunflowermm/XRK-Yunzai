import AIStream from '../../lib/aistream/base.js';
import BotUtil from '../../lib/common/util.js';

/**
 * 清理工作流
 * 提供群消息清理、撤回等功能
 */
export default class CleanupStream extends AIStream {
  constructor() {
    super({
      name: 'cleanup',
      description: '消息清理工作流',
      version: '1.0.0',
      author: 'XRK',
      priority: 20,
      config: {
        enabled: true
      }
    });

    this.registerAllFunctions();
  }

  registerAllFunctions() {
    // 撤回消息功能
    this.registerFunction('recall', {
      prompt: `[撤回:消息ID] - 撤回指定消息`,
      parser: (text, context) => {
        const functions = [];
        const regex = /\[撤回:([^\]]+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ type: 'recall', params: [match[1]] });
        }
        
        return { functions, cleanText: text.replace(regex, '') };
      },
      handler: async ([msgId], context) => {
        if (context.e?.isGroup) {
          try {
            await context.e.group.recallMsg(msgId);
            BotUtil.makeLog('info', `已撤回消息: ${msgId}`, 'CleanupStream');
          } catch (error) {
            BotUtil.makeLog('error', `撤回失败: ${error.message}`, 'CleanupStream');
          }
        }
      },
      enabled: true,
      permission: 'admin'
    });

    // 清理垃圾消息功能
    this.registerFunction('cleanGarbage', {
      prompt: `[清理垃圾:数量] - 清理最近的垃圾消息`,
      parser: (text, context) => {
        const functions = [];
        const regex = /\[清理垃圾:(\d+)\]/g;
        let match;
        
        while ((match = regex.exec(text))) {
          functions.push({ type: 'cleanGarbage', params: [match[1]] });
        }
        
        return { functions, cleanText: text.replace(regex, '') };
      },
      handler: async ([count], context) => {
        BotUtil.makeLog('info', `准备清理${count}条垃圾消息`, 'CleanupStream');
        // 实际的清理逻辑
      },
      enabled: true,
      permission: 'admin'
    });
  }

  buildSystemPrompt(context) {
    const functionsPrompt = this.buildFunctionsPrompt();
    
    return `你是一个消息清理助手，专门负责群消息管理和清理。

【你的职责】
1. 识别垃圾消息、广告、刷屏等
2. 执行消息撤回和清理操作
3. 维护群聊秩序

${functionsPrompt}

【注意事项】
1. 谨慎使用撤回功能
2. 清理前要确认消息类型
3. 保护重要消息不被误删`;
  }

  async buildChatContext(e, question) {
    const messages = [];
    
    messages.push({
      role: 'system',
      content: this.buildSystemPrompt({ e, question })
    });
    
    messages.push({
      role: 'user',
      content: question
    });
    
    return messages;
  }
}