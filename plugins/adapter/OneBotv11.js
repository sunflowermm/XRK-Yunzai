import cfg from "../../lib/config/config.js"
import path from "node:path"
import { ulid } from "ulid"

/**
 * OneBotv11适配器 - 用于连接QQ机器人
 * 支持标准OneBot v11协议和扩展API
 */
class OneBotv11Adapter {
  constructor() {
    this.id = "QQ"
    this.name = "OneBotv11"
    this.path = this.name
    this.echo = new Map()
    this.timeout = 60000
    
    // API速率限制
    this.rateLimiter = new Map()
    this.maxRequestsPerMinute = 120
  }

  // ==================== 工具方法 ====================
  
  /**
   * 生成日志信息，隐藏敏感的base64数据
   */
  makeLog(msg) {
    return Bot.String(msg).replace(/base64:\/\/.*?(,|]|")/g, "base64://...$1")
  }

  /**
   * 清理速率限制记录
   */
  cleanRateLimiter() {
    const now = Date.now()
    for (const [key, time] of this.rateLimiter) {
      if (now - time > 60000) {
        this.rateLimiter.delete(key)
      }
    }
  }

  /**
   * 检查API调用频率
   */
  checkRateLimit(action) {
    this.cleanRateLimiter()
    const key = `${action}_${Date.now() / 1000 | 0}`
    const count = this.rateLimiter.get(key) || 0
    
    if (count >= this.maxRequestsPerMinute) {
      throw new Error(`API调用频率超限: ${action}`)
    }
    
    this.rateLimiter.set(key, count + 1)
    return true
  }

  // ==================== API 调用核心 ====================
  
  /**
   * 发送API请求到OneBot实现端
   */
  async sendApi(data, ws, action, params = {}) {
    try {
      this.checkRateLimit(action)
    } catch (err) {
      Bot.makeLog("warn", err.message, data.self_id)
    }

    const echo = ulid()
    const request = { action, params, echo }
    ws.sendMsg(request)
    
    const cache = Promise.withResolvers()
    this.echo.set(echo, cache)
    
    const timeout = setTimeout(() => {
      cache.reject(Bot.makeError("请求超时", request, { timeout: this.timeout }))
      Bot.makeLog("error", ["请求超时", request], data.self_id)
      ws.terminate()
    }, this.timeout)

    return cache.promise
      .then(response => {
        if (response.retcode !== 0 && response.retcode !== 1) {
          throw Bot.makeError(
            response.msg || response.wording || "未知错误", 
            request, 
            { error: response }
          )
        }
        
        // 创建代理对象，使data中的属性可以直接访问
        return response.data
          ? new Proxy(response, {
              get: (target, prop) => target.data[prop] ?? target[prop],
            })
          : response
      })
      .finally(() => {
        clearTimeout(timeout)
        this.echo.delete(echo)
      })
  }

  // ==================== 消息处理 ====================
  
  /**
   * 将文件转换为OneBot可接受的格式
   */
  async makeFile(file, opts = {}) {
    file = await Bot.Buffer(file, {
      http: true,
      size: 10485760,
      ...opts,
    })
    
    if (Buffer.isBuffer(file)) {
      return `base64://${file.toString("base64")}`
    }
    return file
  }

  /**
   * 构建消息数组
   */
  async makeMsg(msg) {
    if (!Array.isArray(msg)) msg = [msg]
    
    const messages = []
    const forwards = []
    
    for (let segment of msg) {
      // 标准化消息段格式
      if (typeof segment !== "object") {
        segment = { type: "text", data: { text: String(segment) } }
      } else if (!segment.data) {
        segment = { type: segment.type, data: { ...segment, type: undefined } }
      }

      // 处理特殊消息类型
      switch (segment.type) {
        case "at":
          segment.data.qq = String(segment.data.qq)
          break
          
        case "reply":
          segment.data.id = String(segment.data.id)
          break
          
        case "button":
          continue // 跳过按钮消息
          
        case "node":
          // 收集转发消息节点
          forwards.push(...(Array.isArray(segment.data) ? segment.data : [segment.data]))
          continue
          
        case "raw":
          segment = segment.data
          break
      }

      // 处理文件类消息
      if (segment.data?.file) {
        segment.data.file = await this.makeFile(segment.data.file)
      }

      messages.push(segment)
    }
    
    return [messages, forwards]
  }

  /**
   * 统一的消息发送处理
   */
  async sendMsg(msg, sendFunc, sendForwardFunc) {
    const [message, forward] = await this.makeMsg(msg)
    const results = []

    // 发送转发消息
    if (forward.length) {
      try {
        const data = await sendForwardFunc(forward)
        if (Array.isArray(data)) {
          results.push(...data)
        } else {
          results.push(data)
        }
      } catch (err) {
        Bot.makeLog("error", ["发送转发消息失败", err])
      }
    }

    // 发送普通消息
    if (message.length) {
      try {
        results.push(await sendFunc(message))
      } catch (err) {
        Bot.makeLog("error", ["发送消息失败", err])
      }
    }
    
    // 处理返回结果
    if (results.length === 1) return results[0]

    const message_ids = results
      .filter(r => r?.message_id)
      .map(r => r.message_id)
    
    return { data: results, message_id: message_ids }
  }

  /**
   * 解析接收到的消息
   */
  parseMsg(msg) {
    const array = []
    for (const segment of Array.isArray(msg) ? msg : [msg]) {
      if (typeof segment === "object") {
        array.push({ ...segment.data, type: segment.type })
      } else {
        array.push({ type: "text", text: String(segment) })
      }
    }
    return array
  }

  /**
   * 构建转发消息
   */
  async makeForwardMsg(nodes) {
    const messages = []
    
    for (const node of nodes) {
      const [content, forward] = await this.makeMsg(node.message)
      
      // 递归处理嵌套转发
      if (forward.length) {
        messages.push(...(await this.makeForwardMsg(forward)))
      }
      
      // 添加当前节点
      if (content.length) {
        messages.push({
          type: "node",
          data: {
            name: node.nickname || "匿名消息",
            uin: String(Number(node.user_id) || 80000000),
            content,
            time: node.time,
          },
        })
      }
    }
    
    return messages
  }

  // ==================== 好友相关API ====================
  
  async sendFriendMsg(data, msg) {
    return this.sendMsg(
      msg,
      message => {
        Bot.makeLog(
          "info",
          `发送好友消息：${this.makeLog(message)}`,
          `${data.self_id} => ${data.user_id}`,
          true
        )
        return data.bot.sendApi("send_msg", {
          user_id: data.user_id,
          message,
        })
      },
      msg => this.sendFriendForwardMsg(data, msg)
    )
  }

  async sendFriendForwardMsg(data, msg) {
    Bot.makeLog(
      "info",
      `发送好友转发消息：${this.makeLog(msg)}`,
      `${data.self_id} => ${data.user_id}`,
      true
    )
    return data.bot.sendApi("send_private_forward_msg", {
      user_id: data.user_id,
      messages: await this.makeForwardMsg(msg),
    })
  }

  async getFriendArray(data) {
    try {
      return (await data.bot.sendApi("get_friend_list")) || []
    } catch (err) {
      Bot.makeLog("error", ["获取好友列表失败", err])
      return []
    }
  }

  async getFriendList(data) {
    const friends = await this.getFriendArray(data)
    return friends.map(f => f.user_id)
  }

  async getFriendMap(data) {
    const map = new Map()
    const friends = await this.getFriendArray(data)
    
    for (const friend of friends) {
      map.set(friend.user_id, friend)
    }
    
    data.bot.fl = map
    return map
  }

  async getFriendInfo(data) {
    try {
      const info = await data.bot.sendApi("get_stranger_info", {
        user_id: data.user_id,
      })
      data.bot.fl.set(data.user_id, info)
      return info
    } catch (err) {
      Bot.makeLog("error", ["获取好友信息失败", err])
      return {}
    }
  }

  async sendFriendFile(data, file, name = path.basename(file)) {
    Bot.makeLog(
      "info",
      `发送好友文件：${name}(${file})`,
      `${data.self_id} => ${data.user_id}`,
      true
    )
    
    const filePath = await this.makeFile(file, { file: true })
    return data.bot.sendApi("upload_private_file", {
      user_id: data.user_id,
      file: filePath.replace("file://", ""),
      name,
    })
  }

  deleteFriend(data) {
    Bot.makeLog("info", "删除好友", `${data.self_id} => ${data.user_id}`, true)
    return data.bot
      .sendApi("delete_friend", { user_id: data.user_id })
      .finally(() => this.getFriendMap(data))
  }

  // ==================== 群组相关API ====================
  
  async sendGroupMsg(data, msg) {
    return this.sendMsg(
      msg,
      message => {
        Bot.makeLog(
          "info",
          `发送群消息：${this.makeLog(message)}`,
          `${data.self_id} => ${data.group_id}`,
          true
        )
        return data.bot.sendApi("send_msg", {
          group_id: data.group_id,
          message,
        })
      },
      msg => this.sendGroupForwardMsg(data, msg)
    )
  }

  async sendGroupForwardMsg(data, msg) {
    Bot.makeLog(
      "info",
      `发送群转发消息：${this.makeLog(msg)}`,
      `${data.self_id} => ${data.group_id}`,
      true
    )
    return data.bot.sendApi("send_group_forward_msg", {
      group_id: data.group_id,
      messages: await this.makeForwardMsg(msg),
    })
  }

  async getGroupArray(data) {
    try {
      const groups = (await data.bot.sendApi("get_group_list")) || []
      
      // 尝试获取频道列表
      try {
        const guilds = await this.getGuildArray(data)
        for (const guild of guilds) {
          const channels = await this.getGuildChannelArray({
            ...data,
            guild_id: guild.guild_id,
          })
          
          for (const channel of channels) {
            groups.push({
              guild,
              channel,
              group_id: `${guild.guild_id}-${channel.channel_id}`,
              group_name: `${guild.guild_name}-${channel.channel_name}`,
            })
          }
        }
      } catch (err) {
        // 静默处理频道获取失败
      }
      
      return groups
    } catch (err) {
      Bot.makeLog("error", ["获取群列表失败", err])
      return []
    }
  }

  async getGroupList(data) {
    const groups = await this.getGroupArray(data)
    return groups.map(g => g.group_id)
  }

  async getGroupMap(data) {
    const map = new Map()
    const groups = await this.getGroupArray(data)
    
    for (const group of groups) {
      map.set(group.group_id, group)
    }
    
    data.bot.gl = map
    return map
  }

  async getGroupInfo(data) {
    try {
      const info = await data.bot.sendApi("get_group_info", {
        group_id: data.group_id,
      })
      data.bot.gl.set(data.group_id, info)
      return info
    } catch (err) {
      Bot.makeLog("error", ["获取群信息失败", err])
      return {}
    }
  }

  async getMemberArray(data) {
    try {
      return (await data.bot.sendApi("get_group_member_list", {
        group_id: data.group_id,
      })) || []
    } catch (err) {
      Bot.makeLog("error", ["获取群成员列表失败", err])
      return []
    }
  }

  async getMemberList(data) {
    const members = await this.getMemberArray(data)
    return members.map(m => m.user_id)
  }

  async getMemberMap(data) {
    const map = new Map()
    const members = await this.getMemberArray(data)
    
    for (const member of members) {
      map.set(member.user_id, member)
    }
    
    data.bot.gml.set(data.group_id, map)
    return map
  }

  async getMemberInfo(data) {
    try {
      const info = await data.bot.sendApi("get_group_member_info", {
        group_id: data.group_id,
        user_id: data.user_id,
      })
      
      // 更新缓存
      let memberMap = data.bot.gml.get(data.group_id)
      if (!memberMap) {
        memberMap = new Map()
        data.bot.gml.set(data.group_id, memberMap)
      }
      memberMap.set(data.user_id, info)
      
      return info
    } catch (err) {
      Bot.makeLog("error", ["获取群成员信息失败", err])
      return {}
    }
  }

  async getGroupMemberMap(data) {
    if (!cfg.bot.cache_group_member) {
      return this.getGroupMap(data)
    }
    
    const groupMap = await this.getGroupMap(data)
    
    for (const [group_id, group] of groupMap) {
      if (!group.guild) {
        await this.getMemberMap({ ...data, group_id })
      }
    }
    
    return groupMap
  }

  async sendGroupFile(data, file, folder = "", name = path.basename(file)) {
    Bot.makeLog(
      "info",
      `发送群文件：${folder || ""}/${name}(${file})`,
      `${data.self_id} => ${data.group_id}`,
      true
    )
    
    const filePath = await this.makeFile(file, { file: true })
    return data.bot.sendApi("upload_group_file", {
      group_id: data.group_id,
      folder,
      file: filePath.replace("file://", ""),
      name,
    })
  }

  // 群管理API
  setGroupName(data, group_name) {
    Bot.makeLog(
      "info",
      `设置群名：${group_name}`,
      `${data.self_id} => ${data.group_id}`,
      true
    )
    return data.bot.sendApi("set_group_name", {
      group_id: data.group_id,
      group_name,
    })
  }

  async setGroupAvatar(data, file) {
    Bot.makeLog(
      "info",
      `设置群头像：${file}`,
      `${data.self_id} => ${data.group_id}`,
      true
    )
    return data.bot.sendApi("set_group_portrait", {
      group_id: data.group_id,
      file: await this.makeFile(file),
    })
  }

  setGroupAdmin(data, user_id, enable) {
    Bot.makeLog(
      "info",
      `${enable ? "设置" : "取消"}群管理员：${user_id}`,
      `${data.self_id} => ${data.group_id}`,
      true
    )
    return data.bot.sendApi("set_group_admin", {
      group_id: data.group_id,
      user_id,
      enable,
    })
  }

  setGroupCard(data, user_id, card) {
    Bot.makeLog(
      "info",
      `设置群名片：${card}`,
      `${data.self_id} => ${data.group_id}, ${user_id}`,
      true
    )
    return data.bot.sendApi("set_group_card", {
      group_id: data.group_id,
      user_id,
      card,
    })
  }

  setGroupTitle(data, user_id, special_title, duration = -1) {
    Bot.makeLog(
      "info",
      `设置群头衔：${special_title} ${duration}`,
      `${data.self_id} => ${data.group_id}, ${user_id}`,
      true
    )
    return data.bot.sendApi("set_group_special_title", {
      group_id: data.group_id,
      user_id,
      special_title,
      duration,
    })
  }

  setGroupBan(data, user_id, duration = 600) {
    Bot.makeLog(
      "info",
      `禁言群成员：${duration}秒`,
      `${data.self_id} => ${data.group_id}, ${user_id}`,
      true
    )
    return data.bot.sendApi("set_group_ban", {
      group_id: data.group_id,
      user_id,
      duration,
    })
  }

  setGroupWholeKick(data, enable) {
    Bot.makeLog(
      "info",
      `${enable ? "开启" : "关闭"}全员禁言`,
      `${data.self_id} => ${data.group_id}`,
      true
    )
    return data.bot.sendApi("set_group_whole_ban", {
      group_id: data.group_id,
      enable,
    })
  }

  setGroupKick(data, user_id, reject_add_request = false) {
    Bot.makeLog(
      "info",
      `踢出群成员${reject_add_request ? "并拒绝再次加群" : ""}`,
      `${data.self_id} => ${data.group_id}, ${user_id}`,
      true
    )
    return data.bot.sendApi("set_group_kick", {
      group_id: data.group_id,
      user_id,
      reject_add_request,
    })
  }

  setGroupLeave(data, is_dismiss = false) {
    Bot.makeLog(
      "info",
      is_dismiss ? "解散群" : "退出群",
      `${data.self_id} => ${data.group_id}`,
      true
    )
    return data.bot.sendApi("set_group_leave", {
      group_id: data.group_id,
      is_dismiss,
    })
  }

  sendGroupSign(data) {
    Bot.makeLog("info", "群打卡", `${data.self_id} => ${data.group_id}`, true)
    return data.bot.sendApi("send_group_sign", {
      group_id: data.group_id,
    })
  }

  // 群文件系统
  deleteGroupFile(data, file_id, busid) {
    Bot.makeLog(
      "info",
      `删除群文件：${file_id}(${busid})`,
      `${data.self_id} => ${data.group_id}`,
      true
    )
    return data.bot.sendApi("delete_group_file", {
      group_id: data.group_id,
      file_id,
      busid,
    })
  }

  createGroupFileFolder(data, name) {
    Bot.makeLog(
      "info",
      `创建群文件夹：${name}`,
      `${data.self_id} => ${data.group_id}`,
      true
    )
    return data.bot.sendApi("create_group_file_folder", {
      group_id: data.group_id,
      name,
    })
  }

  getGroupFileSystemInfo(data) {
    return data.bot.sendApi("get_group_file_system_info", {
      group_id: data.group_id,
    })
  }

  getGroupFiles(data, folder_id) {
    if (folder_id) {
      return data.bot.sendApi("get_group_files_by_folder", {
        group_id: data.group_id,
        folder_id,
      })
    }
    return data.bot.sendApi("get_group_root_files", {
      group_id: data.group_id,
    })
  }

  getGroupFileUrl(data, file_id, busid) {
    return data.bot.sendApi("get_group_file_url", {
      group_id: data.group_id,
      file_id,
      busid,
    })
  }

  getGroupFs(data) {
    return {
      upload: this.sendGroupFile.bind(this, data),
      rm: this.deleteGroupFile.bind(this, data),
      mkdir: this.createGroupFileFolder.bind(this, data),
      df: this.getGroupFileSystemInfo.bind(this, data),
      ls: this.getGroupFiles.bind(this, data),
      download: this.getGroupFileUrl.bind(this, data),
    }
  }

  // ==================== 频道相关API ====================
  
  async sendGuildMsg(data, msg) {
    return this.sendMsg(
      msg,
      message => {
        Bot.makeLog(
          "info",
          `发送频道消息：${this.makeLog(message)}`,
          `${data.self_id} => ${data.guild_id}-${data.channel_id}`,
          true
        )
        return data.bot.sendApi("send_guild_channel_msg", {
          guild_id: data.guild_id,
          channel_id: data.channel_id,
          message,
        })
      },
      msg => Bot.sendForwardMsg(msg => this.sendGuildMsg(data, msg), msg)
    )
  }

  async getGuildArray(data) {
    try {
      return (await data.bot.sendApi("get_guild_list")) || []
    } catch {
      return []
    }
  }

  async getGuildInfo(data) {
    try {
      return await data.bot.sendApi("get_guild_meta_by_guest", {
        guild_id: data.guild_id,
      })
    } catch {
      return {}
    }
  }

  async getGuildChannelArray(data) {
    try {
      return (await data.bot.sendApi("get_guild_channel_list", {
        guild_id: data.guild_id,
      })) || []
    } catch {
      return []
    }
  }

  async getGuildChannelMap(data) {
    const map = new Map()
    const channels = await this.getGuildChannelArray(data)
    
    for (const channel of channels) {
      map.set(channel.channel_id, channel)
    }
    
    return map
  }

  async getGuildMemberArray(data) {
    const members = []
    let next_token = ""
    
    while (true) {
      try {
        const list = await data.bot.sendApi("get_guild_member_list", {
          guild_id: data.guild_id,
          next_token,
        })
        
        if (!list) break
        
        for (const member of list.members || []) {
          members.push({
            ...member,
            user_id: member.tiny_id,
          })
        }
        
        if (list.finished) break
        next_token = list.next_token
      } catch {
        break
      }
    }
    
    return members
  }

  async getGuildMemberList(data) {
    const members = await this.getGuildMemberArray(data)
    return members.map(m => m.user_id)
  }

  async getGuildMemberMap(data) {
    const map = new Map()
    const members = await this.getGuildMemberArray(data)
    
    for (const member of members) {
      map.set(member.user_id, member)
    }
    
    data.bot.gml.set(data.group_id, map)
    return map
  }

  async getGuildMemberInfo(data) {
    try {
      return await data.bot.sendApi("get_guild_member_profile", {
        guild_id: data.guild_id,
        user_id: data.user_id,
      })
    } catch {
      return {}
    }
  }

  // ==================== 其他通用API ====================
  
  async recallMsg(data, message_id) {
    Bot.makeLog("info", `撤回消息：${message_id}`, data.self_id)
    
    if (!Array.isArray(message_id)) {
      message_id = [message_id]
    }
    
    const results = []
    for (const id of message_id) {
      try {
        results.push(await data.bot.sendApi("delete_msg", { message_id: id }))
      } catch (err) {
        results.push(err)
      }
    }
    
    return results.length === 1 ? results[0] : results
  }

  async getMsg(data, message_id) {
    const msg = await data.bot.sendApi("get_msg", { message_id })
    if (msg?.message) {
      msg.message = this.parseMsg(msg.message)
    }
    return msg
  }

  async getFriendMsgHistory(data, message_seq = 0, count = 20, reverseOrder = true) {
    try {
      const result = await data.bot.sendApi("get_friend_msg_history", {
        user_id: data.user_id,
        message_seq,
        count,
        reverseOrder,
      })
      
      const messages = result?.messages || []
      for (const msg of Array.isArray(messages) ? messages : [messages]) {
        if (msg?.message) {
          msg.message = this.parseMsg(msg.message)
        }
      }
      
      return messages
    } catch (err) {
      Bot.makeLog("error", ["获取好友消息历史失败", err])
      return []
    }
  }

  async getGroupMsgHistory(data, message_seq = 0, count = 20, reverseOrder = true) {
    try {
      const result = await data.bot.sendApi("get_group_msg_history", {
        group_id: data.group_id,
        message_seq,
        count,
        reverseOrder,
      })
      
      const messages = result?.messages || []
      for (const msg of Array.isArray(messages) ? messages : [messages]) {
        if (msg?.message) {
          msg.message = this.parseMsg(msg.message)
        }
      }
      
      return messages
    } catch (err) {
      Bot.makeLog("error", ["获取群消息历史失败", err])
      return []
    }
  }

  async getForwardMsg(data, message_id) {
    try {
      const result = await data.bot.sendApi("get_forward_msg", { message_id })
      const messages = result?.messages || []
      
      for (const msg of Array.isArray(messages) ? messages : [messages]) {
        if (msg?.message || msg?.content) {
          msg.message = this.parseMsg(msg.message || msg.content)
        }
      }
      
      return messages
    } catch (err) {
      Bot.makeLog("error", ["获取转发消息失败", err])
      return []
    }
  }

  // 其他API
  setProfile(data, profile) {
    Bot.makeLog("info", `设置资料：${Bot.String(profile)}`, data.self_id)
    return data.bot.sendApi("set_qq_profile", profile)
  }

  async setAvatar(data, file) {
    Bot.makeLog("info", `设置头像：${file}`, data.self_id)
    return data.bot.sendApi("set_qq_avatar", {
      file: await this.makeFile(file),
    })
  }

  sendLike(data, times = 1) {
    Bot.makeLog(
      "info",
      `点赞：${times}次`,
      `${data.self_id} => ${data.user_id}`,
      true
    )
    return data.bot.sendApi("send_like", {
      user_id: data.user_id,
      times,
    })
  }

  downloadFile(data, url, thread_count = 1, headers = "") {
    return data.bot.sendApi("download_file", {
      url,
      thread_count,
      headers,
    })
  }

  setFriendAddRequest(data, flag, approve = true, remark = "") {
    return data.bot.sendApi("set_friend_add_request", {
      flag,
      approve,
      remark,
    })
  }

  setGroupAddRequest(data, flag, approve = true, reason = "", sub_type = "add") {
    return data.bot.sendApi("set_group_add_request", {
      flag,
      sub_type,
      approve,
      reason,
    })
  }

  getGroupHonorInfo(data) {
    return data.bot.sendApi("get_group_honor_info", { 
      group_id: data.group_id 
    })
  }

  getEssenceMsg(data) {
    return data.bot.sendApi("get_essence_msg_list", { 
      group_id: data.group_id 
    })
  }

  setEssenceMsg(data, message_id) {
    return data.bot.sendApi("set_essence_msg", { message_id })
  }

  deleteEssenceMsg(data, message_id) {
    return data.bot.sendApi("delete_essence_msg", { message_id })
  }

  // ==================== 对象构建方法 ====================
  
  /**
   * 构建好友对象
   */
  pickFriend(data, user_id) {
    const context = {
      ...data.bot.fl.get(user_id),
      ...data,
      user_id,
    }
    
    return {
      ...context,
      sendMsg: this.sendFriendMsg.bind(this, context),
      getMsg: this.getMsg.bind(this, context),
      recallMsg: this.recallMsg.bind(this, context),
      getForwardMsg: this.getForwardMsg.bind(this, context),
      sendForwardMsg: this.sendFriendForwardMsg.bind(this, context),
      sendFile: this.sendFriendFile.bind(this, context),
      getInfo: this.getFriendInfo.bind(this, context),
      getAvatarUrl() {
        return this.avatar || `https://q.qlogo.cn/g?b=qq&s=0&nk=${user_id}`
      },
      getChatHistory: this.getFriendMsgHistory.bind(this, context),
      thumbUp: this.sendLike.bind(this, context),
      delete: this.deleteFriend.bind(this, context),
    }
  }

  /**
   * 构建群成员对象（修复版）
   */
  pickMember(data, group_id, user_id) {
    // 处理频道成员
    if (typeof group_id === "string" && group_id.includes("-")) {
      const [guild_id, channel_id] = group_id.split("-")
      const context = {
        ...data,
        guild_id,
        channel_id,
        user_id,
      }
      
      return {
        ...this.pickGroup(context, group_id),
        ...context,
        getInfo: this.getGuildMemberInfo.bind(this, context),
        getAvatarUrl: async () => {
          const info = await this.getGuildMemberInfo(context)
          return info.avatar_url
        },
      }
    }

    // 获取成员信息
    const memberInfo = data.bot.gml.get(group_id)?.get(user_id) || {}
    const context = {
      ...memberInfo,
      ...data,
      group_id,
      user_id,
    }
    
    return {
      ...this.pickFriend(context, user_id),
      ...context,
      getInfo: this.getMemberInfo.bind(this, context),
      getAvatarUrl() {
        return this.avatar || `https://q.qlogo.cn/g?b=qq&s=0&nk=${user_id}`
      },
      poke: () => this.sendGroupMsg(context, { 
        type: "poke", 
        data: { qq: user_id } 
      }),
      mute: (duration = 600) => this.setGroupBan(context, user_id, duration),
      kick: (reject = false) => this.setGroupKick(context, user_id, reject),
      
      // 修复：使用成员信息中的role字段判断
      get is_friend() {
        return data.bot.fl.has(user_id)
      },
      get is_owner() {
        // 直接使用memberInfo中的role字段
        return memberInfo.role === "owner"
      },
      get is_admin() {
        // 直接使用memberInfo中的role字段
        return memberInfo.role === "admin" || memberInfo.role === "owner"
      },
    }
  }

  /**
   * 构建群组对象
   */
  pickGroup(data, group_id) {
    // 处理频道
    if (typeof group_id === "string" && group_id.includes("-")) {
      const [guild_id, channel_id] = group_id.split("-")
      const context = {
        ...data.bot.gl.get(group_id),
        ...data,
        guild_id,
        channel_id,
      }
      
      return {
        ...context,
        sendMsg: this.sendGuildMsg.bind(this, context),
        getMsg: this.getMsg.bind(this, context),
        recallMsg: this.recallMsg.bind(this, context),
        getForwardMsg: this.getForwardMsg.bind(this, context),
        getInfo: this.getGuildInfo.bind(this, context),
        getChannelArray: this.getGuildChannelArray.bind(this, context),
        getChannelList: async () => {
          const channels = await this.getGuildChannelArray(context)
          return channels.map(c => c.channel_id)
        },
        getChannelMap: this.getGuildChannelMap.bind(this, context),
        getMemberArray: this.getGuildMemberArray.bind(this, context),
        getMemberList: this.getGuildMemberList.bind(this, context),
        getMemberMap: this.getGuildMemberMap.bind(this, context),
        pickMember: (user_id) => this.pickMember(context, group_id, user_id),
      }
    }

    // 普通群组
    const groupInfo = data.bot.gl.get(group_id) || {}
    const context = {
      ...groupInfo,
      ...data,
      group_id,
    }
    
    return {
      ...context,
      sendMsg: this.sendGroupMsg.bind(this, context),
      getMsg: this.getMsg.bind(this, context),
      recallMsg: this.recallMsg.bind(this, context),
      getForwardMsg: this.getForwardMsg.bind(this, context),
      sendForwardMsg: this.sendGroupForwardMsg.bind(this, context),
      sendFile: (file, name) => this.sendGroupFile(context, file, undefined, name),
      getInfo: this.getGroupInfo.bind(this, context),
      getAvatarUrl() {
        return this.avatar || `https://p.qlogo.cn/gh/${group_id}/${group_id}/0`
      },
      getChatHistory: this.getGroupMsgHistory.bind(this, context),
      getHonorInfo: this.getGroupHonorInfo.bind(this, context),
      getEssence: this.getEssenceMsg.bind(this, context),
      getMemberArray: this.getMemberArray.bind(this, context),
      getMemberList: this.getMemberList.bind(this, context),
      getMemberMap: this.getMemberMap.bind(this, context),
      pickMember: (user_id) => this.pickMember(context, group_id, user_id),
      pokeMember: (qq) => this.sendGroupMsg(context, { 
        type: "poke", 
        data: { qq } 
      }),
      setName: (name) => this.setGroupName(context, name),
      setAvatar: (file) => this.setGroupAvatar(context, file),
      setAdmin: (user_id, enable) => this.setGroupAdmin(context, user_id, enable),
      setCard: (user_id, card) => this.setGroupCard(context, user_id, card),
      setTitle: (user_id, title, duration) => 
        this.setGroupTitle(context, user_id, title, duration),
      sign: () => this.sendGroupSign(context),
      muteMember: (user_id, duration) => this.setGroupBan(context, user_id, duration),
      muteAll: (enable) => this.setGroupWholeKick(context, enable),
      kickMember: (user_id, reject) => this.setGroupKick(context, user_id, reject),
      quit: () => this.setGroupLeave(context, false),
      fs: this.getGroupFs(context),
      
      // 判断机器人在群中的权限
      get is_owner() {
        const botMember = data.bot.gml.get(group_id)?.get(data.self_id)
        return botMember?.role === "owner"
      },
      get is_admin() {
        const botMember = data.bot.gml.get(group_id)?.get(data.self_id)
        const role = botMember?.role
        return role === "admin" || role === "owner"
      },
    }
  }

  // ==================== 连接与初始化 ====================
  
  /**
   * 建立连接并初始化Bot实例
   */
  async connect(data, ws) {
    // 创建Bot实例
    Bot[data.self_id] = {
      adapter: this,
      ws: ws,
      sendApi: this.sendApi.bind(this, data, ws),
      
      // 统计信息
      stat: {
        start_time: data.time,
        stat: {},
        get lost_pkt_cnt() {
          return this.stat.packet_lost || 0
        },
        get lost_times() {
          return this.stat.lost_times || 0
        },
        get recv_msg_cnt() {
          return this.stat.message_received || 0
        },
        get recv_pkt_cnt() {
          return this.stat.packet_received || 0
        },
        get sent_msg_cnt() {
          return this.stat.message_sent || 0
        },
        get sent_pkt_cnt() {
          return this.stat.packet_sent || 0
        },
      },
      
      model: "TRSS Yunzai",
      info: {},
      
      get uin() {
        return this.info.user_id
      },
      get nickname() {
        return this.info.nickname
      },
      get avatar() {
        return `https://q.qlogo.cn/g?b=qq&s=0&nk=${this.uin}`
      },

      // 账号操作
      setProfile: this.setProfile.bind(this, data),
      setNickname: (nickname) => this.setProfile(data, { nickname }),
      setAvatar: this.setAvatar.bind(this, data),

      // 好友操作
      pickFriend: this.pickFriend.bind(this, data),
      get pickUser() {
        return this.pickFriend
      },
      getFriendArray: this.getFriendArray.bind(this, data),
      getFriendList: this.getFriendList.bind(this, data),
      getFriendMap: this.getFriendMap.bind(this, data),
      fl: new Map(),

      // 群组操作
      pickMember: this.pickMember.bind(this, data),
      pickGroup: this.pickGroup.bind(this, data),
      getGroupArray: this.getGroupArray.bind(this, data),
      getGroupList: this.getGroupList.bind(this, data),
      getGroupMap: this.getGroupMap.bind(this, data),
      getGroupMemberMap: this.getGroupMemberMap.bind(this, data),
      gl: new Map(),
      gml: new Map(),

      // 请求管理
      request_list: [],
      getSystemMsg() {
        return this.request_list
      },
      setFriendAddRequest: this.setFriendAddRequest.bind(this, data),
      setGroupAddRequest: this.setGroupAddRequest.bind(this, data),

      // 精华消息
      setEssenceMessage: this.setEssenceMsg.bind(this, data),
      removeEssenceMessage: this.deleteEssenceMsg.bind(this, data),

      // Cookies管理
      cookies: {},
      getCookies(domain) {
        return this.cookies[domain]
      },
      getCsrfToken() {
        return this.bkn
      },
    }
    
    data.bot = Bot[data.self_id]

    // 注册Bot账号
    if (!Bot.uin.includes(data.self_id)) {
      Bot.uin.push(data.self_id)
    }

    // 初始化机器人信息
    await this.initializeBotInfo(data)

    Bot.makeLog(
      "mark",
      `${this.name}(${this.id}) ${data.bot.version.version} 已连接`,
      data.self_id
    )
    
    Bot.em(`connect.${data.self_id}`, data)
  }

  /**
   * 初始化机器人信息
   */
  async initializeBotInfo(data) {
    // 设置机器人型号
    data.bot.sendApi("_set_model_show", {
      model: data.bot.model,
      model_show: data.bot.model,
    }).catch(() => {})

    // 获取登录信息
    try {
      data.bot.info = await data.bot.sendApi("get_login_info")
    } catch (err) {
      Bot.makeLog("error", ["获取登录信息失败", err])
      data.bot.info = {}
    }

    // 获取频道服务信息
    try {
      data.bot.guild_info = await data.bot.sendApi("get_guild_service_profile")
    } catch {
      data.bot.guild_info = {}
    }

    // 获取在线客户端
    try {
      const result = await data.bot.sendApi("get_online_clients")
      data.bot.clients = result.clients || []
    } catch {
      data.bot.clients = []
    }

    // 获取版本信息
    try {
      data.bot.version = await data.bot.sendApi("get_version_info")
      data.bot.version = {
        ...data.bot.version,
        id: this.id,
        name: this.name,
        get version() {
          return this.app_full_name || `${this.app_name} v${this.app_version}`
        },
      }
    } catch {
      data.bot.version = {
        id: this.id,
        name: this.name,
        version: "Unknown",
      }
    }

    // 获取Cookies
    await this.initializeCookies(data)

    // 获取CSRF Token
    try {
      const result = await data.bot.sendApi("get_csrf_token")
      data.bot.bkn = result.token
    } catch {
      data.bot.bkn = null
    }

    // 异步加载好友和群组信息
    data.bot.getFriendMap().catch(() => {})
    data.bot.getGroupMemberMap().catch(() => {})
  }

  /**
   * 初始化Cookies
   */
  async initializeCookies(data) {
    try {
      const mainCookies = await data.bot.sendApi("get_cookies", { 
        domain: "qun.qq.com" 
      })
      
      if (mainCookies?.cookies) {
        data.bot.cookies["qun.qq.com"] = mainCookies.cookies
        
        // 获取其他域名的cookies
        const domains = [
          "aq", "connect", "docs", "game", "gamecenter", "haoma",
          "id", "kg", "mail", "mma", "office", "openmobile",
          "qqweb", "qzone", "ti", "v", "vip", "y"
        ]
        
        const cookiePromises = domains.map(async (domain) => {
          const fullDomain = `${domain}.qq.com`
          try {
            const result = await data.bot.sendApi("get_cookies", { 
              domain: fullDomain 
            })
            if (result?.cookies) {
              data.bot.cookies[fullDomain] = result.cookies
            }
          } catch {
            // 静默处理单个域名cookie获取失败
          }
        })
        
        await Promise.allSettled(cookiePromises)
      }
    } catch (err) {
      Bot.makeLog("warn", "获取cookies失败，部分功能可能受限")
    }
  }

  // ==================== 事件处理 ====================
  
  /**
   * 处理消息事件
   */
  makeMessage(data) {
    data.message = this.parseMsg(data.message)
    
    switch (data.message_type) {
      case "private":
        this.handlePrivateMessage(data)
        break
        
      case "group":
        this.handleGroupMessage(data)
        break
        
      case "guild":
        this.handleGuildMessage(data)
        break
        
      default:
        Bot.makeLog("warn", `未知消息类型：${logger.magenta(data.raw)}`, data.self_id)
    }

    Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  /**
   * 处理私聊消息
   */
  handlePrivateMessage(data) {
    const name = data.sender?.card || 
                 data.sender?.nickname || 
                 data.bot.fl.get(data.user_id)?.nickname
    
    Bot.makeLog(
      "info",
      `好友消息：${name ? `[${name}] ` : ""}${data.raw_message}`,
      `${data.self_id} <= ${data.user_id}`,
      true
    )
  }

  /**
   * 处理群消息
   */
  handleGroupMessage(data) {
    const group_name = data.group_name || 
                      data.bot.gl.get(data.group_id)?.group_name
    
    let user_name = data.sender?.card || data.sender?.nickname
    if (!user_name) {
      const user = data.bot.gml.get(data.group_id)?.get(data.user_id) || 
                  data.bot.fl.get(data.user_id)
      if (user) {
        user_name = user?.card || user?.nickname
      }
    }
    
    Bot.makeLog(
      "info",
      `群消息：${user_name ? `[${group_name ? `${group_name}, ` : ""}${user_name}] ` : ""}${data.raw_message}`,
      `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
      true
    )
  }

  /**
   * 处理频道消息
   */
  handleGuildMessage(data) {
    data.message_type = "group"
    data.group_id = `${data.guild_id}-${data.channel_id}`
    
    Bot.makeLog(
      "info",
      `频道消息：[${data.sender?.nickname}] ${Bot.String(data.message)}`,
      `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
      true
    )
    
    Object.defineProperty(data, "friend", {
      get() {
        return this.member || {}
      },
    })
  }

  /**
   * 处理通知事件
   */
  async makeNotice(data) {
    const handlers = {
      friend_recall: this.handleFriendRecall.bind(this),
      group_recall: this.handleGroupRecall.bind(this),
      group_increase: this.handleGroupIncrease.bind(this),
      group_decrease: this.handleGroupDecrease.bind(this),
      group_admin: this.handleGroupAdmin.bind(this),
      group_upload: this.handleGroupUpload.bind(this),
      group_ban: this.handleGroupBan.bind(this),
      group_msg_emoji_like: this.handleGroupEmojiLike.bind(this),
      friend_add: this.handleFriendAdd.bind(this),
      notify: this.handleNotify.bind(this),
      group_card: this.handleGroupCard.bind(this),
      offline_file: this.handleOfflineFile.bind(this),
      client_status: this.handleClientStatus.bind(this),
      essence: this.handleEssence.bind(this),
      guild_channel_recall: this.handleGuildChannelRecall.bind(this),
      message_reactions_updated: this.handleMessageReactionsUpdated.bind(this),
      channel_updated: this.handleChannelUpdated.bind(this),
      channel_created: this.handleChannelCreated.bind(this),
      channel_destroyed: this.handleChannelDestroyed.bind(this),
      bot_offline: this.handleBotOffline.bind(this),
    }

    const handler = handlers[data.notice_type]
    if (handler) {
      await handler(data)
    } else {
      Bot.makeLog("warn", `未知通知类型：${logger.magenta(data.raw)}`, data.self_id)
    }

    // 处理notice_type
    let notice = data.notice_type.split("_")
    data.notice_type = notice.shift()
    notice = notice.join("_")
    if (notice) data.sub_type = notice

    // 处理频道相关
    if (data.guild_id && data.channel_id) {
      data.group_id = `${data.guild_id}-${data.channel_id}`
      Object.defineProperty(data, "friend", {
        get() {
          return this.member || {}
        },
      })
    }

    Bot.em(`${data.post_type}.${data.notice_type}.${data.sub_type}`, data)
  }

  // 各种通知处理函数
  handleFriendRecall(data) {
    Bot.makeLog(
      "info",
      `好友消息撤回：${data.message_id}`,
      `${data.self_id} <= ${data.user_id}`,
      true
    )
  }

  handleGroupRecall(data) {
    Bot.makeLog(
      "info",
      `群消息撤回：${data.operator_id} => ${data.user_id} ${data.message_id}`,
      `${data.self_id} <= ${data.group_id}`,
      true
    )
  }

  async handleGroupIncrease(data) {
    Bot.makeLog(
      "info",
      `群成员增加：${data.operator_id} => ${data.user_id} ${data.sub_type}`,
      `${data.self_id} <= ${data.group_id}`,
      true
    )
    
    const group = data.bot.pickGroup(data.group_id)
    group.getInfo().catch(() => {})
    
    if (data.user_id === data.self_id && cfg.bot.cache_group_member) {
      group.getMemberMap().catch(() => {})
    } else {
      group.pickMember(data.user_id).getInfo().catch(() => {})
    }
  }

  handleGroupDecrease(data) {
    Bot.makeLog(
      "info",
      `群成员减少：${data.operator_id} => ${data.user_id} ${data.sub_type}`,
      `${data.self_id} <= ${data.group_id}`,
      true
    )
    
    if (data.user_id === data.self_id) {
      data.bot.gl.delete(data.group_id)
      data.bot.gml.delete(data.group_id)
    } else {
      data.bot.pickGroup(data.group_id).getInfo().catch(() => {})
      data.bot.gml.get(data.group_id)?.delete(data.user_id)
    }
  }

  handleGroupAdmin(data) {
    Bot.makeLog(
      "info",
      `群管理员变动：${data.sub_type}`,
      `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
      true
    )
    
    data.set = data.sub_type === "set"
    data.bot.pickMember(data.group_id, data.user_id).getInfo().catch(() => {})
  }

  handleGroupUpload(data) {
    Bot.makeLog(
      "info",
      `群文件上传：${Bot.String(data.file)}`,
      `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
      true
    )
    
    Bot.em("message.group.normal", {
      ...data,
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message: [{ ...data.file, type: "file" }],
      raw_message: `[文件：${data.file.name}]`,
    })
  }

  handleGroupBan(data) {
    Bot.makeLog(
      "info",
      `群禁言：${data.operator_id} => ${data.user_id} ${data.sub_type} ${data.duration}秒`,
      `${data.self_id} <= ${data.group_id}`,
      true
    )
    
    data.bot.pickMember(data.group_id, data.user_id).getInfo().catch(() => {})
  }

  handleGroupEmojiLike(data) {
    Bot.makeLog(
      "info",
      [`群消息回应：${data.message_id}`, data.likes],
      `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
      true
    )
  }

  handleFriendAdd(data) {
    Bot.makeLog("info", "好友添加", `${data.self_id} <= ${data.user_id}`, true)
    data.bot.pickFriend(data.user_id).getInfo().catch(() => {})
  }

  handleNotify(data) {
    if (data.group_id) {
      data.notice_type = "group"
    } else {
      data.notice_type = "friend"
    }
    
    data.user_id ??= data.operator_id || data.target_id
    
    const notifyHandlers = {
      poke: this.handlePoke.bind(this),
      honor: this.handleHonor.bind(this),
      title: this.handleTitle.bind(this),
      group_name: this.handleGroupName.bind(this),
      input_status: this.handleInputStatus.bind(this),
      profile_like: this.handleProfileLike.bind(this),
    }
    
    const handler = notifyHandlers[data.sub_type]
    if (handler) {
      handler(data)
    } else {
      Bot.makeLog("warn", `未知通知：${logger.magenta(data.raw)}`, data.self_id)
    }
  }

  handlePoke(data) {
    data.operator_id = data.user_id
    
    if (data.group_id) {
      Bot.makeLog(
        "info",
        `群戳一戳：${data.operator_id} => ${data.target_id}`,
        `${data.self_id} <= ${data.group_id}`,
        true
      )
    } else {
      Bot.makeLog(
        "info",
        `好友戳一戳：${data.operator_id} => ${data.target_id}`,
        data.self_id,
        true
      )
    }
  }

  handleHonor(data) {
    Bot.makeLog(
      "info",
      `群荣誉：${data.honor_type}`,
      `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
      true
    )
    data.bot.pickMember(data.group_id, data.user_id).getInfo().catch(() => {})
  }

  handleTitle(data) {
    Bot.makeLog(
      "info",
      `群头衔：${data.title}`,
      `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
      true
    )
    data.bot.pickMember(data.group_id, data.user_id).getInfo().catch(() => {})
  }

  handleGroupName(data) {
    Bot.makeLog(
      "info",
      `群名更改：${data.name_new}`,
      `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
      true
    )
    data.bot.pickGroup(data.group_id).getInfo().catch(() => {})
  }

  handleInputStatus(data) {
    data.post_type = "internal"
    data.notice_type = "input"
    data.end ??= data.event_type !== 1
    data.message ||= data.status_text || `对方${data.end ? "结束" : "正在"}输入...`
    
    Bot.makeLog("info", data.message, `${data.self_id} <= ${data.user_id}`, true)
  }

  handleProfileLike(data) {
    Bot.makeLog(
      "info",
      `资料卡点赞：${data.times}次`,
      `${data.self_id} <= ${data.operator_id}`,
      true
    )
  }

  handleGroupCard(data) {
    Bot.makeLog(
      "info",
      `群名片更新：${data.card_old} => ${data.card_new}`,
      `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
      true
    )
    data.bot.pickMember(data.group_id, data.user_id).getInfo().catch(() => {})
  }

  handleOfflineFile(data) {
    Bot.makeLog(
      "info",
      `离线文件：${Bot.String(data.file)}`,
      `${data.self_id} <= ${data.user_id}`,
      true
    )
    
    Bot.em("message.private.friend", {
      ...data,
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      message: [{ ...data.file, type: "file" }],
      raw_message: `[文件：${data.file.name}]`,
    })
  }

  async handleClientStatus(data) {
    Bot.makeLog(
      "info",
      `客户端${data.online ? "上线" : "下线"}：${Bot.String(data.client)}`,
      data.self_id
    )
    
    try {
      const result = await data.bot.sendApi("get_online_clients")
      data.clients = result.clients || []
      data.bot.clients = data.clients
    } catch {
      data.clients = []
      data.bot.clients = []
    }
  }

  handleEssence(data) {
    data.notice_type = "group_essence"
    Bot.makeLog(
      "info",
      `群精华消息：${data.operator_id} => ${data.sender_id} ${data.sub_type} ${data.message_id}`,
      `${data.self_id} <= ${data.group_id}`,
      true
    )
  }

  handleGuildChannelRecall(data) {
    Bot.makeLog(
      "info",
      `频道消息撤回：${data.operator_id} => ${data.user_id} ${data.message_id}`,
      `${data.self_id} <= ${data.guild_id}-${data.channel_id}`,
      true
    )
  }

  handleMessageReactionsUpdated(data) {
    data.notice_type = "guild_message_reactions_updated"
    Bot.makeLog(
      "info",
      `频道消息表情贴：${data.message_id} ${Bot.String(data.current_reactions)}`,
      `${data.self_id} <= ${data.guild_id}-${data.channel_id}, ${data.user_id}`,
      true
    )
  }

  handleChannelUpdated(data) {
    data.notice_type = "guild_channel_updated"
    Bot.makeLog(
      "info",
      `子频道更新：${Bot.String(data.old_info)} => ${Bot.String(data.new_info)}`,
      `${data.self_id} <= ${data.guild_id}-${data.channel_id}, ${data.user_id}`,
      true
    )
  }

  handleChannelCreated(data) {
    data.notice_type = "guild_channel_created"
    Bot.makeLog(
      "info",
      `子频道创建：${Bot.String(data.channel_info)}`,
      `${data.self_id} <= ${data.guild_id}-${data.channel_id}, ${data.user_id}`,
      true
    )
    data.bot.getGroupMap().catch(() => {})
  }

  handleChannelDestroyed(data) {
    data.notice_type = "guild_channel_destroyed"
    Bot.makeLog(
      "info",
      `子频道删除：${Bot.String(data.channel_info)}`,
      `${data.self_id} <= ${data.guild_id}-${data.channel_id}, ${data.user_id}`,
      true
    )
    data.bot.getGroupMap().catch(() => {})
  }

  handleBotOffline(data) {
    data.post_type = "system"
    data.notice_type = "offline"
    Bot.makeLog("info", `${data.tag || "账号下线"}：${data.message}`, data.self_id)
    Bot.sendMasterMsg(`[${data.self_id}] ${data.tag || "账号下线"}：${data.message}`)
  }

  /**
   * 处理请求事件
   */
  makeRequest(data) {
    switch (data.request_type) {
      case "friend":
        this.handleFriendRequest(data)
        break
        
      case "group":
        this.handleGroupRequest(data)
        break
        
      default:
        Bot.makeLog("warn", `未知请求类型：${logger.magenta(data.raw)}`, data.self_id)
    }

    data.bot.request_list.push(data)
    Bot.em(`${data.post_type}.${data.request_type}.${data.sub_type}`, data)
  }

  handleFriendRequest(data) {
    Bot.makeLog(
      "info",
      `加好友请求：${data.comment}(${data.flag})`,
      `${data.self_id} <= ${data.user_id}`,
      true
    )
    
    data.sub_type = "add"
    data.approve = function (approve = true, remark = "") {
      return this.bot.setFriendAddRequest(this.flag, approve, remark)
    }
  }

  handleGroupRequest(data) {
    Bot.makeLog(
      "info",
      `加群请求：${data.sub_type} ${data.comment}(${data.flag})`,
      `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
      true
    )
    
    data.approve = function (approve = true, reason = "") {
      return this.bot.setGroupAddRequest(this.flag, approve, reason, this.sub_type)
    }
  }

  /**
   * 处理心跳
   */
  heartbeat(data) {
    if (data.status) {
      Object.assign(data.bot.stat, data.status)
    }
  }

  /**
   * 处理元事件
   */
  makeMeta(data, ws) {
    switch (data.meta_event_type) {
      case "heartbeat":
        this.heartbeat(data)
        break
        
      case "lifecycle":
        this.connect(data, ws)
        break
        
      default:
        Bot.makeLog("warn", `未知元事件：${logger.magenta(data.raw)}`, data.self_id)
    }
  }

  /**
   * 消息处理入口
   */
  message(data, ws) {
    try {
      data = {
        ...JSON.parse(data),
        raw: Bot.String(data),
      }
    } catch (err) {
      return Bot.makeLog("error", ["解码数据失败", data, err])
    }

    // 处理不同类型的消息
    if (data.post_type) {
      // 检查Bot是否存在
      if (data.meta_event_type !== "lifecycle" && !Bot.uin.includes(data.self_id)) {
        Bot.makeLog("warn", `找不到对应Bot，忽略消息：${logger.magenta(data.raw)}`, data.self_id)
        return false
      }
      
      data.bot = Bot[data.self_id]

      switch (data.post_type) {
        case "meta_event":
          return this.makeMeta(data, ws)
          
        case "message":
          return this.makeMessage(data)
          
        case "notice":
          return this.makeNotice(data)
          
        case "request":
          return this.makeRequest(data)
          
        case "message_sent":
          data.post_type = "message"
          return this.makeMessage(data)
      }
    } else if (data.echo) {
      // 处理API响应
      const cache = this.echo.get(data.echo)
      if (cache) {
        return cache.resolve(data)
      }
    }
    
    Bot.makeLog("warn", `未知消息：${logger.magenta(data.raw)}`, data.self_id)
  }

  /**
   * 加载适配器
   */
  load() {
    if (!Array.isArray(Bot.wsf[this.path])) {
      Bot.wsf[this.path] = []
    }
    
    Bot.wsf[this.path].push((ws, ...args) =>
      ws.on("message", data => this.message(data, ws, ...args))
    )
  }
}

// 创建并注册适配器实例
Bot.adapter.push(new OneBotv11Adapter())