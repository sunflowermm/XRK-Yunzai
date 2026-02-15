/**
 * 兼容层：对手工引用 lib/puppeteer/puppeteer.js 的兼容，底层统一走 RendererLoader。
 * .screenshot / .screenshots 返回 segment。
 */
import RendererLoader from "../renderer/loader.js"

const renderer = RendererLoader.getRenderer()

function toSegment(img) {
  return img ? segment.image(img) : img
}

renderer.screenshot = async (name, data) => toSegment(await renderer.render(name, data))
renderer.screenshots = async (name, data) => {
  const next = { ...data, multiPage: true }
  const imgs = (await renderer.render(name, next)) || []
  const ret = Array.isArray(imgs) ? imgs.map(toSegment).filter(Boolean) : [toSegment(imgs)].filter(Boolean)
  return ret.length > 0 ? ret : false
}

export default renderer
