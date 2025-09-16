export class MessageFabricator extends plugin {
  constructor() {
    super({
      name: '制造消息',
      dsc: '制造自定义聊天记录，支持文字、图片、视频',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: "^#制造消息帮助$",
          fnc: 'showHelp'
        },
        {
          reg: "^#制造消息(.+)$",
          fnc: 'fabricateMessages'
        }
      ]
    })
  }
  
  /**
   * 制造消息主函数
   */
  async fabricateMessages(e) {
    const content = e.msg.replace(/^#制造消息/, '').trim();
    
    if (!content || content === '帮助') {
      return false;
    }
    
    try {
      // 分割多条消息
      const messages = content.split('||').map(msg => msg.trim()).filter(msg => msg);
      
      if (messages.length === 0) {
        await e.reply('❌ 未检测到有效消息内容');
        return false;
      }
      
      const data_msg = [];
      
      // 解析每条消息
      for (let i = 0; i < messages.length; i++) {
        const msgData = await this.parseMessage(messages[i], i, e);
        if (!msgData) return false;
        data_msg.push(msgData);
      }
      
      // 生成转发消息
      const forwardMsg = await this.makeForwardMsg(e, data_msg);
      
      if (forwardMsg) {
        await e.reply(forwardMsg);
      } else {
        await e.reply('❌ 生成转发消息失败');
      }
      
    } catch (error) {
      logger.error(`[MessageFabricator] 错误: ${error}`);
      await e.reply('❌ 处理消息时发生错误');
      return false;
    }
    
    return true;
  }
  
  /**
   * 解析单条消息
   */
  async parseMessage(messageStr, index, e) {
    const parts = messageStr.split('|').map(p => p.trim());
    
    if (parts.length < 3) {
      await e.reply(`❌ 第${index + 1}条消息格式错误！\n格式：QQ号|昵称|消息内容`);
      return null;
    }
    
    const [qq, nickname, content] = parts;
    
    // 解析QQ号
    const user_id = this.parseQQ(qq, e);
    if (!user_id) {
      await e.reply(`❌ 第${index + 1}条消息的QQ号格式错误：${qq}`);
      return null;
    }
    
    // 处理消息内容
    const processedContent = this.processContent(content);
    
    return {
      message: processedContent,
      nickname: nickname || '匿名用户',
      user_id: user_id
    };
  }
  
  /**
   * 解析QQ号
   */
  parseQQ(qq, e) {
    const keywords = {
      'me': e.user_id,
      '我': e.user_id,
      'bot': Bot.uin,
      '机器人': Bot.uin
    };
    
    // 关键词匹配
    if (keywords[qq.toLowerCase()]) {
      return keywords[qq.toLowerCase()];
    }
    
    // 纯数字QQ号
    if (/^\d+$/.test(qq)) {
      return qq;
    }
    
    return null;
  }
  
  /**
   * 处理消息内容（图片、视频、文字）
   */
  processContent(content) {
    const processedContent = [];
    const segments = [];
    
    // 匹配图片和视频
    const imageRegex = /\[图片?:([^\]]+)\]/g;
    const videoRegex = /\[视频:([^\]]+)\]/g;
    
    let match;
    
    // 查找图片
    while ((match = imageRegex.exec(content)) !== null) {
      segments.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'image',
        value: match[1]
      });
    }
    
    // 查找视频
    while ((match = videoRegex.exec(content)) !== null) {
      segments.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'video',
        value: match[1]
      });
    }
    
    // 按位置排序
    segments.sort((a, b) => a.start - b.start);
    
    // 构建消息内容
    let lastEnd = 0;
    for (const seg of segments) {
      // 添加文本部分
      if (seg.start > lastEnd) {
        const text = content.substring(lastEnd, seg.start);
        if (text) processedContent.push(text);
      }
      
      // 添加媒体元素
      if (seg.type === 'image') {
        processedContent.push(segment.image(seg.value));
      } else if (seg.type === 'video') {
        processedContent.push(segment.video(seg.value));
      }
      
      lastEnd = seg.end;
    }
    
    // 添加剩余文本
    if (lastEnd < content.length) {
      const text = content.substring(lastEnd);
      if (text) processedContent.push(text);
    }
    
    return processedContent.length > 0 ? processedContent : content;
  }
  
  /**
   * 生成转发消息
   */
  async makeForwardMsg(e, msgList) {
    try {
      const msgs = [];
      
      for (const msg of msgList) {
        msgs.push({
          message: msg.message,
          nickname: msg.nickname,
          user_id: String(msg.user_id)
        });
      }
      
      // 创建转发消息
      let forwardMsg;
      if (e.group?.makeForwardMsg) {
        forwardMsg = await e.group.makeForwardMsg(msgs);
      } else if (e.friend?.makeForwardMsg) {
        forwardMsg = await e.friend.makeForwardMsg(msgs);
      } else {
        return null;
      }
      
      return forwardMsg;
      
    } catch (error) {
      logger.error(`[MessageFabricator] 制作转发消息失败: ${error}`);
      return null;
    }
  }
  
  /**
   * 显示帮助信息
   */
  async showHelp(e) {
    const helpMsg = `📝 制造消息使用说明

【基础格式】
#制造消息 QQ号|昵称|消息内容

【多条消息】
使用 || 分隔：
#制造消息 消息1 || 消息2 || 消息3

【参数说明】
◆ QQ号：
  • 数字QQ号：123456789
  • 自己：me / 我
  • 机器人：bot / 机器人

◆ 内容标记：
  • 图片：[图片:URL] 或 [图:URL]
  • 视频：[视频:URL]
  • 普通文字直接输入即可

【使用示例】
◆ 简单对话：
#制造消息 10001|小明|你好 || me|我|你好呀

◆ 带图片的消息：
#制造消息 bot|助手|看这张图[图片:http://xxx.jpg] || me|我|收到了

◆ 混合内容：
#制造消息 10001|张三|这是今天的视频[视频:http://xxx.mp4] || me|我|视频不错`;
    
    await e.reply(helpMsg);
    return true;
  }
}