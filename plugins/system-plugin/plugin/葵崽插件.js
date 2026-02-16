import fs from 'fs'
import path from 'path'
import { spawn, execSync, exec } from 'child_process'
import { promisify } from 'util'
import common from '../../../lib/common/common.js'

const execAsync = promisify(exec)
let updateLogs = []

const REPOS = [
  { name: 'XRK-plugin', url: 'https://gitcode.com/Xrkseek/XRK-plugin', urlGitHub: 'https://github.com/sunflowermm/XRK-plugin', requiredFiles: ['apps', 'package.json'] },
  { name: 'XRK-Genshin-Adapter-plugin', url: 'https://gitcode.com/Xrkseek/XRK-Genshin-Adapter-plugin', urlGitHub: 'https://github.com/sunflowermm/XRK-Genshin-Adapter-plugin', requiredFiles: ['apps', 'package.json'] }
]

export class example2 extends plugin {
  constructor() {
    super({
      name: '向日葵妈咪妈咪哄',
      dsc: '一键安装/更新向日葵插件与原神适配器',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^(#)?向日葵妈咪妈咪哄$', fnc: 'handleXRK', permission: 'master' }
      ]
    })
  }

  async handleXRK() {
    const pluginsPath = path.join(process.cwd(), 'plugins')
    const results = []
    updateLogs = []

    await this.reply('🌻 开始处理 XRK 仓库...', false, { at: true })

    for (const repo of REPOS) {
      try {
        results.push(await this.processRepo(pluginsPath, repo))
      } catch (err) {
        results.push(`❌ ${repo.name}: ${err.message}`)
        logger.error(`[XRK] 处理 ${repo.name} 时出错:`, err)
      }
    }

    await this.reply(`处理完成！\n${results.join('\n')}`, false, { at: true })
    if (updateLogs.length > 0) {
      const forwardMsg = await common.makeForwardMsg(this.e, updateLogs, 'XRK仓库更新日志')
      await this.reply(forwardMsg)
    }
  }

  async processRepo(pluginsPath, repo) {
    const repoPath = path.join(pluginsPath, repo.name)
    if (!fs.existsSync(repoPath)) return await this.cloneRepo(pluginsPath, repo)
    const isComplete = repo.requiredFiles.every(f => fs.existsSync(path.join(repoPath, f)))
    if (!isComplete) {
      logger.info(`[XRK] ${repo.name} 目录不完整，重新克隆...`)
      await this.removeDirectory(repoPath)
      return await this.cloneRepo(pluginsPath, repo)
    }
    return await this.updateRepo(repoPath, repo)
  }

  getCommitId(repoPath) {
    try {
      return execSync('git rev-parse --short HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim()
    } catch {
      return null
    }
  }

  getUpdateTime(repoPath) {
    try {
      return execSync('git log -1 --pretty=%cd --date=format:"%F %T"', { cwd: repoPath, encoding: 'utf-8' }).trim()
    } catch {
      return '获取时间失败'
    }
  }

  getUpdateLog(repoPath, oldCommitId, repoName) {
    try {
      const logAll = execSync('git log -100 --pretty="%h||[%cd] %s" --date=format:"%F %T"', { cwd: repoPath, encoding: 'utf-8' })
      const lines = logAll.trim().split('\n')
      const list = []
      for (const str of lines) {
        const [commitId, message] = str.split('||')
        if (commitId === oldCommitId) break
        if (message && !message.includes('Merge branch')) list.push(message)
      }
      return list.length ? `${repoName} 更新内容（共${list.length}条）：\n\n${list.join('\n\n')}` : null
    } catch (err) {
      logger.error('[XRK] 获取更新日志失败:', err)
      return null
    }
  }

  async cloneRepo(pluginsPath, repo) {
    const tryClone = (url) =>
      new Promise((resolve, reject) => {
        const git = spawn('git', ['clone', '--progress', url, repo.name], { cwd: pluginsPath, stdio: ['inherit', 'pipe', 'pipe'] })
        git.stderr.on('data', d => process.stderr.write(d.toString()))
        git.stdout.on('data', d => process.stdout.write(d.toString()))
        git.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`退出码: ${code}`))))
        git.on('error', (err) => reject(new Error(`无法启动 git: ${err.message}`)))
      })

    try {
      await tryClone(repo.url)
    } catch (err) {
      if (repo.urlGitHub) {
        logger.warn(`[XRK] ${repo.name} GitCode 克隆失败，尝试 GitHub: ${err.message}`)
        await tryClone(repo.urlGitHub)
      } else {
        throw err
      }
    }

    const time = this.getUpdateTime(path.join(pluginsPath, repo.name))
    return `✅ ${repo.name}: 克隆成功\n更新时间：${time}`
  }

  async updateRepo(repoPath, repo) {
    const oldCommitId = this.getCommitId(repoPath)
    return new Promise((resolve, reject) => {
      const git = spawn('git', ['pull', '--progress'], { cwd: repoPath, stdio: ['inherit', 'pipe', 'pipe'] })
      let output = ''
      let errOut = ''
      git.stdout.on('data', (d) => { const s = d.toString(); output += s; process.stdout.write(s) })
      git.stderr.on('data', (d) => { const s = d.toString(); errOut += s; process.stderr.write(s) })
      git.on('close', (code) => {
        if (code !== 0) return reject(new Error(`更新失败，退出码: ${code}`))
        const time = this.getUpdateTime(repoPath)
        if (output.includes('Already up to date') || errOut.includes('Already up to date')) {
          return resolve(`📌 ${repo.name}: 已是最新版本\n最后更新时间：${time}`)
        }
        const newCommitId = this.getCommitId(repoPath)
        if (oldCommitId && newCommitId && oldCommitId !== newCommitId) {
          const log = this.getUpdateLog(repoPath, oldCommitId, repo.name)
          if (log) updateLogs.push(log)
        }
        resolve(`✅ ${repo.name}: 更新成功\n更新时间：${time}`)
      })
      git.on('error', (err) => reject(new Error(`无法启动 git: ${err.message}`)))
    })
  }

  async removeDirectory(dirPath) {
    try {
      if (fs.existsSync(dirPath)) await fs.promises.rm(dirPath, { recursive: true, force: true })
    } catch {
      const cmd = process.platform === 'win32' ? `rmdir /s /q "${dirPath}"` : `rm -rf "${dirPath}"`
      try {
        await execAsync(cmd)
      } catch (err) {
        logger.error('[XRK] 删除目录失败:', dirPath, err)
        throw new Error(`无法删除目录: ${err.message}`)
      }
    }
  }
}
