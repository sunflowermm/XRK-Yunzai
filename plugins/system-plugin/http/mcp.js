/**
 * MCP HTTP API：统一通过 MCP 暴露工具列表与 JSON-RPC 调用
 */
import { respondFail, sanitizeErrorMessage } from '../../../lib/http/utils/helpers.js';

const getMCPServer = () => Bot.AiWorkflowLoader?.mcpServer;

function requireMCP(res) {
  const mcpServer = getMCPServer();
  if (!mcpServer) {
    res.status(503).json({ success: false, message: 'MCP 服务未启用' });
    return null;
  }
  return mcpServer;
}

function success(res, data) {
  res.json({ success: true, ...data });
}

function errorRes(res, err, code = 500, fallback = 'MCP 请求失败') {
  return respondFail(res, code, sanitizeErrorMessage(err, fallback), 'MCPAPI', err);
}

export default {
  name: 'mcp',
  dsc: 'MCP服务HTTP接口',
  priority: 100,
  routes: [
    {
      method: 'POST',
      path: '/api/mcp/jsonrpc',
      handler: async (req, res) => {
        const mcpServer = requireMCP(res);
        if (!mcpServer) return;
        try {
          const stream = req.query?.stream;
          const response = await mcpServer.handleJSONRPC(req.body || {}, { stream });
          res.json(response);
        } catch (error) {
          errorRes(res, error, 500);
        }
      }
    },
    {
      method: 'POST',
      path: '/api/mcp/jsonrpc/:stream',
      handler: async (req, res) => {
        const mcpServer = requireMCP(res);
        if (!mcpServer) return;
        try {
          const stream = req.params.stream;
          const response = await mcpServer.handleJSONRPC(req.body || {}, { stream });
          res.json(response);
        } catch (error) {
          errorRes(res, error, 500);
        }
      }
    },
    {
      method: 'GET',
      path: '/api/mcp/tools',
      handler: async (req, res) => {
        const mcpServer = requireMCP(res);
        if (!mcpServer) return;
        const stream = req.query?.stream;
        const tools = stream ? mcpServer.listTools(stream) : mcpServer.listTools();
        success(res, { tools, count: tools.length, stream: stream || 'all' });
      }
    },
    {
      method: 'GET',
      path: '/api/mcp/tools/workflows',
      handler: async (req, res) => {
        const mcpServer = requireMCP(res);
        if (!mcpServer) return;
        const workflows = typeof mcpServer.listWorkflows === 'function'
          ? mcpServer.listWorkflows()
          : (mcpServer.listStreams?.() || []);
        const groups = typeof mcpServer.listToolsByWorkflow === 'function'
          ? mcpServer.listToolsByWorkflow()
          : (mcpServer.listToolsByStream?.() || {});
        success(res, { workflows, groups, count: workflows.length });
      }
    },
    {
      method: 'GET',
      path: '/api/mcp/tools/workflow/:workflowName',
      handler: async (req, res) => {
        const mcpServer = requireMCP(res);
        if (!mcpServer) return;
        const workflowName = req.params.workflowName;
        const tools = mcpServer.listTools(workflowName);
        success(res, { workflow: workflowName, tools, count: tools.length });
      }
    },
    {
      method: 'POST',
      path: '/api/mcp/tools/call',
      handler: async (req, res) => {
        const mcpServer = requireMCP(res);
        if (!mcpServer) return;
        const { name, arguments: args } = req.body || {};
        if (!name) {
          errorRes(res, new Error('工具名称不能为空'), 400);
          return;
        }
        if (!mcpServer.tools.has(name)) {
          errorRes(res, new Error(`工具未找到: ${name}`), 404);
          return;
        }
        try {
          const result = await mcpServer.handleToolCall({ name, arguments: args || {} });
          res.json(result);
        } catch (error) {
          errorRes(res, error, 500);
        }
      }
    },
    {
      method: 'GET',
      path: '/api/mcp/tools/:name',
      handler: async (req, res) => {
        const mcpServer = requireMCP(res);
        if (!mcpServer) return;
        const name = req.params.name;
        if (!mcpServer.tools.has(name)) {
          errorRes(res, new Error(`工具未找到: ${name}`), 404);
          return;
        }
        const tool = mcpServer.tools.get(name);
        success(res, {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema || {}
        });
      }
    },
    {
      method: 'GET',
      path: '/api/mcp/connect',
      handler: async (req, res) => {
        const mcpServer = getMCPServer();
        const toolsCount = mcpServer ? mcpServer.tools.size : 0;
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        if (res.flushHeaders) res.flushHeaders();

        res.write(`data: ${JSON.stringify({
          type: 'connected',
          message: 'MCP连接已建立',
          timestamp: Date.now(),
          toolsCount
        })}\n\n`);

        const heartbeat = setInterval(() => {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({
              type: 'ping',
              timestamp: Date.now(),
              toolsCount: getMCPServer()?.tools?.size ?? toolsCount
            })}\n\n`);
          }
        }, 30000);

        const cleanup = () => clearInterval(heartbeat);
        req.on('close', cleanup);
        req.on('error', cleanup);
      }
    },
    {
      method: 'GET',
      path: '/api/mcp/resources',
      handler: async (req, res) => {
        const mcpServer = requireMCP(res);
        if (!mcpServer) return;
        const resources = mcpServer.listResources();
        success(res, { resources, count: resources.length });
      }
    },
    {
      method: 'GET',
      path: '/api/mcp/resources/:uri',
      handler: async (req, res) => {
        const mcpServer = requireMCP(res);
        if (!mcpServer) return;
        try {
          const resource = await mcpServer.getResource(decodeURIComponent(req.params.uri));
          success(res, { resource });
        } catch (error) {
          errorRes(res, error, 404, `资源未找到: ${req.params.uri}`);
        }
      }
    },
    {
      method: 'GET',
      path: '/api/mcp/prompts',
      handler: async (req, res) => {
        const mcpServer = requireMCP(res);
        if (!mcpServer) return;
        const prompts = mcpServer.listPrompts();
        success(res, { prompts, count: prompts.length });
      }
    },
    {
      method: 'POST',
      path: '/api/mcp/prompts/:name',
      handler: async (req, res) => {
        const mcpServer = requireMCP(res);
        if (!mcpServer) return;
        try {
          const result = await mcpServer.getPrompt(req.params.name, req.body?.arguments || {});
          success(res, { prompt: result });
        } catch (error) {
          errorRes(res, error, 404, `提示词未找到: ${req.params.name}`);
        }
      }
    },
    {
      method: 'GET',
      path: '/api/mcp/health',
      handler: async (req, res) => {
        const mcpServer = getMCPServer();
        const isEnabled = !!mcpServer;
        res.json({
          success: true,
          mcp: {
            enabled: isEnabled,
            initialized: isEnabled ? mcpServer.initialized : false,
            toolsCount: isEnabled ? mcpServer.tools.size : 0,
            protocolVersion: isEnabled ? mcpServer.serverInfo?.protocolVersion : null
          }
        });
      }
    }
  ]
};
