import cfg from '../../lib/config/config.js'

export class quit extends plugin {
  constructor () {
    super({
      name: 'notice',
      dsc: '自动退群',
      event: ['notice.group.increase', 'request.group.invite']
    })
  }

  async accept () {
    const other = cfg.other
    if (other.autoQuit <= 0) return

    /** 请求阶段直接拒绝拉群邀请，避免遗漏入群事件 */
    if (this.e.post_type === 'request') {
      if (this.e.sub_type !== 'invite') return
      const inviter = Number(this.e.user_id)
      if (cfg.masterQQ.some(qq => Number(qq) === inviter)) {
        logger.mark(`[主人邀请] ${this.e.group_id}`)
        return
      }
      await this.e.bot.setGroupAddRequest(this.e.flag, false, '禁止拉群')
      logger.mark(`[自动拒绝拉群邀请] ${this.e.group_id}`)
      return
    }

    /** 仅处理机器人自身入群的通知 */
    if (this.e.user_id != this.e.bot.uin) return

    /** 拉取最新群信息与成员列表，防止人数判断失真 */
    const info = await this.e.group.getInfo().catch(() => ({}))
    const gl = await this.e.group.getMemberMap().catch(() => null)
    if (!gl) return

    /** 判断主人，主人邀请不退群 */
    for (let qq of cfg.masterQQ) {
      if (gl.has(Number(qq))) {
        logger.mark(`[主人拉群] ${this.e.group_id}`)
        return
      }
    }

    /** 自动退群：优先用 member_count，其次成员表大小 */
    const memberCount = Number(info?.member_count) || gl.size
    if (memberCount <= other.autoQuit && !this.e.group.is_owner) {
      await this.e.reply('禁止拉群，已自动退出')
      logger.mark(`[自动退群] ${this.e.group_id}`)
      setTimeout(() => {
        this.e.group.quit()
      }, 2000)
    }
  }
}
