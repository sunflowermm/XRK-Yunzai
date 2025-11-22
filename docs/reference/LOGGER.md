# Logger 对象完整手册 (`lib/config/log.js`)

> 全局注入的日志系统，基于 Pino 高性能日志库，提供丰富的日志方法和格式化工具。

---

## 1. 基础日志方法

### trace(...args)
- **签名**: `(...args: any[]) => void`
- **作用**: 输出 trace 级别日志（最详细）
- **示例**: `logger.trace('详细调试信息', data)`

### debug(...args)
- **签名**: `(...args: any[]) => void`
- **作用**: 输出 debug 级别日志
- **示例**: `logger.debug('调试信息', variable)`

### info(...args)
- **签名**: `(...args: any[]) => void`
- **作用**: 输出 info 级别日志（默认级别）
- **示例**: `logger.info('信息', '操作完成')`

### warn(...args)
- **签名**: `(...args: any[]) => void`
- **作用**: 输出警告级别日志
- **示例**: `logger.warn('警告', '配置缺失')`

### error(...args)
- **签名**: `(...args: any[]) => void`
- **作用**: 输出错误级别日志
- **示例**: `logger.error('错误', error)`

### fatal(...args)
- **签名**: `(...args: any[]) => void`
- **作用**: 输出致命错误级别日志
- **示例**: `logger.fatal('致命错误', error)`

### mark(...args)
- **签名**: `(...args: any[]) => void`
- **作用**: 输出标记级别日志（特殊标记）
- **示例**: `logger.mark('重要标记', '关键操作')`

---

## 2. 颜色工具方法

### chalk
- **类型**: `Chalk` 实例
- **作用**: 直接访问 chalk 颜色库
- **示例**: `logger.chalk.red('红色文本')`

### red(text)
- **签名**: `(text: string) => string`
- **作用**: 返回红色文本
- **示例**: `logger.red('错误信息')`

### green(text)
- **签名**: `(text: string) => string`
- **作用**: 返回绿色文本
- **示例**: `logger.green('成功信息')`

### yellow(text)
- **签名**: `(text: string) => string`
- **作用**: 返回黄色文本
- **示例**: `logger.yellow('警告信息')`

### blue(text)
- **签名**: `(text: string) => string`
- **作用**: 返回蓝色文本
- **示例**: `logger.blue('信息')`

### magenta(text)
- **签名**: `(text: string) => string`
- **作用**: 返回洋红色文本
- **示例**: `logger.magenta('特殊信息')`

### cyan(text)
- **签名**: `(text: string) => string`
- **作用**: 返回青色文本
- **示例**: `logger.cyan('提示信息')`

### gray(text)
- **签名**: `(text: string) => string`
- **作用**: 返回灰色文本
- **示例**: `logger.gray('次要信息')`

### white(text)
- **签名**: `(text: string) => string`
- **作用**: 返回白色文本
- **示例**: `logger.white('普通文本')`

---

## 3. 渐变色工具

### xrkyzGradient(text)
- **签名**: `(text: string) => string`
- **作用**: 使用 XRK-Yunzai 主题渐变色
- **示例**: `logger.xrkyzGradient('XRK-Yunzai')`

### rainbow(text)
- **签名**: `(text: string) => string`
- **作用**: 使用彩虹渐变色
- **示例**: `logger.rainbow('彩虹文本')`

### gradient(text, colors?)
- **签名**: `(text: string, colors?: string[]) => string`
- **作用**: 自定义渐变色
- **参数**:
  - `text`: 文本内容
  - `colors`: 可选的颜色数组（十六进制）
- **示例**: `logger.gradient('文本', ['#FF0000', '#00FF00'])`

---

## 4. 特殊日志方法

### success(...args)
- **签名**: `(...args: any[]) => void`
- **作用**: 输出成功日志（绿色）
- **示例**: `logger.success('操作成功')`

### warning(...args)
- **签名**: `(...args: any[]) => void`
- **作用**: `warn` 的别名
- **示例**: `logger.warning('警告')`

### tip(...args)
- **签名**: `(...args: any[]) => void`
- **作用**: 输出提示日志（黄色）
- **示例**: `logger.tip('提示信息')`

### done(text, label?)
- **签名**: `(text: string, label?: string) => void`
- **作用**: 输出完成日志，可关联计时器
- **参数**:
  - `text`: 完成消息
  - `label`: 可选的计时器标签（会自动计算耗时）
- **示例**: 
  ```javascript
  logger.time('operation');
  // ... 操作 ...
  logger.done('操作完成', 'operation'); // 会自动显示耗时
  ```

---

## 5. 计时器方法

### time(label = 'default')
- **签名**: `(label?: string) => void`
- **作用**: 开始计时器
- **参数**:
  - `label`: 计时器标签（默认 'default'）
- **示例**: `logger.time('api-call')`

