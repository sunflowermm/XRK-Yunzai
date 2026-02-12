import BotUtil from '../util.js';
import StreamLoader from './loader.js';

/**
 * 多工作流管理器
 * 支持同时调用多个工作流，实现模块化区分
 */
export class WorkflowManager {
  constructor() {
    this.workflows = new Map();
    this.activeCalls = new Map(); // 跟踪活跃调用
  }

  /**
   * 注册工作流
   * @param {string} name - 工作流名称
   * @param {Function} handler - 处理函数
   * @param {Object} options - 选项
   */
  registerWorkflow(name, handler, options = {}) {
    const normalized = this.normalizeName(name);
    this.workflows.set(normalized, {
      name: normalized,
      handler,
      description: options.description || '',
      enabled: options.enabled !== false,
      priority: options.priority || 100,
      timeout: options.timeout || 30000
    });
  }

  /**
   * 规范化名称
   */
  normalizeName(name = '') {
    return name.toString().trim().toLowerCase();
  }

  /**
   * 调用单个工作流
   * @param {string} name - 工作流名称
   * @param {Object} params - 参数
   * @param {Object} context - 上下文
   * @returns {Promise<Object>} 结果
   */
  async run(name, params = {}, context = {}) {
    const normalized = this.normalizeName(name);
    const workflow = this.workflows.get(normalized);

    if (!workflow || !workflow.enabled) {
      return { 
        type: 'text', 
        content: `工作流 "${name}" 不存在或已禁用` 
      };
    }

    const callId = `${normalized}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.activeCalls.set(callId, { workflow: normalized, startTime: Date.now() });

    try {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('工作流超时')), workflow.timeout);
      });

      const result = await Promise.race([
        workflow.handler(params, context),
        timeoutPromise
      ]);

      this.activeCalls.delete(callId);
      
      if (result && typeof result === 'object' && result.type) {
        return result;
      }
      
      return { 
        type: 'text', 
        content: String(result?.content || result || '') 
      };
    } catch (error) {
      this.activeCalls.delete(callId);
      BotUtil.makeLog('warn', `工作流执行失败[${name}]: ${error.message}`, 'WorkflowManager');
      return { 
        type: 'text', 
        content: '工作流执行遇到问题，稍后再试试吧～' 
      };
    }
  }

  /**
   * 同时调用多个工作流（并行执行）
   * @param {Array<string|Object>} workflows - 工作流列表，可以是名称字符串或配置对象
   * @param {Object} sharedParams - 共享参数
   * @param {Object} context - 上下文
   * @returns {Promise<Array>} 结果数组
   */
  async runMultiple(workflows, sharedParams = {}, context = {}) {
    if (!Array.isArray(workflows) || workflows.length === 0) {
      return [];
    }

    const tasks = workflows.map(wf => {
      if (typeof wf === 'string') {
        return this.run(wf, sharedParams, context);
      } else if (typeof wf === 'object' && wf.name) {
        const params = { ...sharedParams, ...wf.params };
        return this.run(wf.name, params, context);
      }
      return Promise.resolve({ type: 'text', content: '无效的工作流配置' });
    });

    try {
      const results = await Promise.allSettled(tasks);
      return results.map((result, index) => {
        if (result.status === 'fulfilled') {
          return result.value;
        } else {
          BotUtil.makeLog('warn', 
            `工作流执行失败[${workflows[index]}]: ${result.reason?.message}`, 
            'WorkflowManager'
          );
          return { 
            type: 'text', 
            content: `工作流执行失败: ${result.reason?.message || '未知错误'}` 
          };
        }
      });
    } catch (error) {
      BotUtil.makeLog('error', `多工作流调用失败: ${error.message}`, 'WorkflowManager');
      return [];
    }
  }

  /**
   * 顺序调用多个工作流（串行执行）
   * @param {Array<string|Object>} workflows - 工作流列表
   * @param {Object} sharedParams - 共享参数
   * @param {Object} context - 上下文
   * @returns {Promise<Array>} 结果数组
   */
  async runSequential(workflows, sharedParams = {}, context = {}) {
    if (!Array.isArray(workflows) || workflows.length === 0) {
      return [];
    }

    const results = [];
    for (const wf of workflows) {
      try {
        let result;
        if (typeof wf === 'string') {
          result = await this.run(wf, sharedParams, context);
        } else if (typeof wf === 'object' && wf.name) {
          const params = { ...sharedParams, ...wf.params };
          result = await this.run(wf.name, params, context);
        } else {
          result = { type: 'text', content: '无效的工作流配置' };
        }
        results.push(result);
      } catch (error) {
        BotUtil.makeLog('warn', 
          `工作流执行失败[${wf}]: ${error.message}`, 
          'WorkflowManager'
        );
        results.push({ 
          type: 'text', 
          content: `工作流执行失败: ${error.message}` 
        });
      }
    }

    return results;
  }

  /**
   * 调用其他工作流（从当前工作流中调用）
   * @param {string} streamName - 工作流名称（如 'chat', 'device'）
   * @param {Object} e - 事件对象
   * @param {Object} question - 问题
   * @param {Object} config - 配置
   * @returns {Promise<string>} 结果
   */
  async callStream(streamName, e, question, config = {}) {
    const stream = StreamLoader.getStream(streamName);
    if (!stream) {
      BotUtil.makeLog('warn', `工作流 "${streamName}" 未找到`, 'WorkflowManager');
      return null;
    }

    try {
      return await stream.execute(e, question, config);
    } catch (error) {
      BotUtil.makeLog('error', 
        `调用工作流失败[${streamName}]: ${error.message}`, 
        'WorkflowManager'
      );
      return null;
    }
  }

  /**
   * 获取工作流列表
   */
  getWorkflows() {
    return Array.from(this.workflows.values())
      .filter(wf => wf.enabled)
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * 启用/禁用工作流
   */
  toggleWorkflow(name, enabled) {
    const normalized = this.normalizeName(name);
    const workflow = this.workflows.get(normalized);
    if (workflow) {
      workflow.enabled = enabled;
      return true;
    }
    return false;
  }

  /**
   * 获取活跃调用统计
   */
  getActiveCalls() {
    return Array.from(this.activeCalls.entries()).map(([id, data]) => ({
      id,
      workflow: data.workflow,
      duration: Date.now() - data.startTime
    }));
  }
}

