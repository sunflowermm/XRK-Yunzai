/**
 * MCP 工具适配器（对齐 XRK-AGT）
 * 工具来自 global.mcpServer，转换为 OpenAI tools；处理 tool_calls 调用 MCP 并返回 role=tool 消息。
 */
export class MCPToolAdapter {
  static getMCPServer() {
    return global.mcpServer || null;
  }

  /** 将 MCP 工具转为 OpenAI tools。streams 白名单时按工作流 listTools 合并；否则 listTools()（默认排除 chat） */
  static convertMCPToolsToOpenAI(streams = []) {
    const mcpServer = this.getMCPServer();
    if (!mcpServer) return [];
    const list = Array.isArray(streams) ? streams.filter(Boolean) : [];
    const mcpTools = list.length > 0
      ? (() => {
          const uniq = new Map();
          for (const s of list) {
            for (const t of mcpServer.listTools(String(s).trim())) {
              if (!uniq.has(t.name)) uniq.set(t.name, t);
            }
          }
          return Array.from(uniq.values());
        })()
      : mcpServer.listTools();
    return mcpTools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: this.convertSchemaToOpenAI(tool.inputSchema || {})
      }
    }));
  }

  /**
   * 将 JSON Schema 转换为 OpenAI function.parameters 定义
   * @param {Object} schema - JSON Schema
   * @returns {Object} OpenAI schema
   */
  static convertSchemaToOpenAI(schema) {
    const s = schema && typeof schema === 'object' ? schema : {};
    const result = {
      type: s.type || 'object',
      properties: {},
      required: s.required || []
    };
    if (s.properties) {
      for (const [key, prop] of Object.entries(s.properties)) {
        result.properties[key] = {
          type: prop.type || 'string',
          description: prop.description || ''
        };
        if (prop.enum) result.properties[key].enum = prop.enum;
        if (prop.default !== undefined) result.properties[key].default = prop.default;
      }
    }
    return result;
  }

  /**
   * 由 tool_calls + role=tool 结果构建 v3 流式 mcp_tools 载荷（供前端工具卡片展示）。
   * @param {Array} toolCalls - OpenAI 格式 tool_calls
   * @param {Array} toolResults - handleToolCalls 返回的 role=tool 消息列表
   * @returns {Array<{ name, arguments, result }>}
   */
  static buildMcpToolsPayload(toolCalls, toolResults) {
    const list = Array.isArray(toolCalls) ? toolCalls : [];
    return list.map((tc, i) => {
      let args = {};
      if (tc.function?.arguments) {
        try {
          args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
        } catch {
          args = { raw: tc.function.arguments };
        }
      }
      return {
        name: tc.function?.name ?? 'tool',
        arguments: args,
        result: toolResults?.[i]?.content ?? ''
      };
    });
  }

  /**
   * 流式场景下向 HTTP 层发送 mcp_tools chunk（onDelta(delta, metadata) 中 metadata.mcp_tools）。
   * @param {Array} toolCalls - OpenAI 格式 tool_calls
   * @param {Array} toolResults - handleToolCalls 返回值
   * @param {Function} [onDelta] - (delta, metadata) => void
   */
  static emitMcpToolsToStream(toolCalls, toolResults, onDelta) {
    if (typeof onDelta !== 'function') return;
    const mcp_tools = this.buildMcpToolsPayload(toolCalls, toolResults);
    if (mcp_tools.length) onDelta('', { mcp_tools });
  }

  /** 并行执行 tool_calls，调用 MCP handleToolCall，返回 role=tool 消息列表 */
  static async handleToolCalls(toolCalls) {
    const list = Array.isArray(toolCalls) ? toolCalls : [];
    if (list.length === 0) return [];

    const mcpServer = this.getMCPServer();
    if (!mcpServer) {
      return list.map(tc => ({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify({ success: false, error: 'MCP服务未启用' })
      }));
    }

    return Promise.all(list.map(async (tc) => {
      const name = tc.function?.name;
      let args = {};
      if (tc.function?.arguments) {
        try {
          args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
        } catch {
          args = { raw: tc.function.arguments };
        }
      }
      try {
        const result = await mcpServer.handleToolCall({ name, arguments: args });
        let content = result?.content?.[0]?.text;
        if (typeof content !== 'string' || !content.length) {
          content = JSON.stringify(result != null ? result : { success: true });
        }
        return { role: 'tool', tool_call_id: tc.id, content };
      } catch (err) {
        return {
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ success: false, error: err.message || String(err) })
        };
      }
    }));
  }

  static hasTools() {
    return !!(this.getMCPServer()?.tools?.size);
  }
}
