/**
 * MCP HTTP API：统一通过 MCP 暴露工具列表与 JSON-RPC 调用
 */

const getMCPServer = () => Bot.StreamLoader?.mcpServer;

function requireMCP(res) {
  const mcpServer = getMCPServer();
  if (!mcpServer) {
    res.status(503).json({ success: false, error: 'MCP服务未启用' });
    return null;
  }
  return mcpServer;
}

function success(res, data) {
  res.json({ success: true, ...data });
}

function errorRes(res, err, code = 500) {
  res.status(code).json({
    success: false,
    error: err?.message || String(err)
  });
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
      path: '/api/mcp/tools/streams',
      handler: async (req, res) => {
        const mcpServer = requireMCP(res);
        if (!mcpServer) return;
        const streams = mcpServer.listStreams();
        const groups = mcpServer.listToolsByStream();
        success(res, { streams, groups, count: streams.length });
      }
    },
    {
      method: 'GET',
      path: '/api/mcp/tools/stream/:streamName',
      handler: async (req, res) => {
        const mcpServer = requireMCP(res);
        if (!mcpServer) return;
        const streamName = req.params.streamName;
        const tools = mcpServer.listTools(streamName);
        success(res, { stream: streamName, tools, count: tools.length });
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
