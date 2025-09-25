import fs from "node:fs"
import yaml from "yaml"
import lodash from "lodash"
import cfg from "../../config/config.js"
import Renderer from "./Renderer.js"

/** 全局变量 Renderer */
global.Renderer = Renderer

/**
 * 加载渲染器
 */
class RendererLoader {
  constructor() {
    this.renderers = new Map()
    this.dir = "renderers"
    this.watcher = {}
  }

  static async init() {
    const render = new RendererLoader()
    await render.load()
    return render
  }

  async load() {
    const subFolders = fs.readdirSync(this.dir, { withFileTypes: true }).filter((dirent) => dirent.isDirectory())
    for (const subFolder of subFolders) {
      const name = subFolder.name
      try {
        const rendererFn = (await import(`../../../${this.dir}/${name}/index.js`)).default
        const configFile = `${this.dir}/${name}/config.yaml`
        const rendererCfg = fs.existsSync(configFile) ? yaml.parse(fs.readFileSync(configFile, "utf8")) : {}
        const renderer = rendererFn(rendererCfg)
        if (!renderer.id || !renderer.type || !renderer.render || !lodash.isFunction(renderer.render)) {
          logger.warn("渲染后端 " + (renderer.id || subFolder.name) + " 不可用")
        }
        this.renderers.set(renderer.id, renderer)
      } catch (err) {
        logger.error(`渲染后端 ${name} 加载失败`)
        logger.error(err)
      }
    }
  }

  getRenderer(name = cfg.renderer?.name || "puppeteer") {
    // TODO 渲染器降级
    return this.renderers.get(name) || {}
  }
}

export default await RendererLoader.init()