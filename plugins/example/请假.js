const instructorQQ = 123456789; // 这里应该替换为真实的导员QQ号
export class LeaveRequest extends plugin {
  constructor() {
    super({
      /** 功能名称 */
      name: '请假对话',
      /** 功能描述 */
      dsc: '模拟学生和导员的请假对话',
      /** https://oicqjs.github.io/oicq/#events */
      event: 'message',
      /** 优先级，数字越小等级越高 */
      priority: 5000,
      rule: [
        {
          /** 命令正则匹配，支持详细请假格式 */
          reg: "^#请假(.+):(.+):(.+):(.*)$",
          /** 执行方法 */
          fnc: 'DetailedLeaveRequest'
        }
      ]
    })
  }
  
  async DetailedLeaveRequest(e) {
    // 解析请假命令中的信息
    const match = e.msg.match(/^#请假(.+):(.+):(.+):(.*)$/);
    if (!match) return false;
    
    const className = match[1].trim();  // 班级
    const instructorName = match[2].trim();  // 导员名字
    const reason = match[3].trim();  // 请假原因，如发烧
    const period = match[4].trim();  // 请假时间段，如今天的晚自习
    
    // 学生QQ使用发送消息的用户QQ
    const studentQQ = e.user_id;
    // 获取学生昵称，如果没有则使用"同学"
    const studentName = e.sender?.card || e.sender?.nickname || "同学";
    
    // 构建完整的请假理由，带自我介绍
    const leaveReason = `导员，我是${className}，我因为${reason}，需要请假${period || ""}。希望您能批准，谢谢！`;
    
    // 导员的回复默认为"好"
    const teacherResponse = "好";
    
    // 构建对话消息
    let data_msg = [
      {
        message: leaveReason,
        nickname: studentName,
        user_id: studentQQ,
      },
      {
        message: teacherResponse,
        nickname: instructorName,
        user_id: instructorQQ,
      },
      {
        message: "谢谢老师！",
        nickname: studentName,
        user_id: studentQQ,
      }
    ];
    
    const ForwardMsg = await this.makeForwardMsg(e, data_msg, instructorName);
    
    e.reply(ForwardMsg); // 回复消息
    return true; // 返回true 阻挡消息不再往下
  }
  
  // 辅助函数：制作转发消息
  async makeForwardMsg(e, data_msg, instructorName) {
    let ForwardMsg;
    /** 制作转发内容 */
    if (e?.group?.makeForwardMsg) {
      ForwardMsg = await e.group.makeForwardMsg(data_msg);
    } else if (e?.friend?.makeForwardMsg) {
      ForwardMsg = await e.friend.makeForwardMsg(data_msg);
    } else {
      return data_msg.map(msg => msg.message).join('\n');
    }
    
    /** 处理描述 */
    if (typeof (ForwardMsg.data) === 'object') {
      let detail = ForwardMsg.data?.meta?.detail;
      if (detail) {
        detail.news = [{ text: "请假对话" }];
        detail.source = `和${instructorName}的聊天记录`;
        detail.summary = "学生请假通知";
      }
      if (ForwardMsg.data?.prompt) {
        ForwardMsg.data.prompt = "[请假记录]";
      }
    } else {
      // 置换合并转发中的特定文本
      let regExp = /<summary color=\"#808080\" size=\"26\">查看(\d+)条转发消息<\/summary>/g;
      let res = regExp.exec(ForwardMsg.data);
      
      ForwardMsg.data = ForwardMsg.data.replace(/<msg brief="\[聊天记录\]"/g, `<msg brief=\"[请假记录]\"`)
        .replace(/<title color=\"#000000\" size=\"34\">转发的聊天记录<\/title>/g, `<title color="#000000" size="34">和${instructorName}的聊天记录</title>`)
        .replace(/<summary color=\"#808080\" size=\"26\">查看(\d+)条转发消息<\/summary>/g, `<summary color="#808080" size="26">学生请假通知</summary>`)
        .replace(/\n/g, '')
        .replace(/<title color="#777777" size="26">.*?<\/title>/g, '<title color="#777777" size="26">请假对话</title>');
    }
    
    return ForwardMsg;
  }
}