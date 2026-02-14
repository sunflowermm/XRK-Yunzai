import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer'

const DEFAULT_WIDTH = 1024
const INITIAL_VIEWPORT_HEIGHT = 800
const MAX_VIEWPORT_HEIGHT = 2000
const MIN_VIEWPORT_HEIGHT = 400

/**
 * 通用网页/本地 HTML 截图工具。高度按页面内容自适应，不依赖传入的 height，且不会设得过高。
 * @param {string} target - URL 或本地 HTML 路径
 * @param {string} name - 截图文件名标识
 * @param {object} options - width/deviceScaleFactor/fullPage/waitUntil/waitForSelector/waitForTimeout（height 忽略，实际高度自适应）
 * @returns {Promise<string>} 截图文件的绝对路径
 */
export async function takeScreenshot(target, name, options = {}) {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })

  try {
    const page = await browser.newPage()
    const width = options.width ?? DEFAULT_WIDTH
    const deviceScaleFactor = options.deviceScaleFactor ?? 2
    const fullPage = options.fullPage === true
    const waitUntil = options.waitUntil ?? 'networkidle2'

    const url = /^https?:\/\//i.test(target)
      ? target
      : 'file://' + (path.isAbsolute(target) ? target : path.resolve(target))

    await page.setViewport({ width, height: INITIAL_VIEWPORT_HEIGHT, deviceScaleFactor })
    await page.goto(url, { waitUntil })

    if (options.waitForSelector) {
      await page.waitForSelector(options.waitForSelector).catch(() => {})
    }
    if (options.waitForTimeout > 0) {
      await new Promise(r => setTimeout(r, options.waitForTimeout))
    }

    if (!fullPage) {
      const contentHeight = await page.evaluate(() =>
        Math.max(
          document.body?.scrollHeight ?? 0,
          document.documentElement?.scrollHeight ?? 0,
          window.innerHeight ?? 0
        )
      )
      const viewportHeight = Math.min(
        MAX_VIEWPORT_HEIGHT,
        Math.max(MIN_VIEWPORT_HEIGHT, contentHeight)
      )
      await page.setViewport({ width, height: viewportHeight, deviceScaleFactor })
    }

    const outDir = path.join(process.cwd(), 'data', 'xrkconfig', 'screenshots')
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true })
    }
    const outPath = path.join(outDir, `${name || 'screenshot'}_${Date.now()}.png`)
    await page.screenshot({ path: outPath, fullPage })
    return outPath
  } finally {
    await browser.close()
  }
}

