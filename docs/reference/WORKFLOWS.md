# 工作流引擎 & 记忆系统手册

> 覆盖 `lib/aistream/aistream.js`、`lib/aistream/memory.js`、`lib/aistream/workflow-manager.js` 全部导出。

---

## 1. AIStream（工作流基架）

### LightweightSimilarity

| 方法 | 说明 |
|------|------|
| `tokenize(text)` | 字符串拆为字符与双字符数组 |
| `calculateIDF(documents)` | 基于文档计算 IDF |
| `score(query, document)` | BM25 得分，轻量语义检索 |

### 构造与初始化

| 方法 | 说明 |
|------|------|
| `constructor(options)` | 合并 cfg.aistream + getLLMConfig，初始化 MemorySystem、函数开关、BM25 配置 |
| `init()` | 一次性初始化：函数 Map、记忆（若启用） |
| `initEmbedding()` | 初始化 LightweightSimilarity（扩展点） |

### 记忆与检索

| 方法 | 说明 |
|------|------|
| `storeMessageWithEmbedding(groupId, message)` | 启用时写入 Redis `ai:embedding:${name}:${groupId}`（对话+元数据） |
| `retrieveRelevantContexts(groupId, query)` | 从 Redis 读历史并按相似度排序 |
| `buildEnhancedContext(e, question, baseMessages)` | 将检索结果注入系统 prompt |

### 功能注册与解析

| 方法 | 说明 |
|------|------|
| `registerFunction(name, { handler?, prompt?, parser?, enabled?, permission?, description? })` | 注册 LLM 可调功能，functionToggles 覆盖启用状态 |
| `isFunctionEnabled(name)` / `toggleFunction(name, enabled)` / `getEnabledFunctions()` | 检查、切换、列举功能开关 |
| `buildSystemPrompt(context)` | 抽象；子类返回系统提示 |
| `buildFunctionsPrompt()` | 拼接启用功能的 prompt 段落 |
| `buildChatContext(e, question)` | 抽象；子类构造对话数组 |
| `parseFunctions(text, context?)` | 运行 parser，提取功能调用，返回 functions/cleanText/timeline |
| `assignFunctionPositions` / `findAvailablePosition` / `buildActionTimeline` / `mergeTextSegments` | 位置分配、时间线构建、文本拼接 |
| `runActionTimeline(timeline, context)` | 执行功能节点并拼合结果 |
| `executeFunction(type, params, context)` | 检查启用/权限后调用 handler |
| `checkPermission(permission, context)` | 按群成员角色判定是否允许 |

### AI 调用与执行

| 方法 | 说明 |
|------|------|
| `callAI(messages, apiConfig?)` | 非流式 Chat Completions，返回 content |
| `callAIStream(messages, apiConfig?, onDelta)` | 流式，增量传 onDelta |
| `execute(e, question, config?)` | 合并配置→上下文→callAI→preprocessResponse→parseFunctions→runActionTimeline→存储记忆/索引 |
| `preprocessResponse(response, context)` | 默认原样返回；子类可重写 |
| `process(e, question, apiConfig?)` | try/catch 包裹 execute |

### 其他

| 方法 | 说明 |
|------|------|
| `getInfo()` | 返回 name/description/version/embedding 状态/函数列表 |
| `getMemorySystem()` | 返回 MemorySystem 实例 |
| `buildMemorySummary(e, options?)` | 调用 MemorySystem.buildSummary |
| `cleanup()` | 清理内部状态（重载/关闭时） |

---

## 2. MemorySystem

| 方法 | 说明 |
|------|------|
| `constructor(options)` | baseKey、maxPerOwner、longTTL、shortTTL；记录 Redis 与 key 前缀 |
| `isEnabled()` | 是否已连 Redis |
| `normalizeLayer(layer)` | 支持 long/short/master 及中文别名 |
| `ownerKey(ownerId, scene?)` | 生成 `ai:memory:<scene>:<owner>` 或 `ai:memory:owner:<owner>` |
| `extractScene(e)` | 从事件推断 ownerId、scene（群/私聊/设备/全局） |
| `initMasters(masterList)` | 清空并重写主人记忆列表 |
| `getMasterMemories()` | 读取 masterKey 并解析 JSON |
| `remember({ ownerId, scene, layer?, content, metadata?, authorId? })` | 写入有序集合，按 TTL 与数量限制清理 |
| `getMemories(ownerId, scene, { limit?, layers? })` | 读取最近记忆并过滤过期 |
| `forget(ownerId, scene, memoryId?, content?)` | 按 ID 删除、按关键词模糊删除或清空 |
| `buildSummary(e, { preferUser? })` | 组合主人/用户/群记忆为多行摘要 |

---

## 3. WorkflowManager

| 方法 | 说明 |
|------|------|
| `constructor()` | 初始化 workflows Map、activeCalls 追踪表 |
| `registerWorkflow(name, handler, { description?, enabled?, priority?, timeout? })` | 保存元数据与处理函数 |
| `normalizeName(name)` | 去首尾空格并转小写 |
| `run(name, params?, context?)` | 查找→race(timeout)→标准化返回→失败日志 |
| `runMultiple(workflows, sharedParams?, context?)` | 并行 Promise.allSettled，失败项返回错误提示 |
| `runSequential(workflows, sharedParams?, context?)` | 顺序执行并收集结果 |
| `callStream(streamName, e, question, config?)` | 通过 StreamLoader 查找并执行 |
| `getWorkflows()` | 返回启用工作流列表，按 priority 升序 |
| `toggleWorkflow(name, enabled)` | 启用/禁用 |
| `getActiveCalls()` | activeCalls 转数组，便于监控 |

---

自定义工作流装载见 `plugins/<插件根>/stream/*.js` 与 [PLUGINS.md](./PLUGINS.md)。
