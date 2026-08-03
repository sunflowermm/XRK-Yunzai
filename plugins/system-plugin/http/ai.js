import LLMFactory from '../../../lib/factory/llm/LLMFactory.js';
import { getAiWorkflowConfigOptional } from '../../../lib/utils/ai-workflow-config.js';
import { mergeAgentWorkspaceIntoMessages } from '../../../lib/utils/agent-workspace.js';
import { transformOpenAIStyleVisionMessages } from '../../../lib/utils/llm/message-transform.js';
import { partitionToolStreamNames } from '../../../lib/ai-workflow/chat-tool-workflows.js';
import { parseMultipartData } from '../../../lib/utils/multipart-parser.js';
import { getServerUploadLimits } from '../../../lib/utils/upload-limits.js';
import { normalizeStringArray } from '../../../lib/utils/string-array-utils.js';
import {
  parseRequestWorkspace,
  buildAiWorkflowCfgForAgentRoot,
  applyRequestWorkspaceToWorkflows
} from '../lib/ai-workspace-runtime.js';
import { runWithAiConsoleContext, installMcpAuditHook } from '../lib/ai-workspace-context.js';
import { pickPromptCacheOverrides } from '../../../lib/utils/llm/prompt-cache-policy.js';
import { assembleChatLlmMessages } from '../../../lib/ai-workflow/chat-pipeline.js';

/**
 * POST /api/v3/chat/completions
 * OpenAI 兼容的对话补全接口：支持流式、多模态、MCP 工具
 *
 * 请求体：messages（必填）、model/provider/llm/profile、stream、temperature、max_tokens 等；
 * 支持 multipart/form-data 图片上传；可选 workflow: { workflows?, streams? } 限定 MCP 工具作用域。
 */
