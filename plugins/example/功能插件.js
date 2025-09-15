import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { promisify } from 'util'
import { exec } from 'child_process'

const execAsync = promisify(exec)

export class example2 extends plugin {
  constructor() {
    super({
      name: '向日葵妈咪妈咪哄',
      dsc: '自动克隆或更新XRK和XRK-Core仓库',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^(#)?向日葵妈咪妈咪哄$',
          fnc: 'handleXRK',
          permission: 'master'
        }
      ]
    })
  }

  async handleXRK() {
    const pluginsPath = path.join(process.cwd(), 'plugins')
    const repos = [
      {
        name: 'XRK',
        url: 'https://gitcode.com/Xrkseek/XRK',
        requiredFiles: ['apps', 'package.json']
      },
      {
        name: 'XRK-Core',
        url: 'https://gitcode.com/Xrkseek/XRK-Core',
        requiredFiles: ['index.js']
      }
    ]

    await this.reply('🌻 开始处理XRK仓库...', false, { at: true })
    
    const results = []
    
    for (const repo of repos) {
      try {
        const result = await this.processRepo(pluginsPath, repo)
        results.push(result)
      } catch (error) {
        results.push(`❌ ${repo.name}: ${error.message}`)
        logger.error(`[XRK] 处理 ${repo.name} 时出错:`, error)
      }
    }

    // 汇总结果一次性发送
    const summary = results.join('\n')
    await this.reply(`处理完成！\n${summary}`, false, { at: true })
  }

  async processRepo(pluginsPath, repo) {
    const repoPath = path.join(pluginsPath, repo.name)
    
    if (fs.existsSync(repoPath)) {
      const isComplete = this.checkRepoCompleteness(repoPath, repo.requiredFiles)
      
      if (!isComplete) {
        logger.info(`[XRK] ${repo.name} 目录不完整，重新克隆...`)
        await this.removeDirectory(repoPath)
        return await this.cloneRepo(pluginsPath, repo)
      } else {
        return await this.updateRepo(repoPath, repo.name)
      }
    } else {
      return await this.cloneRepo(pluginsPath, repo)
    }
  }

  checkRepoCompleteness(repoPath, requiredFiles) {
    return requiredFiles.every(file => 
      fs.existsSync(path.join(repoPath, file))
    )
  }

  async cloneRepo(pluginsPath, repo) {
    return new Promise((resolve, reject) => {
      const args = ['clone', '--progress', repo.url, repo.name]
      const git = spawn('git', args, {
        cwd: pluginsPath,
        stdio: ['inherit', 'pipe', 'pipe']
      })

      let progressData = ''
      
      // 监听进度输出
      git.stderr.on('data', (data) => {
        const output = data.toString()
        process.stderr.write(output) // 在终端显示进度
        progressData += output
      })

      git.stdout.on('data', (data) => {
        process.stdout.write(data.toString())
      })

      git.on('close', (code) => {
        if (code === 0) {
          logger.info(`[XRK] 成功克隆 ${repo.name}`)
          resolve(`✅ ${repo.name}: 克隆成功`)
        } else {
          reject(new Error(`克隆失败，退出码: ${code}`))
        }
      })

      git.on('error', (err) => {
        reject(new Error(`无法启动git: ${err.message}`))
      })
    })
  }

  async updateRepo(repoPath, repoName) {
    return new Promise((resolve, reject) => {
      const git = spawn('git', ['pull', '--progress'], {
        cwd: repoPath,
        stdio: ['inherit', 'pipe', 'pipe']
      })

      let output = ''
      let errorOutput = ''

      git.stdout.on('data', (data) => {
        const str = data.toString()
        output += str
        process.stdout.write(str)
      })

      git.stderr.on('data', (data) => {
        const str = data.toString()
        errorOutput += str
        process.stderr.write(str)
      })

      git.on('close', (code) => {
        if (code === 0) {
          if (output.includes('Already up to date') || errorOutput.includes('Already up to date')) {
            resolve(`📌 ${repoName}: 已是最新版本`)
          } else {
            resolve(`✅ ${repoName}: 更新成功`)
          }
        } else {
          reject(new Error(`更新失败，退出码: ${code}`))
        }
      })

      git.on('error', (err) => {
        reject(new Error(`无法启动git: ${err.message}`))
      })
    })
  }

  async removeDirectory(dirPath) {
    try {
      if (fs.existsSync(dirPath)) {
        // 优先使用 Node.js 内置方法
        await fs.promises.rm(dirPath, { recursive: true, force: true })
      }
    } catch (error) {
      // 备用方案：使用系统命令
      try {
        const isWindows = process.platform === 'win32'
        const command = isWindows 
          ? `rmdir /s /q "${dirPath}"`
          : `rm -rf "${dirPath}"`
        await execAsync(command)
      } catch (cmdError) {
        logger.error(`[XRK] 删除目录失败: ${dirPath}`, cmdError)
        throw new Error(`无法删除目录: ${cmdError.message}`)
      }
    }
  }
}