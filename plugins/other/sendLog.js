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
    // 解析命令参数
    const match = this.e.msg.match(/^#(运行|错误|追踪)?日志(\d+)?(.*)$/)
    const logType = match[1] || "运行"
    const lineNum = match[2] ? parseInt(match[2]) : this.lineNum
    const keyWord = match[3] ? match[3].trim() : ""

    // 验证行数
    const finalLineNum = Math.min(lineNum, this.maxNum)
    if (lineNum > this.maxNum) {
      await this.reply(`行数超过最大限制，已调整为${this.maxNum}行`)
    }

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
          await this.reply(`当天日志不存在，使用最近的日志文件：${path.basename(recentFile)}`)
        } else {
          return this.reply(`暂无${type}日志文件`)
        }
      } else {
        return this.reply(`暂无${type}日志文件`)
      }
    }

    // 读取日志
    const log = await this.getLog(logFile, finalLineNum, keyWord)

    if (lodash.isEmpty(log)) {
      return this.reply(keyWord ? `未找到包含"${keyWord}"的${type}日志` : `暂无${type}日志`)
    }

    // 构建转发消息
    const title = keyWord 
      ? `🔍 包含"${keyWord}"的${type}日志 (共${log.length}条)`
      : `📋 最近${log.length}条${type}日志`
    
    const forwardMsg = await this.makeForwardMsg(title, log, type, keyWord)
    return this.reply(forwardMsg)
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
        line = line.replace(/\x1b\[[0-9;]*m/g, "")
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

  // 构建转发消息
  async makeForwardMsg(title, logs, type, keyWord) {
    const messages = []
    
    // 添加标题和统计信息
    messages.push(title)
    messages.push("━".repeat(30))
    
    // 添加日志信息
    const timestamp = moment().format("YYYY-MM-DD HH:mm:ss")
    const info = [
      `📅 查询时间: ${timestamp}`,
      `📁 日志类型: ${type}日志`,
      `📊 显示条数: ${logs.length}条`
    ]
    
    if (keyWord) {
      info.push(`🔍 搜索关键词: ${keyWord}`)
    }
    
    messages.push(info.join("\n"))
    messages.push("━".repeat(30))
    
    // 分批添加日志，避免消息过长
    const batchSize = 50
    for (let i = 0; i < logs.length; i += batchSize) {
      const batch = logs.slice(i, Math.min(i + batchSize, logs.length))
      const batchHeader = `📄 第 ${Math.floor(i / batchSize) + 1} 页 (${i + 1}-${Math.min(i + batchSize, logs.length)} 条)\n` + "─".repeat(25)
      messages.push(batchHeader + "\n" + batch.join("\n"))
    }
    
    // 添加操作提示
    const tips = [
      "━".repeat(30),
      "💡 提示:",
      "• 使用 #错误日志 查看错误日志",
      "• 使用 #追踪日志 查看追踪日志",
      "• 使用 #运行日志100 指定行数",
      "• 使用 #运行日志 关键词 搜索日志"
    ]
    messages.push(tips.join("\n"))

    // 使用 Bot 的转发消息功能
    if (Bot.makeForwardArray) {
      try {
        return await Bot.makeForwardArray(messages)
      } catch (err) {
        logger.error("创建转发消息失败:", err)
        // 如果转发失败，返回拼接的消息
        return messages.slice(0, 3).join("\n\n") + "\n\n⚠️ 日志内容过多，仅显示摘要"
      }
    }
    
    // 如果没有转发功能，返回拼接的消息（限制长度）
    const combinedMessage = messages.join("\n\n")
    if (combinedMessage.length > 3000) {
      return messages.slice(0, 3).join("\n\n") + "\n\n⚠️ 日志内容过多，仅显示摘要"
    }
    return combinedMessage
  }
}