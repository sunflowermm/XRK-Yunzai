---
name: xrk-qq-chat
description: QQ/群聊 Agent：NapCat 能力、回复、发文件、记忆与刷屏克制
---

## 适用场景

用户在 QQ 群或私聊中与 Bot 对话（@、前缀、随机插话）。协议经 **OneBotv11** 适配器对接 [NapCat](https://napcat.apifox.cn)。

## chat 工作流 MCP（NapCat 对照）

| MCP | NapCat 分类 / API |
|-----|-------------------|
| reply | 文字消息：`send_msg`（`\|`、`[回复:ID]`、`[at:QQ]`） |
| emotion | 内置表情包图（resources/aiimages） |
| poke | 核心 `send_poke` |
| relayPrivate | 私聊传话：`pickFriend` → `send_msg`（`user_id`） |
| relayPrivateImage | 私聊发图：`pickFriend.sendMsg` + `segment.image` |
| relayPrivateFile | 私聊发文件：`pickFriend.sendFile` + 工作区路径 |
| relayPrivateEmotion | 私聊发表情包：`pickFriend` + `resources/aiimages` |
| getFriendRequests | 待处理好友申请（`request_list` + `get_doubt_friends_add_request`） |
| handleFriendRequest | 同意/拒绝好友申请：`set_friend_add_request`（须主人） |
| handleDoubtFriendRequest | 同意可疑好友申请：`set_doubt_friends_add_request`（须主人） |
| setFriendRemark | 设置好友备注：`set_friend_remark`（须主人） |
| deleteFriend | 删除好友：`delete_friend`（须主人） |
| send_file | 群组/私聊 `sendFile` + 工作区路径 |
| getFriendList / getFriendInfo | 好友列表与资料（传话前确认 qq） |
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

## 私聊传话（relayPrivate*）

- **relayPrivate**：`qq` + `content`；群聊中发起时正文**不会**出现在当前群，仅工具回执可见。
- **relayPrivateImage** / **relayPrivateEmotion** / **relayPrivateFile**：向好友私聊发图、表情包或文件；附言支持 `|` 分句（图/文件与文字分条时图仅随首条）。
- 目标须为机器人好友；先用 **getFriendList** 确认 QQ。非好友时 relay 会失败，**禁止 reply 声称已私聊发出**。

## 加好友（限制说明）

- **OneBot/NapCat 无「机器人主动加好友」API**；只能处理别人发来的申请。
- 用户需先向机器人号发起好友申请；`plugins/system-plugin/plugin/friend.js` 在 `autoFriend=1` 时自动同意。
- 主人手动处理：**getFriendRequests** → **handleFriendRequest**（`flag` + `approve`）；可疑申请用 **handleDoubtFriendRequest**。
- 备注/删好友：**setFriendRemark**、**deleteFriend**（均须主人）。

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
