import StreamLoader from '../aistream/loader.js';

const stateArr = {}
const SymbolTimeout = Symbol("Timeout")
const SymbolResolve = Symbol("Resolve")

let Common
try {
  Common = (await import("#miao")).Common
} catch {}

export default class plugin {
  constructor({
    name = "your-plugin",
    dsc = "无",
    bypassThrottle = false,
    handler,
    namespace,
    event = "message",
    priority = 5000,
    task = { name: "", fnc: "", cron: "" },
    rule = []
  }) {
    this.name = name
    this.dsc = dsc
    this.event = event
    this.priority = priority
    this.task = task
    this.rule = rule
    this.bypassThrottle = bypassThrottle
    
    if (handler) {
      this.handler = handler
      this.namespace = namespace || ""
    }
  }

  async callAIStream(aiConfig, streamInput = null, promptOrContext = '', additionalContext = {}) {
    try {
      let stream = null;
      let systemPrompt = '';
      let context = {};
      
      if (typeof promptOrContext === 'string') {
        systemPrompt = promptOrContext;
        context = additionalContext;
      } else if (typeof promptOrContext === 'object') {
        systemPrompt = promptOrContext.prompt || '';
        context = { ...promptOrContext, ...additionalContext };
      }
      
      if (typeof streamInput === 'string') {
        stream = StreamLoader.getStream(streamInput);
        if (!stream) {
          logger?.warn(`[Plugin] 工作流 ${streamInput} 未找到`);
        }
      } else if (streamInput && typeof streamInput === 'object') {
        stream = streamInput;
      }
      
      if (stream) {
        if (stream.buildChatSystemPrompt && typeof stream.buildChatSystemPrompt === 'function') {
          systemPrompt = stream.buildChatSystemPrompt(systemPrompt, context);
        } else {
          systemPrompt = stream.buildSystemPrompt(systemPrompt, context);
        }
      }
      
      const messages = this.buildAIMessages(systemPrompt, context);
      const response = await this.callAI(messages, aiConfig);
      
      if (!response) {
        return {
          success: false,
          error: 'AI响应为空'
        };
      }
      
      if (stream) {
        const result = await StreamLoader.executeStream(stream.name, response, context);
        return {
          success: true,
          response: result.processedResponse,
          stream: stream.name,
          executed: result.executed,
          raw: response
        };
      }
      
      return {
        success: true,
        response: response,
        stream: null,
        raw: response
      };
      
    } catch (error) {
      logger?.error(`[Plugin] 调用AI工作流失败: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  getStream(name) {
    return StreamLoader.getStream(name);
  }

  getAllStreams() {
    return StreamLoader.getAllStreams();
  }

  buildAIMessages(systemPrompt, context) {
    const messages = [];
    
    if (systemPrompt) {
      messages.push({
        role: 'system',
        content: systemPrompt
      });
    }
    
    if (context.history && Array.isArray(context.history)) {
      messages.push(...context.history);
    }
    
    if (context.question) {
      messages.push({
        role: 'user',
        content: context.question
      });
    }
    
    return messages;
  }

  async callAI(messages, config) {
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: config.model || 'gpt-3.5-turbo',
          messages: messages,
          temperature: config.temperature || 0.8,
          max_tokens: config.max_tokens || 2000,
          top_p: config.top_p || 0.9,
          ...config.extra
        }),
        timeout: 30000
      });

      if (!response.ok) {
        throw new Error(`API错误: ${response.status}`);
      }

      const result = await response.json();
      return result.choices?.[0]?.message?.content || null;
    } catch (error) {
      throw new Error(`AI API调用失败: ${error.message}`);
    }
  }

  reply(msg = "", quote = false, data = {}) {
    if (!this.e?.reply || !msg) return false
    return this.e.reply(msg, quote, data)
  }

  markNeedReparse() {
    if (this.e) {
      this.e._needReparse = true
    }
  }

  conKey(isGroup = false) {
    const selfId = this.e?.self_id || ''
    const targetId = isGroup ? 
      (this.group_id || this.e?.group_id || '') : 
      (this.user_id || this.e?.user_id || '')
    return `${this.name}.${selfId}.${targetId}`
  }

  setContext(type, isGroup = false, time = 120, timeout = "操作超时已取消") {
    const key = this.conKey(isGroup)
    if (!stateArr[key]) stateArr[key] = {}
    stateArr[key][type] = this.e
    
    if (time > 0) {
      stateArr[key][type][SymbolTimeout] = setTimeout(() => {
        if (!stateArr[key]?.[type]) return
        
        const state = stateArr[key][type]
        const resolve = state[SymbolResolve]
        
        delete stateArr[key][type]
        if (!Object.keys(stateArr[key]).length) delete stateArr[key]
        
        resolve ? resolve(false) : this.reply(timeout, true)
      }, time * 1000)
    }
    
    return stateArr[key][type]
  }

  getContext(type, isGroup = false) {
    const key = this.conKey(isGroup)
    if (!stateArr[key]) return null
    return type ? stateArr[key][type] : stateArr[key]
  }

  finish(type, isGroup = false) {
    const key = this.conKey(isGroup)
    const context = stateArr[key]?.[type]
    
    if (context) {
      const timeout = context[SymbolTimeout]
      const resolve = context[SymbolResolve]
      
      if (timeout) clearTimeout(timeout)
      if (resolve) resolve(true)
      
      delete stateArr[key][type]
      if (!Object.keys(stateArr[key]).length) delete stateArr[key]
    }
  }

  awaitContext(...args) {
    return new Promise(resolve => {
      const context = this.setContext("resolveContext", ...args)
      if (context) context[SymbolResolve] = resolve
    })
  }

  resolveContext(context) {
    const key = this.conKey(false)
    const storedContext = stateArr[key]?.["resolveContext"]
    const resolve = storedContext?.[SymbolResolve]
    
    this.finish("resolveContext")
    if (resolve && context) resolve(this.e)
  }

  async renderImg(plugin, tpl, data, cfg) {
    const renderCfg = { ...(cfg || {}), e: this.e }
    return Common?.render(plugin, tpl, data, renderCfg)
  }
}