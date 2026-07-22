export class newcomer extends plugin {
  constructor () {
    super({
      name: '欢迎新人',
      dsc: '新人入群欢迎',
      event: 'notice.group.increase',
      priority: 5000
    })
  }

  async accept () {
    const e = this.e
    if (e.user_id === e.self_id || e.user_id === e.bot?.uin) return

    await this.reply([
      segment.at(e.user_id),
      ' ',
      '欢迎新人！'
    ])
  }
}

export class outNotice extends plugin {
  constructor () {
    super({
      name: '退群通知',
      dsc: 'xx退群了',
      event: 'notice.group.decrease'
    })

    this.tips = '退群了'
  }

  async accept () {
    const e = this.e
    if (e.user_id === e.self_id || e.user_id === e.bot?.uin) return

    let msg
    if (e.member) {
      const name = e.member.card || e.member.nickname
      msg = name ? `${name}(${e.user_id}) ${this.tips}` : `${e.user_id} ${this.tips}`
    } else {
      msg = `${e.user_id} ${this.tips}`
    }
    Bot.makeLog('mark', `[退出通知]${e.logText} ${msg}`, 'GroupNotice')
    await this.reply(msg)
  }
}