### timeEnd(label = 'default')
- **签名**: `(label?: string) => void`
- **作用**: 结束计时器并输出耗时
- **参数**:
  - `label`: 计时器标签（默认 'default'）
- **示例**: 
  ```javascript
  logger.time('api-call');
  // ... 操作 ...
  logger.timeEnd('api-call'); // 输出: Timer ended api-call: 123ms
  ```

---

## 6. 格式化方法

### title(text, color = 'yellow')
- **签名**: `(text: string, color?: string) => void`
- **作用**: 输出标题（带边框）
- **参数**:
  - `text`: 标题文本
  - `color`: 颜色（默认 'yellow'）
- **示例**: `logger.title('系统启动', 'cyan')`

### subtitle(text, color = 'cyan')
- **签名**: `(text: string, color?: string) => void`
- **作用**: 输出子标题
- **参数**:
  - `text`: 子标题文本
  - `color`: 颜色（默认 'cyan'）
- **示例**: `logger.subtitle('模块加载')`

### line(char = '─', length = 35, color = 'gray')
- **签名**: `(char?: string, length?: number, color?: string) => void`
- **作用**: 输出分隔线
- **参数**:
  - `char`: 分隔符字符（默认 '─'）
  - `length`: 长度（默认 35）
  - `color`: 颜色（默认 'gray'）
- **示例**: `logger.line('=', 50, 'blue')`

### gradientLine(char = '─', length = 50)
- **签名**: `(char?: string, length?: number) => void`
- **作用**: 输出渐变色分隔线
- **参数**:
  - `char`: 分隔符字符（默认 '─'）
  - `length`: 长度（默认 50）
- **示例**: `logger.gradientLine('═', 60)`

### box(text, color = 'blue')
- **签名**: `(text: string, color?: string) => void`
- **作用**: 输出方框文本
- **参数**:
  - `text`: 文本内容
  - `color`: 颜色（默认 'blue'）
- **示例**: `logger.box('重要信息', 'yellow')`

---

## 7. 数据展示方法

### json(obj, title?)
- **签名**: `(obj: any, title?: string) => void`
- **作用**: 格式化输出 JSON 对象
- **参数**:
  - `obj`: JSON 对象
  - `title`: 可选的标题
- **示例**: `logger.json({ name: 'test', value: 123 }, '配置信息')`

### table(data, title?)
- **签名**: `(data: any, title?: string) => void`
- **作用**: 以表格形式输出数据
- **参数**:
  - `data`: 表格数据（对象或数组）
  - `title`: 可选的标题
- **示例**: `logger.table([{ id: 1, name: 'test' }], '用户列表')`

### list(items, title?)
- **签名**: `(items: string[], title?: string) => void`
- **作用**: 输出列表
- **参数**:
  - `items`: 列表项数组
  - `title`: 可选的标题
- **示例**: `logger.list(['项目1', '项目2'], '待办事项')`

### progress(current, total, length = 30)
- **签名**: `(current: number, total: number, length?: number) => void`
- **作用**: 输出进度条
- **参数**:
  - `current`: 当前进度
  - `total`: 总数
  - `length`: 进度条长度（默认 30）
- **示例**: `logger.progress(50, 100, 40)`

---

## 8. 状态方法

### status(message, status, statusColor = 'green')
- **签名**: `(message: string, status: string, statusColor?: string) => void`
- **作用**: 输出状态日志
- **参数**:
  - `message`: 消息文本
  - `status`: 状态（success/error/warning/info/pending/running/complete/failed/blocked/skipped）
  - `statusColor`: 状态颜色（默认 'green'）
- **示例**: `logger.status('任务完成', 'success', 'green')`

### important(text)
- **签名**: `(text: string) => void`
- **作用**: 输出重要日志（黄色加粗）
- **示例**: `logger.important('重要通知')`

### highlight(text)
- **签名**: `(text: string) => void`
- **作用**: 输出高亮日志（黄色背景）
- **示例**: `logger.highlight('高亮信息')`

### fail(text)
- **签名**: `(text: string) => void`
- **作用**: 输出失败日志（红色）
- **示例**: `logger.fail('操作失败')`

### system(text)
- **签名**: `(text: string) => void`
- **作用**: 输出系统日志（灰色）
- **示例**: `logger.system('系统消息')`

### tag(text, tag, tagColor = 'blue')
- **签名**: `(text: string, tag: string, tagColor?: string) => void`
- **作用**: 输出带标签的日志
- **参数**:
  - `text`: 文本内容
  - `tag`: 标签文本
  - `tagColor`: 标签颜色（默认 'blue'）
- **示例**: `logger.tag('消息内容', 'API', 'cyan')`

---

## 9. 系统方法

