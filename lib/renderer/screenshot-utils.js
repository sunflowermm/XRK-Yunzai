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
    if (buff.data != null) {
      try {
        return Buffer.from(buff.data);
      } catch {
        // buff.data 形状不支持，继续尝试 buffer / ArrayBuffer 等字段
      }
    }
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

/** 判断 page.evaluate 返回值或 clip 参数是否为有效截图区域 */
export function isScreenshotClip(v) {
  return v && typeof v === "object"
    && ["x", "y", "width", "height"].every(k => Number.isFinite(v[k]))
    && v.width > 0 && v.height > 0
}

/** 合并 list 与单值 fallback 为字符串数组 */
export function toStringList(list) {
  return Array.isArray(list) ? list.filter(s => typeof s === "string" && s.trim()) : []
}
