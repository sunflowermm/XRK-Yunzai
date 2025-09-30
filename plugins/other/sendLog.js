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
    this.batchSize = 20  // 改为20条一批
    
    // 日志级别配置
    this.levelConfig = {
      ERROR: { emoji: "❌", color: "red" },
      WARN: { emoji: "⚠️", color: "yellow" },
      INFO: { emoji: "ℹ️", color: "blue" },
      DEBUG: { emoji: "🔧", color: "gray" },
      TRACE: { emoji: "📝", color: "gray" },
      FATAL: { emoji: "💀", color: "darkred" },
      MARK: { emoji: "📌", color: "green" }
    }
  }

  async sendLog() {
    try {
      const match = this.e.msg.match(/^#(运行|错误|追踪)?日志(\d+)?(.*)$/)
      const logType = match[1] || "运行"
      const lineNum = Math.min(parseInt(match[2]) || this.lineNum, this.maxNum)
      const keyWord = match[3]?.trim() || ""
      
      // 获取日志文件
      const logFile = await this.getLogFile()
      if (!logFile) {
        return await this.replyError(`暂无日志文件`)
      }

      // 读取和处理日志
      const logs = await this.getLog(logFile, lineNum, keyWord)
      if (lodash.isEmpty(logs)) {
        const errorMsg = keyWord ? `未找到包含"${keyWord}"的日志` : `暂无日志`
        return await this.replyError(errorMsg)
      }

      // 构建并发送转发消息
      const forwardData = await this.buildForwardData(logs, logType, keyWord, lineNum, logFile)
      const forwardMsg = await this.makeForwardMsg(this.e, forwardData)
      
      if (!forwardMsg) {
        await this.replyError('生成转发消息失败')
        return false
      }
      
      await this.e.reply(forwardMsg)
      return true
      
    } catch (error) {
      logger.error(`[sendLog] 发送日志失败:`, error)
      await this.replyError('发送日志时发生错误')
      return false
    }
  }

  async getLogFile() {
    try {
      // 优先使用当前日期的日志文件
      const currentDate = moment().format("YYYY-MM-DD")
      const currentLogFile = path.join(this.logDir, `app.${currentDate}.log`)
      
      try {
        await fs.access(currentLogFile)
        return currentLogFile
      } catch {
        // 查找最近的日志文件
        return await this.findRecentLogFile()
      }
    } catch (error) {
      logger.error("[sendLog] 获取日志文件失败:", error)
      return null
    }
  }

  async findRecentLogFile() {
    try {
      const files = await fs.readdir(this.logDir)
      
      const appLogs = files
        .filter(file => file.startsWith("app.") && file.endsWith(".log"))
        .sort()
        .reverse()
      
      return appLogs.length > 0 ? path.join(this.logDir, appLogs[0]) : null
      
    } catch (err) {
      logger.error("[sendLog] 查找日志文件失败:", err)
      return null
    }
  }

  async getLog(logFile, lineNum = 100, keyWord = "") {
    try {
      const content = await fs.readFile(logFile, "utf8")
      let lines = content.split("\n").filter(line => line.trim())

      // 关键词过滤
      if (keyWord) {
        const lowerKeyword = keyWord.toLowerCase()
        lines = lines.filter(line => line.toLowerCase().includes(lowerKeyword))
        lines = lines.slice(-this.maxNum)  // 限制搜索结果数量
      } else {
        lines = lines.slice(-lineNum)
      }

      // 反转并格式化日志行
      return lines.reverse().map(line => this.formatLogLine(line))
      
    } catch (err) {
      logger.error(`[sendLog] 读取日志文件失败: ${logFile}`, err)
      return []
    }
  }

  formatLogLine(line) {
    if (!line) return ""
    
    // 识别并标记日志级别
    const levelMatch = line.match(/$$(ERROR|WARN|INFO|DEBUG|TRACE|FATAL|MARK)$$/i)
    if (levelMatch) {
      const level = levelMatch[1].toUpperCase()
      const config = this.levelConfig[level]
      if (config) {
        return `${config.emoji} ${line.trim()}`
      }
    }
    
    return `• ${line.trim()}`
  }

  async buildForwardData(logs, type, keyWord, lineNum, logFile) {
    const messages = []
    const timestamp = moment().format("YYYY-MM-DD HH:mm:ss")
    const fileName = path.basename(logFile)
    
    // 标题消息
    messages.push({
      message: this.buildHeaderMessage(keyWord, timestamp, fileName, logs.length),
      nickname: "日志系统",
      user_id: Bot.uin
    })

    // 搜索信息（如果有关键词）
    if (keyWord) {
      messages.push({
        message: `🔍 搜索关键词: "${keyWord}"\n💡 共找到 ${logs.length} 条相关日志`,
        nickname: "搜索信息",
        user_id: Bot.uin
      })
    }

    // 分批发送日志内容（20条一批）
    const totalPages = Math.ceil(logs.length / this.batchSize)
    for (let i = 0; i < logs.length; i += this.batchSize) {
      const batch = logs.slice(i, Math.min(i + this.batchSize, logs.length))
      const pageNum = Math.floor(i / this.batchSize) + 1
      
      messages.push({
        message: this.buildBatchMessage(batch, i, pageNum, totalPages),
        nickname: `日志内容 [${pageNum}/${totalPages}]`,
        user_id: Bot.uin
      })
    }

    // 使用说明
    messages.push({
      message: this.buildFooterMessage(),
      nickname: "使用说明",
      user_id: Bot.uin
    })

    return messages
  }

  buildHeaderMessage(keyWord, timestamp, fileName, logCount) {
    const title = keyWord ? `🔍 包含"${keyWord}"的日志` : `📋 最近日志`
    
    return [
      title,
      "━".repeat(30),
      `📅 查询时间: ${timestamp}`,
      `📁 日志文件: ${fileName}`,
      `📊 显示条数: ${logCount}条`
    ].join("\n")
  }

  buildBatchMessage(batch, startIdx, pageNum, totalPages) {
    const header = [
      "─".repeat(35),
      `📄 第 ${pageNum}/${totalPages} 页`,
      `💬 条目 ${startIdx + 1}-${startIdx + batch.length}`,
      "─".repeat(35),
      ""
    ].join("\n")
    
    const numberedBatch = batch.map((log, idx) => 
      `[${startIdx + idx + 1}] ${log}`
    )
    
    return header + numberedBatch.join("\n")
  }

  buildFooterMessage() {
    return [
      "━".repeat(30),
      "💡 使用提示:",
      "• #日志 - 查看最近100条",
      "• #日志200 - 指定显示行数",
      "• #日志 关键词 - 搜索特定内容",
      "",
      `📝 最大显示: ${this.maxNum}行`,
      `📦 批量大小: ${this.batchSize}条/页`
    ].join("\n")
  }

  async makeForwardMsg(e, msgList) {
    try {
      const msgs = this.prepareMsgsForForward(msgList)
      
      const apis = [
        e.group?.makeForwardMsg,
        e.friend?.makeForwardMsg,
        e.bot?.makeForwardMsg,
        Bot.makeForwardMsg
      ].filter(Boolean)
      
      for (const api of apis) {
        try {
          return await api.call(api === Bot.makeForwardMsg ? Bot : e.group || e.friend || e.bot, msgs)
        } catch {
          continue
        }
      }
      
      logger.error("[sendLog] 所有转发消息API均失败")
      return null
      
    } catch (error) {
      logger.error(`[sendLog] 制作转发消息失败:`, error)
      return null
    }
  }

  prepareMsgsForForward(msgList) {
    const baseTime = Math.floor(Date.now() / 1000)
    
    return msgList.map((msg, i) => ({
      message: msg.message,
      nickname: msg.nickname || "日志系统",
      user_id: String(msg.user_id || Bot.uin),
      time: msg.time || (baseTime - (msgList.length - i) * 2)
    }))
  }

  async replyError(errorMsg) {
    try {
      const errorMessage = {
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
      
      const forwardMsg = await this.makeForwardMsg(this.e, [errorMessage])
      
      if (forwardMsg) {
        await this.e.reply(forwardMsg)
      } else {
        // 简单回复作为fallback
        await this.e.reply(`❌ ${errorMsg}`)
      }
      
    } catch (error) {
      logger.error(`[sendLog] 回复错误信息失败:`, error)
      await this.e.reply(`❌ ${errorMsg}`)
    }
    
    return false
  }
}