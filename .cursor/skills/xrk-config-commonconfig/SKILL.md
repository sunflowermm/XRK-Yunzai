---
name: xrk-config-commonconfig
description: 新增或修改 XRK-Yunzai 的 CommonConfig schema 时使用；涉及 plugins/system-plugin/commonconfig/、配置 schema 定义或 YAML 与前端表单对接时使用。
---

# CommonConfig 配置开发

## 文档与代码

- 短契约：`docs/base-classes.md`（ConfigBase 段）
- 基类：`lib/commonconfig/commonconfig.js`；工具：`lib/commonconfig/config-utils.js`

## 注册位置

- 主注册：`plugins/system-plugin/commonconfig/system.js` 的 `configFiles`。
- 各业务：`plugins/system-plugin/commonconfig/*_llm.js` 等。

## Schema

```javascript
{
  filePath: (c) => getServerConfigPath(c?._port ?? 2536, 'config_name'),
  schema: {
    fields: {
      fieldName: { type: 'string', label: '显示名', default: '', required: false }
    }
  }
}
```

类型：`string`、`number`、`boolean`、`object`、`array`；嵌套用 `fields` / `itemSchema`。

## 约定

- 继承 `ConfigBase`；`filePath` 优先 `getServerConfigPath(port, name)`。
- 合并：`deepMergeConfig`、`applyDefaults`、`cleanConfigData`（`config-utils.js`）。
- 对象判断用 `ObjectUtils`，不重复实现。
- 默认模板：`config/default_config/`；运行时：`data/server_bots/<port>/`。

## 参考

- skill `xrk-base-layer`；规则 `commonconfig-schema.mdc`
