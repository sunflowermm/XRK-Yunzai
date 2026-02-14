import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer'

/**
 * 通用网页/本地 HTML 截图工具
 * @param {string} target - URL 或本地 HTML 路径
 * @param {string} name - 截图文件名标识
 * @param {object} options - 视图和截图配置（可选）
 * @returns {Promise<string>} 截图文件的绝对路径
 */
export async function takeScreenshot(target, name, options = {}) {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })

  try {
    const page = await browser.newPage()

    const {
      width = 1024,
      height = 768,
      deviceScaleFactor = 2,
      fullPage = false,
      waitUntil = 'networkidle2',
      waitForSelector,
      waitForTimeout
    } = options

    await page.setViewport({ width, height, deviceScaleFactor })

    let url = target
    if (!/^https?:\/\//i.test(target)) {
      const absPath = path.isAbsolute(target) ? target : path.resolve(target)
      url = 'file://' + absPath
    }

    await page.goto(url, { waitUntil })

    if (waitForSelector) {
      await page.waitForSelector(waitForSelector).catch(() => {})
    }
    if (waitForTimeout) {
      await page.waitForTimeout(waitForTimeout)
    }

    const outDir = path.join(process.cwd(), 'data', 'xrkconfig', 'screenshots')
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true })
    }

    const filename = `${name || 'screenshot'}_${Date.now()}.png`
    const outPath = path.join(outDir, filename)

    await page.screenshot({
      path: outPath,
      fullPage
    })

    return outPath
  } finally {
    await browser.close()
  }
}

