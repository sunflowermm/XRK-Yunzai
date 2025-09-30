import fs from "node:fs/promises"
import path from "node:path"
import lodash from "lodash"
import moment from "moment"
import common from '../../lib/common/common.js'

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
    
    // 构建消息数组
    const messages = []
    
    if (lineNum > this.maxNum) {
      messages.push(`⚠️ 行数超过最大限制，已调整为${this.maxNum}行`)
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
          messages.push(`ℹ️ 当天日志不存在，使用最近的日志文件：${path.basename(recentFile)}`)
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

    // 构建转发消息标题
    const title = keyWord 
      ? `🔍 ${type}日志搜索结果 - "${keyWord}"`
      : `📋 ${type}日志查看`

    // 构建完整消息内容
    const forwardMessages = await this.buildForwardMessages(log, type, keyWord, messages)
    
    // 使用common的转发消息方法
    const forwardMsg = await common.makeForwardMsg(this.e, forwardMessages, title)
    
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

  // 构建转发消息内容
  async buildForwardMessages(logs, type, keyWord, extraMessages = []) {
    const messages = []
    
    // 添加额外消息（如文件提示）
    if (extraMessages.length > 0) {
      messages.push(extraMessages.join('\n'))
    }
    
    // 构建统计信息头部
    const timestamp = moment().format("YYYY-MM-DD HH:mm:ss")
    const header = []
    header.push("═".repeat(35))
    header.push("📊 日志统计信息")
    header.push("─".repeat(35))
    header.push(`📅 查询时间: ${timestamp}`)
    header.push(`📁 日志类型: ${type}日志`)
    header.push(`📈 总条数: ${logs.length}条`)
    
    if (keyWord) {
      header.push(`🔍 搜索词: "${keyWord}"`)
    }
    
    header.push("═".repeat(35))
    messages.push(header.join('\n'))

    // 分批处理日志内容
    const batchSize = 30  // 每批显示30条，避免单条消息过长
    const totalBatches = Math.ceil(logs.length / batchSize)
    
    for (let i = 0; i < logs.length; i += batchSize) {
      const batch = logs.slice(i, Math.min(i + batchSize, logs.length))
      const currentBatch = Math.floor(i / batchSize) + 1
      
      const batchContent = []
      batchContent.push("─".repeat(35))
      batchContent.push(`📄 第 ${currentBatch}/${totalBatches} 页`)
      batchContent.push(`💬 条目 ${i + 1}-${Math.min(i + batchSize, logs.length)}`)
      batchContent.push("─".repeat(35))
      batchContent.push("")
      
      // 添加日志内容
      batch.forEach((log, index) => {
        const lineNumber = i + index + 1
        // 为了更好的可读性，给每条日志添加序号
        batchContent.push(`[${lineNumber}] ${log}`)
      })
      
      messages.push(batchContent.join('\n'))
    }

    // 添加使用说明
    const footer = []
    footer.push("═".repeat(35))
    footer.push("💡 使用提示")
    footer.push("─".repeat(35))
    footer.push("📌 支持的命令:")
    footer.push("• #运行日志 - 查看运行日志")
    footer.push("• #错误日志 - 查看错误日志")
    footer.push("• #追踪日志 - 查看追踪日志")
    footer.push("")
    footer.push("🔧 高级用法:")
    footer.push("• #运行日志100 - 指定查看100条")
    footer.push("• #错误日志50 关键词 - 搜索包含关键词的50条")
    footer.push("• #日志 error - 搜索默认条数的error日志")
    footer.push("")
    footer.push(`📊 当前配置: 默认${this.lineNum}条 | 最大${this.maxNum}条`)
    
    // 添加日志级别说明
    footer.push("")
    footer.push("📝 日志级别说明:")
    footer.push("❌ ERROR - 错误 | ⚠️ WARN - 警告")
    footer.push("ℹ️ INFO - 信息 | 🔧 DEBUG - 调试")
    footer.push("📝 TRACE - 追踪 | 💀 FATAL - 严重")
    footer.push("═".repeat(35))
    
    messages.push(footer.join('\n'))

    // 如果日志过多，添加提醒
    if (logs.length === this.maxNum) {
      const warning = []
      warning.push("⚠️ 注意")
      warning.push("─".repeat(35))
      warning.push(`日志已达到最大显示数量 ${this.maxNum} 条`)
      warning.push("如需查看更多，请使用关键词进行精确搜索")
      warning.push("或直接查看服务器日志文件")
      messages.push(warning.join('\n'))
    }

    return messages
  }
}