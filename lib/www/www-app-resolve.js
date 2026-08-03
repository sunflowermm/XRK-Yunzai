/**
 * plugins 下 www 应用 sign.json 挂载决策（对齐 XRK-AGT www-app-resolve）
 * 路径形态：plugins/<插件>/www/<应用>/sign.json
 */
import path from 'node:path'
import { FileUtils } from '../utils/file-utils.js'

export const WWW_BUILD_OUT_CANDIDATES = ['dist', 'build', 'out']

export function readWwwSignFile(signPath) {
  try {
    if (!FileUtils.existsSync(signPath)) return { ok: true, value: null }
    const raw = FileUtils.readFileSync(signPath)
    if (!raw) return { ok: false, value: null, error: 'sign.json 为空' }
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, value: null, error: 'sign.json 根须为对象' }
    }
    return { ok: true, value }
  } catch (err) {
    return { ok: false, value: null, error: err?.message || String(err) }
  }
}

/** enabled:false 或 serve:static → 不反代；enabled:true + proxy → 反代 */
export function shouldProxyFrontend(sign) {
  if (!sign || typeof sign !== 'object') return false
  if (sign.enabled === false) return false
  const serve = String(sign.serve || '').toLowerCase().trim()
  if (serve === 'static' || serve === 'dist') return false
  if (serve === 'proxy' || serve === 'dev') return true
  return true
}

export function resolveWwwMountPath(sign, folderName) {
  const proxyMount = sign?.proxy?.mount && String(sign.proxy.mount).trim()
  if (proxyMount) return proxyMount.startsWith('/') ? proxyMount : `/${proxyMount}`
  if (sign?.mount && String(sign.mount).trim()) {
    const m = String(sign.mount).trim()
    return m.startsWith('/') ? m : `/${m}`
  }
  if (sign?.id) return `/${String(sign.id).trim()}`
  return `/${folderName}`
}

export function looksLikeFrontendSourceTree(appDir) {
  try {
    if (FileUtils.existsSync(path.join(appDir, 'package.json'))) {
      if (
        FileUtils.existsSync(path.join(appDir, 'vite.config.js')) ||
        FileUtils.existsSync(path.join(appDir, 'vite.config.mjs')) ||
        FileUtils.existsSync(path.join(appDir, 'vite.config.ts'))
      ) {
        return true
      }
      const html = FileUtils.readFileSync(path.join(appDir, 'index.html'))
      if (html && /\/src\//.test(html)) return true
    }
  } catch {
    /* ignore */
  }
  return false
}

/**
 * @returns {{ root: string, via: string } | null}
 */
export function resolveWwwStaticRoot(appDir, sign) {
  if (!sign) return { root: appDir, via: '.' }

  const explicit =
    (sign.staticRoot != null && String(sign.staticRoot).trim()) ||
    (sign.outDir != null && String(sign.outDir).trim()) ||
    ''

  if (explicit === '.' || explicit === './') {
    return { root: appDir, via: '.' }
  }

  if (explicit) {
    const abs = path.resolve(appDir, explicit)
    if (FileUtils.existsSync(path.join(abs, 'index.html'))) {
      return { root: abs, via: explicit }
    }
    return null
  }

  for (const cand of WWW_BUILD_OUT_CANDIDATES) {
    const abs = path.resolve(appDir, cand)
    if (FileUtils.existsSync(path.join(abs, 'index.html'))) {
      return { root: abs, via: cand }
    }
  }

  if (looksLikeFrontendSourceTree(appDir)) {
    return null
  }

  if (FileUtils.existsSync(path.join(appDir, 'index.html'))) {
    return { root: appDir, via: '.' }
  }
  return null
}

/**
 * @returns {{ kind: 'plain'|'signed', mode: 'static'|'proxy', mountPath: string, staticRoot: string|null, sign: object|null, reason: string }}
 */
export function resolveWwwAppMount(appDir, folderName) {
  const signPath = path.join(appDir, 'sign.json')
  const { ok, value: sign, error } = readWwwSignFile(signPath)

  if (!ok || !sign) {
    return {
      kind: 'plain',
      mode: 'static',
      mountPath: `/${folderName}`,
      staticRoot: appDir,
      sign: null,
      reason: error ? `sign 无效回退: ${error}` : '无 sign.json',
    }
  }

  const mountPath = resolveWwwMountPath(sign, folderName)
  if (shouldProxyFrontend(sign)) {
    return {
      kind: 'signed',
      mode: 'proxy',
      mountPath,
      staticRoot: null,
      sign,
      reason: 'serve=proxy',
    }
  }

  const resolved = resolveWwwStaticRoot(appDir, sign)
  return {
    kind: 'signed',
    mode: 'static',
    mountPath,
    staticRoot: resolved?.root ?? null,
    sign,
    reason: resolved ? `static via ${resolved.via}` : 'static 缺产物',
  }
}
