import fs from "node:fs/promises"
import path from "node:path"
import { existsSync } from "node:fs"
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
          reg: "^#(运行|错误)?日志(\\d+)?(.*)$",
          fnc: "sendLog",
          permission: "master",
        },
      ],
    })

    // 配置参数
    this.config = {
      defaultLines: 100,      // 默认行数
      maxLines: 100,          // 最大行数限制（优化为100）
      maxSearchResults: 100,  // 搜索结果最大数量（优化为100）
      logsDir: "logs",        // 日志目录
      maxChunkSize: 5000     // 每个转发消息块的最大字符长度（用于限制输出长度）
    }
  }

  /**
   * 获取日志文件路径
   */
  getLogPaths() {
    const today = moment().format("YYYY-MM-DD")
    return {
      command: path.join(this.config.logsDir, `${today}.log`),
      error: path.join(this.config.logsDir, "error.log")
    }
  }

  /**
   * 主处理函数
   */
  async sendLog() {
    try {
      // 解析用户输入
      const { type, lineNum, keyword } = this.parseUserInput()
      
      // 获取对应的日志文件路径
      const logPaths = this.getLogPaths()
      const logFile = type === "错误" ? logPaths.error : logPaths.command
      
      // 检查文件是否存在
      if (!existsSync(logFile)) {
        return this.reply(`日志文件不存在：${path.basename(logFile)}`)
      }

      // 读取和处理日志
      const logs = await this.processLogs(logFile, lineNum, keyword)
      
      // 检查结果
      if (!logs || logs.length === 0) {
        const searchInfo = keyword ? `包含"${keyword}"的` : ""
        return this.reply(`暂无${searchInfo}${type}日志`)
      }

      // 构建回复消息
      const header = this.buildLogHeader(type, logs.length, keyword)
      
      // 分割日志内容为多个块（学习update插件的makeForwardMsg处理方式，限制每个块的字符长度）
      const chunks = this.splitLogsIntoChunks(logs)
      
      // 使用common.makeForwardMsg构建转发消息（学习update插件的聊天记录制作方式）
      const forwardMsg = await common.makeForwardMsg(this.e, [header, ...chunks], `${type}日志，共${logs.length}条`)
      
      // 发送日志
      return this.reply(forwardMsg)
    } catch (error) {
      logger.error("发送日志失败:", error)
      return this.reply(`获取日志失败：${error.message}`)
    }
  }

  /**
   * 解析用户输入
   */
  parseUserInput() {
    const message = this.e.msg
    
    // 提取日志类型
    const type = message.includes("错误") ? "错误" : "运行"
    
    // 提取行数（如果有）
    const lineMatch = message.match(/\d+/)
    const lineNum = lineMatch ? parseInt(lineMatch[0]) : this.config.defaultLines
    
    // 提取关键词（移除命令部分）
    const keyword = message
      .replace(/^#(运行|错误)?日志\d*/g, "")
      .trim()
    
    return { type, lineNum, keyword }
  }

  /**
   * 处理日志文件
   */
  async processLogs(logFile, lineNum, keyword) {
    try {
      // 读取文件内容
      const content = await fs.readFile(logFile, "utf8")
      if (!content) return []
      
      // 分割成行
      let lines = content.split("\n").filter(line => line.trim())
      
      // 根据是否有关键词决定处理方式
      if (keyword) {
        lines = this.searchInLogs(lines, keyword)
      } else {
        lines = this.getRecentLogs(lines, lineNum)
      }
      
      // 清理每一行
      return lines.map(line => this.cleanLogLine(line))
    } catch (error) {
      logger.error(`读取日志文件失败 ${logFile}:`, error)
      throw new Error("无法读取日志文件")
    }
  }

  /**
   * 搜索日志中的关键词
   */
  searchInLogs(lines, keyword) {
    const results = []
    const lowerKeyword = keyword.toLowerCase()
    
    for (const line of lines) {
      if (line.toLowerCase().includes(lowerKeyword)) {
        results.push(line)
        if (results.length >= this.config.maxSearchResults) {
          break
        }
      }
    }
    
    return results.reverse()
  }

  /**
   * 获取最近的日志行
   */
  getRecentLogs(lines, lineNum) {
    // 限制请求的行数
    const requestedLines = Math.min(lineNum, this.config.maxLines)
    
    // 获取最后N行并反转（最新的在前）
    return lines.slice(-requestedLines).reverse()
  }

  /**
   * 清理日志行（移除所有ANSI转义序列和控制字符）
   */
  cleanLogLine(line) {
    if (!line) return ""
    
    return line
      // 移除所有ANSI转义序列（包括颜色、光标移动等）
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
      // 移除其他ANSI转义字符
      .replace(/\x1b[()][0-9;]*[a-zA-Z]/g, "")
      // 移除单独的转义字符
      .replace(/\x1b/g, "")
      // 移除其他控制字符（保留换行符除外）
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      // 移除回车符
      .replace(/\r/g, "")
      // 移除可能的Unicode控制字符
      .replace(/[-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
      // 清理多余的空格
      .replace(/\s+/g, " ")
      .trim()
  }

  /**
   * 分割日志为多个块（限制每个块的字符长度）
   */
  splitLogsIntoChunks(logs) {
    const chunks = []
    let currentChunk = []
    let currentLength = 0
    
    for (const line of logs) {
      const lineLength = line.length + 1 // +1 for newline
      if (currentLength + lineLength > this.config.maxChunkSize && currentChunk.length > 0) {
        chunks.push(currentChunk.join("\n"))
        currentChunk = []
        currentLength = 0
      }
      currentChunk.push(line)
      currentLength += lineLength
    }
    
    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join("\n"))
    }
    
    return chunks
  }

  /**
   * 构建日志消息头
   */
  buildLogHeader(type, count, keyword) {
    const parts = []
    
    if (keyword) {
      parts.push(`搜索"${keyword}"的结果`)
    }
    
    parts.push(`最近${count}条${type}日志`)
    
    if (count >= this.config.maxSearchResults && keyword) {
      parts.push(`(已达到最大显示数量)`)
    }
    
    return parts.join(" - ")
  }

  /**
   * 获取日志统计信息（可选功能）
   */
  async getLogStats() {
    try {
      const logPaths = this.getLogPaths()
      const stats = {}
      
      for (const [type, filePath] of Object.entries(logPaths)) {
        if (existsSync(filePath)) {
          const stat = await fs.stat(filePath)
          const content = await fs.readFile(filePath, "utf8")
          const lines = content.split("\n").filter(line => line.trim())
          
          stats[type] = {
            size: this.formatFileSize(stat.size),
            lines: lines.length,
            modified: moment(stat.mtime).format("YYYY-MM-DD HH:mm:ss")
          }
        }
      }
      
      return stats
    } catch (error) {
      logger.error("获取日志统计失败:", error)
      return null
    }
  }

  /**
   * 格式化文件大小
   */
  formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  /**
   * 清理过期日志（可选功能）
   */
  async cleanOldLogs(daysToKeep = 15) {
    try {
      const files = await fs.readdir(this.config.logsDir)
      const now = moment()
      let cleaned = 0
      
      for (const file of files) {
        if (file.startsWith("command.") && file.endsWith(".log")) {
          const dateStr = file.replace("command.", "").replace(".log", "")
          const fileDate = moment(dateStr, "YYYY-MM-DD")
          
          if (fileDate.isValid() && now.diff(fileDate, "days") > daysToKeep) {
            await fs.unlink(path.join(this.config.logsDir, file))
            cleaned++
          }
        }
      }
      
      return cleaned
    } catch (error) {
      logger.error("清理过期日志失败:", error)
      return 0
    }
  }
}