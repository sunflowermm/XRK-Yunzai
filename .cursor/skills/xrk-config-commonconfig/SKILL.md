---
name: xrk-config-commonconfig
description: 新增或修改 XRK-Yunzai 的 CommonConfig schema 时使用；涉及 plugins/system-plugin/commonconfig/、配置 schema 定义或 YAML 与前端表单对接时使用。
---

# CommonConfig 配置开发

## 权威入口

- **写法**：`docs/coding-style.md`
- **短契约**：`docs/base-classes.md`（ConfigBase 段）· **详述**：`docs/COMMONCONFIG_BASE.md`
- **常量**：`lib/config/config-constants.js`（`GLOBAL_CONFIG_NAMES`、`PORT_CONFIG_NAMES`）
- **基类**：`lib/commonconfig/commonconfig.js`

## 适用场景

- 新增/修改 `system.js` 配置段或独立 `*_llm.js` schema
- 对齐 `config/default_config/*.yaml` 与表单字段

## 非适用场景

- 运行时 Bot 逻辑 → 插件/工作流 skill
- 仅改端口 bot.yaml 值、不改 schema → 用户数据，无需改 commonconfig

## 配置三件套（改 GLOBAL/PORT 时必做）

1. `config/default_config/{name}.yaml` 存在
2. `plugins/system-plugin/commonconfig/system.js` schema 含 `{name}:` 段
3. `lib/config/config-constants.js` 列表含 `name`

验证：`pnpm test` → `config-alignment.test.mjs`

## Schema 示例

```javascript
import ConfigBase from '../../lib/commonconfig/commonconfig.js';
import { getServerConfigPath } from '../../lib/config/config-constants.js';

export default class MyConfig extends ConfigBase {
  constructor() {
    super({
      name: 'myconfig',
      displayName: '显示名',
      filePath: (cfg) => getServerConfigPath(cfg?._port ?? 2536, 'myconfig'),
      schema: {
        fields: {
          fieldName: { type: 'string', label: '显示名', default: '', required: false }
        }
      }
    });
  }
}
```

类型：`string`、`number`、`boolean`、`object`、`array`；嵌套用 `fields` / `itemSchema`。

## 约定

- 合并：`mergeConfigLayers`（读）、`deepMergeConfig`（写/表单）、`buildDefaultsFromSchema`（`lib/commonconfig/config-utils.js`）
- 读：`ConfigBase.read()` = default_config → data → schema.default；`readStored()` = 仅 data 层
- 动态 enum：`prepareValidate` + `getStructure()` 前刷新（aistream Provider / MCP 列表）
- 运行时 `cfg`：`getMergedConfig(name)` = 深合并 `getdefSet` + `getConfig`
- 对象判断：`ObjectUtils`，不重复实现
- 默认模板：`config/default_config/`；运行时：`data/server_bots/<port>/` 或全局根 yaml
- **无** ASR/TTS 工厂配置项（已移除）；LLM 为 `*_llm` / `*_compat_llm`

## 常见陷阱

- 只改 yaml 不改 `system.js` schema（三件套失败）
- 手写路径字符串，未用 `getServerConfigPath`
- 将 `*_llm.yaml` 误加入 `GLOBAL_CONFIG_NAMES`

## 参考

- skill `xrk-framework-tests`、`xrk-base-layer`
- 规则 `commonconfig-schema.mdc`
