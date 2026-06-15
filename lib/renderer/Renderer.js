import template from 'art-template'
import { FileUtils } from '../utils/file-utils.js'
import { HotReloadBase } from '../utils/hot-reload-base.js'

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
  html = {}
  watcher = {}

  /**
   * @param {Object} [options={}] - 配置对象
   * @param {string} [options.id='renderer'] - 渲染器ID
   * @param {string} [options.type='image'] - 渲染器类型
   * @param {string} [options.render='render'] - 渲染器入口方法名
   */
  constructor(options = {}) {
    this.id = options.id || 'renderer'
    this.type = options.type || 'image'
    this.render = this[options.render || 'render']
    this.dir = './temp/html'
  }

  /** 创建文件夹 */
  createDir(dirname) {
    try {
      FileUtils.ensureDirSync(dirname)
      return true
    } catch (error) {
      Bot.makeLog('error', `[Renderer] 创建目录失败: ${dirname}`, 'Renderer', error)
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
        Bot.makeLog('error', `[Renderer] 加载HTML模板失败: ${tplFile}`, 'Renderer', error)
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
      Bot.makeLog('error', `[Renderer] 模板渲染失败: ${tplFile}`, 'Renderer', error)
      return false
    }

    // 保存模板
    try {
      FileUtils.writeFileSync(savePath, tmpHtml)
      Bot.makeLog('debug', `[Renderer] 生成模板: ${savePath}`, 'Renderer')
    } catch (error) {
      Bot.makeLog('error', `[Renderer] 保存模板失败: ${savePath}`, 'Renderer', error)
      return false
    }

    return savePath
  }

  /** 监听配置文件 */
  watch(tplFile) {
    if (this.watcher[tplFile]) return

    try {
      this.watcher[tplFile] = HotReloadBase.createWatcher(tplFile, {
        onChange: () => {
          delete this.html[tplFile]
          Bot.makeLog('mark', `[Renderer] HTML模板已更新: ${tplFile}`, 'Renderer')
        },
        onError: (error) => {
          Bot.makeLog('error', `[Renderer] 监听模板文件失败: ${tplFile}`, 'Renderer', error)
        }
      }, { loggerName: 'Renderer' })
    } catch (error) {
      Bot.makeLog('error', `[Renderer] 创建文件监听器失败: ${tplFile}`, 'Renderer', error)
    }
  }
}