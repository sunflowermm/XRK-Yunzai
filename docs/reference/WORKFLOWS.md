<div align="center">

# 工作流引擎 & 记忆系统手册

> 覆盖 `lib/aistream/aistream.js`, `lib/aistream/memory.js`, `lib/aistream/workflow-manager.js` 全部导出函数。

</div>

---

<div align="center">

## 1. `AIStream`（工作流基架）

</div>

### LightweightSimilarity 工具
- **`tokenize(text)`**：将字符串拆分为字符与双字符数组。
- **`calculateIDF(documents)`**：基于所有文档计算 IDF。
- **`score(query, document)`**：根据 BM25 得分，用于轻量级语义检索。

### constructor(options = {})
- **签名**: `new AIStream({ name?, description?, version?, author?, priority?, config?, functionToggles?, embedding? })`
- **要点**: 合并 `cfg.kuizai.ai` 生成默认推理配置，初始化 `MemorySystem`、函数开关与 embedding 配置。

### init()
- **签名**: `async init(): Promise<void>`
- **作用**: 仅执行一次的初始化：创建函数 Map、初始化记忆（如果启用）。

### initEmbedding()
- **签名**: `async initEmbedding(): Promise<void>`
- **作用**: 根据 `embeddingConfig.provider` 初始化，并在失败时尝试降级到 `lightweight`。

### tryInitProvider(provider)
- **签名**: `async tryInitProvider(provider: 'lightweight'|'onnx'|'hf'|'fasttext'|'api'): Promise<void>`
- **作用**: 分派到对应 `init*Embedding`。

### initLightweightEmbedding()
- **作用**: 构造 `LightweightSimilarity`（BM25）。

### initONNXEmbedding()
- **作用**: 下载/加载 ONNX 模型与 tokenizer，创建 `onnxruntime-node` session。

### downloadONNXModel(modelName)
- **作用**: 如本地不存在则从 HuggingFace 下载 `model_quantized.onnx`。

### loadONNXTokenizer(modelName)
- **作用**: 暂用字符编码法生成 512 长度输入。

### initHFEmbedding()
- **作用**: 使用 `@huggingface/inference`，需提供 `embeddingConfig.hfToken`。

### initFastTextEmbedding()
- **作用**: 下载 fastText 模型（如 `cc.zh.300.bin`）并加载。

### downloadFastTextModel(modelName)
- **作用**: 从 `dl.fbaipublicfiles.com` 获取 fastText 模型文件。

### initAPIEmbedding()
- **作用**: 校验 `apiUrl/apiKey/apiModel` 并进行连通性测试。

### testEmbeddingModel() / testHFConnection() / testAPIConnection()
- **作用**: 通过生成一次向量验证 embedding 是否可用。

### generateEmbedding(text)
- **签名**: `async generateEmbedding(text: string): Promise<number[]|string|null>`
- **作用**: 封装 provider 分支以及异常降级。

### generateONNXEmbedding(text)
- **作用**: 利用 ONNX session 推理，并对 token 向量取平均值 + 归一化。

### generateHFEmbedding(text) / generateFastTextEmbedding(text) / generateAPIEmbedding(text)
- **作用**: 分别调用 HF API、fastText、本地/远程 API 生成向量。

### cosineSimilarity(vec1, vec2)
- **签名**: `(number[], number[]) => number`
- **作用**: 计算余弦相似度，用于 embedding 检索。

### storeMessageWithEmbedding(groupId, message)
- **签名**: `async storeMessageWithEmbedding(groupId: string|number, message: { user_id, nickname, message, message_id, time }): Promise<void>`
- **作用**: 若启用 embedding，则在 Redis 列表 `ai:embedding:${name}:${groupId}` 中存储向量。

### retrieveRelevantContexts(groupId, query)
- **签名**: `async retrieveRelevantContexts(groupId: string, query: string): Promise<Array<{ message, similarity, time, userId, nickname }>>`
- **作用**: 从 Redis 读取历史消息并按相似度排序过滤。

### buildEnhancedContext(e, question, baseMessages)
- **签名**: `async buildEnhancedContext(e, question, baseMessages: ChatMessage[]): Promise<ChatMessage[]>`
- **作用**: 将检索到的历史对话注入系统 prompt。

### registerFunction(name, options)
- **签名**: `registerFunction(name: string, { handler?, prompt?, parser?, enabled?, permission?, description? })`
- **作用**: 注册可供 LLM 调用的功能，`functionToggles` 会覆盖默认启用状态。

### isFunctionEnabled(name) / toggleFunction(name, enabled) / getEnabledFunctions()
- **作用**: 检查、切换、列举功能开关。

### buildSystemPrompt(context)
- **说明**: 抽象方法；子类需要返回系统提示。

### buildFunctionsPrompt()
- **作用**: 将启用的功能 prompt 拼接成提示段落。

### buildChatContext(e, question)
- **说明**: 抽象方法；子类实现构造对话数组。

### parseFunctions(text, context = {})
- **签名**: `parseFunctions(text: string, context?: any): { functions: ParsedFunction[], cleanText: string, timeline: TimelineEntry[] }`
- **作用**: 运行所有注册 parser，提取功能调用并生成文本时间线。

### assignFunctionPositions(text, functions)
- **作用**: 为功能调用记录原始文本位置，避免冲突。

### findAvailablePosition(text, raw, usedRanges)
- **作用**: 辅助 `assignFunctionPositions` 找到不重叠区间。

### buildActionTimeline(text, functions)
- **作用**: 根据位置排序生成 `{ type: 'text'|'function' }` 列表。

