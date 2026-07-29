/**
 * 重启与关机 — 对齐 XRK-AGT：
 * - #重启 → exit(1) 热重启（守护自动拉起）
 * - #热关机 / #停机 → Redis 停消息，可 #开机
 * - #关机 → exit(0) 真关机回菜单
 * - #开机 → 清除热关机标记
 */
export class Restart extends plugin {
  key = 'Yz:restart'
  shutdownKey = 'Yz:shutdown'

  constructor(e = '') {
    super({
      name: '重启与关机',
      dsc: '#重启 #热关机 #停机 #关机 #开机',
      event: 'message',
      priority: 10,
      rule: [
        { reg: '^#重启$', fnc: 'restart', permission: 'master' },
        { reg: '^#(热关机|停机)$', fnc: 'hotStop', permission: 'master' },
        { reg: '^#关机$', fnc: 'powerOff', permission: 'master' },
        { reg: '^#开机$', fnc: 'start', permission: 'master' },
      ],
    })
    if (e) this.e = e
  }

  _uin() {
    return this.e?.self_id || this.e?.bot?.uin || Bot.uin?.[0] || ''
  }

  async restart() {
    const uin = this._uin()
    await this.e.reply('开始执行重启，请稍等...')

    const adapter = this.e?.adapter ?? (this.e?.post_type === 'device' ? 'device' : '')
    const data = JSON.stringify({
      uin,
      isGroup: !!this.e.isGroup,
      id: this.e.isGroup ? this.e.group_id : this.e.user_id,
      time: Date.now(),
      user_id: this.e.user_id,
      adapter,
      sender: {
        card: this.e.sender?.card || this.e.sender?.nickname,
        nickname: this.e.sender?.nickname,
      },
    })

    const saveKey = `${this.key}:${uin}`
    await redis.set(saveKey, data, { EX: 300 })
    logger.mark(`[重启] 保存重启信息到 ${saveKey}`)
    setTimeout(() => process.exit(1), 1000)
    return true
  }

  /** Redis 标记停机：进程仍在，仅忽略消息；`#开机` 恢复 */
  async hotStop() {
    const uin = this._uin()
    try {
      await redis.set(`${this.shutdownKey}:${uin}`, 'true')
      await this.e.reply('热关机成功，已停止处理消息。发送"#开机"可恢复运行')
      logger.mark(`[热关机][${uin}] 机器人已热关机`)
      return true
    } catch (error) {
      logger.error(`[热关机失败][${uin}]: ${error.message}`)
      await this.e.reply(`热关机失败: ${error.message}`)
      return false
    }
  }

  /** 真关机：子进程 exit(0)，菜单守护回菜单 */
  async powerOff() {
    await this.e.reply('正在关机，返回菜单…')
    logger.mark('[关机] 进程退出，返回菜单')
    setTimeout(() => process.exit(0), 1000)
    return true
  }

  async start() {
    const uin = this._uin()
    const isShutdown = await redis.get(`${this.shutdownKey}:${uin}`)
    if (isShutdown !== 'true') {
      await this.e.reply('机器人已经处于开机状态')
      return false
    }
    await redis.del(`${this.shutdownKey}:${uin}`)
    await this.e.reply('开机成功，恢复正常运行')
    logger.mark(`[开机][${uin}] 机器人已开机`)
    return true
  }
}
