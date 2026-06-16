---
name: xrk-qq-chat
description: QQ/群聊 Agent：NapCat 能力、回复、发文件、记忆与刷屏克制
---

## 适用场景

用户在 QQ 群或私聊中与 Bot 对话（@、前缀、随机插话）。协议经 **OneBotv11** 适配器对接 [NapCat](https://napcat.apifox.cn)。

## chat 工作流 MCP（NapCat 对照）

| MCP | NapCat 分类 / API |
|-----|-------------------|
| reply / at | 消息接口 `send_msg` |
| poke | 核心 `send_poke` |
| send_file | 群组/私聊 `sendFile` + 工作区路径 |
| saveMessageAsset | `get_msg` + 下载到工作区 `downloads/` |
| readChatRecord | 内存/适配器聊天记录（**仅一层**） |
| emojiReaction | 消息扩展 `set_msg_emoji_like` |
| announce | `set_group_announcement` |
| listAnnouncements | `get_group_announcements` |
| setEssence / removeEssence | `set_essence_msg` / `delete_essence_msg` |
| setGroupTodo | `set_group_todo` |
| completeGroupTodo / cancelGroupTodo | `complete_group_todo` / `cancel_group_todo` |
| mute / kick / setAdmin … | 群组接口（**需群主/管理员**） |
| getGroupInfo / getMemberInfo | 群组接口 |
| thumbUp | 用户接口 `send_like` |
| recall | `delete_msg` + `get_msg` |

底层桥接：`OneBotv11` 适配器的 `e.group` / `e.bot.sendApi`。

## 聊天记录协议（一层限制）

- 注入历史的行格式：`昵称(QQ)[ID:xxx]: 文本`；Bot 为 `【我】`。
- 标签：`[含图片]`、`[含文件]`、`[含表情]`、`[合并转发]`。
- **合并转发 / node 只展示一层摘要**，内层消息不可读（OneBot 转发协议与框架实现的共同限制）；勿编造转发内文。
- 需要结构化列表时用 **readChatRecord**；需要落盘图片/文件/自定义表情用 **saveMessageAsset**，再用 **send_file** 发出。

## 记忆

| 文件 | 用途 |
|------|------|
| `memory/MEMORY.md` | 长期偏好（工作区 default） |
| `memory/groups/{群号}.md` | 本群记忆 |
| `memory/users/{QQ}.md` | 用户记忆 |

使用 **append_memory** / **search_memory**；工作区 ID 默认 `default`。

## 群聊礼仪

- 被 @、被提问、能纠错/总结/给可执行价值时才回复
- 一条消息一次高质量回答，不刷屏

## 安全

- 发文件路径须在工作区内
- 记忆勿写密钥；专用 memory 工具有沙箱
- 群管/公告/待办/禁言等须机器人为群主或管理员
