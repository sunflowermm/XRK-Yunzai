import EventListener from '../../../lib/listener/listener.js';

export default class onlineEvent extends EventListener {
  constructor() {
    super({ event: 'online', once: true });
  }

  async execute() {
    Bot.makeLog('info', '尽情享受吧QaQ', 'event');
  }
}