import fs from "node:fs"
import yaml from "yaml"
import path from "node:path"
import cfg from "../config/config.js"
import Renderer from "./Renderer.js"
import BotUtil from "../util.js"
import { FileUtils } from "../utils/file-utils.js"
import { ObjectUtils } from "../utils/object-utils.js"

/** 全局变量 Renderer */
global.Renderer = Renderer

/**
 * 渲染器加载器
 * 支持从多个目录加载渲染器：renderers/, plugins/插件名/renderer/
 */
class RendererLoader {
  constructor() {
    this.renderers = new Map();
    this.dirs = ["renderers", "plugins"];
    this.watcher = {};
  }

  static async init() {
    const loader = new RendererLoader()
    await loader.load()
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
          let configPath = null

          // 检查 renderers/ 目录
          if (baseDir === "renderers") {
            rendererPath = path.join(baseDir, name, "index.js")
            configPath = path.join(baseDir, name, "config.yaml")
          }
          // 检查 plugins/*/renderer/ 或 core/*/renderer/
          else {
            const rendererDir = path.join(baseDir, name, "renderer")
            if (FileUtils.existsSync(rendererDir)) {
              rendererPath = path.join(rendererDir, "index.js")
              configPath = path.join(rendererDir, "config.yaml")
            }
          }

          if (!rendererPath || !FileUtils.existsSync(rendererPath)) continue

          try {
            const rendererModule = await import(`../../${rendererPath}`)
            const rendererFn = rendererModule.default

            if (!ObjectUtils.isFunction(rendererFn)) {
              BotUtil.makeLog('warn', `[RendererLoader] ${name} 不是有效的渲染器函数`, 'RendererLoader')
              continue
            }

            const configContent = FileUtils.readFileSync(configPath);
            const rendererCfg = configContent ? yaml.parse(configContent) : {};

            const renderer = rendererFn(rendererCfg)

            if (!renderer?.id || !renderer?.type || !ObjectUtils.isFunction(renderer.render)) {
              BotUtil.makeLog('warn', `[RendererLoader] ${name} 渲染器配置不完整`, 'RendererLoader')
              continue
            }

            if (this.renderers.has(renderer.id)) {
              BotUtil.makeLog('warn', `[RendererLoader] 渲染器ID冲突: ${renderer.id}，跳过 ${name}`, 'RendererLoader')
              continue
            }

            this.renderers.set(renderer.id, renderer)
            BotUtil.makeLog('debug', `[RendererLoader] 加载渲染器: ${renderer.id} (${name})`, 'RendererLoader')
          } catch (err) {
            BotUtil.makeLog('error', `[RendererLoader] 加载渲染器失败 [${name}]: ${err.message}`, 'RendererLoader', err)
          }
        }
      } catch (err) {
        BotUtil.makeLog('error', `[RendererLoader] 扫描目录失败 [${baseDir}]: ${err.message}`, 'RendererLoader', err)
      }
    }

    if (this.renderers.size > 0) {
      BotUtil.makeLog('info', `[RendererLoader] 渲染器加载完成: ${this.renderers.size}个`, 'RendererLoader');
    }
  }

  getRenderer(name = null) {
    const rendererName = name || cfg.renderer?.name || "puppeteer"
    const renderer = this.renderers.get(rendererName)
    
    if (!renderer) {
      BotUtil.makeLog('warn', `[RendererLoader] 渲染器不存在: ${rendererName}，使用默认渲染器`, 'RendererLoader')
      return this.renderers.values().next().value || null
    }
    
    return renderer
  }

  listRenderers() {
    return Array.from(this.renderers.keys())
  }

  hasRenderer(name) {
    return this.renderers.has(name)
  }
}

export default await RendererLoader.init()