import cfg from '../../../lib/config/config.js'

export class invite extends plugin {
  constructor () {
    super({
      name: 'invite',
      dsc: '主人邀请自动进群',
      event: 'request.group.invite'
    })
  }

  isMaster (userId) {
    const masters = cfg.masterQQ
    if (!masters?.length) return false
    const id = Number(userId)
    return masters.some(qq => Number(qq) === id)
  }

  groupLabel () {
    return this.e.group_name || this.e.group_id
  }

  async accept () {
    const inviter = Number(this.e.user_id)
    const label = this.groupLabel()

    if (this.isMaster(inviter)) {
      Bot.makeLog('mark', `[主人邀请加群]：${label}：${this.e.group_id}`, 'Invite')
      await this.e.approve(true)
      try {
        await this.e.bot.pickFriend(inviter).sendMsg(`已同意加群：${label}`)
      } catch (err) {
        Bot.makeLog('error', err, 'Invite')
      }
      return
    }

    Bot.makeLog('mark', `[邀请加群]：${label}：${this.e.group_id}`, 'Invite')

    const autoQuit = cfg.other?.autoQuit ?? 0
    if (autoQuit <= 0) return

    await this.e.approve(false, '禁止拉群')
    Bot.makeLog('mark', `[自动拒绝拉群邀请] ${this.e.group_id}`, 'Invite')
  }
}
