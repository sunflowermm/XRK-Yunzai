import cfg from '../../../lib/config/config.js';
import LLMFactory from '../../../lib/factory/llm/LLMFactory.js';
import BotUtil from '../../../lib/util.js';
import { transformMessagesWithVision } from '../../../lib/utils/llm/message-transform.js';

/**
 * 解析 multipart/form-data
 */
async function parseMultipartData(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^;]+)/);
    if (!boundaryMatch) {
      reject(new Error('No boundary found'));
      return;
    }
    const boundary = boundaryMatch[1];

    let data = Buffer.alloc(0);
    const files = [];
    const fields = {};

    req.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
    });

    req.on('end', () => {
      try {
        const parts = data.toString('binary').split(`--${boundary}`);
        
        for (const part of parts) {
          if (!part.trim() || part.trim() === '--') continue;
          
          if (part.includes('Content-Disposition: form-data')) {
            const nameMatch = part.match(/name="([^"]+)"/);
            const filenameMatch = part.match(/filename="([^"]+)"/);
            
            if (filenameMatch) {
              // 文件字段
              const filename = filenameMatch[1];
              const contentTypeMatch = part.match(/Content-Type: ([^\r\n]+)/);
              const contentType = contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream';
              
              const headerEndIndex = part.indexOf('\r\n\r\n');
              if (headerEndIndex !== -1) {
                const fileStart = headerEndIndex + 4;
                const fileEnd = part.lastIndexOf('\r\n');
                const fileContent = Buffer.from(part.substring(fileStart, fileEnd), 'binary');
                
                files.push({
                  fieldname: nameMatch ? nameMatch[1] : 'file',
                  originalname: filename,
                  mimetype: contentType,
                  buffer: fileContent,
                  size: fileContent.length
                });
              }
            } else if (nameMatch) {
              // 普通字段
              const fieldName = nameMatch[1];
              const headerEndIndex = part.indexOf('\r\n\r\n');
              if (headerEndIndex !== -1) {
                const fieldStart = headerEndIndex + 4;
                const fieldEnd = part.lastIndexOf('\r\n');
                const fieldBuf = Buffer.from(part.substring(fieldStart, fieldEnd), 'binary');
                fields[fieldName] = fieldBuf.toString('utf8');
              }
            }
          }
        }
        
        resolve({ files, fields });
      } catch (e) {
        reject(e);
      }
    });

    req.on('error', reject);
  });
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) return obj[k];
  }
  return undefined;
}

