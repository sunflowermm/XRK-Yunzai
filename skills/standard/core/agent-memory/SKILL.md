---
name: agent-memory
description: 工作区 Markdown 记忆（memory/MEMORY.md）读写边界与 MCP 工具
---

## 唯一推荐层：工作区 Markdown

| 文件 | 用途 |
|------|------|
| `memory/MEMORY.md` | 长期偏好、固定联系人、反复出现的约束 |
| `memory/YYYY-MM-DD.md` | 当日流水 |
| `memory/groups/{群号}.md` | 群聊 scoped 记忆 |
| `memory/users/{QQ}.md` | 用户 scoped 记忆 |

内容会随 Agent 工作区注入 system prompt；**编辑请用 memory 专用 MCP**，不要用 `tools.write` 直写 memory/（无沙箱）。

## MCP 工具

| 工具 | 用途 |
|------|------|
| **append_memory** | 追加一条记忆（首选） |
| **read_memory** | 读取 MEMORY / today / group / user |
| **search_memory** | 关键词检索全部 memory/*.md |
| **list_memory_files** | 列出允许的记忆文件 |
| **write_memory** | 整文件覆盖（**不可**覆盖 MEMORY.md） |

兼容别名：`save_memory` → append；`query_memory` → search。

## QQ 群聊

加载 **xrk-qq-chat**：群聊默认可把事实 append 到 `memory/groups/{群号}.md`；跨群通用写 `MEMORY`。

## 何时写入

- 用户说「记住」「以后都这样」
- 反复出现的格式/联系人/路径约定

## 何时不写入

- 未确认的猜测、一次性闲聊
- 密钥、token、身份证号（工具会拦截疑似密钥）

## 与会话 Redis 摘要

【会话记忆】是短期对话摘要，与 Markdown 长期记忆互补；长期事实仍应 **append_memory**。
