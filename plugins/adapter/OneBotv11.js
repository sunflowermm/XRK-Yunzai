import cfg from "../../lib/config/config.js";
import path from "node:path";
import { ulid } from "ulid";

/**
 * 超时值验证工具
 * 确保所有setTimeout/setInterval使用的值在安全范围内
 */
class TimeoutValidator {
  static MAX_TIMEOUT = 2147483647; // 2^31-1，Node.js最大超时值
  static DEFAULT_TIMEOUT = 60000;   // 默认60秒
  static MIN_TIMEOUT = 0;            // 最小值

  /**
   * 验证并修正超时值
   * @param {number} value - 原始超时值
   * @param {number} defaultValue - 默认值
   * @param {string} context - 上下文描述（用于日志）
   * @returns {number} 安全的超时值
   */
  static validate(value, defaultValue = this.DEFAULT_TIMEOUT, context = '') {
    // 类型检查
    if (typeof value !== 'number' || isNaN(value)) {
      if (context) {
        Bot.makeLog("warn", `超时值非法 [${context}]: ${value}, 使用默认值 ${defaultValue}ms`);
      }
      return defaultValue;
    }

    // 范围检查
    if (value < this.MIN_TIMEOUT) {
      if (context) {
        Bot.makeLog("warn", `超时值过小 [${context}]: ${value}ms, 使用最小值 ${this.MIN_TIMEOUT}ms`);
      }
      return this.MIN_TIMEOUT;
    }

    if (value > this.MAX_TIMEOUT) {
      if (context) {
        Bot.makeLog("warn", `超时值过大 [${context}]: ${value}ms, 使用最大值 ${this.MAX_TIMEOUT}ms`);
      }
      return this.MAX_TIMEOUT;
    }

    return Math.floor(value);
  }

  /**
   * 创建安全的setTimeout
   * @param {Function} callback - 回调函数
   * @param {number} delay - 延时
   * @param {string} context - 上下文描述
   * @returns {NodeJS.Timeout} 定时器ID
   */
  static setTimeout(callback, delay, context = '') {
    const safeDelay = this.validate(delay, this.DEFAULT_TIMEOUT, context);
    return setTimeout(callback, safeDelay);
  }

  /**
   * 创建安全的setInterval
   * @param {Function} callback - 回调函数
   * @param {number} interval - 间隔
   * @param {string} context - 上下文描述
   * @returns {NodeJS.Timeout} 定时器ID
   */
  static setInterval(callback, interval, context = '') {
    const safeInterval = this.validate(interval, this.DEFAULT_TIMEOUT, context);
    return setInterval(callback, safeInterval);
  }
}

/**
 * OneBotv11适配器
 * 实现OneBot v11协议的适配器
 */
