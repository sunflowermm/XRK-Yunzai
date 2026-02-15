/**
 * 渲染器截图通用工具：截图返回值转 Buffer、路径转 file URL。
 * 供 renderers/puppeteer、renderers/playwright 共用，避免重复实现。
 */

import path from "node:path"

/**
 * 将截图 API 的返回值转为 Buffer；支持 Buffer、ArrayBuffer、Uint8Array、base64 字符串。
 * @param {*} buff
 * @returns {Buffer|null}
 */
export function toBuffer(buff) {
  if (Buffer.isBuffer(buff)) return buff
  if (buff && typeof buff === "object") {
    if (buff.type === "Buffer" && buff.data != null) return Buffer.from(buff.data)
    if (buff.buffer != null && Buffer.isBuffer(buff.buffer)) return buff.buffer
    if (buff.buffer instanceof ArrayBuffer) return Buffer.from(buff.buffer)
    if (ArrayBuffer.isView(buff) || buff instanceof ArrayBuffer) return Buffer.from(buff)
  }
  try {
    return Buffer.from(buff)
  } catch {
    if (typeof buff === "string") return Buffer.from(buff, "base64")
    return null
  }
}

/**
 * 将本地文件路径转为 file: URL（供 page.goto 等使用）。
 * @param {string} filePath
 * @returns {string}
 */
export function toFileUrl(filePath) {
  return `file:///${path.normalize(filePath).replace(/\\/g, "/").replace(/^\/+/, "")}`
}
