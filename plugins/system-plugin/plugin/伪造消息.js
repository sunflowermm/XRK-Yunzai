import {
  FABRICATOR_HELP,
  buildFabricatorMsgList,
  fabricatorContextFromEvent,
  makeFabricatorForwardMsg
} from '../lib/message-fabricator.js';

export class MessageFabricator extends plugin {
  constructor() {
    super({
      name: '制造消息',
      dsc: '制造自定义聊天记录，支持文字、图片、视频、时间伪造',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^#制造消息帮助$', fnc: 'showHelp' },
        { reg: '^#制造消息(.+)$', fnc: 'fabricateMessages' }
      ]
    });
  }

  async fabricateMessages(e) {
    const content = e.msg.replace(/^#制造消息/, '').trim();
    if (!content || content === '帮助') return false;

    try {
      const ctx = fabricatorContextFromEvent(e);
      const data_msg = buildFabricatorMsgList(content, ctx);
      const forwardMsg = await makeFabricatorForwardMsg(e, data_msg);
      if (forwardMsg) {
        await e.reply(forwardMsg);
      } else {
        await e.reply('❌ 生成转发消息失败');
      }
    } catch (error) {
      Bot.makeLog('error', `[MessageFabricator] ${error?.message || error}`, 'FakeMsg');
      await e.reply(`❌ ${error?.message || '处理消息时发生错误'}`);
      return false;
    }
    return true;
  }

  async showHelp(e) {
    await e.reply(FABRICATOR_HELP);
    return true;
  }
}
