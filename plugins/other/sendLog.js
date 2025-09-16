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

    // 配置参数 - 优化为50条
    this.config = {
      defaultLines: 50,       // 默认行数改为50
      maxLines: 50,           // 最大行数限制改为50
      maxSearchResults: 50,   // 搜索结果最大数量改为50
      logsDir: "logs",        // 日志目录
      maxChunkSize: 3000     // 每个转发消息块的最大字符长度（减小以避免太长）
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
      
      // 分割日志内容为多个块
      const chunks = this.splitLogsIntoChunks(logs)
      
      // 使用common.makeForwardMsg构建转发消息
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
    let lineNum = lineMatch ? parseInt(lineMatch[0]) : this.config.defaultLines
    
    // 限制最大行数
    lineNum = Math.min(lineNum, this.config.maxLines)
    
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
      
      // 清理每一行，并限制每行长度
      return lines.map(line => this.cleanAndTruncateLogLine(line))
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
   * 清理日志行并限制长度
   */
  cleanAndTruncateLogLine(line) {
    if (!line) return ""
    
    // 清理ANSI转义序列和控制字符
    let cleaned = line
      // 移除所有ANSI转义序列
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
      // 移除其他ANSI转义字符
      .replace(/\x1b[()][0-9;]*[a-zA-Z]/g, "")
      // 移除单独的转义字符
      .replace(/\x1b/g, "")
      // 移除其他控制字符
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      // 移除回车符
      .replace(/\r/g, "")
      // 移除Unicode控制字符
      .replace(/[\u0080-\u009F]/g, "")
      // 清理多余的空格
      .replace(/\s+/g, " ")
      .trim()
    
    // 限制每行最大长度为200字符
    if (cleaned.length > 200) {
      cleaned = cleaned.substring(0, 197) + "..."
    }
    
    return cleaned
  }

  /**
   * 分割日志为多个块
   */
  splitLogsIntoChunks(logs) {
    const chunks = []
    let currentChunk = []
    let currentLength = 0
    
    for (const line of logs) {
      const lineLength = line.length + 1 // +1 for newline
      
      // 如果当前块会超过最大长度，先保存当前块
      if (currentLength + lineLength > this.config.maxChunkSize && currentChunk.length > 0) {
        chunks.push(currentChunk.join("\n"))
        currentChunk = []
        currentLength = 0
      }
      
      currentChunk.push(line)
      currentLength += lineLength
    }
    
    // 保存最后一个块
    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join("\n"))
    }
    
    // 限制总块数不超过3个（避免消息太长）
    if (chunks.length > 3) {
      const firstChunk = chunks[0]
      const lastChunk = chunks[chunks.length - 1]
      const middleInfo = `\n...\n(省略了${chunks.length - 2}个日志块)\n...\n`
      return [firstChunk, middleInfo, lastChunk]
    }
    
    return chunks
  }

  /**
   * 构建日志消息头
   */
  buildLogHeader(type, count, keyword) {
    const parts = [`【${type}日志】`]
    
    if (keyword) {
      parts.push(`搜索"${keyword}"`)
    }
    
    parts.push(`共${count}条`)
    
    if (count >= this.config.maxLines) {
      parts.push(`(已达上限)`)
    }
    
    parts.push(`\n时间：${moment().format("MM-DD HH:mm:ss")}`)
    
    return parts.join(" ")
  }

  /**
   * 获取日志统计信息
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
   * 清理过期日志（修复路径问题）
   */
  async cleanOldLogs(daysToKeep = 15) {
    try {
      const files = await fs.readdir(this.config.logsDir)
      const now = moment()
      let cleaned = 0
      
      for (const file of files) {
        if (file.match(/^\d{4}-\d{2}-\d{2}\.log$/)) {
          const dateStr = file.replace(".log", "")
          const fileDate = moment(dateStr, "YYYY-MM-DD")
          
          if (fileDate.isValid() && now.diff(fileDate, "days") > daysToKeep) {
            await fs.unlink(path.join(this.config.logsDir, file))
            cleaned++
            logger.info(`清理过期日志: ${file}`)
          }
        }
      }
      
      return cleaned
    } catch (error) {
      logger.error("清理过期日志失败:", error)
      return 0
    }
  }

  /**
   * 获取日志文件列表
   */
  async getLogFileList() {
    try {
      const files = await fs.readdir(this.config.logsDir)
      const logFiles = []
      
      for (const file of files) {
        const filePath = path.join(this.config.logsDir, file)
        if (file.endsWith(".log") && existsSync(filePath)) {
          const stat = await fs.stat(filePath)
          logFiles.push({
            name: file,
            size: this.formatFileSize(stat.size),
            modified: moment(stat.mtime).format("YYYY-MM-DD HH:mm:ss")
          })
        }
      }
      
      return logFiles.sort((a, b) => b.modified.localeCompare(a.modified))
    } catch (error) {
      logger.error("获取日志文件列表失败:", error)
      return []
    }
  }
}