/**
 * 更新 — 对齐 XRK-AGT / TRSS：
 * - #强制更新[插件]：始终 reset --hard
 * - #全部(强制)更新：先 pull；仅冲突再强制（已最新不强制）
 * - 静默 / 定时：不刷「开始」「已是最新」；有更新或失败才说话
 */
import path from 'node:path'
import lodash from 'lodash'
import cfg from '../../lib/config/config.js'
import { FileUtils } from '../../lib/utils/file-utils.js'
import { exec } from '../../lib/utils/exec-async.js'
import { Restart } from './restart.js'
import common from '../../lib/common/common.js'

const GIT_TIMEOUT_MS = 600_000
const DEFAULT_CRON = '0 0 12 * * *'
const CONFLICT_RE = /be overwritten by merge|CONFLICT|Would be overwritten|unmerged|needs merge/i

let uping = false

/** @typedef {'hard'|'onConflict'|'none'} ForceMode */

function autoUpdateCfg() {
  return cfg.bot?.autoUpdate || {}
}

function cronList(acfg) {
  const raw = acfg.cron
  const list = Array.isArray(raw) ? raw : (raw != null && String(raw).trim() ? [raw] : [DEFAULT_CRON])
  return list.map((c) => String(c).trim()).filter(Boolean)
}

export class update extends plugin {
  typeName = 'XRK-Yunzai'
  /** XRK 相关插件（主仓 #更新 时顺带） */
  xrkPlugins = [
    { name: 'XRK-plugin', requiredFiles: ['apps', 'package.json'] },
    { name: 'XRK-Genshin-Adapter-plugin', requiredFiles: ['apps', 'package.json'] },
  ]

  constructor() {
    super({
      name: '更新',
      dsc: '#更新 #强制更新 #全部更新；静默/定时有变更才通知',
      event: 'message',
      priority: 4000,
      rule: [
        { reg: '^#更新日志', fnc: 'updateLog' },
        { reg: '^#(强制)?更新', fnc: 'update' },
        { reg: '^#(静默)?全部(强制)?更新$', fnc: 'updateAll', permission: 'master' },
      ],
    })
  }

  get quiet() {
    return /^#静默全部(强制)?更新$/.test(this.e?.msg || '')
  }

  async init() {
    const acfg = autoUpdateCfg()
    if (acfg.enabled === false) {
      this.task = { name: '', fnc: '', cron: '' }
      return
    }
    const tasks = cronList(acfg).map((cron) => ({
      name: '定时更新',
      cron,
      fnc: () => this.scheduledUpdateAll(),
      log: false,
    }))
    this.task = tasks.length === 1 ? tasks[0] : tasks
  }

