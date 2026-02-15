import fs from 'fs'
import path from 'path'
import { spawn, exec, execSync } from 'child_process'
import { promisify } from 'util'
import common from '../../../lib/common/common.js'

const execAsync = promisify(exec)

let updateLogs = []

export class example2 extends plugin {
  constructor() {
    super({
      name: '向日葵妈咪妈咪哄',
      dsc: '自动克隆或更新 XRK / XRK-Core 仓库',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^(#)?向日葵妈咪妈咪哄$', fnc: 'handleXRK', permission: 'master' }
      ]
    })
  }

  async handleXRK() {
    const pluginsPath = path.join(process.cwd(), 'plugins')
    const repos = [
      { name: 'XRK-plugin', url: 'https://gitcode.com/Xrkseek/XRK-plugin', requiredFiles: ['apps', 'package.json'] },
      { name: 'XRK-Core', url: 'https://gitcode.com/Xrkseek/XRK-Core', requiredFiles: ['index.js'] }
    ]

    await this.reply('🌻 开始处理 XRK 仓库...', false, { at: true })
    const results = []
    updateLogs = []

    for (const repo of repos) {
      try {
        results.push(await this.processRepo(pluginsPath, repo))
      } catch (error) {
        results.push(`❌ ${repo.name}: ${error.message}`)
        logger.error(`[XRK] 处理 ${repo.name} 时出错:`, error)
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
      if (!logAll) return null
      const lines = logAll.trim().split('\n')
      const list = []
      for (const str of lines) {
        const [commitId, message] = str.split('||')
        if (commitId === oldCommitId) break
        if (message && !message.includes('Merge branch')) list.push(message)
      }
      if (list.length === 0) return null
      return `${repoName} 更新内容（共${list.length}条）：\n\n${list.join('\n\n')}`
    } catch (error) {
      logger.error('[XRK] 获取更新日志失败:', error)
      return null
    }
  }

  async cloneRepo(pluginsPath, repo) {
    return new Promise((resolve, reject) => {
      const git = spawn('git', ['clone', '--progress', repo.url, repo.name], {
        cwd: pluginsPath,
        stdio: ['inherit', 'pipe', 'pipe']
      })
      git.stderr.on('data', d => process.stderr.write(d.toString()))
      git.stdout.on('data', d => process.stdout.write(d.toString()))
      git.on('close', async code => {
        if (code === 0) {
          const time = this.getUpdateTime(path.join(pluginsPath, repo.name))
          resolve(`✅ ${repo.name}: 克隆成功\n更新时间：${time}`)
        } else reject(new Error(`克隆失败，退出码: ${code}`))
      })
      git.on('error', err => reject(new Error(`无法启动 git: ${err.message}`)))
    })
  }

  async updateRepo(repoPath, repo) {
    const oldCommitId = this.getCommitId(repoPath)
    return new Promise((resolve, reject) => {
      const git = spawn('git', ['pull', '--progress'], { cwd: repoPath, stdio: ['inherit', 'pipe', 'pipe'] })
      let output = ''
      let errorOutput = ''
      git.stdout.on('data', d => { const s = d.toString(); output += s; process.stdout.write(s) })
      git.stderr.on('data', d => { const s = d.toString(); errorOutput += s; process.stderr.write(s) })
      git.on('close', async code => {
        if (code !== 0) return reject(new Error(`更新失败，退出码: ${code}`))
        const time = this.getUpdateTime(repoPath)
        if (output.includes('Already up to date') || errorOutput.includes('Already up to date')) {
          return resolve(`📌 ${repo.name}: 已是最新版本\n最后更新时间：${time}`)
        }
        const newCommitId = this.getCommitId(repoPath)
        if (oldCommitId && newCommitId && oldCommitId !== newCommitId) {
          const log = this.getUpdateLog(repoPath, oldCommitId, repo.name)
          if (log) updateLogs.push(log)
        }
        resolve(`✅ ${repo.name}: 更新成功\n更新时间：${time}`)
      })
      git.on('error', err => reject(new Error(`无法启动 git: ${err.message}`)))
    })
  }

  async removeDirectory(dirPath) {
    try {
      if (fs.existsSync(dirPath)) await fs.promises.rm(dirPath, { recursive: true, force: true })
    } catch {
      try {
        const cmd = process.platform === 'win32' ? `rmdir /s /q "${dirPath}"` : `rm -rf "${dirPath}"`
        await execAsync(cmd)
      } catch (err) {
        logger.error('[XRK] 删除目录失败:', dirPath, err)
        throw new Error(`无法删除目录: ${err.message}`)
      }
    }
  }
}
