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

    this.lineNum = 100
    this.maxNum = 1000
    this.logDir = "logs"
  }

  async sendLog() {
    try {
      const match = this.e.msg.match(/^#(运行|错误|追踪)?日志(\d+)?(.*)$/)
      const logType = match[1] || "运行"
      const lineNum = match[2] ? parseInt(match[2]) : this.lineNum
      const keyWord = match[3] ? match[3].trim() : ""
      const finalLineNum = Math.min(lineNum, this.maxNum)
      
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
          logFile = path.join(this.logDir, `command.${moment().format("YYYY-MM-DD")}.log`)
          type = "运行"
      }

      try {
        await fs.access(logFile)
      } catch (err) {
        if (type === "运行") {
          const recentFile = await this.findRecentLogFile()
          if (recentFile) {
            logFile = recentFile
          } else {
            return await this.replyError(`暂无${type}日志文件`)
          }
        } else {
          return await this.replyError(`暂无${type}日志文件`)
        }
      }

      const log = await this.getLog(logFile, finalLineNum, keyWord)

      if (lodash.isEmpty(log)) {
        const errorMsg = keyWord ? `未找到包含"${keyWord}"的${type}日志` : `暂无${type}日志`
        return await this.replyError(errorMsg)
      }

      const forwardData = await this.buildForwardData(log, type, keyWord, finalLineNum, lineNum, logFile)
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

      if (keyWord) {
        lines = lines.filter(line => line.toLowerCase().includes(keyWord.toLowerCase()))
        lines = lines.slice(-this.maxNum)
      } else {
        lines = lines.slice(-lineNum)
      }

      lines = lines.reverse()

      const cleanedLines = []
      for (let line of lines) {
        if (!line) continue
        
        // 清理所有ANSI转义序列
        line = line.replace(/\x1b$$[0-9;]*m/g, "")  // 颜色代码
        line = line.replace(/\[38;5;\d+m/g, "")     // 256色代码
        line = line.replace(/\[39m/g, "")           // 重置颜色
        line = line.replace(/\[\d+m/g, "")          // 其他格式代码
        line = line.replace(/\u001b\[[^m]*m/g, "") // Unicode转义
        line = line.replace(/\r|\n/g, "")           // 换行符
        
        // 清理多余的方括号
        line = line.replace(/\[{2,}/g, "[").replace(/$${2,}/g, "]")
        
        // 识别日志级别
        const levelMatch = line.match(/$$(ERROR|WARN|INFO|DEBUG|TRACE|FATAL|MARK)$$/i)
        if (levelMatch) {
          const level = levelMatch[1].toUpperCase()
          const levelEmoji = {
            ERROR: "❌",
            WARN: "⚠️",
            INFO: "ℹ️",
            DEBUG: "🔧",
            TRACE: "📝",
            FATAL: "💀",
            MARK: "📌"
          }
          line = `${levelEmoji[level] || "•"} ${line}`
        }
        
        // 清理特殊符号
        line = line.replace(/[✧✗]/g, "").trim()
        
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

  /** 构建转发消息数据 */
  async buildForwardData(logs, type, keyWord, finalLineNum, originalLineNum, logFile) {
    const messages = []
    const timestamp = moment().format("YYYY-MM-DD HH:mm:ss")
    const fileName = path.basename(logFile)
    
    const title = keyWord 
      ? `🔍 包含"${keyWord}"的${type}日志`
      : `📋 最近${type}日志`
    
    // 标题消息
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

    // 行数调整提醒
    if (originalLineNum > this.maxNum) {
      messages.push({
        message: `⚠️ 行数超过最大限制，已调整为${this.maxNum}行`,
        nickname: "系统提示",
        user_id: Bot.uin
      })
    }

    // 关键词信息
    if (keyWord) {
      messages.push({
        message: `🔍 搜索关键词: "${keyWord}"`,
        nickname: "搜索信息",
        user_id: Bot.uin
      })
    }

    // 日志内容分页
    const batchSize = 30
    for (let i = 0; i < logs.length; i += batchSize) {
      const batch = logs.slice(i, Math.min(i + batchSize, logs.length))
      const pageNum = Math.floor(i / batchSize) + 1
      const totalPages = Math.ceil(logs.length / batchSize)
      
      const header = [
        "─".repeat(35),
        `📄 第 ${pageNum}/${totalPages} 页`,
        `💬 条目 ${i + 1}-${Math.min(i + batchSize, logs.length)}`,
        "─".repeat(35),
        ""
      ].join("\n")
      
      const numberedBatch = batch.map((log, idx) => `[${i + idx + 1}] ${log}`)
      
      messages.push({
        message: header + numberedBatch.join("\n"),
        nickname: `日志内容 [${pageNum}]`,
        user_id: Bot.uin
      })
    }

    // 使用说明
    messages.push({
      message: [
        "━".repeat(30),
        "💡 使用提示:",
        "• #运行日志 - 查看运行日志",
        "• #错误日志 - 查看错误日志",  
        "• #追踪日志 - 查看追踪日志",
        "• #运行日志100 - 指定显示行数",
        "• #运行日志 关键词 - 搜索日志",
        "",
        `📝 最大显示: ${this.maxNum}行`
      ].join("\n"),
      nickname: "使用说明",
      user_id: Bot.uin
    })

    return messages
  }

  /** 生成转发消息 */
  async makeForwardMsg(e, msgList) {
    try {
      const msgs = []
      const baseTime = Math.floor(Date.now() / 1000)
      
      for (let i = 0; i < msgList.length; i++) {
        const msg = msgList[i]
        msgs.push({
          message: msg.message,
          nickname: msg.nickname || "日志系统",
          user_id: String(msg.user_id || Bot.uin),
          time: msg.time || (baseTime - (msgList.length - i) * 2)
        })
      }
      
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
        const messages = msgs.map(m => m.message)
        forwardMsg = await Bot.makeForwardArray(messages)
      } else {
        logger.error("[sendLog] 未找到可用的转发消息API")
        return null
      }
      
      return forwardMsg
      
    } catch (error) {
      logger.error(`[sendLog] 制作转发消息失败: ${error}`)
      
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

  /** 发送错误提示 */
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