  /** @returns {ForceMode} */
  _forceModeFromMsg(msg = '') {
    if (/^#强制更新/.test(msg)) return 'hard'
    if (/全部强制更新/.test(msg)) return 'onConflict'
    return 'none'
  }

  pluginCwd(plugin = '') {
    return plugin ? path.join('plugins', plugin) : '.'
  }

  async _git(cmd, plugin = '') {
    try {
      const { stdout, stderr } = await exec(cmd, {
        cwd: this.pluginCwd(plugin),
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      })
      return { ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') }
    } catch (err) {
      return {
        ok: false,
        error: err,
        stdout: String(err?.stdout || ''),
        stderr: String(err?.stderr || ''),
        message: String(err?.message || err),
      }
    }
  }

  _isConflict(ret) {
    return CONFLICT_RE.test(`${ret.message || ''}\n${ret.stdout || ''}\n${ret.stderr || ''}`)
  }

  _isLatest(stdout) {
    return /Already up|已经是最新/i.test(stdout || '')
  }

  getPlugin(plugin = '') {
    if (!plugin) {
      plugin = this.e.msg.replace(/#(强制)?更新(日志)?/, '').trim()
      if (!plugin) return ''
    }
    if (!FileUtils.existsSync(path.join('plugins', plugin, '.git'))) return false
    this.typeName = plugin
    return plugin
  }

  async checkPluginIntegrity(plugin) {
    const pluginPath = path.join('plugins', plugin.name)
    if (!FileUtils.existsSync(pluginPath)) return false
    if (!FileUtils.existsSync(path.join(pluginPath, '.git'))) return false
    const ok = plugin.requiredFiles.every((f) => FileUtils.existsSync(path.join(pluginPath, f)))
    if (!ok) logger.mark(`[更新] ${plugin.name} 目录不完整，跳过`)
    return ok
  }

  async update() {
    if (!this.e.isMaster) return false
    if (uping) return this.reply('已有命令更新中..请勿重复操作')
    if (/详细|详情|面板|面版/.test(this.e.msg)) return false

    const plugin = this.getPlugin()
    if (plugin === false) return false

    uping = true
    let isUp = false
    try {
      const forceMode = this._forceModeFromMsg(this.e.msg)
      if (plugin === '') {
        isUp = await this.updateMainAndXRK(forceMode)
      } else {
        const result = await this.runUpdate(plugin, { forceMode })
        isUp = !!result.updated
      }
      this._scheduleRestartIfUpdated(isUp)
    } catch (error) {
      logger.error(`更新失败: ${error.message}`, error)
      await this.reply(`更新失败: ${error.message}`)
      return false
    } finally {
      uping = false
    }
    return true
  }

  async updateMainAndXRK(forceMode) {
    let isUp = false
    const main = await this.runUpdate('', { forceMode })
    if (main.updated) isUp = true

    await common.sleep(800)
    const tips = []
    for (const plugin of this.xrkPlugins) {
      if (!(await this.checkPluginIntegrity(plugin))) continue
      await common.sleep(800)
      const result = await this.runUpdate(plugin.name, { forceMode })
      if (result.updated) {
        isUp = true
        tips.push(`${plugin.name} 已更新`)
      }
    }
    if (tips.length && !this.quiet) await this.reply(`XRK插件：\n${tips.join('\n')}`)
    return isUp
  }

  /**
   * @param {string} plugin
   * @param {{ forceMode?: ForceMode, muteStart?: boolean, quiet?: boolean }} [opts]
   */
  async runUpdate(plugin = '', opts = {}) {
    const forceMode = opts.forceMode ?? this._forceModeFromMsg(this.e?.msg || '')
    const targetName = plugin || this.typeName || 'XRK-Yunzai'
    const lines = []
    const reply = async (msg) => {
      lines.push(msg)
      if (this.reply) await this.reply(msg)
    }

    const softCmd = 'git pull --no-rebase'
    const hardCmd = 'git reset --hard && git pull --rebase --allow-unrelated-histories'
    const oldCommitId = await this.getCommitId(plugin)

    if (forceMode === 'hard') {
      if (!opts.muteStart) await reply(`开始强制更新 ${targetName}`)
      const ret = await this._git(hardCmd, plugin)
      return this._finishUpdate(ret, {
        plugin, targetName, oldCommitId, lines, reply, forced: true, quiet: opts.quiet,
      })
    }

    if (!opts.muteStart) await reply(`开始更新 ${targetName}`)
    let ret = await this._git(softCmd, plugin)

    if (!ret.ok && forceMode === 'onConflict' && this._isConflict(ret)) {
      await reply(`${targetName} 拉取冲突，改为强制更新…`)
      ret = await this._git(hardCmd, plugin)
      return this._finishUpdate(ret, {
        plugin, targetName, oldCommitId, lines, reply, forced: true, quiet: opts.quiet,
      })
    }

    if (!ret.ok) {
      await this.gitErr(ret.error || new Error(ret.message), ret.stdout || ret.stderr)
      lines.push(`更新失败：${targetName}`)
      return { updated: false, status: 'failed', lines }
    }

    return this._finishUpdate(ret, {
      plugin, targetName, oldCommitId, lines, reply, forced: false, quiet: opts.quiet,
    })
  }

  async _finishUpdate(ret, ctx) {
    const { plugin, targetName, oldCommitId, lines, reply, forced, quiet } = ctx
    if (!ret.ok) {
      await this.gitErr(ret.error || new Error(ret.message), ret.stdout || ret.stderr)
      lines.push(`更新失败：${targetName}`)
      return { updated: false, status: 'failed', lines }
    }

    const time = await this.getTime(plugin)
    if (this._isLatest(ret.stdout)) {
      if (!quiet) await reply(`${targetName} 已是最新\n最后更新时间：${time}`)
      else lines.push(`${targetName} 已是最新`)
      return { updated: false, status: 'latest', lines }
    }

    const tag = forced ? '强制更新成功' : '更新成功'
    await reply(`${targetName} ${tag}\n更新时间：${time}`)
    const updateLog = await this.getLog(plugin, oldCommitId)
    if (updateLog) await reply(updateLog)
    return { updated: true, status: forced ? 'forced' : 'updated', lines }
  }

  async getCommitId(plugin = '') {
    const ret = await this._git('git rev-parse --short HEAD', plugin)
    return ret.ok ? lodash.trim(ret.stdout) : ''
  }

  async getTime(plugin = '') {
    const ret = await this._git('git log -1 --pretty=%cd --date=format:"%F %T"', plugin)
    return ret.ok ? (lodash.trim(ret.stdout) || '获取时间失败') : '获取时间失败'
  }

  async gitErr(err, stdout) {
    const msg = '更新失败！'
    const errMsg = err?.message || String(err)
    const stdoutStr = String(stdout || '')
    if (/Timed out|ETIMEDOUT|timeout|killed/i.test(errMsg)) {
      return this.reply?.(`${msg}\n命令超时（>${Math.round(GIT_TIMEOUT_MS / 60000)} 分钟），请检查网络`)
    }
    if (/Failed to connect|unable to access/i.test(errMsg)) {
      const remote = (errMsg.match(/'(.+?)'/g) || []).pop()?.replace(/'/g, '') || '未知地址'
      return this.reply?.(`${msg}\n连接失败：${remote}`)
    }
    if (CONFLICT_RE.test(errMsg) || CONFLICT_RE.test(stdoutStr)) {
      return this.reply?.(
        `${msg}\n存在冲突，请解决后再更新；或对单仓执行 #强制更新 <插件名> / #强制更新（主仓）放弃本地修改`
      )
    }
    return this.reply?.(`${msg}\n${errMsg}${stdoutStr ? `\n${stdoutStr}` : ''}`)
  }

  /**
   * @param {{ forceMode?: ForceMode, silent?: boolean, fromSchedule?: boolean }} [opts]
   */
  async updateAll(opts = {}) {
    if (this.e && !this.e.isMaster) return false
    if (uping) return this.reply?.('已有命令更新中..请勿重复操作')

    const msg = this.e?.msg || ''
    const acfg = autoUpdateCfg()
    const isSilent = opts.silent === true || opts.fromSchedule === true || this.quiet
    const forceMode = opts.forceMode ?? (
      opts.fromSchedule
        ? (acfg.forceOnConflict === false ? 'none' : 'onConflict')
        : this._forceModeFromMsg(msg)
    )
    const quiet = isSilent

    const collected = []
    const originalReply = this.reply?.bind(this)
    if (isSilent) {
      this.reply = async (message) => {
        collected.push(message)
      }
    } else if (forceMode === 'onConflict') {
      await this.reply?.('开始全部更新：已最新跳过强制，遇冲突再强制…')
    }

    uping = true
    let isUp = false
    const summary = { updated: [], latest: [], forced: [], failed: [] }
    const done = new Set()

    const note = (name, status) => {
      if (status === 'updated') summary.updated.push(name)
      else if (status === 'latest') summary.latest.push(name)
      else if (status === 'failed') summary.failed.push(name)
      else if (status === 'forced') summary.forced.push(name)
    }

    try {
      this.typeName = 'XRK-Yunzai'
      const root = await this.runUpdate('', { forceMode, muteStart: isSilent, quiet })
      if (root.updated) isUp = true
      note('XRK-Yunzai', root.status)
      done.add('main')

      const dirs = FileUtils.readDirSync('./plugins/') || []
      for (let plu of dirs) {
        if (done.has(plu)) continue
        const name = this.getPlugin(plu)
        if (name === false) continue
        await common.sleep(quiet ? 400 : 1000)
        const result = await this.runUpdate(name, { forceMode, muteStart: isSilent, quiet })
        if (result.updated) isUp = true
        note(name, result.status)
        done.add(name)
      }
    } catch (error) {
      logger.error(`[更新] 全部更新异常: ${error?.message || error}`, error)
      collected.push(`全部更新过程中出错: ${error?.message || error}`)
      summary.failed.push('(过程异常)')
      if (!isSilent) await originalReply?.(`全部更新过程中出错: ${error?.message || error}`)
    } finally {
      uping = false
      if (isSilent && originalReply) this.reply = originalReply
    }

    const hasNews = isUp || summary.failed.length > 0
    const digest = this._formatSummary(summary, forceMode, { omitLatest: isSilent })
    const pack = [
      digest,
      ...collected.filter((m) => typeof m !== 'string' || !/已是最新/.test(m)),
    ].filter(Boolean)

    if (opts.fromSchedule) {
      if (hasNews) await this.notifyMasters(pack, '定时更新汇总')
      this._scheduleRestartIfUpdated(isUp, true)
      return true
    }

    if (isSilent) {
      if (hasNews && originalReply && pack.length) {
        await originalReply(await common.makeForwardMsg(this.e, pack, '全部更新汇总'))
      }
    } else {
      await this.reply?.(digest)
    }

    this._scheduleRestartIfUpdated(isUp, false)
    return true
  }

  _formatSummary(summary, forceMode, opts = {}) {
    const modeHint = forceMode === 'hard'
      ? '模式：硬强制'
      : forceMode === 'onConflict'
        ? '模式：冲突才强制'
        : '模式：普通拉取'
    const lines = [
      `【更新汇总】${modeHint}`,
      summary.updated.length ? `已更新：${summary.updated.join('、')}` : null,
      summary.forced.length ? `冲突后强制：${summary.forced.join('、')}` : null,
      (!opts.omitLatest && summary.latest.length) ? `已是最新：${summary.latest.length} 个` : null,
      summary.failed.length ? `失败：${summary.failed.join('、')}` : null,
    ].filter(Boolean)
    if (lines.length === 1) lines.push('无仓库变更')
    return lines.join('\n')
  }

  async scheduledUpdateAll() {
    if (uping) return
    this.e = {
      isMaster: true,
      msg: '#静默全部强制更新',
      logFnc: '[定时更新]',
      user_id: cfg.masterQQ?.[0],
    }
    try {
      await this.updateAll({ silent: true, fromSchedule: true })
    } catch (err) {
      logger.error(`[更新] 定时更新失败: ${err?.message || err}`, err)
    }
  }

  async notifyMasters(messages, title = '更新汇总') {
    const flat = messages.flatMap((m) => {
      if (m == null) return []
      if (typeof m === 'string' || typeof m === 'number') return [String(m)]
      return [m]
    })
    if (!flat.length) return
    const text = `${title}\n\n${flat.map((m) => (typeof m === 'string' ? m : String(m))).join('\n\n')}`
    try {
      await Bot.sendMasterMsg(text)
    } catch (err) {
      logger.error(`[更新] 推送主人失败: ${err?.message || err}`)
    }
  }

  _scheduleRestartIfUpdated(didUpdate, fromSchedule = false) {
    if (!didUpdate) return
    if (fromSchedule) {
      setTimeout(() => process.exit(1), 2000)
      return
    }
    setTimeout(() => new Restart(this.e).restart(), 2000)
  }

  async getLog(plugin = '', oldCommitId = null) {
    const ret = await this._git('git log -100 --pretty="%h||[%cd] %s" --date=format:"%F %T"', plugin)
    if (!ret.ok || !ret.stdout) {
      if (ret.message) await this.reply?.(ret.message)
      return false
    }

    const log = []
    for (const line of ret.stdout.trim().split('\n')) {
      const parts = line.split('||')
      if (oldCommitId && parts[0] === oldCommitId) break
      if (parts[1]?.includes('Merge branch')) continue
      log.push(parts[1])
    }
    if (!log.length) return ''

    let repoUrl = ''
    const cfgRet = await this._git('git config -l', plugin)
    if (cfgRet.ok) {
      repoUrl = cfgRet.stdout
        ?.match(/remote\..*\.url=.+/g)
        ?.map((u) => u.replace(/remote\..*\.url=/, '').replace(/\/\/([^@]+)@/, '//'))
        .join('\n\n') || ''
    }

    if (this.e?.group || this.e?.friend) {
      return common.makeForwardMsg(
        this.e,
        [log.join('\n\n'), repoUrl].filter(Boolean),
        `${plugin || 'XRK-Yunzai'} 更新日志，共${log.length}条`
      )
    }
    return `${plugin || 'XRK-Yunzai'} 更新日志，共${log.length}条\n\n${log.join('\n')}${repoUrl ? `\n\n${repoUrl}` : ''}`
  }

  async updateLog() {
    const plugin = this.getPlugin()
    if (plugin === false) return false
    return this.reply(await this.getLog(plugin, null))
  }
}
