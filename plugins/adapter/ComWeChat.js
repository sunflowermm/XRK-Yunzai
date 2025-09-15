import cfg from "../../lib/config/config.js"
import { ulid } from "ulid"

Bot.adapter.push(new class ComWeChatAdapter {
  id = "WeChat"
  name = "ComWeChat"
  path = this.name
  echo = new Map
  timeout = 60000

  makeLog(msg) {
    return Bot.String(msg).replace(/(base64:\/\/|"type":"data","data":").*?"/g, '$1..."')
  }

  sendApi(data, ws, action, params = {}) {
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

    return cache.promise.then(data => {
      if (data.retcode !== 0)
        throw Bot.makeError(data.message, request, { error: data })
      return data.data ? new Proxy(data, {
        get: (target, prop) => target.data[prop] ?? target[prop],
      }) : data
    }).finally(() => {
      clearTimeout(timeout)
      this.echo.delete(echo)
    })
  }

  async uploadFile(data, file) {
    file = await Bot.fileType(file, {
      http: true, size: 10485760,
    })
    const opts = { name: file.name }

    if (Buffer.isBuffer(file.buffer)) {
      opts.type = "data"
      opts.data = file.buffer.toString("base64")
    } else if (file.buffer.match(/^https?:\/\//)) {
      opts.type = "url"
      opts.url = file.buffer
    } else {
      opts.type = "path"
      opts.path = file.buffer
    }

    Bot.makeLog("info", `上传文件：${this.makeLog(opts)}`, data.self_id)
    return data.bot.sendApi("upload_file", opts)
  }

  async makeMsg(data, msg, send) {
    if (!Array.isArray(msg))
      msg = [msg]
    const msgs = []
    for (let i of msg) {
      if (typeof i !== "object")
        i = { type: "text", data: { text: i }}
      else if (!i.data)
        i = { type: i.type, data: { ...i, type: undefined }}
      if (i.data.file)
        i.data = { file_id: (await this.uploadFile(data, i.data)).file_id }

      switch (i.type) {
        case "text":
        case "image":
        case "file":
        case "wx.emoji":
        case "wx.link":
          break
        case "record":
        case "video":
          i.type = "file"
          break
        case "at":
          if (i.data.qq === "all")
            i = { type: "mention_all", data: {}}
          else
            i = { type: "mention", data: { user_id: i.data.qq }}
          break
        case "reply":
        case "button":
          continue
        case "node":
          await Bot.sendForwardMsg(send, i.data)
          continue
        case "raw":
          i = i.data
          break
        default:
          i = { type: "text", data: { text: Bot.String(i) }}
      }
      msgs.push(i)
    }
    return msgs
  }

  async sendFriendMsg(data, msg) {
    const message = await this.makeMsg(data, msg, msg => this.sendFriendMsg(data, msg))
    Bot.makeLog("info", `发送好友消息：${this.makeLog(message)}`, `${data.self_id} => ${data.user_id}`, true)
    return data.bot.sendApi("send_message", {
      detail_type: "private",
      user_id: data.user_id,
      message,
    })
  }

  async sendGroupMsg(data, msg) {
    const message = await this.makeMsg(data, msg, msg => this.sendGroupMsg(data, msg))
    Bot.makeLog("info", `发送群消息：${this.makeLog(message)}`, `${data.self_id} => ${data.group_id}`, true)
    return data.bot.sendApi("send_message", {
      detail_type: "group",
      group_id: data.group_id,
      message,
    })
  }

  async getFriendArray(data) {
    const array = []
    for (const i of (await data.bot.sendApi("get_friend_list")).data)
      array.push({
        ...i,
        nickname: i.user_remark === "null" ? i.user_displayname || i.user_name : i.user_remark,
      })
    return array
  }

  async getFriendList(data) {
    const array = []
    for (const { user_id } of (await this.getFriendArray(data)))
      array.push(user_id)
    return array
  }

  async getFriendMap(data) {
    const map = new Map
    for (const i of (await this.getFriendArray(data)))
      map.set(i.user_id, i)
    data.bot.fl = map
    return map
  }

  async getFriendInfo(data) {
    const info = (await data.bot.sendApi("get_user_info", {
      user_id: data.user_id,
    })).data
    data.bot.fl.set(data.user_id, info)
    return info
  }

  async getGroupArray(data) {
    return (await data.bot.sendApi("get_group_list")).data
  }

  async getGroupList(data) {
    const array = []
    for (const { group_id } of (await this.getGroupArray(data)))
      array.push(group_id)
    return array
  }

  async getGroupMap(data) {
    const map = new Map
    for (const i of (await this.getGroupArray(data)))
      map.set(i.group_id, i)
    data.bot.gl = map
    return map
  }

  async getGroupInfo(data) {
    const info = (await data.bot.sendApi("get_group_info", {
      group_id: data.group_id,
    })).data
    data.bot.gl.set(data.group_id, info)
    return info
  }

  async getMemberArray(data) {
    return (await data.bot.sendApi("get_group_member_list", {
      group_id: data.group_id,
    })).data
  }

  async getMemberList(data) {
    const array = []
    for (const { user_id } of (await this.getMemberArray(data)))
      array.push(user_id)
    return array
  }

  async getMemberMap(data) {
    const map = new Map
    for (const i of (await this.getMemberArray(data)))
      map.set(i.user_id, i)
    data.bot.gml.set(data.group_id, map)
    return map
  }

  async getGroupMemberMap(data) {
    if (!cfg.bot.cache_group_member)
      return this.getGroupMap(data)
    for (const [group_id] of await this.getGroupMap(data)) {
      if (group_id === "filehelper")
        continue
      await this.getMemberMap({ ...data, group_id }).catch(() => {})
    }
  }

  async getMemberInfo(data) {
    const info = (await data.bot.sendApi("get_group_member_info", {
      group_id: data.group_id,
      user_id: data.user_id,
    })).data
    let gml = data.bot.gml.get(data.group_id)
    if (!gml) {
      gml = new Map
      data.bot.gml.set(data.group_id, gml)
    }
    gml.set(data.user_id, info)
    return info
  }

  pickFriend(data, user_id) {
    const i = {
      ...data.bot.fl.get(user_id),
      ...data,
      user_id,
    }
    return {
      ...i,
      sendMsg: this.sendFriendMsg.bind(this, i),
      sendFile: (file, name) => this.sendFriendMsg(i, segment.file(file, name)),
      getInfo: this.getFriendInfo.bind(this, i),
      async getAvatarUrl() { return this["wx.avatar"] || (await this.getInfo())["wx.avatar"] },
    }
  }

  pickMember(data, group_id, user_id) {
    const i = {
      ...data.bot.gml.get(group_id)?.get(user_id),
      ...data,
      group_id,
      user_id,
    }
    return {
      ...this.pickFriend(i, user_id),
      ...i,
      getInfo: this.getMemberInfo.bind(this, i),
    }
  }

  pickGroup(data, group_id) {
    const i = {
      ...data.bot.gl.get(group_id),
      ...data,
      group_id,
    }
    return {
      ...i,
      sendMsg: this.sendGroupMsg.bind(this, i),
      sendFile: (file, name) => this.sendGroupMsg(i, segment.file(file, name)),
      getInfo: this.getGroupInfo.bind(this, i),
      async getAvatarUrl() { return this["wx.avatar"] || (await this.getInfo())["wx.avatar"] },
      getMemberArray: this.getMemberArray.bind(this, i),
      getMemberList: this.getMemberList.bind(this, i),
      getMemberMap: this.getMemberMap.bind(this, i),
      pickMember: this.pickMember.bind(this, i, group_id),
    }
  }

  async connect(data, ws) {
    for (const bot of data.status.bots)
      data.self_id = bot.self.user_id

    Bot[data.self_id] = {
      adapter: this,
      ws: ws,
      sendApi: this.sendApi.bind(this, data, ws),
      stat: { ...data.status, start_time: data.time },

      info: {},
      get uin() { return this.info.user_id },
      get nickname() { return this.info.user_name },
      get avatar() { return this.info["wx.avatar"] },

      pickFriend: this.pickFriend.bind(this, data),
      get pickUser() { return this.pickFriend },
      getFriendArray: this.getFriendArray.bind(this, data),
      getFriendList: this.getFriendList.bind(this, data),
      getFriendMap: this.getFriendMap.bind(this, data),
      fl: new Map,

      pickMember: this.pickMember.bind(this, data),
      pickGroup: this.pickGroup.bind(this, data),
      getGroupArray: this.getGroupArray.bind(this, data),
      getGroupList: this.getGroupList.bind(this, data),
      getGroupMap: this.getGroupMap.bind(this, data),
      getGroupMemberMap: this.getGroupMemberMap.bind(this, data),
      gl: new Map,
      gml: new Map,
    }
    data.bot = Bot[data.self_id]

    if (!Bot.uin.includes(data.self_id))
      Bot.uin.push(data.self_id)

    data.bot.info = (await data.bot.sendApi("get_self_info").catch(i => i.error)).data
    data.bot.version = {
      ...(await data.bot.sendApi("get_version").catch(i => i.error)).data,
      id: this.id,
      name: this.name,
    }

    data.bot.getFriendMap()
    data.bot.getGroupMemberMap()

    Bot.makeLog("mark", `${this.name}(${this.id}) ${data.bot.version.impl}-${data.bot.version.version} 已连接`, data.self_id)
    Bot.em(`connect.${data.self_id}`, data)
  }

  makeMessage(data) {
    data.post_type = data.type
    data.message_type = data.detail_type
    data.raw_message = data.alt_message

    data.sender = {
      ...data.bot.fl.get(data.user_id),
      user_id: data.user_id,
    }

    const message = []
    for (const i of data.message)
      switch (i.type) {
        case "mention":
          message.push({ type: "at", qq: i.data.user_id })
          break
        case "mention_all":
          message.push({ type: "at", qq: "all" })
          break
        case "voice":
          message.push({ type: "record", ...i.data })
          break
        case "reply":
          message.push({ type: "reply", id: i.data.message_id, user_id: i.data.user_id })
          break
        default:
          message.push({ type: i.type, ...i.data })
      }
    data.message = message

    switch (data.message_type) {
      case "private":
        Bot.makeLog("info", `好友消息：${data.raw_message}`, `${data.self_id} <= ${data.user_id}`, true)
        break
      case "group":
        Bot.makeLog("info", `群消息：${data.raw_message}`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true)
        break
      default:
        Bot.makeLog("warn", `未知消息：${logger.magenta(data.raw)}`, data.self_id)
    }

    Bot.em(`${data.post_type}.${data.message_type}`, data)
  }

  makeNotice(data) {
    data.post_type = data.type
    if (data.group_id)
      data.notice_type = "group"
    else
      data.notice_type = "friend"

    switch (data.detail_type) {
      case "private_message_delete":
        Bot.makeLog("info", `好友消息撤回：${data.message_id}`, `${data.self_id} <= ${data.user_id}`, true)
        data.sub_type = "recall"
        break
      case "group_message_delete":
        Bot.makeLog("info", `群消息撤回：${data.operator_id} => ${data.user_id} ${data.message_id}`, `${data.self_id} <= ${data.group_id}`, true)
        data.sub_type = "recall"
        break
      case "wx.get_private_file":
        Bot.makeLog("info", `私聊文件：${data.file_name} ${data.file_length} ${data.md5}`, `${data.self_id} <= ${data.user_id}`, true)
        break
      case "wx.get_group_file":
        Bot.makeLog("info", `群文件：${data.file_name} ${data.file_length} ${data.md5}`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true)
        break
      case "wx.get_private_redbag":
        Bot.makeLog("info", `好友红包`, `${data.self_id} <= ${data.user_id}`, true)
        break
      case "wx.get_group_redbag":
        Bot.makeLog("info", `群红包`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true)
        break
      case "wx.get_private_poke":
        data.operator_id = data.from_user_id
        data.target_id = data.user_id
        Bot.makeLog("info", `好友拍一拍：${data.operator_id} => ${data.target_id}`, data.self_id)
        break
      case "wx.get_group_poke":
        data.operator_id = data.from_user_id
        data.target_id = data.user_id
        Bot.makeLog("info", `群拍一拍：${data.operator_id} => ${data.target_id}`, `${data.self_id} <= ${data.group_id}`, true)
        break
      case "wx.get_private_card":
        Bot.makeLog("info", `好友用户名片：${data.v3} ${data.v4} ${data.nickname} ${data.head_url} ${data.province} ${data.city} ${data.sex}`, `${data.self_id} <= ${data.user_id}`, true)
        break
      case "wx.get_group_card":
        Bot.makeLog("info", `群用户名片：${data.v3} ${data.v4} ${data.nickname} ${data.head_url} ${data.province} ${data.city} ${data.sex}`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true)
        break
      default:
        Bot.makeLog("warn", `未知通知：${logger.magenta(data.raw)}`, data.self_id)
    }
    if (!data.sub_type)
      data.sub_type = data.detail_type.split("_").pop()

    Bot.em(`${data.post_type}.${data.notice_type}.${data.sub_type}`, data)
  }

  makeRequest(data) {
    data.post_type = data.type
    if (data.group_id)
      data.notice_type = "group"
    else
      data.notice_type = "friend"

    switch (data.detail_type) {
      case "wx.friend_request":
        Bot.makeLog("info", `加好友请求：${data.v3} ${data.v4} ${data.nickname} ${data.content} ${data.province} ${data.city}`, `${data.self_id} <= ${data.user_id}`, true)
        data.sub_type = "add"
        break
      default:
        Bot.makeLog("warn", `未知请求：${logger.magenta(data.raw)}`, data.self_id)
    }
    if (!data.sub_type)
      data.sub_type = data.detail_type.split("_").pop()

    Bot.em(`${data.post_type}.${data.request_type}.${data.sub_type}`, data)
  }

  makeMeta(data, ws) {
    switch (data.detail_type) {
      case "heartbeat":
        break
      case "connect":
        break
      case "status_update":
        this.connect(data, ws)
        break
      default:
        Bot.makeLog("warn", `未知消息：${logger.magenta(data.raw)}`, data.self_id)
    }
  }

  message(data, ws) {
    try {
      data = {
        ...JSON.parse(data),
        raw: Bot.String(data),
      }
    } catch (err) {
      return Bot.makeLog("error", ["解码数据失败", data, err])
    }

    if (data.self?.user_id) {
      data.self_id = data.self.user_id
    } else {
      data.self_id = data.id
    }

    if (data.type) {
      if (data.type !== "meta" && !Bot.uin.includes(data.self_id)) {
        Bot.makeLog("warn", `找不到对应Bot，忽略消息：${logger.magenta(data.raw)}`, data.self_id)
        return false
      }
      data.bot = Bot[data.self_id]

      switch (data.type) {
        case "meta":
          return this.makeMeta(data, ws)
        case "message":
          return this.makeMessage(data)
        case "notice":
          return this.makeNotice(data)
        case "request":
          return this.makeRequest(data)
      }
    } else if (data.echo) {
      const cache = this.echo.get(data.echo)
      if (cache) return cache.resolve(data)
    }
    Bot.makeLog("warn", `未知消息：${logger.magenta(data.raw)}`, data.self_id)
  }

  load() {
    if (!Array.isArray(Bot.wsf[this.path]))
      Bot.wsf[this.path] = []
    Bot.wsf[this.path].push((ws, ...args) =>
      ws.on("message", data => this.message(data, ws, ...args))
    )
  }
})