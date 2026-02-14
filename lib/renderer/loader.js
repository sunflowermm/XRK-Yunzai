import yaml from "yaml"
import path from "node:path"
import cfg from "../config/config.js"
import Renderer from "./Renderer.js"
import BotUtil from "../util.js"
import { FileUtils } from "../utils/file-utils.js"

global.Renderer = Renderer

/**
 * 渲染器加载器：从 renderers/、plugins/<名>/renderer/ 加载，config 支持 config.yaml 或 config_default.yaml
 */
class RendererLoader {
  constructor() {
    this.renderers = new Map()
    this.dirs = ["renderers", "plugins"]
  }

  static async init() {
    const loader = new RendererLoader()
    await loader.load()
    global.RendererLoader = loader
    return loader
  }

  async load() {
    for (const baseDir of this.dirs) {
      if (!FileUtils.existsSync(baseDir)) continue
      try {
        const entries = FileUtils.readDirSync(baseDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const name = entry.name
          let rendererPath = null
          let configDir = null
          if (baseDir === "renderers") {
            rendererPath = path.join(baseDir, name, "index.js")
            configDir = path.join(baseDir, name)
          } else {
            const rendererDir = path.join(baseDir, name, "renderer")
            if (!FileUtils.existsSync(rendererDir)) continue
            rendererPath = path.join(rendererDir, "index.js")
            configDir = rendererDir
          }
          if (!rendererPath || !FileUtils.existsSync(rendererPath)) continue
          try {
            const rendererModule = await import(`../../${rendererPath}`)
            const rendererFn = rendererModule.default
            if (typeof rendererFn !== "function") continue
            const configPath = FileUtils.existsSync(path.join(configDir, "config.yaml"))
              ? path.join(configDir, "config.yaml")
              : path.join(configDir, "config_default.yaml")
            const rendererCfg = FileUtils.existsSync(configPath)
              ? yaml.parse(FileUtils.readFileSync(configPath)) : {}
            const renderer = rendererFn(rendererCfg)
            if (!renderer?.id || !renderer?.type || typeof renderer.render !== "function") continue
            if (this.renderers.has(renderer.id)) continue
            this.renderers.set(renderer.id, renderer)
            BotUtil.makeLog("debug", `[RendererLoader] 加载渲染器: ${renderer.id} (${name})`, "RendererLoader")
          } catch (err) {
            BotUtil.makeLog("error", `[RendererLoader] 加载失败 [${name}]: ${err.message}`, "RendererLoader", err)
          }
        }
      } catch (err) {
        BotUtil.makeLog("error", `[RendererLoader] 扫描失败 [${baseDir}]: ${err.message}`, "RendererLoader", err)
      }
    }
    if (this.renderers.size > 0) BotUtil.makeLog("info", `[RendererLoader] 渲染器加载完成: ${this.renderers.size}个`, "RendererLoader")
  }

  getRenderer(name = null) {
    const key = name || cfg.renderer?.name || "puppeteer"
    return this.renderers.get(key) || this.renderers.values().next().value || null
  }

  listRenderers() {
    return Array.from(this.renderers.keys())
  }

  hasRenderer(name) {
    return this.renderers.has(name)
  }
}

export default await RendererLoader.init()