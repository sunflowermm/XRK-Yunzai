<h1 align="center">CommonConfig 基类指南</h1>

<div align="center">

![Config Base](https://img.shields.io/badge/CommonConfig-Base%20Class-blue?style=flat-square)
![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Version](https://img.shields.io/badge/Version-3.1.3-informational?style=flat-square)

</div>

> ⚙️ `lib/commonconfig/commonconfig.js` 提供配置统一基类 `ConfigBase`，在「配置文件 → API → 前端 UI」间打通类型、校验与读写约定。本指南总结能力、扩展方式及前后端约定。

---

### 1. 主要职责
- **统一路径解析**：支持静态/动态 `filePath`，并自动拼接项目根目录。
- **缓存与备份**：5 秒内重复读取直接命中缓存，写入前自动生成时间戳备份。
- **读写与序列化**：内置 YAML / JSON 读写，序列化时保持缩进与行宽一致，避免 diff 污染。
- **Schema 驱动的校验和类型纠偏**：通过 `schema.fields` 描述类型，`read` 与 `write` 均会调用 `cleanConfigData` 做统一的类型标准化，再交由 `validate` 做业务规则校验。
- **工具方法**：`get` / `set` / `delete` / `append` / `remove` / `merge` 等帮助 API 快速实现局部更新。

### 2. schema 结构
```js
{
  name: 'server',
  displayName: 'Web 服务配置',
  filePath: 'config/default_config/server.yaml',
  fileType: 'yaml',
  schema: {
    required: ['host', 'port'],
    fields: {
      host: { type: 'string', label: 'Host', default: '0.0.0.0' },
      port: { type: 'number', min: 1, max: 65535, default: 8086 },
      https: {
        type: 'object',
        fields: {
          enabled: { type: 'boolean', default: false },
          cert: { type: 'string' }
        }
      },
      whitelist: {
        type: 'array',
        itemType: 'string',
        description: '允许访问的来源'
      }
    }
  }
}
```

- `fields` 支持 `string|number|boolean|object|array`，数组可指定 `itemType / itemSchema`。
- `required` 控制必填字段；`min/max/minLength/maxLength/pattern/enum` 直接用于校验。
- 任意字段可添加 `label/description/placeholder/component/default` 帮助前端渲染。

### 3. 类型标准化流程
1. **读取**：`read()` 在解析 YAML/JSON 后立即调用 `cleanConfigData`，根据 schema 把每个字段转换为目标类型（数字、布尔、数组、对象等），确保缓存与 API 输出的数据结构统一。
2. **写入**：`write()` 在 transform 与 validate 之前再次执行 `cleanConfigData`。这样即使前端传来字符串数字或 `'on'/'off'` 之类值，也能在落盘前被转换为正确的 YAML 类型。
3. **API 层**：`plugins/<插件根>/http/config.js` 复用同一个 `cleanConfigData`，对局部 `set`/`write` 请求做相同的类型收敛，避免重复判断。
4. **前端**：`www/xrk/app.js` 在可视化表单和 JSON 编辑模式中都通过 schema key 调用 `_normalizeConfigData`，保持与后端一致的类型约束，防止组件之间出现值冲突。

> 统一的标准化流程意味着任何一段配置数据，从 UI → API → 底层文件，始终使用同一份 schema 信息来决定真实数据类型，彻底消除“字符串数字”“真假值”以及数组/对象结构不一致的问题。

### 4. 扩展新配置的步骤
1. **创建类**：继承 `ConfigBase`，传入基础元数据（`name/displayName/description/filePath/fileType/schema`）。
2. **定义 schema**：覆盖所有需要暴露到 UI 的字段，合理设置默认值与验证条件。
3. **可选 hook**：
   - `transformRead(data)`：读取后动态整理展示结构。
   - `transformWrite(data)`：写入前做额外的派生或剪裁。
   - `customValidate(data)`：除了 schema 之外的交叉字段校验，返回错误数组。
4. **注册到 ConfigManager**：确保 `global.ConfigManager` 能实例化并暴露 `getStructure()`，前端即可自动渲染表单。

### 5. 与前端的协作约定
- `getStructure()` 返回的 schema 将被缓存为 `schemaKey = configName[.subName]`，前端据此渲染组件与校验。
- 新的“组件渲染注册表”消除了表单组件之间的条件嵌套，任何字段只需声明 `component` 即可得到对应 UI。
- 保存/验证时，前端会把 form 数据通过 `_normalizeConfigData` 处理后提交，字段值与后端保持一一对应，避免“headers/methods/origins”这类数组字段被错误串化。

### 6. 最佳实践
- **始终提供 schema**：没有 schema 的配置将回退到 JSON 编辑模式，既无法自动校验，也无法得到类型标准化收益。
- **保持字段命名一致**：schema、默认 YAML、UI 组件 id / data-field 应保持相同的字段名，便于自动映射。
- **在 schema 中描述嵌套对象**：多级 `fields` 不仅可以驱动表单嵌套，还能让 `cleanConfigData` 递归工作，避免后续手动 `typeof` 判断。
- **使用默认值表达“空状态”**：例如布尔和数组字段，通过 `default` 即可告知后端/前端，在缺省场景应该返回什么，减少冗余 if-else。

遵循 schema 约束即可获得一致的类型、校验与编辑体验。

## 配置文件存放与加载

| 优先级 | 目录 | key 格式 |
|--------|------|----------|
| 高 | `plugins/<插件名>/commonconfig/*.js` | `插件名_文件名` |
| 中 | `config/commonconfig/*.js` | `文件名` |
| 低 | `core/<模块>/commonconfig/*.js` | `模块名_文件名` |

同名按上表优先级覆盖。须导出 `default`（类或对象）。
