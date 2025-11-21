import template from 'art-template'
import chokidar from 'chokidar'
import path from 'node:path'
import fs from 'node:fs'

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
    this.createDir(this.dir)
  }

  /** 创建文件夹 */
  createDir(dirname) {
    if (fs.existsSync(dirname)) {
      return true
    } else {
      if (this.createDir(path.dirname(dirname))) {
        fs.mkdirSync(dirname)
        return true
      }
    }
  }

  /** 模板 */
  dealTpl(name, data) {
    let { tplFile, saveId = name } = data
    let savePath = `./temp/html/${name}/${saveId}.html`

    /** 读取html模板 */
    if (!this.html[tplFile]) {
      this.createDir(`./temp/html/${name}`)

      try {
        this.html[tplFile] = fs.readFileSync(tplFile, 'utf8')
      } catch (error) {
        logger.error(`加载html错误：${tplFile}`)
        return false
      }

      this.watch(tplFile)
    }

    data.resPath = `./resources/`

    /** 替换模板 */
    let tmpHtml = template.render(this.html[tplFile], data)

    /** 保存模板 */
    fs.writeFileSync(savePath, tmpHtml)

    logger.debug(`[图片生成][使用模板] ${savePath}`)

    return savePath
  }

  /** 监听配置文件 */
  watch(tplFile) {
    if (this.watcher[tplFile]) return

    const watcher = chokidar.watch(tplFile)
    watcher.on('change', () => {
      delete this.html[tplFile]
      logger.mark(`[修改html模板] ${tplFile}`)
    })

    this.watcher[tplFile] = watcher
  }
}