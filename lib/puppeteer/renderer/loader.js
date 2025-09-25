import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
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
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    this.dir = path.join(__dirname, "..", "renderers")
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
        // 使用绝对路径导入模块
        const modulePath = path.join(this.dir, name, "index.js")
        const rendererFn = (await import(modulePath)).default
        
        // 配置文件路径也使用绝对路径
        const configFile = path.join(this.dir, name, "config.yaml")
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