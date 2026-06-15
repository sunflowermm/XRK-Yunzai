# AIStream 配置与 MCP 手册

> 覆盖 `config/default_config/aistream.yaml`、`lib/aistream/loader.js`、`lib/utils/aistream-config.js`、控制台 **系统配置 → aistream** 段。

---

## 1. 配置读取（代码约定）

| API | 路径 | 用途 |
|-----|------|------|
| `getAistreamConfigOptional()` | `lib/utils/aistream-config.js` | **`lib/` 内读 aistream 的唯一入口**；无配置时返回 `{}` |
| `cfg.aistream` | `lib/config/config.js` 单例 | 运行时合并后的有效配置（启动后裸名 `cfg` 可用） |
| `cfg.getMergedConfig('aistream')` | 同上 | default_config + data 深合并 |

**规范**：`lib/aistream/*`、`lib/factory/llm/*`、`lib/crawl/*` 等底层模块应使用 `getAistreamConfigOptional()`，避免散落 `cfg?.aistream?.…`。

---

## 2. 配置文件结构（`aistream.yaml`）

| 段 | 说明 |
|----|------|
| `enabled` | 工作流总开关；`false` 时 `StreamLoader` 跳过加载 |
| `global` | `maxTimeout`、`maxConcurrent`、`debug` 等 |
| `llm` | 全局 LLM 参数与 **`Provider`**（`providers[].key`） |
| `mcp` | MCP 服务、默认工作流/远程 MCP、工具合并策略 |
| `cache` | 工作流结果 LRU 缓存 |
| `crawl` | `web_fetch` / `web_search` / `browser` 等 |

默认模板：`config/default_config/aistream.yaml`。  
运行时：全局 `data/server_bots/aistream.yaml`（`GLOBAL_CONFIG_NAMES`）。

---

## 3. LLM 运营商（Provider）

- **配置键**：`aistream.llm.Provider`（大小写兼容 `provider`）。
- **取值**：各工厂 YAML 中 `providers[]` 条目的 **`key`**（如 `gptgod`、`deepseek-main`），**不是**工厂 id（如 `volcengine_llm`）。
- **解析**：`LLMFactory.resolveProvider()` / `getProviderConfig(key)`。
- **控制台**：`SystemConfig` 在 `getStructure()` 前动态刷新 enum，有可用 provider 时表单项为 **下拉 Select**（`plugins/system-plugin/commonconfig/system.js`）。

工厂 YAML：`data/server_bots/*_llm.yaml`、`data/server_bots/<port>/*_llm.yaml`。详见 [FACTORY.md](../FACTORY.md)。

---

## 4. MCP 架构

```
StreamLoader
├── mcpServer          ← MCPToolAdapter / HTTP mcp.js 统一入口
├── streams            ← 各工作流 registerMCPTool
├── builtinMcpServers  ← stream 模块 export mcpServers
└── remoteMCPServers   ← 用户配置的远程 MCP
```

| 访问方式 | 说明 |
|----------|------|
| `StreamLoader.mcpServer` | MCP 服务实例（工具 Map） |
| `MCPToolAdapter.getMCPServer()` | 封装为 `StreamLoader.mcpServer` |
| `StreamLoader.listRemoteMCPServers()` | 已加载远程 MCP 名称列表（供配置 enum） |

**已废弃**：`global.mcpServer`（勿在文档或新代码中引用）。

---

## 5. MCP 配置字段（`aistream.mcp`）

| 字段 | 说明 |
|------|------|
| `enabled` | MCP 总开关 |
| `autoRegister` | 是否自动注册工作流 `mcpTools` |
| `defaultStreams` | 默认启用工作流（留空=内置 `tools`、`web`） |
| `defaultRemoteMcp` | 默认启用远程 MCP 名称 |
| `toolMergeStrategy` | `preferRequest` / `preferStream` / `merge` |
| `remote.enabled` | 是否加载用户配置的远程 MCP |
| `remote.mcpServers` | **JSON 块数组**（见下节） |

### 远程 MCP：`remote.mcpServers`

每条为一个对象，核心字段为 `config`（JSON 组件）。可粘贴 Claude Desktop 风格片段：

```json
{
  "mcpServers": {
    "my-mcp": {
      "command": "npx",
      "args": ["-y", "some-mcp-package"]
    }
  }
}
```

`StreamLoader._getRemoteMCPConfig()` 合并所有块的 `mcpServers` 后按名称注册。

**已废弃**（勿再写入 yaml / schema）：

- `remote.servers` + `remote.selected` 分离式表单

---

## 6. 插件内置 MCP

工作流模块可导出：

```javascript
export const mcpServers = {
  'plugin-mcp': { command: 'npx', args: ['-y', 'pkg'] }
};
```

或由 `getMcpServers()` 返回同等结构。`StreamLoader` 加载 stream 时自动登记，**无需**在 `aistream.yaml` 重复配置。

---

## 7. CommonConfig 动态 schema

`plugins/system-plugin/commonconfig/system.js` 在构造与每次 `getStructure()` / 写入校验前调用 `_refreshDynamicSchema()`：

| 字段 | 动态 enum 来源 |
|------|----------------|
| `llm.Provider` | `LLMFactory.listProviders()` |
| `mcp.defaultStreams` | `StreamLoader.getStreamsByPriority()` |
| `mcp.defaultRemoteMcp` | `StreamLoader.listRemoteMCPServers()` |

`ConfigBase.validate` 支持 `prepareValidate` 钩子，避免校验时 enum 不含已持久化旧值。

---

## 8. 配置合并（控制台读写）

与 [COMMONCONFIG_BASE.md](../COMMONCONFIG_BASE.md) 一致：

1. `default_config` 模板  
2. `data/server_bots/…` 覆盖  
3. `schema.fields[].default` 补缺  

读取：`mergeConfigLayers`；写入：`readStored` + `deepMergeConfig`。

---

## 相关文档

- [CONFIG_PRIORITY.md](../CONFIG_PRIORITY.md) — `resolveLLMConfig` 字段优先级  
- [WORKFLOW_BASE_CLASS.md](../WORKFLOW_BASE_CLASS.md) — 工作流基类  
- [reference/WORKFLOWS.md](./WORKFLOWS.md) — AIStream API 手册  
- [lib/aistream/README.md](../../lib/aistream/README.md) — 模块索引
