---
name: office-env-workspace
description: Agent 工作区文件操作：read/write/list_files/grep/create/delete；cwd 为 data/ai-workspace
---

## 何时使用

要在工作区找文件、读配置、写草稿、批量搜关键字、整理目录。**A 档基础能力，几乎总是可用。**

## 范围

- **cwd**：`data/ai-workspace/{id}/`（与 `tools.file.workspace` 一致）
- 项目源码在仓库根，默认**不要**改；除非用户明确要动代码并选 `project` 工作区

## tools 工作流工具

| 工具 | 用途 |
|------|------|
| `list_files` | 列目录（`maxDepth` 可递归） |
| `read` | 读文本；`startLine`/`endLine` 看指定行，返回带行号 |
| `grep` | 搜关键字；`contextBefore`/`contextAfter` 带上下文 |
| `search_replace` | 按 `oldText`→`newText` 定向改代码（须唯一或 `replaceAll`） |
| `write` | 整文件新建或覆盖 |
| `modify_file` | `append`/`prepend`/单行 `line` |
| `delete_file` | 删除（需确认） |
| `run` | 工作区内执行命令 |

## 习惯

1. 先 `list_files` 再 `read`，避免猜路径
2. 大文件先 `grep` 定位再分段 `read`
3. 办公产出统一放 `docs/`、`exports/`、`scripts/`
4. 环境清单维护在根目录 **`ENV.md`**
5. 长文档分章放 `docs/<项目>/`（见 office-long-doc）

## 缺其他能力时

工作区仍可交付 **Markdown / 纯文本 / JSON**——这是所有降级的最后落脚点。见 **office-env-setup**。

## 禁止

- 不读写工作区外敏感路径（`.env`、密钥）
- 不删除未点名的文件
