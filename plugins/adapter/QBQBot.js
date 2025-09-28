Bot.adapter.push(
  new (class OPQBotAdapter {
    id = "QQ"
    name = "OPQBot"
    path = this.name
    echo = new Map()
    timeout = 60000
    CommandId = {
      FriendImage: 1,
      GroupImage: 2,
      FriendVoice: 26,
      GroupVoice: 29,
    }

    sendApi(id, CgiCmd, CgiRequest) {
      const ReqId = Math.round(Math.random() * 10 ** 16)
      const request = { BotUin: String(id), CgiCmd, CgiRequest, ReqId }
      Bot[id].ws.sendMsg(request)
      const cache = Promise.withResolvers()
      this.echo.set(ReqId, cache)
      const timeout = setTimeout(() => {
        cache.reject(Bot.makeError("请求超时", request, { timeout: this.timeout }))
        Bot.makeLog("error", ["请求超时", request], id)
        ws.terminate()
      }, this.timeout)

      return cache.promise
        .then(data => {
          if (data.CgiBaseResponse?.Ret !== 0)
            throw Bot.makeError(data.CgiBaseResponse?.ErrMsg, request, { error: data })
          return data
        })
        .finally(() => {
          clearTimeout(timeout)
          this.echo.delete(ReqId)
        })
    }

    makeLog(msg) {
      return Bot.String(msg).replace(/base64:\/\/.*?"/g, 'base64://..."')
    }

    async uploadFile(id, type, file) {
      const opts = { CommandId: this.CommandId[type] }

      file = await Bot.Buffer(file, {
        http: true,
        size: 10485760,
      })
      if (Buffer.isBuffer(file)) opts.Base64Buf = file.toString("base64")
      else if (file.match(/^https?:\/\//)) opts.FileUrl = file
      else opts.FilePath = file

      return (await this.sendApi(id, "PicUp.DataUp", opts)).ResponseData
    }

    async sendMsg(send, upload, msg) {
      if (!Array.isArray(msg)) msg = [msg]
      const message = {
        Content: "",
        Images: [],
        AtUinLists: [],
      }

      for (let i of msg) {
        if (typeof i !== "object") i = { type: "text", text: i }

        switch (i.type) {
          case "text":
            message.Content += i.text
            break
          case "image":
            message.Images.push(await upload("Image", i.file))
            break
          case "record":
            message.Voice = await upload("Voice", i.file)
            break
          case "at":
            message.AtUinLists.push({ Uin: i.qq })
            break
          case "video":
          case "file":
          case "face":
          case "reply":
          case "button":
            continue
          case "node":
            await Bot.sendForwardMsg(msg => this.sendMsg(send, upload, msg), i.data)
            continue
          case "raw":
            for (const i in i.data) message[i] = i.data[i]
            continue
          default:
            message.Content += Bot.String(i)
        }
      }

      return send(message)
    }

    sendFriendMsg(data, msg) {
      Bot.makeLog(
        "info",
        `发送好友消息：${this.makeLog(msg)}`,
        `${data.self_id} => ${data.user_id}`,
        true,
      )
      return this.sendMsg(
        msg =>
          this.sendApi(data.self_id, "MessageSvc.PbSendMsg", {
            ToUin: data.user_id,
            ToType: 1,
            ...msg,
          }),
        (type, file) => this.uploadFile(data.self_id, `Friend${type}`, file),
        msg,
      )
    }

    sendMemberMsg(data, msg) {
      Bot.makeLog(
        "info",
        `发送群员消息：${this.makeLog(msg)}`,
        `${data.self_id} => ${data.group_id}, ${data.user_id}`,
        true,
      )
      return this.sendMsg(
        msg =>
          this.sendApi(data.self_id, "MessageSvc.PbSendMsg", {
            ToUin: data.user_id,
            GroupCode: data.group_id,
            ToType: 3,
            ...msg,
          }),
        (type, file) => this.uploadFile(data.self_id, `Friend${type}`, file),
        msg,
      )
    }

    sendGroupMsg(data, msg) {
      Bot.makeLog(
        "info",
        `发送群消息：${this.makeLog(msg)}`,
        `${data.self_id} => ${data.group_id}`,
        true,
      )
      let ReplyTo
      if (data.message_id && data.seq && data.time)
        ReplyTo = {
          MsgSeq: data.seq,
          MsgTime: data.time,
          MsgUid: data.message_id,
        }

      return this.sendMsg(
        msg =>
          this.sendApi(data.self_id, "MessageSvc.PbSendMsg", {
            ToUin: data.group_id,
            ToType: 2,
            ReplyTo,
            ...msg,
          }),
        (type, file) => this.uploadFile(data.self_id, `Group${type}`, file),
        msg,
      )
    }

    pickFriend(id, user_id) {
      const i = {
        ...Bot[id].fl.get(user_id),
        self_id: id,
        bot: Bot[id],
        user_id: user_id,
      }
      return {
        ...i,
        sendMsg: this.sendFriendMsg.bind(this, i),
        getAvatarUrl() {
          return `https://q.qlogo.cn/g?b=qq&s=0&nk=${user_id}`
        },
      }
    }

    pickMember(id, group_id, user_id) {
      const i = {
        ...Bot[id].fl.get(user_id),
        self_id: id,
        bot: Bot[id],
        user_id: user_id,
        group_id: group_id,
      }
      return {
        ...this.pickFriend(id, user_id),
        ...i,
        sendMsg: this.sendMemberMsg.bind(this, i),
      }
    }

    pickGroup(id, group_id) {
      const i = {
        ...Bot[id].gl.get(group_id),
        self_id: id,
        bot: Bot[id],
        group_id: group_id,
      }
      return {
        ...i,
        sendMsg: this.sendGroupMsg.bind(this, i),
        pickMember: this.pickMember(this, id, group_id),
        getAvatarUrl() {
          return `https://p.qlogo.cn/gh/${group_id}/${group_id}/0`
        },
      }
    }

    makeMessage(id, event) {
      const data = {
        event,
        bot: Bot[id],
        self_id: id,
        post_type: "message",
        message_id: event.MsgHead.MsgUid,
        seq: event.MsgHead.MsgSeq,
        time: event.MsgHead.MsgTime,
        user_id: event.MsgHead.SenderUin,
        sender: {
          user_id: event.MsgHead.SenderUin,
          nickname: event.MsgHead.SenderNick,
        },
        message: [],
        raw_message: "",
      }

      if (event.MsgBody.AtUinLists)
        for (const i of event.MsgBody.AtUinLists) {
          data.message.push({
            type: "at",
            qq: i.Uin,
            data: i,
          })
          data.raw_message += `[提及：${i.Uin}]`
        }

      if (event.MsgBody.Content) {
        data.message.push({
          type: "text",
          text: event.MsgBody.Content,
        })
        data.raw_message += event.MsgBody.Content
      }

      if (event.MsgBody.Images)
        for (const i of event.MsgBody.Images) {
          data.message.push({
            type: "image",
            url: i.Url,
            data: i,
          })
          data.raw_message += `[图片：${i.Url}]`
        }

      return data
    }

    makeFriendMessage(id, data) {
      if (!data.MsgBody) return
      data = this.makeMessage(id, data)
      data.message_type = "private"

      if (!Bot[id].fl.has(data.user_id)) Bot[id].fl.set(data.user_id, data.sender)

      Bot.makeLog(
        "info",
        `好友消息：[${data.sender.nickname}] ${data.raw_message}`,
        `${data.self_id} <= ${data.user_id}`,
        true,
      )
      Bot.em(`${data.post_type}.${data.message_type}`, data)
    }

    makeGroupMessage(id, data) {
      if (!data.MsgBody) return
      data = this.makeMessage(id, data)
      data.message_type = "group"
      data.sender.card = data.event.MsgHead.GroupInfo.GroupCard
      data.group_id = data.event.MsgHead.GroupInfo.GroupCode
      data.group_name = data.event.MsgHead.GroupInfo.GroupName

      if (!Bot[id].gl.has(data.group_id))
        Bot[id].gl.set(data.group_id, { group_id: data.group_id, group_name: data.group_name })
      let gml = Bot[id].gml.get(data.group_id)
      if (!gml) {
        gml = new Map()
        Bot[id].gml.set(data.group_id, gml)
      }
      if (!gml.has(data.user_id)) gml.set(data.user_id, data.sender)

      Bot.makeLog(
        "info",
        `群消息：[${data.group_name}, ${data.sender.nickname}] ${data.raw_message}`,
        `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
        true,
      )
      Bot.em(`${data.post_type}.${data.message_type}`, data)
    }

    makeEvent(id, data) {
      switch (data.EventName) {
        case "ON_EVENT_FRIEND_NEW_MSG":
          this.makeFriendMessage(id, data.EventData)
          break
        case "ON_EVENT_GROUP_NEW_MSG":
          this.makeGroupMessage(id, data.EventData)
          break
        default:
          Bot.makeLog("warn", `未知事件：${logger.magenta(data.raw)}`, id)
      }
    }

    makeBot(id, ws) {
      Bot[id] = {
        adapter: this,
        ws,

        uin: id,
        info: { id },
        get nickname() {
          return this.info.nickname
        },
        get avatar() {
          return `https://q.qlogo.cn/g?b=qq&s=0&nk=${this.uin}`
        },

        version: {
          id: this.id,
          name: this.name,
          version: this.version,
        },
        stat: { start_time: Date.now() / 1000 },

        pickFriend: this.pickFriend.bind(this, id),
        get pickUser() {
          return this.pickFriend
        },
        getFriendMap() {
          return this.fl
        },
        fl: new Map(),

        pickMember: this.pickMember.bind(this, id),
        pickGroup: this.pickGroup.bind(this, id),
        getGroupMap() {
          return this.gl
        },
        gl: new Map(),
        gml: new Map(),
      }

      Bot.makeLog("mark", `${this.name}(${this.id}) ${this.version} 已连接`, id)
      Bot.em(`connect.${id}`, { self_id: id })
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

      const id = data.CurrentQQ
      if (id && data.CurrentPacket) {
        if (Bot[id]) Bot[id].ws = ws
        else this.makeBot(id, ws)

        return this.makeEvent(id, data.CurrentPacket)
      } else if (data.ReqId) {
        const cache = this.echo.get(data.ReqId)
        if (cache) return cache.resolve(data)
      }
      Bot.makeLog("warn", `未知消息：${logger.magenta(data.raw)}`, id)
    }

    load() {
      if (!Array.isArray(Bot.wsf[this.path])) Bot.wsf[this.path] = []
      Bot.wsf[this.path].push((ws, ...args) =>
        ws.on("message", data => this.message(data, ws, ...args)),
      )
    }
  })(),
)
