export class MessageFabricator extends plugin {
  constructor() {
    super({
      name: '制造消息',
      dsc: '制造自定义聊天记录，支持多条消息、自定义时间、图片、表情等多媒体内容',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: "^#制造消息(.*)$",
          fnc: 'fabricateMessages'
        },
        {
          reg: "^#制造消息帮助$",
          fnc: 'showHelp'
        }
      ]
    })
  }
  
  async fabricateMessages(e) {
    const content = e.msg.replace(/^#制造消息/, '').trim();
    
    if (!content) {
      return this.showHelp(e);
    }
    
    try {
      const messages = content.split('||').map(msg => msg.trim()).filter(msg => msg);
      
      if (messages.length === 0) {
        await e.reply('❌ 未检测到有效消息内容');
        return false;
      }
      
      const data_msg = [];
      const currentTime = Math.floor(Date.now() / 1000);
      
      for (let i = 0; i < messages.length; i++) {
        const msgData = await this.parseMessage(messages[i], i, currentTime, e);
        if (!msgData) return false;
        data_msg.push(msgData);
      }
      
      const forwardMsg = await this.makeForwardMsg(e, data_msg);
      
      if (forwardMsg) {
        await e.reply(forwardMsg);
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
  
  async parseMessage(messageStr, index, currentTime, e) {
    const parts = messageStr.split('|').map(p => p.trim());
    
    if (parts.length < 3) {
      await e.reply(`❌ 第${index + 1}条消息格式错误！\n每条消息至少需要：QQ号|昵称|消息内容`);
      return null;
    }
    
    const [qq, nickname, content, timeStr, ...extraParams] = parts;
    
    const user_id = this.parseQQ(qq, e);
    if (!user_id) {
      await e.reply(`❌ 第${index + 1}条消息的QQ号格式错误：${qq}`);
      return null;
    }
    
    const msgTime = timeStr ? this.parseTime(timeStr, currentTime) : 
                    currentTime - (index * 60);
    
    const processedContent = await this.processContent(content, e);
    
    return {
      message: processedContent,
      nickname: nickname || '匿名用户',
      user_id: user_id,
      time: msgTime
    };
  }
  
  parseQQ(qq, e) {
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
    
    if (qq.startsWith('@')) {
      const atQQ = qq.substring(1);
      if (/^\d+$/.test(atQQ)) {
        return atQQ;
      }
    }
    
    if (/^\d+$/.test(qq)) {
      return qq;
    }
    
    return null;
  }
  
  async processContent(content, e) {
    const processedContent = [];
    
    const patterns = [
      { regex: /$$图片?:([^$$]+)\]/g, type: 'image' },
      { regex: /$$表情:([^$$]+)\]/g, type: 'face' },
      { regex: /$$语音:([^$$]+)\]/g, type: 'record' },
      { regex: /$$视频:([^$$]+)\]/g, type: 'video' },
      { regex: /$$文件:([^$$]+)\]/g, type: 'file' },
      { regex: /$$@(\d+)$$/g, type: 'at' },
      { regex: /$$骰子:(\d+)$$/g, type: 'dice' },
      { regex: /$$猜拳:([123])$$/g, type: 'rps' },
      { regex: /$$戳一戳$$/g, type: 'poke' }
    ];
    
    const segments = [];
    
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
    
    segments.sort((a, b) => a.start - b.start);
    
    let lastEnd = 0;
    for (const seg of segments) {
      if (seg.start > lastEnd) {
        const text = content.substring(lastEnd, seg.start);
        if (text) processedContent.push(text);
      }
      
      const element = this.createSegment(seg.type, seg.value);
      if (element) {
        processedContent.push(element);
      }
      
      lastEnd = seg.end;
    }
    
    if (lastEnd < content.length) {
      const text = content.substring(lastEnd);
      if (text) processedContent.push(text);
    }
    
    return processedContent.length > 0 ? processedContent : [content];
  }
  
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
  
  parseTime(timeStr, currentTime) {
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
    
    if (/^\d{10}$/.test(timeStr)) {
      return parseInt(timeStr);
    }
    
    const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (timeMatch) {
      const date = new Date();
      date.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0, 0);
      return Math.floor(date.getTime() / 1000);
    }
    
    const dateTimeMatch = timeStr.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
    if (dateTimeMatch) {
      const date = new Date();
      date.setMonth(parseInt(dateTimeMatch[1]) - 1);
      date.setDate(parseInt(dateTimeMatch[2]));
      date.setHours(parseInt(dateTimeMatch[3]), parseInt(dateTimeMatch[4]), 0, 0);
      return Math.floor(date.getTime() / 1000);
    }
    
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
    
    return currentTime;
  }
  
  async makeForwardMsg(e, msgList) {
    try {
      const msgs = [];
      
      for (const msg of msgList) {
        let content = msg.message;
        if (!Array.isArray(content)) {
          content = [content];
        }
        
        msgs.push({
          type: "node",
          data: {
            name: msg.nickname || "匿名消息",
            uin: String(Number(msg.user_id) || 80000000),
            content: content,
            time: msg.time || Math.floor(Date.now() / 1000)
          }
        });
      }
      
      if (e.bot?.adapter?.makeForwardMsg) {
        return await e.bot.adapter.makeForwardMsg(msgs);
      } else if (e.group?.makeForwardMsg) {
        return await e.group.makeForwardMsg(msgs);
      } else if (e.friend?.makeForwardMsg) {
        return await e.friend.makeForwardMsg(msgs);
      } else {
        const textMsg = msgList.map(msg => {
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
}