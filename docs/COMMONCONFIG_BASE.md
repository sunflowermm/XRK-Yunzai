<h1 align="center">CommonConfig 基类指南</h1>

<div align="center">

![Config Base](https://img.shields.io/badge/CommonConfig-Base%20Class-blue?style=flat-square)
![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Version](https://img.shields.io/badge/Version-3.2.0-informational?style=flat-square)

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

### 3. 类型标准化与三层合并

**读取合并顺序**（`ConfigBase.read()` / `mergeConfigLayers`）：

1. `config/default_config/{name}.yaml` — 模板兜底  
2. `data/server_bots/...` — 实际配置覆盖  
3. `schema.fields[].default` — 新增字段缺省值（旧 yaml 无此键时 Web 不显示空值）  

**写入**：`readStored()` 仅读 data 层再合并，避免把模板全量复制进 data。

1. **读取**：`read()` 在三层合并后调用 `cleanConfigData`，根据 schema 做类型标准化。
2. **写入**：`write()` 在 transform 与 validate 之前再次执行 `cleanConfigData`。
3. **API 层**：`plugins/system-plugin/http/config.js` 复用同一套 `cleanConfigData` / `deepMergeConfig`。
4. **前端**：`fillMissingSchemaDefaults` 仅作 flat 路径兜底；有效值以 API `read`/`flat` 为准。

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

## 与其它仓库约定

若从其它项目迁移 commonconfig：**基类**为 `lib/commonconfig/commonconfig.js`；**扫描目录**仅为 `plugins/<插件名>/commonconfig/`，配置键为 `插件名_文件名`（`system-plugin` 的 `system.js` 映射为 `system`）。`Loader.getList()` 仅收录实现了 `getStructure` 的配置类。兼容 LLM 使用各 `*_compat_llm.yaml` 的 `providers[]`，由 `LLMFactory` 注册为独立 provider。

## 配置文件存放与加载

| 目录 | key 格式 | 说明 |
|------|----------|------|
| `plugins/<插件名>/commonconfig/*.js` | `插件名_文件名`（system-plugin 的 system.js 特殊映射为 `system`） | ConfigLoader 仅扫描各插件下 commonconfig 目录，不加载项目根下旧目录。 |

须导出 `default`（类或对象）。  
**实现**：`ConfigLoader`（`lib/commonconfig/loader.js`）在 `load()` 时扫描上述目录，`watch()` 仅对已加载目录做热重载。  
**设计说明**：配置与插件绑定，便于按插件热重载与权限隔离；键名带插件前缀避免跨插件同名冲突。

### Compat 工厂与系统配置清单

| 配置名 | 说明 | default_config |
|--------|------|----------------|
| openai_compat_llm | OpenAI Chat 协议兼容（多运营商 providers 数组） | openai_compat_llm.yaml |
| openai_responses_compat_llm | OpenAI Responses 协议 | openai_responses_compat_llm.yaml |
| newapi_compat_llm | New API 协议 | newapi_compat_llm.yaml |
| cherryin_compat_llm | CherryIN 协议 | cherryin_compat_llm.yaml |
| ollama_compat_llm | Ollama /api/chat 协议 | ollama_compat_llm.yaml |
| gemini_compat_llm | Gemini Generate Content 协议 | gemini_compat_llm.yaml |
| anthropic_compat_llm | Anthropic Messages 协议 | anthropic_compat_llm.yaml |
| azure_openai_compat_llm | Azure OpenAI Chat Completions 协议 | azure_openai_compat_llm.yaml |
