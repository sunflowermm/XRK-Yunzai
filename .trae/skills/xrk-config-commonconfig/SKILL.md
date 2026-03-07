---
name: xrk-config-commonconfig
description: 新增或修改 XRK-Yunzai 的 CommonConfig schema 时使用；涉及 plugins/system-plugin/commonconfig/、配置 schema 定义或 YAML 与前端表单对接时使用。
---

# CommonConfig 配置开发

## 位置

- 主注册：`plugins/system-plugin/commonconfig/system.js` 的 `configFiles`。
- 各工厂/业务配置：如 `*_llm.js`、`*_asr.js` 等，在对应 commonconfig 中注册。

## Schema 结构

```javascript
{
  filePath: (c) => getServerConfigPath(c?._port ?? 8086, 'config_name'),
  schema: {
    fields: {
      fieldName: {
        type: 'string',
        label: '显示名',
        default: '',
        required: false
      }
    }
  }
}
```

## 类型

- `string`、`number`、`boolean`、`object`、`array`。
- 嵌套对象：`fields`；数组：`itemType`、`itemSchema`。

## 工具

- 路径：`getServerConfigPath(port, configName)`（`lib/config/config-constants.js`）。
- 合并与默认值：`deepMergeConfig`、`applyDefaults`、`cleanConfigData`（`lib/commonconfig/config-utils.js`）。