Bot.adapter.push(
  new (class OneBotv11Adapter {
    // 适配器标识
    id = "QQ";
    name = "OneBotv11";
    path = this.name;
    
    // 请求管理
    echo = new Map();        // 存储待响应的请求
    timeout = 60000;         // 默认超时时间（60秒）
    
    // 请求计数和限制
    requestCount = 0;
    maxConcurrentRequests = 100;  // 最大并发请求数
    requestQueue = [];             // 请求队列

    /**
     * 日志处理 - 隐藏base64内容
     * @param {*} msg - 消息内容
     * @returns {string} 处理后的消息
     */
    makeLog(msg) {
      return Bot.String(msg).replace(/base64:\/\/.*?(,|]|")/g, "base64://...$1");
    }

    /**
     * 发送API请求到OneBot实现
     * @param {Object} data - 数据对象
     * @param {WebSocket} ws - WebSocket连接
     * @param {string} action - API动作
     * @param {Object} params - 参数
     * @returns {Promise<Object>} API响应
     */
    async sendApi(data, ws, action, params = {}) {
      // 生成唯一请求ID
      const echo = ulid();
      const request = { action, params, echo };
      
      // 发送请求
      ws.sendMsg(request);
      
      // 创建Promise解析器
      const cache = Promise.withResolvers();
      this.echo.set(echo, cache);
      
      // 设置超时处理（修复：使用安全的超时值）
      const safeTimeout = TimeoutValidator.validate(this.timeout, 60000, 'sendApi');
      const timeout = TimeoutValidator.setTimeout(() => {
        cache.reject(Bot.makeError("请求超时", request, { timeout: safeTimeout }));
        Bot.makeLog("error", ["请求超时", request], data.self_id);
        ws.terminate();
        this.echo.delete(echo);
      }, safeTimeout, 'sendApi timeout');

      return cache.promise
        .then(data => {
          // 检查返回码
          if (data.retcode !== 0 && data.retcode !== 1) {
            throw Bot.makeError(data.msg || data.wording, request, { error: data });
          }
          
          // 返回代理对象以便访问data属性
          return data.data
            ? new Proxy(data, {
                get: (target, prop) => target.data[prop] ?? target[prop],
              })
            : data;
        })
        .finally(() => {
          clearTimeout(timeout);
          this.echo.delete(echo);
        });
    }

    /**
     * 处理文件内容，转换为base64格式
     * @param {*} file - 文件内容
     * @param {Object} opts - 选项
     * @returns {Promise<string>} base64字符串或URL
     */
    async makeFile(file, opts) {
      file = await Bot.Buffer(file, {
        http: true,
        size: 10485760,  // 10MB限制
        ...opts,
      });
      
      if (Buffer.isBuffer(file)) {
        return `base64://${file.toString("base64")}`;
      }
      
      return file;
    }

    /**
     * 构造消息数组
     * @param {*} msg - 消息内容
     * @returns {Promise<Array>} [消息数组, 转发消息数组]
     */
    async makeMsg(msg) {
      if (!Array.isArray(msg)) msg = [msg];
      
      const msgs = [];
      const forward = [];
      
      for (let i of msg) {
        // 标准化消息格式
        if (typeof i !== "object") {
          i = { type: "text", data: { text: String(i) } };
        } else if (!i.data) {
          i = { type: i.type, data: { ...i, type: undefined } };
        }

        // 处理不同消息类型
        switch (i.type) {
          case "at":
            i.data.qq = String(i.data.qq);
            break;
          case "reply":
            i.data.id = String(i.data.id);
            break;
          case "button":
            continue;  // 跳过按钮类型
          case "node":
            forward.push(...(Array.isArray(i.data) ? i.data : [i.data]));
            continue;
          case "raw":
            i = i.data;
            break;
        }

        // 处理文件类型
        if (i.data?.file) {
          i.data.file = await this.makeFile(i.data.file);
        }

        msgs.push(i);
      }
      
      return [msgs, forward];
    }

    /**
     * 发送消息
     * @param {*} msg - 消息内容
     * @param {Function} send - 发送函数
     * @param {Function} sendForwardMsg - 发送转发消息函数
     * @returns {Promise<Object>} 发送结果
     */
    async sendMsg(msg, send, sendForwardMsg) {
      const [message, forward] = await this.makeMsg(msg);
      const ret = [];

      // 发送转发消息
      if (forward.length) {
        try {
          const data = await sendForwardMsg(forward);
          if (Array.isArray(data)) ret.push(...data);
          else ret.push(data);
        } catch (err) {
          Bot.makeLog("error", ["发送转发消息失败", err]);
        }
      }

      // 发送普通消息
      if (message.length) {
        try {
          ret.push(await send(message));
        } catch (err) {
          Bot.makeLog("error", ["发送消息失败", err]);
        }
      }
      
      // 返回结果处理
      if (ret.length === 1) return ret[0];

      const message_id = [];
      for (const i of ret) {
        if (i?.message_id) message_id.push(i.message_id);
      }
      return { data: ret, message_id };
    }

    /**
     * 发送好友消息
     */
    sendFriendMsg(data, msg) {
      return this.sendMsg(
        msg,
        message => {
          Bot.makeLog(
            "info",
            `发送好友消息：${this.makeLog(message)}`,
            `${data.self_id} => ${data.user_id}`,
            true
          );
          return data.bot.sendApi("send_msg", {
            user_id: data.user_id,
            message,
          });
        },
        msg => this.sendFriendForwardMsg(data, msg)
      );
    }

    /**
     * 发送群消息
     */
    sendGroupMsg(data, msg) {
      return this.sendMsg(
        msg,
        message => {
          Bot.makeLog(
            "info",
            `发送群消息：${this.makeLog(message)}`,
            `${data.self_id} => ${data.group_id}`,
            true
          );
          return data.bot.sendApi("send_msg", {
            group_id: data.group_id,
            message,
          });
        },
        msg => this.sendGroupForwardMsg(data, msg)
      );
    }

    /**
     * 发送频道消息
     */
    sendGuildMsg(data, msg) {
      return this.sendMsg(
        msg,
        message => {
          Bot.makeLog(
            "info",
            `发送频道消息：${this.makeLog(message)}`,
            `${data.self_id} => ${data.guild_id}-${data.channel_id}`,
            true
          );
          return data.bot.sendApi("send_guild_channel_msg", {
            guild_id: data.guild_id,
            channel_id: data.channel_id,
            message,
          });
        },
        msg => Bot.sendForwardMsg(msg => this.sendGuildMsg(data, msg), msg)
      );
    }

    /**
     * 撤回消息
     */
    async recallMsg(data, message_id) {
      Bot.makeLog("info", `撤回消息：${message_id}`, data.self_id);
      
      if (!Array.isArray(message_id)) message_id = [message_id];
      
      const msgs = [];
      for (const i of message_id) {
        try {
          msgs.push(await data.bot.sendApi("delete_msg", { message_id: i }));
        } catch (err) {
          msgs.push(err);
        }
      }
      return msgs;
    }

    /**
     * 解析消息格式
     */
    parseMsg(msg) {
      const array = [];
      for (const i of Array.isArray(msg) ? msg : [msg]) {
        if (typeof i === "object") {
          array.push({ ...i.data, type: i.type });
        } else {
          array.push({ type: "text", text: String(i) });
        }
      }
      return array;
    }

    /**
     * 获取消息详情
     */
    async getMsg(data, message_id) {
      const msg = await data.bot.sendApi("get_msg", { message_id });
      if (msg?.message) {
        msg.message = this.parseMsg(msg.message);
      }
      return msg;
    }

    /**
     * 获取好友消息历史
     */
    async getFriendMsgHistory(data, message_seq, count = 20, reverseOrder = true) {
      try {
        const result = await data.bot.sendApi("get_friend_msg_history", {
          user_id: data.user_id,
          message_seq,
          count,
          reverseOrder,
        });
        const msgs = result?.messages || [];
        
        for (const i of Array.isArray(msgs) ? msgs : [msgs]) {
          if (i?.message) i.message = this.parseMsg(i.message);
        }
        return msgs;
      } catch (err) {
        Bot.makeLog("error", ["获取好友消息历史失败", err]);
        return [];
      }
    }

    /**
     * 获取群消息历史
     */
    async getGroupMsgHistory(data, message_seq, count = 20, reverseOrder = true) {
      try {
        const result = await data.bot.sendApi("get_group_msg_history", {
          group_id: data.group_id,
          message_seq,
          count,
          reverseOrder,
        });
        const msgs = result?.messages || [];
        
        for (const i of Array.isArray(msgs) ? msgs : [msgs]) {
          if (i?.message) i.message = this.parseMsg(i.message);
        }
        return msgs;
      } catch (err) {
        Bot.makeLog("error", ["获取群消息历史失败", err]);
        return [];
      }
    }

    /**
     * 获取转发消息内容
     */
    async getForwardMsg(data, message_id) {
      try {
        const result = await data.bot.sendApi("get_forward_msg", { message_id });
        const msgs = result?.messages || [];
        
        for (const i of Array.isArray(msgs) ? msgs : [msgs]) {
          if (i?.message) i.message = this.parseMsg(i.message || i.content);
        }
        return msgs;
      } catch (err) {
        Bot.makeLog("error", ["获取转发消息失败", err]);
        return [];
      }
    }

    /**
     * 构造转发消息节点
     */
    async makeForwardMsg(msg) {
      const msgs = [];
      for (const i of msg) {
        const [content, forward] = await this.makeMsg(i.message);
        
        if (forward.length) {
          msgs.push(...(await this.makeForwardMsg(forward)));
        }
        
        if (content.length) {
          msgs.push({
            type: "node",
            data: {
              name: i.nickname || "匿名消息",
              uin: String(Number(i.user_id) || 80000000),
              content,
              time: i.time,
            },
          });
        }
      }
      return msgs;
    }

    /**
     * 发送好友转发消息
     */
    async sendFriendForwardMsg(data, msg) {
      Bot.makeLog(
        "info",
        `发送好友转发消息：${this.makeLog(msg)}`,
        `${data.self_id} => ${data.user_id}`,
        true
      );
      return data.bot.sendApi("send_private_forward_msg", {
        user_id: data.user_id,
        messages: await this.makeForwardMsg(msg),
      });
    }

    /**
     * 发送群转发消息
     */
    async sendGroupForwardMsg(data, msg) {
      Bot.makeLog(
        "info",
        `发送群转发消息：${this.makeLog(msg)}`,
        `${data.self_id} => ${data.group_id}`,
        true
      );
      return data.bot.sendApi("send_group_forward_msg", {
        group_id: data.group_id,
        messages: await this.makeForwardMsg(msg),
      });
    }

    // 好友相关API
    async getFriendArray(data) {
      try {
        const result = await data.bot.sendApi("get_friend_list");
        return result || [];
      } catch (err) {
        Bot.makeLog("error", ["获取好友列表失败", err]);
        return [];
      }
    }

    async getFriendList(data) {
      const array = [];
      for (const { user_id } of await this.getFriendArray(data)) {
        array.push(user_id);
      }
      return array;
    }

    async getFriendMap(data) {
      const map = new Map();
      for (const i of await this.getFriendArray(data)) {
        map.set(i.user_id, i);
      }
      data.bot.fl = map;
      return map;
    }

    async getFriendInfo(data) {
      try {
        const info = await data.bot.sendApi("get_stranger_info", {
          user_id: data.user_id,
        });
        data.bot.fl.set(data.user_id, info);
        return info;
      } catch (err) {
        Bot.makeLog("error", ["获取好友信息失败", err]);
        return {};
      }
    }

    // 群组相关API
    async getGroupArray(data) {
      try {
        const array = await data.bot.sendApi("get_group_list") || [];
        
        // 尝试获取频道列表
        try {
          for (const guild of await this.getGuildArray(data)) {
            for (const channel of await this.getGuildChannelArray({
              ...data,
              guild_id: guild.guild_id,
            })) {
              array.push({
                guild,
                channel,
                group_id: `${guild.guild_id}-${channel.channel_id}`,
                group_name: `${guild.guild_name}-${channel.channel_name}`,
              });
            }
          }
        } catch (err) {
          // 静默处理频道列表获取失败
        }
        
        return array;
      } catch (err) {
        Bot.makeLog("error", ["获取群列表失败", err]);
        return [];
      }
    }

    async getGroupList(data) {
      const array = [];
      for (const { group_id } of await this.getGroupArray(data)) {
        array.push(group_id);
      }
      return array;
    }

    async getGroupMap(data) {
      const map = new Map();
      for (const i of await this.getGroupArray(data)) {
        map.set(i.group_id, i);
      }
      data.bot.gl = map;
      return map;
    }

    async getGroupInfo(data) {
      try {
        const info = await data.bot.sendApi("get_group_info", {
          group_id: data.group_id,
        });
        data.bot.gl.set(data.group_id, info);
        return info;
      } catch (err) {
        Bot.makeLog("error", ["获取群信息失败", err]);
        return {};
      }
    }

    // 群成员相关API
    async getMemberArray(data) {
      try {
        const result = await data.bot.sendApi("get_group_member_list", {
          group_id: data.group_id,
        });
        return result || [];
      } catch (err) {
        Bot.makeLog("error", ["获取群成员列表失败", err]);
        return [];
      }
    }

    async getMemberList(data) {
      const array = [];
      for (const { user_id } of await this.getMemberArray(data)) {
        array.push(user_id);
      }
      return array;
    }

    async getMemberMap(data) {
      const map = new Map();
      for (const i of await this.getMemberArray(data)) {
        map.set(i.user_id, i);
      }
      data.bot.gml.set(data.group_id, map);
      return map;
    }

    async getGroupMemberMap(data) {
      if (!cfg.bot.cache_group_member) return this.getGroupMap(data);
      
      for (const [group_id, group] of await this.getGroupMap(data)) {
        if (group.guild) continue;
        await this.getMemberMap({ ...data, group_id });
      }
    }

    async getMemberInfo(data) {
      try {
        const info = await data.bot.sendApi("get_group_member_info", {
          group_id: data.group_id,
          user_id: data.user_id,
        });
        
        let gml = data.bot.gml.get(data.group_id);
        if (!gml) {
          gml = new Map();
          data.bot.gml.set(data.group_id, gml);
        }
        gml.set(data.user_id, info);
        return info;
      } catch (err) {
        Bot.makeLog("error", ["获取群成员信息失败", err]);
        return {};
      }
    }

    // 群管理相关API
    setGroupName(data, group_name) {
      Bot.makeLog("info", `设置群名：${group_name}`, `${data.self_id} => ${data.group_id}`, true);
      return data.bot.sendApi("set_group_name", {
        group_id: data.group_id,
        group_name,
      });
    }

    async setGroupAvatar(data, file) {
      Bot.makeLog("info", `设置群头像：${file}`, `${data.self_id} => ${data.group_id}`, true);
      return data.bot.sendApi("set_group_portrait", {
        group_id: data.group_id,
        file: await this.makeFile(file),
      });
    }

    setGroupAdmin(data, user_id, enable) {
      Bot.makeLog(
        "info",
        `${enable ? "设置" : "取消"}群管理员：${user_id}`,
        `${data.self_id} => ${data.group_id}`,
        true
      );
      return data.bot.sendApi("set_group_admin", {
        group_id: data.group_id,
        user_id,
        enable,
      });
    }

    setGroupCard(data, user_id, card) {
      Bot.makeLog(
        "info",
        `设置群名片：${card}`,
        `${data.self_id} => ${data.group_id}, ${user_id}`,
        true
      );
      return data.bot.sendApi("set_group_card", {
        group_id: data.group_id,
        user_id,
        card,
      });
    }

    /**
     * 设置群头衔（修复：确保duration在安全范围内）
     */
    setGroupTitle(data, user_id, special_title, duration = -1) {
      // 验证duration值
      const safeDuration = duration === -1 ? -1 : TimeoutValidator.validate(duration, 86400000, 'setGroupTitle');
      
      Bot.makeLog(
        "info",
        `设置群头衔：${special_title} ${safeDuration}`,
        `${data.self_id} => ${data.group_id}, ${user_id}`,
        true
      );
      return data.bot.sendApi("set_group_special_title", {
        group_id: data.group_id,
        user_id,
        special_title,
        duration: safeDuration,
      });
    }

    /**
     * 设置群禁言（修复：确保duration在安全范围内）
     */
    setGroupBan(data, user_id, duration = 600) {
      // 验证duration值（最大30天）
      const MAX_BAN_DURATION = 2592000; // 30天（秒）
      const safeDuration = Math.min(Math.max(0, duration), MAX_BAN_DURATION);
      
      Bot.makeLog(
        "info",
        `禁言群成员：${safeDuration}秒`,
        `${data.self_id} => ${data.group_id}, ${user_id}`,
        true
      );
      return data.bot.sendApi("set_group_ban", {
        group_id: data.group_id,
        user_id,
        duration: safeDuration,
      });
    }

    setGroupWholeKick(data, enable) {
      Bot.makeLog(
        "info",
        `${enable ? "开启" : "关闭"}全员禁言`,
        `${data.self_id} => ${data.group_id}`,
        true
      );
      return data.bot.sendApi("set_group_whole_ban", {
        group_id: data.group_id,
        enable,
      });
    }

    setGroupKick(data, user_id, reject_add_request = false) {
      Bot.makeLog(
        "info",
        `踢出群成员${reject_add_request ? "拒绝再次加群" : ""}`,
        `${data.self_id} => ${data.group_id}, ${user_id}`,
        true
      );
      return data.bot.sendApi("set_group_kick", {
        group_id: data.group_id,
        user_id,
        reject_add_request,
      });
    }

    setGroupLeave(data, is_dismiss = false) {
      Bot.makeLog("info", is_dismiss ? "解散" : "退群", `${data.self_id} => ${data.group_id}`, true);
      return data.bot.sendApi("set_group_leave", {
        group_id: data.group_id,
        is_dismiss,
      });
    }

    sendGroupSign(data) {
      Bot.makeLog("info", "群打卡", `${data.self_id} => ${data.group_id}`, true);
      return data.bot.sendApi("send_group_sign", {
        group_id: data.group_id,
      });
    }

    // 个人信息相关API
    setProfile(data, profile) {
      Bot.makeLog("info", `设置资料：${Bot.String(profile)}`, data.self_id);
      return data.bot.sendApi("set_qq_profile", profile);
    }

    async setAvatar(data, file) {
      Bot.makeLog("info", `设置头像：${file}`, data.self_id);
      return data.bot.sendApi("set_qq_avatar", {
        file: await this.makeFile(file),
      });
    }

    sendLike(data, times) {
      Bot.makeLog("info", `点赞：${times}次`, `${data.self_id} => ${data.user_id}`, true);
      return data.bot.sendApi("send_like", {
        user_id: data.user_id,
        times,
      });
    }

    // 文件相关API
    async sendGroupFile(data, file, folder = "", name = path.basename(file)) {
      Bot.makeLog(
        "info",
        `发送群文件：${folder || ""}/${name}(${file})`,
        `${data.self_id} => ${data.group_id}`,
        true
      );
      return data.bot.sendApi("upload_group_file", {
        group_id: data.group_id,
        folder,
        file: (await this.makeFile(file, { file: true })).replace("file://", ""),
        name,
      });
    }

    async sendFriendFile(data, file, name = path.basename(file)) {
      Bot.makeLog(
        "info",
        `发送好友文件：${name}(${file})`,
        `${data.self_id} => ${data.user_id}`,
        true
      );
      return data.bot.sendApi("upload_private_file", {
        user_id: data.user_id,
        file: (await this.makeFile(file, { file: true })).replace("file://", ""),
        name,
      });
    }

    // 创建对象方法
    pickFriend(data, user_id) {
      const i = {
        ...data.bot.fl.get(user_id),
        ...data,
        user_id,
      };
      return {
        ...i,
        sendMsg: this.sendFriendMsg.bind(this, i),
        getMsg: this.getMsg.bind(this, i),
        recallMsg: this.recallMsg.bind(this, i),
        getForwardMsg: this.getForwardMsg.bind(this, i),
        sendForwardMsg: this.sendFriendForwardMsg.bind(this, i),
        sendFile: this.sendFriendFile.bind(this, i),
        getInfo: this.getFriendInfo.bind(this, i),
        getAvatarUrl() {
          return this.avatar || `https://q.qlogo.cn/g?b=qq&s=0&nk=${user_id}`;
        },
        getChatHistory: this.getFriendMsgHistory.bind(this, i),
        thumbUp: this.sendLike.bind(this, i),
      };
    }

    pickMember(data, group_id, user_id) {
      const i = {
        ...data.bot.gml.get(group_id)?.get(user_id),
        ...data,
        group_id,
        user_id,
      };
      return {
        ...this.pickFriend(i, user_id),
        ...i,
        getInfo: this.getMemberInfo.bind(this, i),
        getAvatarUrl() {
          return this.avatar || `https://q.qlogo.cn/g?b=qq&s=0&nk=${user_id}`;
        },
        poke: () => this.sendGroupMsg(i, { type: "poke", data: { qq: user_id } }),
        mute: (duration = 600) => this.setGroupBan(i, user_id, duration),
        kick: (reject = false) => this.setGroupKick(i, user_id, reject),
        get is_friend() {
          return data.bot.fl.has(user_id);
        },
        get is_owner() {
          return this.role === "owner";
        },
        get is_admin() {
          return this.role === "admin" || this.is_owner;
        },
      };
    }

    pickGroup(data, group_id) {
      const i = {
        ...data.bot.gl.get(group_id),
        ...data,
        group_id,
      };
      return {
        ...i,
        sendMsg: this.sendGroupMsg.bind(this, i),
        getMsg: this.getMsg.bind(this, i),
        recallMsg: this.recallMsg.bind(this, i),
        getForwardMsg: this.getForwardMsg.bind(this, i),
        sendForwardMsg: this.sendGroupForwardMsg.bind(this, i),
        sendFile: (file, name) => this.sendGroupFile(i, file, undefined, name),
        getInfo: this.getGroupInfo.bind(this, i),
        getAvatarUrl() {
          return this.avatar || `https://p.qlogo.cn/gh/${group_id}/${group_id}/0`;
        },
        getChatHistory: this.getGroupMsgHistory.bind(this, i),
        getMemberArray: this.getMemberArray.bind(this, i),
        getMemberList: this.getMemberList.bind(this, i),
        getMemberMap: this.getMemberMap.bind(this, i),
        pickMember: (user_id) => this.pickMember(i, group_id, user_id),
        pokeMember: (qq) => this.sendGroupMsg(i, { type: "poke", data: { qq } }),
        setName: (name) => this.setGroupName(i, name),
        setAvatar: (file) => this.setGroupAvatar(i, file),
        setAdmin: (user_id, enable) => this.setGroupAdmin(i, user_id, enable),
        setCard: (user_id, card) => this.setGroupCard(i, user_id, card),
        setTitle: (user_id, title, duration) => this.setGroupTitle(i, user_id, title, duration),
        sign: () => this.sendGroupSign(i),
        muteMember: (user_id, duration) => this.setGroupBan(i, user_id, duration),
        muteAll: (enable) => this.setGroupWholeKick(i, enable),
        kickMember: (user_id, reject) => this.setGroupKick(i, user_id, reject),
        quit: () => this.setGroupLeave(i, false),
        get is_owner() {
          return data.bot.gml.get(group_id)?.get(data.self_id)?.role === "owner";
        },
        get is_admin() {
          const role = data.bot.gml.get(group_id)?.get(data.self_id)?.role;
          return role === "admin" || this.is_owner;
        },
      };
    }

    /**
     * 建立连接
     * @param {Object} data - 连接数据
     * @param {WebSocket} ws - WebSocket连接
     */
    async connect(data, ws) {
      // 创建Bot实例
      Bot[data.self_id] = {
        adapter: this,
        ws: ws,
        sendApi: this.sendApi.bind(this, data, ws),
        stat: {
          start_time: data.time,
          stat: {},
          get lost_pkt_cnt() {
            return this.stat.packet_lost || 0;
          },
          get lost_times() {
            return this.stat.lost_times || 0;
          },
          get recv_msg_cnt() {
            return this.stat.message_received || 0;
          },
          get recv_pkt_cnt() {
            return this.stat.packet_received || 0;
          },
          get sent_msg_cnt() {
            return this.stat.message_sent || 0;
          },
          get sent_pkt_cnt() {
            return this.stat.packet_sent || 0;
          },
        },
        model: "TRSS Yunzai",

        info: {},
        get uin() {
          return this.info.user_id;
        },
        get nickname() {
          return this.info.nickname;
        },
        get avatar() {
          return `https://q.qlogo.cn/g?b=qq&s=0&nk=${this.uin}`;
        },

        setProfile: this.setProfile.bind(this, data),
        setNickname: (nickname) => this.setProfile(data, { nickname }),
        setAvatar: this.setAvatar.bind(this, data),

        pickFriend: this.pickFriend.bind(this, data),
        get pickUser() {
          return this.pickFriend;
        },
        getFriendArray: this.getFriendArray.bind(this, data),
        getFriendList: this.getFriendList.bind(this, data),
        getFriendMap: this.getFriendMap.bind(this, data),
        fl: new Map(),

        pickMember: this.pickMember.bind(this, data),
        pickGroup: this.pickGroup.bind(this, data),
        getGroupArray: this.getGroupArray.bind(this, data),
        getGroupList: this.getGroupList.bind(this, data),
        getGroupMap: this.getGroupMap.bind(this, data),
        getGroupMemberMap: this.getGroupMemberMap.bind(this, data),
        gl: new Map(),
        gml: new Map(),

        request_list: [],
        getSystemMsg() {
          return this.request_list;
        },
      };
      
      data.bot = Bot[data.self_id];

      // 添加到UIN列表
      if (!Bot.uin.includes(data.self_id)) {
        Bot.uin.push(data.self_id);
      }

      // 初始化Bot信息
      try {
        // 获取登录信息
        data.bot.info = await data.bot.sendApi("get_login_info");
        
        // 获取版本信息
        data.bot.version = await data.bot.sendApi("get_version_info");
        data.bot.version = {
          ...data.bot.version,
          id: this.id,
          name: this.name,
          get version() {
            return this.app_full_name || `${this.app_name} v${this.app_version}`;
          },
        };
      } catch (err) {
        Bot.makeLog("error", ["初始化Bot信息失败", err]);
      }

      // 异步加载好友和群组信息
      data.bot.getFriendMap().catch(() => {});
      data.bot.getGroupMemberMap().catch(() => {});

      Bot.makeLog(
        "mark",
        `${this.name}(${this.id}) ${data.bot.version.version} 已连接`,
        data.self_id
      );
      
      Bot.em(`connect.${data.self_id}`, data);
    }

    /**
     * 处理消息事件
     */
    makeMessage(data) {
      data.message = this.parseMsg(data.message);
      
      switch (data.message_type) {
        case "private": {
          const name = data.sender?.card || 
                      data.sender?.nickname || 
                      data.bot.fl.get(data.user_id)?.nickname;
          Bot.makeLog(
            "info",
            `好友消息：${name ? `[${name}] ` : ""}${data.raw_message}`,
            `${data.self_id} <= ${data.user_id}`,
            true
          );
          break;
        }
        case "group": {
          const group_name = data.group_name || data.bot.gl.get(data.group_id)?.group_name;
          let user_name = data.sender?.card || data.sender?.nickname;
          if (!user_name) {
            const user = data.bot.gml.get(data.group_id)?.get(data.user_id) || 
                        data.bot.fl.get(data.user_id);
            if (user) user_name = user?.card || user?.nickname;
          }
          Bot.makeLog(
            "info",
            `群消息：${user_name ? `[${group_name ? `${group_name}, ` : ""}${user_name}] ` : ""}${data.raw_message}`,
            `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
            true
          );
          break;
        }
        case "guild":
          data.message_type = "group";
          data.group_id = `${data.guild_id}-${data.channel_id}`;
          Bot.makeLog(
            "info",
            `频道消息：[${data.sender?.nickname}] ${Bot.String(data.message)}`,
            `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
            true
          );
          break;
        default:
          Bot.makeLog("warn", `未知消息：${logger.magenta(data.raw)}`, data.self_id);
      }

      Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data);
    }

    /**
     * 处理通知事件
     */
    async makeNotice(data) {
      switch (data.notice_type) {
        case "friend_recall":
          Bot.makeLog(
            "info",
            `好友消息撤回：${data.message_id}`,
            `${data.self_id} <= ${data.user_id}`,
            true
          );
          break;
        case "group_recall":
          Bot.makeLog(
            "info",
            `群消息撤回：${data.operator_id} => ${data.user_id} ${data.message_id}`,
            `${data.self_id} <= ${data.group_id}`,
            true
          );
          break;
        case "group_increase":
          Bot.makeLog(
            "info",
            `群成员增加：${data.operator_id} => ${data.user_id} ${data.sub_type}`,
            `${data.self_id} <= ${data.group_id}`,
            true
          );
          const group = data.bot.pickGroup(data.group_id);
          group.getInfo().catch(() => {});
          if (data.user_id === data.self_id && cfg.bot.cache_group_member) {
            group.getMemberMap().catch(() => {});
          } else {
            group.pickMember(data.user_id).getInfo().catch(() => {});
          }
          break;
        case "group_decrease":
          Bot.makeLog(
            "info",
            `群成员减少：${data.operator_id} => ${data.user_id} ${data.sub_type}`,
            `${data.self_id} <= ${data.group_id}`,
            true
          );
          if (data.user_id === data.self_id) {
            data.bot.gl.delete(data.group_id);
            data.bot.gml.delete(data.group_id);
          } else {
            data.bot.pickGroup(data.group_id).getInfo().catch(() => {});
            data.bot.gml.get(data.group_id)?.delete(data.user_id);
          }
          break;
        case "group_admin":
          Bot.makeLog(
            "info",
            `群管理员变动：${data.sub_type}`,
            `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
            true
          );
          data.set = data.sub_type === "set";
          data.bot.pickMember(data.group_id, data.user_id).getInfo().catch(() => {});
          break;
        case "group_ban":
          Bot.makeLog(
            "info",
            `群禁言：${data.operator_id} => ${data.user_id} ${data.sub_type} ${data.duration}秒`,
            `${data.self_id} <= ${data.group_id}`,
            true
          );
          data.bot.pickMember(data.group_id, data.user_id).getInfo().catch(() => {});
          break;
        default:
          Bot.makeLog("warn", `未知通知：${logger.magenta(data.raw)}`, data.self_id);
      }

      let notice = data.notice_type.split("_");
      data.notice_type = notice.shift();
      notice = notice.join("_");
      if (notice) data.sub_type = notice;

      Bot.em(`${data.post_type}.${data.notice_type}.${data.sub_type}`, data);
    }

    /**
     * 处理请求事件
     */
    makeRequest(data) {
      switch (data.request_type) {
        case "friend":
          Bot.makeLog(
            "info",
            `加好友请求：${data.comment}(${data.flag})`,
            `${data.self_id} <= ${data.user_id}`,
            true
          );
          data.sub_type = "add";
          data.approve = function (approve = true, remark = "") {
            return this.bot.setFriendAddRequest(this.flag, approve, remark);
          };
          break;
        case "group":
          Bot.makeLog(
            "info",
            `加群请求：${data.sub_type} ${data.comment}(${data.flag})`,
            `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
            true
          );
          data.approve = function (approve = true, reason = "") {
            return this.bot.setGroupAddRequest(this.flag, approve, reason, this.sub_type);
          };
          break;
        default:
          Bot.makeLog("warn", `未知请求：${logger.magenta(data.raw)}`, data.self_id);
      }

      data.bot.request_list.push(data);
      Bot.em(`${data.post_type}.${data.request_type}.${data.sub_type}`, data);
    }

    /**
     * 处理心跳
     */
    heartbeat(data) {
      if (data.status) {
        Object.assign(data.bot.stat, data.status);
      }
    }

    /**
     * 处理元事件
     */
    makeMeta(data, ws) {
      switch (data.meta_event_type) {
        case "heartbeat":
          this.heartbeat(data);
          break;
        case "lifecycle":
          this.connect(data, ws);
          break;
        default:
          Bot.makeLog("warn", `未知元事件：${logger.magenta(data.raw)}`, data.self_id);
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
        };
      } catch (err) {
        return Bot.makeLog("error", ["解码数据失败", data, err]);
      }

      if (data.post_type) {
        if (data.meta_event_type !== "lifecycle" && !Bot.uin.includes(data.self_id)) {
          Bot.makeLog("warn", `找不到对应Bot，忽略消息：${logger.magenta(data.raw)}`, data.self_id);
          return false;
        }
        data.bot = Bot[data.self_id];

        switch (data.post_type) {
          case "meta_event":
            return this.makeMeta(data, ws);
          case "message":
            return this.makeMessage(data);
          case "notice":
            return this.makeNotice(data);
          case "request":
            return this.makeRequest(data);
          case "message_sent":
            data.post_type = "message";
            return this.makeMessage(data);
        }
      } else if (data.echo) {
        const cache = this.echo.get(data.echo);
        if (cache) return cache.resolve(data);
      }
      
      Bot.makeLog("warn", `未知消息：${logger.magenta(data.raw)}`, data.self_id);
    }

    /**
     * 加载适配器
     */
    load() {
      if (!Array.isArray(Bot.wsf[this.path])) {
        Bot.wsf[this.path] = [];
      }
      Bot.wsf[this.path].push((ws, ...args) =>
        ws.on("message", data => this.message(data, ws, ...args))
      );
    }
  })()
);