/**
 * 启动前 / CI：按需构建 plugins/*/www 有 sign 的静态前端
 * 用法：pnpm run build:www
 */
import { buildSignedStaticWwwBeforeRuntime } from '../lib/www/www-static-build.js'

const r = await buildSignedStaticWwwBeforeRuntime({
  log: (level, msg) => {
    const line = `[build:www] ${msg}`
    if (level === 'error') console.error(line)
    else console.log(line)
  },
})

if (r.skipped) {
  console.log('[build:www] 已跳过（XRK_SKIP_WWW_BUILD=1）')
  process.exit(0)
}

if (r.failed.length) {
  console.error(`[build:www] 失败: ${r.failed.join(', ')}`)
  process.exit(1)
}

console.log(
  r.built.length
    ? `[build:www] 完成: ${r.built.join(', ')}`
    : '[build:www] 无需构建（产物已是最新）',
)
process.exit(0)
