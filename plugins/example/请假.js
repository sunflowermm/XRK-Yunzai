export class MessageFabricator extends plugin {
  constructor() {
    super({
      /** 功能名称 */
      name: '制造消息',
      /** 功能描述 */
      dsc: '制造自定义聊天记录，支持多条消息、自定义时间、图片、表情等多媒体内容',
      /** https://oicqjs.github.io/oicq/#events */
      event: 'message',
      /** 优先级，数字越小等级越高 */
      priority: 5000,
      rule: [
        {
          /** 命令正则匹配 */
          reg: "^#制造消息(.*)$",
          /** 执行方法 */
          fnc: 'fabricateMessages'
        },
        {
          /** 帮助命令 */
          reg: "^#制造消息帮助$",
          /** 执行方法 */
          fnc: 'showHelp'
        }
      ]
    })
  }
  
  async fabricateMessages(e) {
    // 获取命令内容
    const content = e.msg.replace(/^#制造消息/, '').trim();
    
    // 如果没有内容，显示帮助
    if (!content) {
      return this.showHelp(e);
    }
    
    try {
      // 解析消息格式：使用 || 分隔每条消息
      const messages = content.split('||').map(msg => msg.trim()).filter(msg => msg);
      
      if (messages.length === 0) {
        await e.reply('❌ 未检测到有效消息内容');
        return this.showHelp(e);
      }
      
      const data_msg = [];
      const currentTime = Math.floor(Date.now() / 1000);
      
      for (let i = 0; i < messages.length; i++) {
        const msgData = await this.parseMessage(messages[i], i, currentTime, e);
        if (!msgData) {
          return false;
        }
        data_msg.push(msgData);
      }
      
      // 生成转发消息标题
      const forwardTitle = this.generateTitle(data_msg);
      
      // 制作转发消息
      const ForwardMsg = await this.makeForwardMsg(e, data_msg, forwardTitle);
      
      if (ForwardMsg) {
        await e.reply(ForwardMsg);
      } else {
        await e.reply('❌ 生成转发消息失败，请检查消息格式');
      }
      
    } catch (error) {
      logger.error(`[MessageFabricator] 错误: ${error}`);
      await e.reply('❌ 处理消息时发生错误，请检查格式是否正确');
      return false;
    }
    
    return true;
  }
  
  // 解析单条消息
  async parseMessage(messageStr, index, currentTime, e) {
    // 解析格式：QQ号|昵称|消息内容|时间(可选)|额外参数(可选)
    const parts = messageStr.split('|').map(p => p.trim());
    
    if (parts.length < 3) {
      await e.reply(`❌ 第${index + 1}条消息格式错误！\n每条消息至少需要：QQ号|昵称|消息内容`);
      await this.showHelp(e);
      return null;
    }
    
    const [qq, nickname, content, timeStr, ...extraParams] = parts;
    
    // 处理QQ号
    const user_id = this.parseQQ(qq, e);
    if (!user_id) {
      await e.reply(`❌ 第${index + 1}条消息的QQ号格式错误：${qq}`);
      return null;
    }
    
    // 处理时间
    const msgTime = timeStr ? this.parseTime(timeStr, currentTime) : 
                    currentTime - (index * 60); // 默认每条间隔1分钟
    
    // 处理消息内容
    const processedContent = await this.processContent(content, e);
    
    // 构建消息对象
    const msgObj = {
      message: processedContent,
      nickname: nickname || '匿名用户',
      user_id: user_id,
      time: msgTime
    };
    
    // 处理额外参数（为未来扩展预留）
    if (extraParams.length > 0) {
      msgObj.extra = this.parseExtraParams(extraParams);
    }
    
    return msgObj;
  }
  
  // 解析QQ号
  parseQQ(qq, e) {
    // 支持特殊关键词
    const keywords = {
      'me': e.user_id,
      '我': e.user_id,
      'self': e.user_id,
      'bot': Bot.uin,
      '机器人': Bot.uin
    };
    
    const lowerQQ = qq.toLowerCase();
    if (keywords[lowerQQ]) {
      return keywords[lowerQQ];
    }
    
    // 支持@格式
    if (qq.startsWith('@')) {
      const atQQ = qq.substring(1);
      if (/^\d+$/.test(atQQ)) {
        return atQQ;
      }
    }
    
    // 普通QQ号
    if (/^\d+$/.test(qq)) {
      return qq;
    }
    
    return null;
  }
  
  // 处理消息内容，支持多种格式
  async processContent(content, e) {
    const processedContent = [];
    
    // 定义支持的标记类型
    const patterns = [
      { regex: /\[图片?:([^\]]+)\]/g, type: 'image' },
      { regex: /\[表情:([^\]]+)\]/g, type: 'face' },
      { regex: /\[语音:([^\]]+)\]/g, type: 'record' },
      { regex: /\[视频:([^\]]+)\]/g, type: 'video' },
      { regex: /\[文件:([^\]]+)\]/g, type: 'file' },
      { regex: /\[@(\d+)\]/g, type: 'at' },
      { regex: /\[骰子:(\d+)\]/g, type: 'dice' },
      { regex: /\[猜拳:([123])\]/g, type: 'rps' },
      { regex: /\[戳一戳\]/g, type: 'poke' }
    ];
    
    let workingContent = content;
    const segments = [];
    
    // 收集所有特殊标记的位置
    for (const pattern of patterns) {
      let match;
      pattern.regex.lastIndex = 0;
      while ((match = pattern.regex.exec(content)) !== null) {
        segments.push({
          start: match.index,
          end: match.index + match[0].length,
          type: pattern.type,
          value: match[1],
          raw: match[0]
        });
      }
    }
    
    // 按位置排序
    segments.sort((a, b) => a.start - b.start);
    
    // 构建最终内容
    let lastEnd = 0;
    for (const seg of segments) {
      // 添加纯文本部分
      if (seg.start > lastEnd) {
        const text = content.substring(lastEnd, seg.start);
        if (text) processedContent.push(text);
      }
      
      // 添加特殊内容
      const element = this.createSegment(seg.type, seg.value);
      if (element) {
        processedContent.push(element);
      }
      
      lastEnd = seg.end;
    }
    
    // 添加剩余文本
    if (lastEnd < content.length) {
      const text = content.substring(lastEnd);
      if (text) processedContent.push(text);
    }
    
    // 如果没有特殊内容，返回原始文本
    return processedContent.length > 0 ? processedContent : [content];
  }
  
  // 创建消息段
  createSegment(type, value) {
    try {
      switch (type) {
        case 'image':
          return segment.image(value);
        case 'face':
          return segment.face(parseInt(value) || 1);
        case 'record':
          return segment.record(value);
        case 'video':
          return segment.video(value);
        case 'file':
          return segment.file(value);
        case 'at':
          return segment.at(value);
        case 'dice':
          return segment.dice(parseInt(value) || 1);
        case 'rps':
          return segment.rps(parseInt(value) || 1);
        case 'poke':
          return segment.poke();
        default:
          return null;
      }
    } catch (error) {
      logger.warn(`[MessageFabricator] 创建${type}段失败: ${error}`);
      return null;
    }
  }
  
  // 解析时间字符串
  parseTime(timeStr, currentTime) {
    // 支持相对时间：-5s、-5m、-2h、-1d、-1w
    const relativeMatch = timeStr.match(/^-(\d+)([smhdw])$/);
    if (relativeMatch) {
      const value = parseInt(relativeMatch[1]);
      const unit = relativeMatch[2];
      const multipliers = { 
        's': 1,
        'm': 60, 
        'h': 3600, 
        'd': 86400,
        'w': 604800
      };
      return currentTime - (value * multipliers[unit]);
    }
    
    // 支持时间戳
    if (/^\d{10}$/.test(timeStr)) {
      return parseInt(timeStr);
    }
    
    // 支持 HH:MM 格式（今天的时间）
    const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (timeMatch) {
      const date = new Date();
      date.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0, 0);
      return Math.floor(date.getTime() / 1000);
    }
    
    // 支持 MM-DD HH:MM 格式
    const dateTimeMatch = timeStr.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
    if (dateTimeMatch) {
      const date = new Date();
      date.setMonth(parseInt(dateTimeMatch[1]) - 1);
      date.setDate(parseInt(dateTimeMatch[2]));
      date.setHours(parseInt(dateTimeMatch[3]), parseInt(dateTimeMatch[4]), 0, 0);
      return Math.floor(date.getTime() / 1000);
    }
    
    // 支持关键词
    const keywords = {
      'now': currentTime,
      '现在': currentTime,
      'yesterday': currentTime - 86400,
      '昨天': currentTime - 86400,
      'today': currentTime,
      '今天': currentTime
    };
    
    if (keywords[timeStr.toLowerCase()]) {
      return keywords[timeStr.toLowerCase()];
    }
    
    // 默认返回当前时间
    return currentTime;
  }
  
  // 解析额外参数（预留扩展）
  parseExtraParams(params) {
    const extra = {};
    for (const param of params) {
      const [key, value] = param.split('=').map(p => p.trim());
      if (key && value) {
        extra[key] = value;
      }
    }
    return extra;
  }
  
  // 生成转发消息标题
  generateTitle(messages) {
    if (messages.length === 0) return '聊天记录';
    
    const uniqueNicks = [...new Set(messages.map(m => m.nickname))];
    
    if (uniqueNicks.length === 1) {
      return `${uniqueNicks[0]}的消息`;
    } else if (uniqueNicks.length === 2) {
      return `${uniqueNicks[0]}和${uniqueNicks[1]}的对话`;
    } else {
      return `群聊记录(${messages.length}条)`;
    }
  }
  
  // 显示帮助信息
  async showHelp(e) {
    const helpMsg = `📝 制造消息使用说明

【基础格式】
#制造消息 QQ号|昵称|消息内容|时间

【多条消息】
使用 || 分隔：
#制造消息 消息1 || 消息2 || 消息3

【参数说明】
◆ QQ号：
  • 数字QQ号：123456789
  • 自己：me / 我 / self
  • 机器人：bot / 机器人
  • @格式：@123456789

◆ 时间（可选）：
  • 相对时间：-5s/-5m/-2h/-1d/-1w
  • 时间戳：1234567890
  • 今日时间：14:30
  • 日期时间：12-25 14:30
  • 关键词：now/现在/yesterday/昨天

◆ 内容标记：
  • 图片：[图片:URL] 或 [图:URL]
  • 表情：[表情:ID]
  • @某人：[@QQ号]
  • 语音：[语音:URL]
  • 视频：[视频:URL]
  • 文件：[文件:URL]
  • 骰子：[骰子:点数]
  • 猜拳：[猜拳:1/2/3]
  • 戳一戳：[戳一戳]

【使用示例】
◆ 简单对话：
#制造消息 10001|小明|你好 || me|我|你好呀

◆ 带时间的消息：
#制造消息 10086|客服|有什么可以帮您|14:20 || me|用户|查话费|-1m

◆ 多媒体消息：
#制造消息 bot|助手|看这张图[图片:http://xxx.jpg] || me|我|收到了[表情:13]

◆ 复杂场景：
#制造消息 10001|张三|[@10002]看这个文件[文件:http://xxx.pdf]|yesterday || 10002|李四|收到，我看看|-2h || me|我|大家辛苦了[戳一戳]|now`;
    
    await e.reply(helpMsg);
    return true;
  }
  
  // 制作转发消息
  async makeForwardMsg(e, data_msg, title) {
    try {
      const msgs = [];
      
      for (const msg of data_msg) {
        // 确保消息内容格式正确
        let content = msg.message;
        if (!Array.isArray(content)) {
          content = [content];
        }
        
        msgs.push({
          type: "node",
          data: {
            name: msg.nickname || "匿名消息",
            uin: String(msg.user_id || 80000000),
            content: content,
            time: msg.time || Math.floor(Date.now() / 1000)
          }
        });
      }
      
      // 根据消息平台制作转发消息
      if (e?.group?.makeForwardMsg) {
        return await e.group.makeForwardMsg(msgs);
      } else if (e?.friend?.makeForwardMsg) {
        return await e.friend.makeForwardMsg(msgs);
      } else {
        // 兼容性处理：返回格式化文本
        const textMsg = data_msg.map(msg => {
          const time = new Date(msg.time * 1000).toLocaleTimeString('zh-CN', { 
            hour: '2-digit', 
            minute: '2-digit' 
          });
          const content = Array.isArray(msg.message) ? 
            msg.message.map(m => typeof m === 'string' ? m : '[多媒体]').join('') : 
            msg.message;
          return `[${time}] ${msg.nickname}: ${content}`;
        }).join('\n');
        
        await e.reply(`📋 聊天记录\n${'─'.repeat(20)}\n${textMsg}`);
        return null;
      }
    } catch (error) {
      logger.error(`[MessageFabricator] 制作转发消息失败: ${error}`);
      return null;
    }
  }
}