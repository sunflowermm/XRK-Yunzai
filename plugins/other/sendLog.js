import fs from "node:fs/promises"
import path from "node:path"
import lodash from "lodash"
import moment from "moment"

export class sendLog extends plugin {
  constructor() {
    super({
      name: "发送日志",
      dsc: "发送最近运行日志",
      event: "message",
      priority: -Infinity,
      rule: [
        {
          reg: "^#(运行|错误|追踪)?日志(\\d+)?(.*)?$",
          fnc: "sendLog",
          permission: "master",
        }
      ],
    })

    this.lineNum = 100  // 默认显示行数
    this.maxNum = 1000  // 最大显示行数
    this.logDir = "logs"
  }

  async sendLog() {
    try {
      // 解析命令参数
      const match = this.e.msg.match(/^#(运行|错误|追踪)?日志(\d+)?(.*)$/)
      const logType = match[1] || "运行"
      const lineNum = match[2] ? parseInt(match[2]) : this.lineNum
      const keyWord = match[3] ? match[3].trim() : ""

      // 验证行数
      const finalLineNum = Math.min(lineNum, this.maxNum)
      
      // 确定日志文件
      let logFile
      let type = logType
      
      switch (logType) {
        case "错误":
          logFile = path.join(this.logDir, "error.log")
          break
        case "追踪":
          logFile = path.join(this.logDir, "trace.log")
          break
        default:
          // 运行日志使用当天的日志文件
          logFile = path.join(this.logDir, `command.${moment().format("YYYY-MM-DD")}.log`)
          type = "运行"
      }

      // 检查文件是否存在
      try {
        await fs.access(logFile)
      } catch (err) {
        // 如果当天的运行日志不存在，尝试查找最近的日志文件
        if (type === "运行") {
          const recentFile = await this.findRecentLogFile()
          if (recentFile) {
            logFile = recentFile
          } else {
            // 使用转发消息格式回复错误信息
            return await this.replyError(`暂无${type}日志文件`)
          }
        } else {
          return await this.replyError(`暂无${type}日志文件`)
        }
      }

      // 读取日志
      const log = await this.getLog(logFile, finalLineNum, keyWord)

      if (lodash.isEmpty(log)) {
        const errorMsg = keyWord ? `未找到包含"${keyWord}"的${type}日志` : `暂无${type}日志`
        return await this.replyError(errorMsg)
      }

      // 构建转发消息数据
      const forwardData = await this.buildForwardData(log, type, keyWord, finalLineNum, lineNum, logFile)
      
      // 生成并发送转发消息
      const forwardMsg = await this.makeForwardMsg(this.e, forwardData)
      
      if (forwardMsg) {
        await this.e.reply(forwardMsg)
      } else {
        await this.replyError('生成转发消息失败，日志可能过长')
      }
      
      return true
      
    } catch (error) {
      logger.error(`[sendLog] 发送日志失败: ${error}`)
      await this.replyError('发送日志时发生错误')
      return false
    }
  }

  async getLog(logFile, lineNum = 100, keyWord = "") {
    try {
      let log = await fs.readFile(logFile, "utf8")
      let lines = log.split("\n").filter(line => line.trim())

      // 如果有关键词，过滤包含关键词的行
      if (keyWord) {
        lines = lines.filter(line => line.toLowerCase().includes(keyWord.toLowerCase()))
        // 限制最大数量
        lines = lines.slice(-this.maxNum)
      } else {
        // 获取最后N行
        lines = lines.slice(-lineNum)
      }

      // 反转数组，最新的在前面
      lines = lines.reverse()

      // 清理和格式化
      const cleanedLines = []
      for (let line of lines) {
        if (!line) continue
        // 移除 ANSI 颜色代码
        line = line.replace(/\x1b$$[0-9;]*m/g, "")
        // 移除回车换行
        line = line.replace(/\r|\n/g, "")
        
        // 解析日志级别并添加对应的emoji
        const levelMatch = line.match(/\[(ERROR|WARN|INFO|DEBUG|TRACE|FATAL)$$/i)
        if (levelMatch) {
          const level = levelMatch[1].toUpperCase()
          const levelEmoji = {
            ERROR: "❌",
            WARN: "⚠️",
            INFO: "ℹ️",
            DEBUG: "🔧",
            TRACE: "📝",
            FATAL: "💀"
          }
          line = `${levelEmoji[level] || "•"} ${line}`
        }
        
        cleanedLines.push(line)
      }

      return cleanedLines
    } catch (err) {
      logger.error(`读取日志文件失败: ${logFile}`, err)
      return []
    }
  }

  async findRecentLogFile() {
    try {
      const files = await fs.readdir(this.logDir)
      const commandLogs = files
        .filter(file => file.startsWith("command.") && file.endsWith(".log"))
        .sort()
        .reverse()
      
      if (commandLogs.length > 0) {
        return path.join(this.logDir, commandLogs[0])
      }
      return null
    } catch (err) {
      logger.error("查找最近日志文件失败:", err)
      return null
    }
  }

  /**
   * 构建转发消息数据
   */
  async buildForwardData(logs, type, keyWord, finalLineNum, originalLineNum, logFile) {
    const messages = []
    const timestamp = moment().format("YYYY-MM-DD HH:mm:ss")
    const fileName = path.basename(logFile)
    
    // 消息头 - 标题和统计信息
    const title = keyWord 
      ? `🔍 包含"${keyWord}"的${type}日志`
      : `📋 最近${type}日志`
    
    messages.push({
      message: [
        title,
        "━".repeat(30),
        `📅 查询时间: ${timestamp}`,
        `📁 日志文件: ${fileName}`,
        `📊 显示条数: ${logs.length}条`
      ].join("\n"),
      nickname: "日志系统",
      user_id: Bot.uin
    })

    // 如果有行数调整提醒
    if (originalLineNum > this.maxNum) {
      messages.push({
        message: `⚠️ 行数超过最大限制，已调整为${this.maxNum}行`,
        nickname: "系统提示",
        user_id: Bot.uin
      })
    }

    // 如果有关键词，显示搜索信息
    if (keyWord) {
      messages.push({
        message: `🔍 搜索关键词: "${keyWord}"`,
        nickname: "搜索信息",
        user_id: Bot.uin
      })
    }

    // 分批添加日志内容
    const batchSize = 30 // 每批显示的日志条数
    for (let i = 0; i < logs.length; i += batchSize) {
      const batch = logs.slice(i, Math.min(i + batchSize, logs.length))
      const pageNum = Math.floor(i / batchSize) + 1
      const totalPages = Math.ceil(logs.length / batchSize)
      
      const batchMessage = [
        `📄 第 ${pageNum}/${totalPages} 页 (${i + 1}-${Math.min(i + batchSize, logs.length)} 条)`,
        "─".repeat(25),
        ...batch
      ].join("\n")
      
      messages.push({
        message: batchMessage,
        nickname: `日志内容 [${pageNum}]`,
        user_id: Bot.uin
      })
    }

    // 添加操作提示（作为最后一条消息）
    messages.push({
      message: [
        "━".repeat(30),
        "💡 使用提示:",
        "• #运行日志 - 查看运行日志",
        "• #错误日志 - 查看错误日志",  
        "• #追踪日志 - 查看追踪日志",
        "• #运行日志100 - 指定显示行数",
        "• #运行日志 关键词 - 搜索包含关键词的日志",
        "",
        `📝 当前最大显示行数: ${this.maxNum}行`
      ].join("\n"),
      nickname: "使用说明",
      user_id: Bot.uin
    })

    return messages
  }

  /**
   * 生成转发消息 - 参考制造消息插件的实现
   */
  async makeForwardMsg(e, msgList) {
    try {
      const msgs = []
      
      // 为每条消息添加时间戳，让消息看起来更自然
      const baseTime = Math.floor(Date.now() / 1000)
      
      for (let i = 0; i < msgList.length; i++) {
        const msg = msgList[i]
        msgs.push({
          message: msg.message,
          nickname: msg.nickname || "日志系统",
          user_id: String(msg.user_id || Bot.uin),
          time: msg.time || (baseTime - (msgList.length - i) * 2) // 每条消息间隔2秒
        })
      }
      
      // 根据消息环境创建转发消息
      let forwardMsg
      if (e.group?.makeForwardMsg) {
        forwardMsg = await e.group.makeForwardMsg(msgs)
      } else if (e.friend?.makeForwardMsg) {
        forwardMsg = await e.friend.makeForwardMsg(msgs)
      } else if (e.bot?.makeForwardMsg) {
        forwardMsg = await e.bot.makeForwardMsg(msgs)
      } else if (Bot.makeForwardMsg) {
        forwardMsg = await Bot.makeForwardMsg(msgs)
      } else if (Bot.makeForwardArray) {
        // 兼容旧版本API
        const messages = msgs.map(m => m.message)
        forwardMsg = await Bot.makeForwardArray(messages)
      } else {
        logger.error("[sendLog] 未找到可用的转发消息API")
        return null
      }
      
      return forwardMsg
      
    } catch (error) {
      logger.error(`[sendLog] 制作转发消息失败: ${error}`)
      
      // 如果转发消息失败，尝试返回简化版本
      try {
        const simplifiedMsgs = msgList.slice(0, 3).map(m => ({
          message: typeof m.message === 'string' ? m.message : "日志内容",
          nickname: m.nickname || "日志系统",
          user_id: String(Bot.uin)
        }))
        
        if (e.group?.makeForwardMsg) {
          return await e.group.makeForwardMsg(simplifiedMsgs)
        }
      } catch (err) {
        logger.error(`[sendLog] 简化转发消息也失败: ${err}`)
      }
      
      return null
    }
  }

  /**
   * 以转发消息格式回复错误信息
   */
  async replyError(errorMsg) {
    try {
      const messages = [
        {
          message: [
            "❌ 操作失败",
            "━".repeat(30),
            errorMsg,
            "",
            "💡 请检查:",
            "• 日志文件是否存在",
            "• 命令格式是否正确",
            "• 是否有足够的权限"
          ].join("\n"),
          nickname: "错误提示",
          user_id: Bot.uin
        }
      ]
      
      const forwardMsg = await this.makeForwardMsg(this.e, messages)
      
      if (forwardMsg) {
        await this.e.reply(forwardMsg)
      } else {
        await this.e.reply(`❌ ${errorMsg}`)
      }
      
    } catch (error) {
      logger.error(`[sendLog] 回复错误信息失败: ${error}`)
      await this.e.reply(`❌ ${errorMsg}`)
    }
    
    return false
  }
}