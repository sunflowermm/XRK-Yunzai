import cfg from '../../../lib/config/config.js'

export class quit extends plugin {
  constructor () {
    super({
      name: 'notice',
      dsc: '自动退群',
      event: 'notice.group.increase'
    })
  }

  async accept () {
    const other = cfg.other
    if (other.autoQuit <= 0) return

    /** 仅处理机器人自身入群的通知 */
    if (this.e.user_id != this.e.bot.uin) return

    /** 邀请人（operator_id）优先判定，少数群可能没有单独的邀请事件 */
    const inviter = Number(this.e.operator_id || this.e.inviter_id || 0)
    if (inviter && cfg.masterQQ.some(qq => Number(qq) === inviter)) {
      Bot.makeLog('mark', `[主人邀请] ${this.e.group_id}`, 'Quit')
      return
    }

    /** 拉取最新群信息与成员列表，防止人数判断失真 */
    const group = this.e.group || this.e.bot?.pickGroup?.(this.e, this.e.group_id)
    if (!group) return

    const info = await group.getInfo().catch(() => ({}))
    const gl = await group.getMemberMap().catch(() => null)

    /** 判断主人已在群中，主人在则不退群 */
    if (gl) {
      for (let qq of cfg.masterQQ) {
        if (gl.has(Number(qq))) {
          Bot.makeLog('mark', `[主人拉群] ${this.e.group_id}`, 'Quit')
          return
        }
      }
    }

    /** 自动退群：优先用 member_count，其次成员表大小，最后兜底为 0 */
    const memberCount = Number(info?.member_count) || gl?.size || 0
    if (memberCount <= other.autoQuit && !group.is_owner) {
      await this.e.reply('禁止拉群，已自动退出')
      Bot.makeLog('mark', `[自动退群] ${this.e.group_id} (inviter: ${inviter || 'unknown'})`, 'Quit')
      setTimeout(() => {
        group.quit()
      }, 2000)
    }
  }
}
