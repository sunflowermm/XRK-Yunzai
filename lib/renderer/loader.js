import yaml from "yaml"
import path from "node:path"
import cfg from "../config/config.js"
import { FileUtils } from "../utils/file-utils.js"
import { ObjectUtils } from "../utils/object-utils.js"
import { PluginDirScanner } from "../utils/plugin-dir-scanner.js"

/**
 * 渲染器加载器：从 renderers/、plugins/<名>/renderer/ 加载
 * config 支持 config.yaml 或 config_default.yaml
 */
class RendererLoader {
  renderers = new Map()
  loaded = false

  static async init() {
    const loader = new RendererLoader()
    await loader.load()
    return loader
  }

  async load() {
    if (this.loaded) return

    for (const { name, rendererPath, configDir } of PluginDirScanner.listRendererEntries()) {
      if (!FileUtils.existsSync(rendererPath)) continue
      try {
        const rendererModule = await import(FileUtils.toImportUrl(path.resolve(rendererPath)))
        const rendererFn = rendererModule.default
        if (!ObjectUtils.isFunction(rendererFn)) continue

        const configPath = FileUtils.existsSync(path.join(configDir, "config.yaml"))
          ? path.join(configDir, "config.yaml")
          : path.join(configDir, "config_default.yaml")
        const rendererCfg = FileUtils.existsSync(configPath)
          ? yaml.parse(FileUtils.readFileSync(configPath)) : {}

        const renderer = rendererFn(rendererCfg)
        if (!renderer?.id || !renderer?.type || !ObjectUtils.isFunction(renderer.render)) continue
        if (this.renderers.has(renderer.id)) continue

        this.renderers.set(renderer.id, renderer)
      } catch (err) {
        Bot.makeLog("error", `[RendererLoader] 加载失败 [${name}]: ${err.message}`, "RendererLoader", err)
      }
    }

    this.loaded = true
    if (this.renderers.size > 0) {
      Bot.makeLog("info", `[RendererLoader] 渲染器加载完成: ${this.renderers.size}个`, "RendererLoader")
    }
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
