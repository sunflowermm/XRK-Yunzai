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
          reg: "^#(运行|错误|追踪|调试|trace|debug)?日志(\\d+)?(.*)$",
          fnc: "sendLog",
          permission: "master",
        }
      ],
    })

    this.lineNum = 100
    this.maxNum = 1000
    this.logDir = "logs"
    this.batchSize = 30
    
    // 日志级别配置
    this.levelConfig = {
      ERROR: { emoji: "❌", color: "red" },
      WARN: { emoji: "⚠️", color: "yellow" },
      INFO: { emoji: "ℹ️", color: "blue" },
      DEBUG: { emoji: "🔧", color: "cyan" },
      TRACE: { emoji: "📝", color: "gray" },
      FATAL: { emoji: "💀", color: "redBright" },
      MARK: { emoji: "📌", color: "magenta" }
    }
  }

  async sendLog() {
    try {
      const match = this.e.msg.match(/^#(运行|错误|追踪|调试|trace|debug)?日志(\d+)?(.*)$/i)
      const logType = this.normalizeLogType(match[1])
      const lineNum = Math.min(parseInt(match[2]) || this.lineNum, this.maxNum)
      const keyWord = match[3]?.trim() || ""
      
      // 获取日志配置
      const { logFile, filterLevel, logName } = await this.getLogConfig(logType)
      
      if (!logFile) {
        return await this.replyError(`暂无${logName}文件`)
      }

      // 读取和处理日志
      const logs = await this.getLog(logFile, lineNum, keyWord, filterLevel)
      
      if (lodash.isEmpty(logs)) {
        const errorMsg = this.buildErrorMessage(logName, keyWord, filterLevel)
        return await this.replyError(errorMsg)
      }

      // 构建并发送转发消息
      const forwardData = await this.buildForwardData(logs, logName, keyWord, lineNum, logFile, filterLevel)
      const forwardMsg = await this.makeForwardMsg(this.e, forwardData)
      
      if (!forwardMsg) {
        await this.e.reply(`❌ 生成转发消息失败，可能内容过长`)
        return false
      }
      
      await this.e.reply(forwardMsg)
      logger.info(`[sendLog] 成功发送${logName}，共${logs.length}条`)
      return true
      
    } catch (error) {
      logger.error(`[sendLog] 发送日志失败:`, error)
      await this.e.reply(`❌ 发送日志时发生错误: ${error.message}`)
      return false
    }
  }

  normalizeLogType(type) {
    if (!type) return "运行"
    
    const typeMap = {
      '追踪': 'TRACE',
      'trace': 'TRACE',
      '错误': 'ERROR',
      '调试': 'DEBUG',
      'debug': 'DEBUG',
      '运行': 'ALL'
    }
    
    return typeMap[type.toLowerCase()] || 'ALL'
  }

  async getLogConfig(logType) {
    const config = {
      logFile: null,
      filterLevel: null,
      logName: '运行日志'
    }

    switch(logType) {
      case 'TRACE':
        config.logFile = await this.findLogFile('trace')
        config.logName = '追踪日志'
        break
      
      case 'ERROR':
        config.logFile = await this.findLogFile('app')
        config.filterLevel = 'ERROR'
        config.logName = '错误日志'
        break
      
      case 'DEBUG':
        config.logFile = await this.findLogFile('app')
        config.filterLevel = 'DEBUG'
        config.logName = '调试日志'
        break
      
      default:
        config.logFile = await this.findLogFile('app')
        config.logName = '运行日志'
        break
    }

    return config
  }

  async findLogFile(prefix = 'app') {
    try {
      // 优先使用当天的日志文件
      const currentDate = moment().format("YYYY-MM-DD")
      const todayLogFile = path.join(this.logDir, `${prefix}.${currentDate}.log`)
      
      try {
        await fs.access(todayLogFile)
        return todayLogFile
      } catch {
        // 如果当天文件不存在，查找最近的日志文件
        const files = await fs.readdir(this.logDir)
        const logFiles = files
          .filter(file => file.startsWith(`${prefix}.`) && file.endsWith('.log'))
          .sort((a, b) => b.localeCompare(a)) // 按日期降序排序
        
        if (logFiles.length > 0) {
          return path.join(this.logDir, logFiles[0])
        }
        
        // 兼容旧格式
        if (prefix === 'app') {
          const oldFiles = files
            .filter(file => file.match(/^\d{4}-\d{2}-\d{2}\.log$/))
            .sort((a, b) => b.localeCompare(a))
          
          if (oldFiles.length > 0) {
            return path.join(this.logDir, oldFiles[0])
          }
        }
        
        return null
      }
    } catch (error) {
      logger.error(`[sendLog] 查找${prefix}日志文件失败:`, error)
      return null
    }
  }

  async getLog(logFile, lineNum = 100, keyWord = "", filterLevel = null) {
    try {
      const content = await fs.readFile(logFile, "utf8")
      let lines = content.split("\n").filter(line => line.trim())

      // 级别过滤 - 使用更准确的正则匹配 [LEVEL] 格式
      if (filterLevel) {
        const levelPattern = new RegExp(`\\[${filterLevel}\\]`, 'i')
        lines = lines.filter(line => levelPattern.test(line))
      }

      // 关键词过滤
      if (keyWord) {
        const lowerKeyword = keyWord.toLowerCase()
        lines = lines.filter(line => line.toLowerCase().includes(lowerKeyword))
      }

      // 限制数量
      const maxLines = (filterLevel || keyWord) ? this.maxNum : lineNum
      lines = lines.slice(-maxLines)

      // 反转顺序（最新的在前）
      lines.reverse()

      // 格式化每行
      return lines.map((line, idx) => this.formatLogLine(line, idx))
      
    } catch (err) {
      logger.error(`[sendLog] 读取日志文件失败: ${logFile}`, err)
      return []
    }
  }

  formatLogLine(line, index) {
    if (!line) return ""
    
    const levelMatch = line.match(/\[([A-Z]+)\]/i)
    if (levelMatch) {
      const level = levelMatch[1].toUpperCase()
      const config = this.levelConfig[level]
      if (config) {
        return `${config.emoji} ${line}`
      }
    }
    
    if (line.includes('Stack:') || line.match(/^\s+at\s/)) {
      return `  ↳ ${line.trim()}`
    }
    
    return `• ${line}`
  }

  buildErrorMessage(logName, keyWord, filterLevel) {
    if (keyWord) {
      return `未找到包含"${keyWord}"的${logName}记录`
    }
    if (filterLevel) {
      return `暂无 ${filterLevel} 级别的日志记录`
    }
    return `暂无${logName}记录`
  }

  async buildForwardData(logs, logName, keyWord, lineNum, logFile, filterLevel) {
    const messages = []
    const timestamp = moment().format("YYYY-MM-DD HH:mm:ss")
    const fileName = path.basename(logFile)
    
    const headerInfo = this.buildHeaderInfo(logName, keyWord, filterLevel, timestamp, fileName, logs.length)
    messages.push({
      message: headerInfo,
      nickname: "日志系统",
      user_id: Bot.uin
    })

    if (keyWord || filterLevel) {
      const statsInfo = this.buildStatsInfo(keyWord, filterLevel, logs.length)
      messages.push({
        message: statsInfo,
        nickname: "统计信息",
        user_id: Bot.uin
      })
    }

    const totalPages = Math.ceil(logs.length / this.batchSize)
    
    for (let i = 0; i < logs.length; i += this.batchSize) {
      const batch = logs.slice(i, Math.min(i + this.batchSize, logs.length))
      const pageNum = Math.floor(i / this.batchSize) + 1
      
      const batchContent = this.buildBatchContent(batch, i, pageNum, totalPages)
      messages.push({
        message: batchContent,
        nickname: `${logName} [${pageNum}/${totalPages}]`,
        user_id: Bot.uin
      })
    }

    messages.push({
      message: this.buildUsageInfo(),
      nickname: "使用说明",
      user_id: Bot.uin
    })

    return messages
  }

  buildHeaderInfo(logName, keyWord, filterLevel, timestamp, fileName, count) {
    const titleEmoji = this.getTitleEmoji(logName, filterLevel)
    let title = `${titleEmoji} ${logName}`
    
    if (keyWord) {
      title += ` - 搜索"${keyWord}"`
    }
    if (filterLevel) {
      title += ` (${filterLevel}级别)`
    }
    
    return [
      title,
      `📅 查询时间: ${timestamp}`,
      `📁 日志文件: ${fileName}`,
      `📊 记录条数: ${count}条`,
      `🔄 排序方式: 最新在前`
    ].join("\n")
  }

  getTitleEmoji(logName, filterLevel) {
    if (filterLevel && this.levelConfig[filterLevel]) {
      return this.levelConfig[filterLevel].emoji
    }
    
    const emojiMap = {
      '追踪日志': '📝',
      '错误日志': '❌',
      '调试日志': '🔧',
      '运行日志': '📋'
    }
    
    return emojiMap[logName] || '📄'
  }

  buildStatsInfo(keyWord, filterLevel, count) {
    const lines = []
    
    if (keyWord) {
      lines.push(`🔍 搜索关键词: "${keyWord}"`)
    }
    
    if (filterLevel) {
      lines.push(`📊 筛选级别: ${filterLevel}`)
    }
    
    lines.push(`✅ 匹配结果: ${count}条`)
    
    if (count === this.maxNum) {
      lines.push(`⚠️ 已达到显示上限(${this.maxNum}条)`)
    }
    
    return lines.join("\n")
  }

  buildBatchContent(batch, startIdx, pageNum, totalPages) {
    const lines = [
      `📄 第 ${pageNum}/${totalPages} 页`,
      `📍 范围: #${startIdx + 1} - #${startIdx + batch.length}`,
      ""
    ]
    
    // 添加编号的日志行
    batch.forEach((log, idx) => {
      lines.push(`[${startIdx + idx + 1}] ${log}`)
    })
    
    return lines.join("\n")
  }

  buildUsageInfo() {
    const platformInfo = logger.platform?.() || {}
    
    return [
      "💡 命令说明:",
      "• #日志 - 查看最近运行日志",
      "• #错误日志 - 仅显示ERROR级别",
      "• #调试日志 - 仅显示DEBUG级别",
      "• #追踪日志 - 查看trace日志",
      "• #日志100 - 指定显示行数",
      "• #日志 关键词 - 搜索特定内容",
      "",
      "📊 系统配置:",
      `• 最大显示: ${this.maxNum}行`,
      `• 分页大小: ${this.batchSize}条/页`,
      `• 主日志保留: ${platformInfo.mainLogAge || '3天'}`,
      `• 追踪日志保留: ${platformInfo.traceLogAge || '1天'}`
    ].join("\n")
  }

  async makeForwardMsg(e, msgList) {
    try {
      const msgs = msgList.map((msg, i) => ({
        message: msg.message,
        nickname: msg.nickname || "日志系统",
        user_id: String(msg.user_id || Bot.uin),
        time: Math.floor(Date.now() / 1000) - (msgList.length - i) * 2
      }))
      
      // 尝试多种API
      const makeForward = e.group?.makeForwardMsg || 
                         e.friend?.makeForwardMsg || 
                         e.bot?.makeForwardMsg ||
                         e.makeForwardMsg ||
                         Bot.makeForwardMsg
      
      if (!makeForward) {
        logger.error("[sendLog] 未找到可用的转发消息API")
        return null
      }
      
      const context = e.group || e.friend || e.bot || e || Bot
      return await makeForward.call(context, msgs)
      
    } catch (error) {
      logger.error(`[sendLog] 制作转发消息失败:`, error)
      return null
    }
  }

  async replyError(errorMsg) {
    try {
      const errorInfo = [
        "❌ 操作失败",
        errorMsg,
        "💡 请检查:",
        "• 日志文件是否存在",
        "• 命令格式是否正确",
        "• 搜索关键词是否准确"
      ].join("\n")
      
      const forwardMsg = await this.makeForwardMsg(this.e, [{
        message: errorInfo,
        nickname: "错误提示",
        user_id: Bot.uin
      }])
      
      await this.e.reply(forwardMsg || `❌ ${errorMsg}`)
      
    } catch (error) {
      logger.error(`[sendLog] 回复错误信息失败:`, error)
      await this.e.reply(`❌ ${errorMsg}`)
    }
    
    return false
  }
}