function parseOptionalJson(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function toNum(v) {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function toBool(v) {
  if (!v) return undefined;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return undefined;
}

/** 提取消息文本内容（支持字符串和对象格式） */
function extractMessageText(messages) {
  return messages.map(m => {
    const content = m.content;
    return typeof content === 'string' ? content : (content && content.text || '');
  }).join('');
}

/** 计算 token 数量（粗略估算：1 token ≈ 4 字符） */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

async function handleChatCompletionsV3(req, res, Bot) {
  const contentType = req.headers['content-type'] || '';
  const body = req.body || {};
  let messages = Array.isArray(body.messages) ? body.messages : null;
  const uploadedImages = [];

  // 支持 multipart/form-data 格式（图片上传）
  if (contentType.includes('multipart/form-data')) {
    try {
      const { files, fields } = await parseMultipartData(req);
      
      // 解析 JSON 字段
      if (fields.messages) {
        try {
          messages = JSON.parse(fields.messages);
        } catch (_e) {
          return res.status(400).json({ success: false, message: 'messages 字段格式无效' });
        }
      }
      
      // 解析其他字段
      if (fields.model) body.model = fields.model;
      if (fields.stream) body.stream = fields.stream === 'true';
      if (fields.apiKey) body.apiKey = fields.apiKey;
      if (fields.api_key) body.api_key = fields.api_key;
      if (fields.temperature) body.temperature = fields.temperature;
      if (fields.max_tokens) body.max_tokens = fields.max_tokens;
      if (fields.maxTokens) body.maxTokens = fields.maxTokens;
      
      // 处理上传的图片（字段名可以是 'images' 或 'file'）
      if (files && files.length > 0) {
        for (const file of files) {
          if (file.mimetype && file.mimetype.startsWith('image/')) {
            const base64 = file.buffer.toString('base64');
            uploadedImages.push(`data:${file.mimetype};base64,${base64}`);
          }
        }
      }
    } catch (e) {
      return res.status(400).json({ success: false, message: `解析 multipart/form-data 失败: ${e.message}` });
    }
  }
  
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ success: false, message: 'messages 参数无效' });
  }
  
  // 如果有上传的图片，将图片添加到最后一条用户消息中
  if (uploadedImages.length > 0) {
    const imageParts = uploadedImages.map(img => ({
      type: 'image_url',
      image_url: { url: img }
    }));

    if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
      const lastMessage = messages[messages.length - 1];
      if (Array.isArray(lastMessage.content)) {
        lastMessage.content.push(...imageParts);
      } else if (typeof lastMessage.content === 'string') {
        const text = lastMessage.content.trim();
        lastMessage.content = text ? [{ type: 'text', text }, ...imageParts] : imageParts;
      } else if (lastMessage.content && typeof lastMessage.content === 'object') {
        const c = lastMessage.content;
        const text = (c.text || c.content || '').toString().trim();
        const images = Array.isArray(c.images) ? c.images : [];
        c.text = text;
        c.images = [...images, ...uploadedImages];
        lastMessage.content = c;
      } else {
        lastMessage.content = imageParts;
      }
    } else {
      messages.push({
        role: 'user',
        content: imageParts
      });
    }
  }

  // 支持多种认证方式：body.apiKey、Authorization头部Bearer令牌
  let accessKey = (pickFirst(body, ['apiKey', 'api_key']) || '').toString().trim();
  if (!accessKey) {
    const authHeader = (req.headers.authorization || '').toString().trim();
    if (authHeader.startsWith('Bearer ')) {
      accessKey = authHeader.substring(7).trim();
    }
  }
  // 兼容 Web 控制台常见写法：X-API-Key
  if (!accessKey) {
    accessKey = (req.headers['x-api-key'] || '').toString().trim();
  }
  
  // 验证 API Key
  if (!Bot.checkApiAuthorization(req)) {
    if (!accessKey || accessKey !== Bot.apiKey) {
      return res.status(401).json({ success: false, message: 'apiKey 无效' });
    }
  }

  const streamFlag = Boolean(pickFirst(body, ['stream']));
  // OpenAI兼容：body.model 字段即为运营商 provider
  const bodyModel = (pickFirst(body, ['model']) || '').toString().trim().toLowerCase();
  const provider = (bodyModel && LLMFactory.hasProvider(bodyModel)) 
    ? bodyModel 
    : LLMFactory.getDefaultProvider();

  const llmConfig = {
    provider,
    ...(accessKey ? { apiKey: accessKey } : {})
  };
  
  const base = LLMFactory.getProviderConfig(provider);

  if (streamFlag && base.enableStream === false) {
    return res.status(400).json({ 
      success: false, 
      message: `提供商 ${provider} 的流式输出已禁用` 
    });
  }

  const client = LLMFactory.createClient(llmConfig);
  
  // 转换消息（支持多模态）
  const transformedMessages = await transformMessagesWithVision(messages, llmConfig, { mode: 'openai' });
  
  // 构建OpenAI兼容的overrides配置
  const overrides = {};
  const addNum = (key, val) => {
    const num = toNum(val);
    if (num !== undefined) {
      overrides[key] = num;
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (camelKey !== key) overrides[camelKey] = num;
    }
  };
  const addBool = (key, val) => {
    const bool = toBool(val);
    if (bool !== undefined) {
      overrides[key] = bool;
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (camelKey !== key) overrides[camelKey] = bool;
    }
  };
  const add = (key, val) => {
    if (val !== undefined) {
      overrides[key] = val;
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (camelKey !== key) overrides[camelKey] = val;
    }
  };
  
  const { temperature, max_tokens, maxTokens, top_p, topP, presence_penalty, presencePenalty, 
          frequency_penalty, frequencyPenalty, tool_choice, toolChoice, parallel_tool_calls, 
          parallelToolCalls, tools, stop, response_format, responseFormat, stream_options, 
          streamOptions, seed, user, n, logit_bias, logitBias, logprobs, top_logprobs, topLogprobs } = body;
  
  if (temperature !== undefined) addNum('temperature', temperature);
  if (max_tokens !== undefined || maxTokens !== undefined) addNum('max_tokens', max_tokens ?? maxTokens);
  if (top_p !== undefined || topP !== undefined) addNum('top_p', top_p ?? topP);
  if (presence_penalty !== undefined || presencePenalty !== undefined) addNum('presence_penalty', presence_penalty ?? presencePenalty);
  if (frequency_penalty !== undefined || frequencyPenalty !== undefined) addNum('frequency_penalty', frequency_penalty ?? frequencyPenalty);
  if (tool_choice !== undefined || toolChoice !== undefined) add('tool_choice', tool_choice ?? toolChoice);
  if (parallel_tool_calls !== undefined || parallelToolCalls !== undefined) addBool('parallel_tool_calls', parallel_tool_calls ?? parallelToolCalls);
  if (tools !== undefined) add('tools', tools);
  if (stop !== undefined) add('stop', stop);
  if (response_format !== undefined || responseFormat !== undefined) add('response_format', response_format ?? responseFormat);
  if (stream_options !== undefined || streamOptions !== undefined) add('stream_options', stream_options ?? streamOptions);
  if (seed !== undefined) addNum('seed', seed);
  if (user !== undefined) add('user', user);
  if (n !== undefined) addNum('n', n);
  if (logit_bias !== undefined || logitBias !== undefined) add('logit_bias', logit_bias ?? logitBias);
  if (logprobs !== undefined) addBool('logprobs', logprobs);
  if (top_logprobs !== undefined || topLogprobs !== undefined) addNum('top_logprobs', top_logprobs ?? topLogprobs);
  
  const extraBody = parseOptionalJson(body.extraBody);
  if (extraBody && typeof extraBody === 'object') overrides.extraBody = extraBody;

  // OpenAI兼容：body.model 字段即为运营商 provider，返回时也返回 provider 作为 model
  if (!streamFlag) {
    const text = await client.chat(transformedMessages, overrides);
    const promptText = extractMessageText(messages);
    const promptTokens = estimateTokens(promptText);
    const completionTokens = estimateTokens(text);
    
    // OpenAI兼容：返回 model=provider
    const responseModel = provider;
    return res.json({
      id: `chatcmpl_${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: responseModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text || '' },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      }
    });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();

  const now = Math.floor(Date.now() / 1000);
  const id = `chatcmpl_${Date.now()}`;
  const modelName = provider;
  
  try {
    let totalContent = '';
    let isFirstChunk = true;
    
    await client.chatStream(transformedMessages, (delta) => {
      if (delta) {
        totalContent += delta;
        const deltaObj = isFirstChunk ? { role: 'assistant', content: delta } : { content: delta };
        
        res.write(`data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: now,
          model: modelName,
          choices: [{
            index: 0,
            delta: deltaObj,
            finish_reason: null
          }]
        })}\n\n`);
        
        isFirstChunk = false;
      }
    }, overrides);
    
    const promptText = extractMessageText(messages);
    const promptTokens = estimateTokens(promptText);
    const completionTokens = estimateTokens(totalContent);
    
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: now,
      model: modelName,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      }
    })}\n\n`);
    res.write('data: [DONE]\n\n');
  } catch (error) {
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: now,
      model: modelName,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: null
      }],
      error: {
        message: error.message || 'Internal server error',
        type: 'server_error',
        code: 'internal_error'
      }
    })}\n\n`);
    res.write('data: [DONE]\n\n');
  } finally {
    res.end();
  }
}

async function handleModels(req, res, Bot) {
  const providers = LLMFactory.listProviders();
  const defaultProvider = LLMFactory.getDefaultProvider();
  const format = (req.query.format || '').toLowerCase();

  if (format === 'openai' || req.path === '/api/v3/models') {
    const list = providers.length ? providers : (defaultProvider ? [defaultProvider] : []);
    const now = Math.floor(Date.now() / 1000);
    return res.json({
      object: 'list',
      data: list.map((p) => ({
        id: p,
        object: 'model',
        created: now,
        owned_by: 'xrk-yunzai'
      }))
    });
  }

  const profiles = providers.map((provider) => {
    const c = LLMFactory.getProviderConfig(provider) || {};
    const model = c.model || c.chatModel || null;
    const baseUrl = c.baseUrl || null;
    const maxTokens = c.maxTokens ?? c.max_tokens ?? null;
    const temperature = c.temperature ?? null;
    const hasApiKey = Boolean((c.apiKey || '').toString().trim());

    const capabilities = [];
    if (c.enableStream !== false) capabilities.push('stream');
    if (c.enableTools === true) capabilities.push('tools');

    return {
      key: provider,
      label: provider,
      description: `LLM提供商: ${provider}`,
      tags: [],
      model,
      baseUrl,
      maxTokens,
      temperature,
      hasApiKey,
      capabilities
    };
  });

  // 获取所有工作流
  const allStreams = Bot.StreamLoader?.getAllStreams?.() ?? [];
  const workflows = allStreams.map(stream => ({
    key: stream.name,
    label: stream.description || stream.name,
    description: stream.description || '',
    profile: null,
    persona: null,
    uiHidden: false
  }));

  const aistreamConfig = cfg.aistream || {};
  return res.json({
    success: true,
    data: {
      enabled: aistreamConfig.enabled !== false,
      defaultProfile: defaultProvider,
      defaultWorkflow: workflows[0] && workflows[0].key || null,
      persona: aistreamConfig.persona || '',
      profiles,
      workflows
    }
  });
}

/** GET /api/ai/stream：SSE 流式对话（query: prompt, workflow, persona） */
async function handleAiStream(req, res, Bot) {
  if (!Bot.checkApiAuthorization(req)) {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }
  const prompt = (req.query.prompt || '').toString().trim();
  const workflow = (req.query.workflow || 'chat').toString().trim();
  const persona = (req.query.persona || '').toString().trim();

  const stream = Bot.StreamLoader.getStream(workflow);
  if (!stream) {
    return res.status(400).json({ success: false, message: `工作流不存在: ${workflow}` });
  }
  if (typeof stream.buildChatContext !== 'function') {
    return res.status(400).json({ success: false, message: '该工作流不支持对话' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();

  try {
    const messages = await stream.buildChatContext(null, { text: prompt || '你好', persona });
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.write('data: ' + JSON.stringify({ error: '消息构建失败' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (typeof stream.callAIStream !== 'function') {
      res.write('data: ' + JSON.stringify({ error: '工作流不支持流式输出' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    await stream.callAIStream(messages, {}, (delta) => {
      if (delta) res.write('data: ' + JSON.stringify({ delta }) + '\n\n');
    });
  } catch (err) {
    res.write('data: ' + JSON.stringify({ error: err.message || '流式输出失败' }) + '\n\n');
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

export default {
  name: 'ai-stream',
  dsc: 'AI 流式输出（SSE）',
  priority: 80,
  routes: [
    {
      method: 'POST',
      path: '/api/v3/chat/completions',
      handler: handleChatCompletionsV3
    },
    {
      method: 'GET',
      path: '/api/v3/models',
      handler: handleModels
    },
    {
      method: 'GET',
      path: '/api/ai/models',
      handler: handleModels
    },
    {
      method: 'GET',
      path: '/api/ai/stream',
      handler: handleAiStream
    }
  ]
};
