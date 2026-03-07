---
name: xrk-config-commonconfig
description: Add or modify CommonConfig schema for XRK-Yunzai. Use when editing plugins/system-plugin/commonconfig/, defining config schema, or integrating YAML config with frontend forms.
---

# CommonConfig 配置开发

## 位置

- `plugins/system-plugin/commonconfig/system.js`：主 configFiles 注册
- 各 `*_llm.js`、`*_asr.js` 等：工厂配置

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

- `string`、`number`、`boolean`、`object`、`array`
- 嵌套对象：`fields`；数组：`itemType`、`itemSchema`

## 工具

- `getServerConfigPath(port, configName)`：config-constants
- `deepMergeConfig`、`applyDefaults`、`cleanConfigData`：config-utils