### mergeTextSegments(timeline)
- **作用**: 将所有 text 片段拼接成干净文本。

### runActionTimeline(timeline, context)
- **作用**: 执行功能节点并拼合结果，用于回答生成。

### executeFunction(type, params, context)
- **作用**: 检查启用状态/权限后调用注册的 handler。

### checkPermission(permission, context)
- **作用**: 基于群成员角色判定功能调用是否允许。

### callAI(messages, apiConfig = {})
- **签名**: `async callAI(messages: ChatMessage[], apiConfig?: Partial<AIConfig>): Promise<string|null>`
- **作用**: 调用 Chat Completions（非流式），并返回 `content`。

### callAIStream(messages, apiConfig = {}, onDelta)
- **签名**: `async callAIStream(messages, apiConfig, onDelta: (chunk: string) => void): Promise<void>`
- **作用**: 开启流式 Chat Completions，将增量传给 `onDelta`。

### execute(e, question, config)
- **签名**: `async execute(e, question: any, config?: Partial<AIConfig>): Promise<string|null>`
- **流程**: 合并配置 → 构造上下文 → `callAI` → `preprocessResponse` → `parseFunctions` → `runActionTimeline` → 存储记忆/embedding。

### preprocessResponse(response, context)
- **默认**: 返回原值；子类可重写进行二次加工。

### process(e, question, apiConfig = {})
- **作用**: try/catch 包裹的 `execute`。

### getInfo()
- **签名**: `getInfo(): WorkflowMetadata`
- **作用**: 返回 name/description/version/embedding 状态/函数列表。

### getMemorySystem()
- **作用**: 返回内部 `MemorySystem` 实例。

### buildMemorySummary(e, options)
- **作用**: 调用 `MemorySystem.buildSummary`，通常用于提示词注入。

### cleanup()
- **作用**: 释放 embedding 资源（session/model/tokenizer），重置初始化标记。

---

<div align="center">

## 2. `MemorySystem`

</div>

### constructor(options = {})
- **参数**: `baseKey`, `maxPerOwner`, `longTTL`, `shortTTL`.
- **作用**: 记录 Redis 可用性、key 前缀与各层 TTL。

### isEnabled()
- **作用**: 判断是否已经连接 Redis。

### normalizeLayer(layer)
- **作用**: 支持 `long/short/master` 及其中文别名。

### ownerKey(ownerId, scene?)
- **作用**: 生成 `ai:memory:<scene>:<owner>` 或 `ai:memory:owner:<owner>`。

### extractScene(e)
- **作用**: 根据事件推断 `{ ownerId, scene }`（群、私聊、设备、全局）。

### initMasters(masterList)
- **作用**: 清空并重新写入主人记忆列表。

### getMasterMemories()
- **作用**: 读取 `masterKey` 列表并解析 JSON。

### remember(params)
- **签名**: `async remember({ ownerId, scene, layer = 'long', content, metadata?, authorId? }): Promise<Memory>`
- **作用**: 向有序集合写入记忆、按 TTL 清理、限制数量。

### getMemories(ownerId, scene, options = {})
- **签名**: `async getMemories(ownerId: string, scene: string, { limit = 6, layers = ['long','short'] } = {}): Promise<Memory[]>`
- **作用**: 读取最近的记忆并过滤过期条目。

### forget(ownerId, scene, memoryId?, content?)
- **作用**: 支持按 ID 删除、按关键词模糊删除或清空整个集合。

### buildSummary(e, { preferUser = false } = {})
- **作用**: 组合主人记忆、用户/群记忆形成多行摘要。

---

<div align="center">

## 3. `WorkflowManager`

</div>

### constructor()
- **作用**: 初始化 `workflows` Map 与 `activeCalls` 追踪表。

### registerWorkflow(name, handler, options = {})
- **签名**: `registerWorkflow(name: string, handler: (params, context) => Promise<any>, { description?, enabled?, priority?, timeout? }?)`
- **作用**: 保存工作流元数据与处理函数。

### normalizeName(name)
- **作用**: 返回去首尾空格并转小写的名称。

### run(name, params = {}, context = {})
- **签名**: `async run(name: string, params?: any, context?: any): Promise<{ type: string, content: any }>`
- **作用**: 查找工作流 → 并发 race(timeout) → 标准化返回结构 → 记录失败日志。

### runMultiple(workflows, sharedParams = {}, context = {})
- **签名**: `async runMultiple(Array<string|{ name, params? }>, sharedParams, context): Promise<Array<Result>>`
- **作用**: 并行执行多个工作流，使用 `Promise.allSettled`，失败项返回错误提示。

### runSequential(workflows, sharedParams = {}, context = {})
- **作用**: 按顺序 await 每个工作流，并收集结果。

### callStream(streamName, e, question, config = {})
- **签名**: `async callStream(streamName: string, e: any, question: any, config?: any): Promise<string|null>`
- **作用**: 通过 `StreamLoader` 找到工作流并执行。

### getWorkflows()
- **作用**: 返回启用状态的工作流列表，按 `priority` 升序排序。

### toggleWorkflow(name, enabled)
- **作用**: 启用/禁用已注册的工作流。

### getActiveCalls()
- **作用**: 将 `activeCalls` Map 转为数组，包含工作流名与持续时间，便于监控。

---

如需了解 `StreamLoader`/`PluginsLoader` 如何装载自定义工作流，请配合阅读 `plugins/stream/*.js` 示例与 `docs/reference/PLUGINS.md`。***