function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj != null && Object.hasOwn(obj, k) && obj[k] != null) return obj[k];
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
  installMcpAuditHook();
  const contentType = req.headers['content-type'] || '';
  const body = req.body || {};
  let messages = Array.isArray(body.messages) ? body.messages : null;
  const uploadedImages = [];
  Bot.makeLog('debug', `[AI] POST /api/v3/chat/completions 收到请求`, 'HTTP');

  // 支持 multipart/form-data 格式（图片上传）
  if (contentType.includes('multipart/form-data')) {
    try {
      const { files, fields } = await parseMultipartData(req, getServerUploadLimits());
      
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
      const maxTok = fields.maxTokens ?? fields.max_tokens;
      if (maxTok != null) body.maxTokens = maxTok;
      
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

  const workspaceCtx = parseRequestWorkspace(body);
  const aiWorkflowCfgForRequest = buildAiWorkflowCfgForAgentRoot(
    getAiWorkflowConfigOptional(),
    workspaceCtx.agentRootAbs
  );
  await mergeAgentWorkspaceIntoMessages(messages, aiWorkflowCfgForRequest, 'v3');

  const streamFlag = toBool(pickFirst(body, ['stream'])) ?? false;
  const provider = LLMFactory.resolveProvider({
    model: pickFirst(body, ['model']),
    provider: pickFirst(body, ['provider']),
    llm: pickFirst(body, ['llm']),
    profile: pickFirst(body, ['profile'])
  });

  if (!provider) {
    return res.status(400).json({
      success: false,
      message: '未指定有效的LLM提供商：请检查 ai-workflow 的 llm.Provider 是否已配置，或在请求中传入 model/provider。'
    });
  }

  const base = LLMFactory.getProviderConfig(provider);
  const llmConfig = { provider, ...base, promptCache: aiWorkflowCfgForRequest.llm?.promptCache };
  Bot.makeLog('debug', `[AI] 运营商=${provider}, stream=${streamFlag}, messages=${messages?.length ?? 0}`, 'HTTP');

  if (streamFlag && base.enableStream === false) {
    return res.status(400).json({ 
      success: false, 
      message: `提供商 ${provider} 的流式输出已禁用` 
    });
  }

  const client = LLMFactory.createClient(llmConfig);
  Bot.makeLog('debug', `[AI] 客户端已创建: provider=${provider}`, 'HTTP');

  const transformedMessages = await transformOpenAIStyleVisionMessages(messages, llmConfig);
  
  // 构建 overrides（规范键名，与 openai-chat-utils/buildOpenAIChatCompletionsBody 一致）
  const overrides = {};
  const t = toNum(body.temperature); if (t !== undefined) overrides.temperature = t;
  const mt = toNum(body.maxTokens ?? body.max_tokens); if (mt !== undefined) overrides.maxTokens = mt;
  const tp = toNum(body.topP ?? body.top_p); if (tp !== undefined) overrides.topP = tp;
  const pp = toNum(body.presencePenalty ?? body.presence_penalty); if (pp !== undefined) overrides.presencePenalty = pp;
  const fp = toNum(body.frequencyPenalty ?? body.frequency_penalty); if (fp !== undefined) overrides.frequencyPenalty = fp;
  const tc = body.tool_choice ?? body.toolChoice; if (tc !== undefined) overrides.tool_choice = tc;
  const ptc = toBool(body.parallel_tool_calls ?? body.parallelToolCalls); if (ptc !== undefined) overrides.parallel_tool_calls = ptc;
  if (body.tools !== undefined) overrides.tools = body.tools;
  if (body.stop !== undefined) overrides.stop = body.stop;
  const rf = body.response_format ?? body.responseFormat; if (rf !== undefined) overrides.response_format = rf;
  const so = body.stream_options ?? body.streamOptions; if (so !== undefined) overrides.stream_options = so;
  const seedNum = toNum(body.seed); if (seedNum !== undefined) overrides.seed = seedNum;
  if (body.user !== undefined) overrides.user = body.user;
  const nNum = toNum(body.n); if (nNum !== undefined) overrides.n = nNum;
  const lb = body.logit_bias ?? body.logitBias; if (lb !== undefined) overrides.logit_bias = lb;
  const lp = toBool(body.logprobs); if (lp !== undefined) overrides.logprobs = lp;
  const tlp = toNum(body.top_logprobs ?? body.topLogprobs); if (tlp !== undefined) overrides.top_logprobs = tlp;
  const extraBody = parseOptionalJson(body.extraBody);
  if (extraBody && typeof extraBody === 'object') overrides.extraBody = extraBody;

  const workflowConfig = pickFirst(body, ['workflow']);
  let workflowStreams = null;
  if (workflowConfig && typeof workflowConfig === 'object') {
    const list = [
      ...(Array.isArray(workflowConfig.workflows) ? workflowConfig.workflows.filter(Boolean) : []),
      ...(Array.isArray(workflowConfig.streams) ? workflowConfig.streams.filter(Boolean) : []),
      ...(typeof workflowConfig.workflow === 'string' && workflowConfig.workflow.trim() ? [workflowConfig.workflow.trim()] : [])
    ];
    workflowStreams = list.length ? normalizeStringArray(list) : null;
  }
  if (!workflowStreams?.length) {
    const defaults = getAiWorkflowConfigOptional()?.mcp?.defaultWorkflows;
    if (Array.isArray(defaults) && defaults.length) {
      workflowStreams = normalizeStringArray(defaults);
    }
  }
  // 勾选 / defaultWorkflows 即严格白名单，不自动追加 remote-mcp / web / browser
  if (workflowStreams?.length) {
    const { mergeable, toolOnly } = partitionToolStreamNames(workflowStreams);
    overrides.streams = [...mergeable, ...toolOnly];
    // 请求临时名单里的 remote-mcp 若尚未被配置同步挂上，补挂一次
    if (toolOnly.length) {
      await Bot?.AiWorkflowLoader?.ensureRemoteMCPServers?.(overrides.streams);
    }
  }
  overrides.mcpToolMode = workflowStreams?.length ? 'execute' : 'passthrough';
  Object.assign(
    overrides,
    pickPromptCacheOverrides(llmConfig, { stream: { name: workflowStreams?.[0] || 'http-v3' } })
  );

  const fileWorkspaceAbs = workspaceCtx.fileRootAbs || workspaceCtx.agentRootAbs;
  const restoreStreamWorkspace = applyRequestWorkspaceToWorkflows(Bot?.AiWorkflowLoader, fileWorkspaceAbs);
  const consoleWorkspaceId = workspaceCtx.presetId || null;

  if (streamFlag) {
    if (workflowStreams?.length) {
      Bot.makeLog('debug', `[AI] MCP 工具白名单: [${overrides.streams?.join(', ') ?? ''}]`, 'HTTP');
    } else {
      Bot.makeLog('debug', '[AI] 未传 workflow，MCP passthrough', 'HTTP');
    }
  }

  if (!streamFlag) {
    Bot.makeLog('debug', `[AI] 非流式调用 chat()`, 'HTTP');
    try {
      const text = await runWithAiConsoleContext(
        { workspaceId: consoleWorkspaceId },
        () => client.chat(transformedMessages, overrides)
      );
      const promptText = extractMessageText(messages);
      const promptTokens = estimateTokens(promptText);
      const completionTokens = estimateTokens(text);

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
    } finally {
      restoreStreamWorkspace();
    }
  }

  Bot.makeLog('debug', `[AI] 流式输出开始`, 'HTTP');
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  const now = Math.floor(Date.now() / 1000);
  const id = `chatcmpl_${Date.now()}`;
  const modelName = provider;

  try {
    let totalContent = '';
    let isFirstChunk = true;

    const streamCallback = (delta, metadata = {}) => {
      const hasTextDelta = typeof delta === 'string' && delta.length > 0;
      const hasMcpTools = Array.isArray(metadata?.mcp_tools) && metadata.mcp_tools.length > 0;
      const hasToolCalls = Array.isArray(metadata?.tool_calls) && metadata.tool_calls.length > 0;

      if (hasTextDelta) {
        totalContent += delta;
        const deltaObj = isFirstChunk ? { role: 'assistant', content: delta } : { content: delta };
        const chunkData = {
          id,
          object: 'chat.completion.chunk',
          created: now,
          model: modelName,
          choices: [{ index: 0, delta: deltaObj, finish_reason: null }]
        };
        if (hasMcpTools) chunkData.mcp_tools = metadata.mcp_tools;
        res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
        if (typeof res.flush === 'function') res.flush();
        isFirstChunk = false;
      } else if (hasMcpTools) {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: now, model: modelName, mcp_tools: metadata.mcp_tools })}\n\n`);
        if (typeof res.flush === 'function') res.flush();
      }

      if (hasToolCalls) {
        const chunkData = {
          id,
          object: 'chat.completion.chunk',
          created: now,
          model: modelName,
          choices: [{
            index: 0,
            delta: { tool_calls: metadata.tool_calls },
            finish_reason: null
          }]
        };
        res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
        if (typeof res.flush === 'function') res.flush();
      }
    };

    await runWithAiConsoleContext({ workspaceId: consoleWorkspaceId }, () =>
      client.chatStream(transformedMessages, streamCallback, overrides)
    );

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
    Bot.makeLog('error', `[AI] 流式请求异常: ${error.message}`, 'HTTP');
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
    restoreStreamWorkspace();
    res.end();
  }
}

async function handleModels(req, res, Bot) {
  installMcpAuditHook();
  const llm = getAiWorkflowConfigOptional().llm || {};
  const defaultProvider = LLMFactory.resolveProvider({}) ?? null;
  const format = (req.query.format || '').toLowerCase();
  const profiles = LLMFactory.listModelProfiles();

  if (format === 'openai' || req.path === '/api/v3/models') {
    const list = profiles.map((p) => p.key);
    const now = Math.floor(Date.now() / 1000);
    return res.json({
      object: 'list',
      data: (list.length ? list : (defaultProvider ? [defaultProvider] : [])).map((p) => ({
        id: p,
        object: 'model',
        created: now,
        owned_by: 'xrk-yunzai'
      }))
    });
  }

  const vendors = LLMFactory.listVendors(profiles);
  const seen = new Set();
  const workflows = [];
  for (const s of Bot.AiWorkflowLoader?.getWorkflowsByPriority?.() ?? []) {
    if (!s?.name || s.primaryStream || s.secondaryStreams || !(s.mcpTools?.size > 0)) continue;
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    workflows.push({
      key: s.name,
      label: s.description || s.name,
      description: s.description || '',
      profile: null,
      persona: null,
      uiHidden: false
    });
  }

  for (const key of Bot.AiWorkflowLoader?.listRemoteMcpWorkflowKeys?.() || []) {
    if (seen.has(key)) continue;
    seen.add(key);
    const name = key.slice('remote-mcp.'.length);
    workflows.push({
      key,
      label: `远程 MCP：${name}`,
      description: `远程 MCP 服务器 ${name}`,
      profile: null,
      persona: null,
      uiHidden: false
    });
  }

  return res.json({
    success: true,
    data: {
      enabled: llm.enabled !== false,
      defaultProfile: defaultProvider || '',
      defaultWorkflow: null,
      persona: llm.persona || '',
      profiles,
      vendors,
      workflows
    }
  });
}

/** GET /api/ai/stream：SSE 流式对话（query: prompt, workflow, persona） */
async function handleAiStream(req, res, Bot) {
  const prompt = (req.query.prompt || '').toString().trim();
  const workflow = (req.query.workflow || 'chat').toString().trim();
  const persona = (req.query.persona || '').toString().trim();

  const stream = Bot.AiWorkflowLoader.getWorkflow(workflow);
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
    const messages = await assembleChatLlmMessages(stream, null, { text: prompt || '你好', persona });
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
    res.write('data: ' + JSON.stringify({ error: '流式输出失败' }) + '\n\n');
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
