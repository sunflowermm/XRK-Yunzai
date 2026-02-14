import template from 'art-template'
import chokidar from 'chokidar'
import path from 'node:path'
import BotUtil from '../util.js'
import { FileUtils } from '../utils/file-utils.js'

/**
 * 渲染器基类
 * 
 * 提供图片渲染能力，支持HTML模板渲染为图片。
 * 所有渲染器都应继承此类。
 * 
 * 文件路径: lib/renderer/Renderer.js
 * 渲染器存放路径: renderers/
 * 
 * @class Renderer
 * @example
 * import Renderer from '../../lib/renderer/Renderer.js';
 * 
 * export default class MyRenderer extends Renderer {
 *   constructor() {
 *     super({
 *       id: 'my-renderer',
 *       type: 'image',
 *       render: 'render'
 *     });
 *   }
 * 
 *   async render(tpl, data) {
 *     return await this.dealTpl('my-template', {
 *       tplFile: tpl,
 *       data: data
 *     });
 *   }
 * }
 */
export default class Renderer {
  /**
   * 渲染器构造函数
   * @param {Object} data - 配置对象
   * @param {string} data.id - 渲染器ID
   * @param {string} data.type - 渲染器类型
   * @param {string} data.render - 渲染器入口方法名
   */
  constructor(data) {
    /** 渲染器ID */
    this.id = data.id || 'renderer'
    /** 渲染器类型 */
    this.type = data.type || 'image'
    /** 渲染器入口 */
    this.render = this[data.render || 'render']
    this.dir = './temp/html'
    this.html = {}
    this.watcher = {}
  }

  /** 创建文件夹 */
  createDir(dirname) {
    try {
      FileUtils.ensureDirSync(dirname)
      return true
    } catch (error) {
      BotUtil.makeLog('error', `[Renderer] 创建目录失败: ${dirname}`, 'Renderer', error)
      return false
    }
  }

  /** 模板 */
  dealTpl(name, data) {
    const { tplFile, saveId = name } = data
    const savePath = `./temp/html/${name}/${saveId}.html`

    // 读取html模板
    if (!this.html[tplFile]) {
      if (!this.createDir(`./temp/html/${name}`)) {
        return false
      }

      try {
        this.html[tplFile] = FileUtils.readFileSync(tplFile, 'utf8')
      } catch (error) {
        BotUtil.makeLog('error', `[Renderer] 加载HTML模板失败: ${tplFile}`, 'Renderer', error)
        return false
      }

      this.watch(tplFile)
    }

    data.resPath = `./resources/`

    // 替换模板
    let tmpHtml
    try {
      tmpHtml = template.render(this.html[tplFile], data)
    } catch (error) {
      BotUtil.makeLog('error', `[Renderer] 模板渲染失败: ${tplFile}`, 'Renderer', error)
      return false
    }

    // 保存模板
    try {
      FileUtils.writeFileSync(savePath, tmpHtml)
      BotUtil.makeLog('debug', `[Renderer] 生成模板: ${savePath}`, 'Renderer')
    } catch (error) {
      BotUtil.makeLog('error', `[Renderer] 保存模板失败: ${savePath}`, 'Renderer', error)
      return false
    }

    return savePath
  }

  /** 监听配置文件 */
  watch(tplFile) {
    if (this.watcher[tplFile]) return

    try {
      const watcher = chokidar.watch(tplFile)
      watcher.on('change', () => {
        delete this.html[tplFile]
        BotUtil.makeLog('mark', `[Renderer] HTML模板已更新: ${tplFile}`, 'Renderer')
      })
      watcher.on('error', (error) => {
        BotUtil.makeLog('error', `[Renderer] 监听模板文件失败: ${tplFile}`, 'Renderer', error)
      })

      this.watcher[tplFile] = watcher
    } catch (error) {
      BotUtil.makeLog('error', `[Renderer] 创建文件监听器失败: ${tplFile}`, 'Renderer', error)
    }
  }
}