### platform()
- **签名**: `() => Object`
- **作用**: 获取平台信息
- **返回**: 
  ```javascript
  {
    os: string,              // 操作系统
    loggerType: 'pino',      // 日志库类型
    loggerVersion: '9.x',    // 日志库版本
    nodeVersion: string,      // Node.js 版本
    logLevel: string,         // 当前日志级别
    logDir: string,           // 日志目录
    cleanupSchedule: string,  // 清理计划
    mainLogAge: string,       // 主日志保留天数
    traceLogAge: string,      // Trace 日志保留天数
    logFiles: {              // 日志文件格式
      main: string,
      trace: string
    },
    performance: string,      // 性能说明
    encoding: 'UTF-8'        // 编码
  }
  ```
- **示例**: `const info = logger.platform()`

### cleanLogs(days, includeTrace = true)
- **签名**: `async (days?: number, includeTrace?: boolean) => Promise<number>`
- **作用**: 手动清理过期日志文件
- **参数**:
  - `days`: 保留天数（默认使用配置值）
  - `includeTrace`: 是否包含 trace 日志（默认 true）
- **返回**: 删除的文件数量
- **示例**: `const count = await logger.cleanLogs(7, true)`

### getTraceLogs(lines = 100)
- **签名**: `async (lines?: number) => Promise<Array<string>|null>`
- **作用**: 获取 trace 日志内容
- **参数**:
  - `lines`: 行数（默认 100）
- **返回**: 日志行数组，失败返回 null
- **示例**: `const logs = await logger.getTraceLogs(200)`

### shutdown()
- **签名**: `async () => Promise<void>`
- **作用**: 关闭日志系统（清理资源）
- **示例**: `await logger.shutdown()`

---

## 10. 配置说明

Logger 的行为可以通过 `config/default_config/bot.yaml` 中的以下配置项控制：

```yaml
bot:
  log_level: 'info'        # 日志级别: trace/debug/info/warn/error/fatal
  log_align: 'XRKYZ'        # 日志头部对齐文本
  log_color: 'default'       # 颜色方案: default/scheme1-7
  log_max_days: 3           # 主日志保留天数
  log_trace_days: 1          # Trace 日志保留天数
```

### 日志级别说明

| 级别 | 值 | 说明 |
|------|-----|------|
| trace | 10 | 最详细，包含所有调试信息 |
| debug | 20 | 调试信息 |
| info | 30 | 一般信息（默认） |
| warn | 40 | 警告信息 |
| error | 50 | 错误信息 |
| fatal | 60 | 致命错误 |

只有大于等于配置级别的日志才会输出到控制台。

---

## 11. 日志文件

Logger 会自动创建以下日志文件：

- **主日志**: `logs/app.yyyy-MM-dd.log` - 包含 debug 及以上级别
- **Trace 日志**: `logs/trace.yyyy-MM-dd.log` - 包含所有级别（trace 及以上）

日志文件会自动按天轮转，过期文件会在每天凌晨 3 点自动清理。

---

## 12. 使用示例

### 基础使用

```javascript
// 简单日志
logger.info('系统启动');
logger.warn('配置缺失');
logger.error('操作失败', error);

// 带颜色
logger.success('操作成功');
logger.tip('提示信息');
logger.fail('操作失败');
```

### 计时器使用

```javascript
logger.time('api-call');
// ... API 调用 ...
logger.timeEnd('api-call');
// 输出: Timer ended api-call: 123ms
```

### 格式化输出

```javascript
// 标题
logger.title('系统初始化', 'cyan');

// 列表
logger.list(['项目1', '项目2'], '待办事项');

// JSON
logger.json({ name: 'test', value: 123 }, '配置');

// 进度条
logger.progress(50, 100);
```

### 状态日志

```javascript
logger.status('任务完成', 'success', 'green');
logger.status('任务失败', 'error', 'red');
logger.status('任务进行中', 'running', 'blue');
```

### 渐变色

```javascript
logger.info(logger.xrkyzGradient('XRK-Yunzai'));
logger.info(logger.rainbow('彩虹文本'));
logger.info(logger.gradient('自定义渐变', ['#FF0000', '#00FF00']));
```

---

## 13. 最佳实践

1. **日志级别选择**：
   - 开发环境使用 `debug` 或 `trace`
   - 生产环境使用 `info` 或 `warn`

2. **性能考虑**：
   - 避免在高频调用的地方使用 `trace` 或 `debug`
   - 使用 `logger.time()` 和 `logger.timeEnd()` 测量性能

3. **错误处理**：
   - 使用 `logger.error()` 记录错误对象
   - 重要错误使用 `logger.fatal()`

4. **结构化日志**：
   - 使用 `logger.json()` 输出结构化数据
   - 使用 `logger.table()` 输出表格数据

5. **日志清理**：
   - 定期调用 `logger.cleanLogs()` 清理过期日志
   - 根据需求调整 `log_max_days` 和 `log_trace_days`

---

## 14. 相关文档

- [核心对象文档](../CORE_OBJECTS.md) - logger 的快速参考
- [配置系统文档](./CONFIG_AND_REDIS.md) - 日志配置说明

