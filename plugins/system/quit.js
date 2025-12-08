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
      const inviter = Number(this.e.user_id || this.e.inviter_id || this.e.invitor_id || 0)
      if (cfg.masterQQ.some(qq => qq * 1 === inviter)) {
        logger.mark(`[主人邀请] ${this.e.group_id}`)
        return
      }
      await this.e.bot.setGroupAddRequest(this.e.flag, false, '禁止拉群')
      logger.mark(`[自动拒绝拉群邀请] ${this.e.group_id}`)
      return
    }

    /** 仅处理机器人自身入群的通知（Napcat 可能把目标放在 target_id） */
    const targetId = Number(this.e.user_id ?? this.e.target_id ?? this.e.self_id ?? 0)
    if (targetId !== Number(this.e.bot.uin)) return

    /** 邀请人（operator_id）优先判定，少数群可能没有单独的邀请事件 */
    const inviter = Number(
      this.e.operator_id ||
      this.e.inviter_id ||
      this.e.invitor_id ||
      // 部分上报会把邀请人塞在 user_id
      (this.e.user_id !== targetId ? this.e.user_id : 0) ||
      0
    )
    if (inviter && cfg.masterQQ.some(qq => qq * 1 === inviter)) {
      logger.mark(`[主人邀请] ${this.e.group_id}`)
      return
    }

    /** 拉取最新群信息与成员列表，防止人数判断失真 */
    const group = this.e.group || this.e.bot?.pickGroup?.(this.e.group_id)
    if (!group) return

    const info = await group.getInfo().catch(() => ({}))
    const gl = await group.getMemberMap().catch(() => null)

    /** 判断主人已在群中，主人在则不退群 */
    if (gl) {
      for (let qq of cfg.masterQQ) {
        if (gl.has(Number(qq))) {
          logger.mark(`[主人拉群] ${this.e.group_id}`)
          return
        }
      }
    }

    /** 自动退群：优先用 member_count，其次成员表大小，最后兜底为 0 */
    const memberCount = Number(info?.member_count) || gl?.size || 0
    if (memberCount <= other.autoQuit && !group.is_owner) {
      await this.e.reply('禁止拉群，已自动退出')
      logger.mark(`[自动退群] ${this.e.group_id} (inviter: ${inviter || 'unknown'})`)
      setTimeout(() => {
        group.quit()
      }, 2000)
    }
  }
}
