/**
 * 截图后按比例裁掉顶部/底部，通用工具，供 fullPage 截图后可选使用。
 * 仅当调用方在 data 中传入 cropTopPercent / cropBottomPercent 时由渲染器调用，无默认值。
 */

import sharp from 'sharp'

/**
 * 按比例裁掉顶部和底部，保留中间区域。
 * @param {Buffer} buffer - 图片 Buffer
 * @param {number} cropTopRatio - 裁掉顶部的比例，0–1
 * @param {number} cropBottomRatio - 裁掉底部的比例，0–1；与 cropTopRatio 之和须小于 1
 * @returns {Promise<Buffer>} 裁剪后的 Buffer，失败或无需裁剪时返回原 buffer
 */
export async function cropTopAndBottom(buffer, cropTopRatio, cropBottomRatio) {
  if (!Buffer.isBuffer(buffer)) return buffer
  const topR = Number(cropTopRatio) || 0
  const bottomR = Number(cropBottomRatio) || 0
  if (topR <= 0 && bottomR <= 0) return buffer
  if (topR < 0 || topR >= 1 || bottomR < 0 || bottomR >= 1 || topR + bottomR >= 1) return buffer
  try {
    const meta = await sharp(buffer).metadata()
    const w = meta.width || 0
    const h = meta.height || 0
    if (w <= 0 || h <= 0) return buffer
    const top = Math.floor(h * topR)
    const keepHeight = Math.floor(h * (1 - topR - bottomR))
    if (keepHeight <= 0) return buffer
    return await sharp(buffer)
      .extract({ left: 0, top, width: w, height: keepHeight })
      .toBuffer()
  } catch (e) {
    logger?.warn?.('[Renderer crop] failed:', e?.message)
    return buffer
  }
}
