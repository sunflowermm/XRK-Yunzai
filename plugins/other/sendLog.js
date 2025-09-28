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
        },
        {
          reg: "^#(查看|列出)日志文件$",
          fnc: "listLogFiles",
          permission: "master",
        },
        {
          reg: "^#清理(过期)?日志(\\d+)?天?$",
          fnc: "cleanLogs",
          permission: "master",
        },
        {
          reg: "^#日志(大小|统计)$",
          fnc: "logStats",
          permission: "master",
        },
      ],
    })

    this.lineNum = 100
    this.maxNum = 1000
    this.logDir = "logs"
  }

  async sendLog() {
    // 解析命令参数
    const match = this.e.msg.match(/^#(运行|错误|追踪)?日志(\d+)?(.*)$/)
    const logType = match[1] || "运行"
    const lineNum = match[2] ? parseInt(match[2]) : this.lineNum
    const keyWord = match[3] ? match[3].trim() : ""

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
    const log = await this.getLog(logFile, lineNum, keyWord)

    if (lodash.isEmpty(log)) {
      return this.reply(keyWord ? `未找到包含"${keyWord}"的${type}日志` : `暂无${type}日志`)
    }

    // 构建转发消息
    const title = keyWord 
      ? `包含"${keyWord}"的${type}日志 (共${log.length}条)`
      : `最近${log.length}条${type}日志`
    
    const forwardMsg = await this.makeForwardMsg(title, log)
    return this.reply(forwardMsg)
  }

  async getLog(logFile, lineNum = 100, keyWord = "") {
    try {
      let log = await fs.readFile(logFile, "utf8")
      let lines = log.split("\n").filter(line => line.trim())

      // 如果有关键词，过滤包含关键词的行
      if (keyWord) {
        lines = lines.filter(line => line.includes(keyWord))
        // 限制最大数量
        lines = lines.slice(-this.maxNum)
      } else {
        // 获取最后N行
        lines = lines.slice(-lineNum)
      }

      // 反转数组，最新的在前面
      lines = lines.reverse()

      // 清理 ANSI 颜色代码
      const cleanedLines = []
      for (let line of lines) {
        if (!line) continue
        // 移除 ANSI 颜色代码
        line = line.replace(/\x1b\[[0-9;]*m/g, "")
        // 移除回车换行
        line = line.replace(/\r|\n/g, "")
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

  async listLogFiles() {
    try {
      const files = await fs.readdir(this.logDir)
      const logFiles = []
      
      for (const file of files) {
        if (file.endsWith(".log") || file.endsWith(".gz")) {
          const filePath = path.join(this.logDir, file)
          const stats = await fs.stat(filePath)
          const size = this.formatFileSize(stats.size)
          const modTime = moment(stats.mtime).format("YYYY-MM-DD HH:mm:ss")
          
          logFiles.push({
            name: file,
            size: size,
            modified: modTime,
            age: this.getFileAge(stats.mtime)
          })
        }
      }

      if (logFiles.length === 0) {
        return this.reply("暂无日志文件")
      }

      // 按修改时间排序
      logFiles.sort((a, b) => b.modified.localeCompare(a.modified))

      // 构建消息
      const messages = [`日志文件列表 (共${logFiles.length}个)：\n`]
      for (const file of logFiles) {
        messages.push(`📄 ${file.name}`)
        messages.push(`   大小: ${file.size} | 修改: ${file.modified}`)
        messages.push(`   存在时间: ${file.age}\n`)
      }

      return this.reply(messages.join("\n"))
    } catch (err) {
      logger.error("列出日志文件失败:", err)
      return this.reply("获取日志文件列表失败")
    }
  }

  async cleanLogs() {
    const match = this.e.msg.match(/清理(过期)?日志(\d+)?/)
    const days = match[2] ? parseInt(match[2]) : 3
    
    await this.reply(`开始清理${days}天前的日志文件...`)
    
    try {
      const deleted = await logger.cleanLogs(days)
      return this.reply(`清理完成，共删除 ${deleted} 个过期日志文件`)
    } catch (err) {
      logger.error("清理日志失败:", err)
      return this.reply("清理日志文件失败，请查看错误日志")
    }
  }

  async logStats() {
    try {
      const files = await fs.readdir(this.logDir)
      let totalSize = 0
      let fileCount = 0
      const typeStats = {
        command: { count: 0, size: 0 },
        error: { count: 0, size: 0 },
        trace: { count: 0, size: 0 },
        other: { count: 0, size: 0 }
      }

      for (const file of files) {
        if (file.endsWith(".log") || file.endsWith(".gz")) {
          const filePath = path.join(this.logDir, file)
          const stats = await fs.stat(filePath)
          totalSize += stats.size
          fileCount++

          // 统计不同类型的日志
          if (file.startsWith("command.")) {
            typeStats.command.count++
            typeStats.command.size += stats.size
          } else if (file.includes("error")) {
            typeStats.error.count++
            typeStats.error.size += stats.size
          } else if (file.includes("trace")) {
            typeStats.trace.count++
            typeStats.trace.size += stats.size
          } else {
            typeStats.other.count++
            typeStats.other.size += stats.size
          }
        }
      }

      const messages = [
        `📊 日志统计信息`,
        `━━━━━━━━━━━━━━━━`,
        `📁 日志目录: ${this.logDir}`,
        `📄 文件总数: ${fileCount} 个`,
        `💾 总占用空间: ${this.formatFileSize(totalSize)}`,
        ``,
        `📈 分类统计:`,
        `• 运行日志: ${typeStats.command.count}个 (${this.formatFileSize(typeStats.command.size)})`,
        `• 错误日志: ${typeStats.error.count}个 (${this.formatFileSize(typeStats.error.size)})`,
        `• 追踪日志: ${typeStats.trace.count}个 (${this.formatFileSize(typeStats.trace.size)})`,
        `• 其他日志: ${typeStats.other.count}个 (${this.formatFileSize(typeStats.other.size)})`,
        ``,
        `🔄 自动清理: 每天凌晨3点`,
        `⏰ 保留时长: 3天`
      ]

      return this.reply(messages.join("\n"))
    } catch (err) {
      logger.error("获取日志统计失败:", err)
      return this.reply("获取日志统计信息失败")
    }
  }

  // 辅助方法：格式化文件大小
  formatFileSize(bytes) {
    if (bytes === 0) return "0 B"
    const units = ["B", "KB", "MB", "GB"]
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`
  }

  // 辅助方法：计算文件年龄
  getFileAge(mtime) {
    const now = Date.now()
    const age = now - mtime.getTime()
    const days = Math.floor(age / (24 * 60 * 60 * 1000))
    const hours = Math.floor((age % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
    
    if (days > 0) {
      return `${days}天${hours}小时`
    }
    return `${hours}小时`
  }

  // 辅助方法：构建转发消息
  async makeForwardMsg(title, logs) {
    const messages = []
    
    // 添加标题
    messages.push(title)
    messages.push("━".repeat(30))
    
    // 分批添加日志，避免消息过长
    const batchSize = 50
    for (let i = 0; i < logs.length; i += batchSize) {
      const batch = logs.slice(i, Math.min(i + batchSize, logs.length))
      messages.push(batch.join("\n"))
    }

    // 使用 Bot 的转发消息功能
    if (Bot.makeForwardArray) {
      return await Bot.makeForwardArray(messages)
    }
    
    // 如果没有转发功能，直接返回拼接的消息
    return messages.join("\n\n")
  }
}