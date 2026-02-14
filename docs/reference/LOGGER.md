# Logger 手册 (`lib/config/log.js`)

> 基于 Pino 的全局日志系统，提供多级别输出、颜色、计时与格式化。

---

## 1. 基础日志

| 方法 | 说明 |
|------|------|
| `trace/debug/info/warn/error/fatal(...args)` | 各级别输出 |
| `mark(...args)` | 标记级别 |

## 2. 颜色与渐变

| 方法 | 说明 |
|------|------|
| `chalk` | 直接使用 chalk 实例 |
| `red/green/yellow/blue/magenta/cyan/gray/white(text)` | 单色文本 |
| `xrkyzGradient(text)` | XRK 主题渐变 |
| `rainbow(text)` | 彩虹渐变 |
| `gradient(text, colors?)` | 自定义渐变（colors 为十六进制数组） |

## 3. 特殊与状态

| 方法 | 说明 |
|------|------|
| `success/warning/tip(...args)` | 成功/警告/提示（带色） |
| `done(text, label?)` | 完成日志，可选与 `time(label)` 配对显示耗时 |
| `fail(text)` | 失败（红） |
| `important(text)` | 重要（黄加粗） |
| `highlight(text)` | 高亮（黄底） |
| `system(text)` | 系统（灰） |
| `tag(text, tag, tagColor?)` | 带标签输出 |
| `status(message, status, statusColor?)` | 状态日志（success/error/warning/info/pending/running/complete/failed 等） |

## 4. 计时

- **time(label = 'default')**：开始计时。
- **timeEnd(label = 'default')**：结束并输出耗时。可与 `done(text, label)` 配合。

## 5. 格式化输出

| 方法 | 说明 |
|------|------|
| `title(text, color?)` / `subtitle(text, color?)` | 标题/子标题（带边框） |
| `line(char?, length?, color?)` / `gradientLine(char?, length?)` | 分隔线 |
| `box(text, color?)` | 方框文本 |
| `json(obj, title?)` | 格式化 JSON |
| `table(data, title?)` | 表格输出 |
| `list(items, title?)` | 列表输出 |
| `progress(current, total, length?)` | 进度条 |

## 6. 系统方法

| 方法 | 说明 |
|------|------|
| `platform()` | 返回平台与日志配置信息（os、loggerType、logLevel、logDir、cleanupSchedule 等） |
| `cleanLogs(days?, includeTrace?)` | 清理过期日志，返回删除文件数 |
| `getTraceLogs(lines?)` | 读取 trace 日志行数组 |
| `shutdown()` | 关闭日志系统 |

## 7. 配置（bot.yaml）

```yaml
bot:
  log_level: 'info'    # trace/debug/info/warn/error/fatal
  log_align: 'XRKYZ'
  log_color: 'default'
  log_max_days: 3
  log_trace_days: 1
```

仅当日志级别 ≥ 配置级别时输出。主日志：`logs/app.yyyy-MM-dd.log`；Trace：`logs/trace.yyyy-MM-dd.log`，按天轮转并定时清理。

## 8. 示例

```javascript
logger.info('启动');
logger.time('op');
// ...
logger.timeEnd('op');
logger.success('完成');
logger.json({ a: 1 }, '配置');
logger.status('任务', 'success');
```

相关：[CORE_OBJECTS.md](../CORE_OBJECTS.md)、[CONFIG_AND_REDIS.md](./CONFIG_AND_REDIS.md)。
