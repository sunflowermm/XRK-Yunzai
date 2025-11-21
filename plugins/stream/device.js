import AIStream from '../../lib/aistream/aistream.js';
import BotUtil from '../../lib/common/util.js';
import { parseEmotionFromText, normalizeEmotion } from '../../components/util/emotionUtil.js';
import { EMOTION_KEYWORDS } from '../../components/config/deviceConfig.js';
import cfg from '../../lib/config/config.js';

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
  }

  /**
   * 系统提示：引导模型优先返回简洁中文，并可选择一个表情指令
   * 集成记忆系统提示
   */
  buildSystemPrompt(context) {
    const persona = context?.persona || '你是一个简洁友好的设备语音助手，以地道中文回答。';
    const supportedEmotions = Object.keys(EMOTION_KEYWORDS).join(' ');
    
    // 获取记忆摘要
    const memorySystem = this.getMemorySystem();
    const memorySummary = context?.memorySummary || '';
    const memoryHint = memorySystem?.isEnabled() && memorySummary
      ? `\n【记忆提示】\n${memorySummary}\n`
      : '';

    return `【人设】
${persona}
${memoryHint}
【规则】
1. 尽量简洁，优先中文
2. 如需展示表情或动画，请在文本前加一个表情标记（可选）：
   [${supportedEmotions}]
3. 最多一个表情标记
4. 不要输出多余解释
5. 参考记忆提示中的信息，但不要直接重复`;
  }

  /**
   * 构建消息（增强版：集成记忆系统）
   */
  async buildChatContext(e, question) {
    const text = typeof question === 'string' ? question : (question?.text || question?.content || '');
    
    // 获取记忆摘要
    const memorySummary = await this.buildMemorySummary(e || { device_id: question?.deviceId });
    
    const messages = [
      { 
        role: 'system', 
        content: this.buildSystemPrompt({ 
          persona: question?.persona,
          memorySummary
        }) 
      },
      { role: 'user', content: text || '你好' }
    ];
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
   * 执行设备工作流并解析输出（增强版：集成记忆、推理、润色）
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

      // 解析表情
      const { emotion, cleanText: rawText } = this.parseEmotion(response);
      
      // 润色（可选）
      let finalText = rawText || response;
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
}


