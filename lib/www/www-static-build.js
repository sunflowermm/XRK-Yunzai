/**
 * sign.json 静态前端：按 stale 执行 build（对齐 XRK-AGT）
 */
import path from 'node:path'
import { spawn } from 'node:child_process'
import { FileUtils } from '../utils/file-utils.js'
import { PLUGINS_DIR, resolveProjectPath } from '../config/config-constants.js'
import {
  readWwwSignFile,
  shouldProxyFrontend,
  resolveWwwStaticRoot,
} from './www-app-resolve.js'

const BUILD_WALK_SKIP = new Set([
  'node_modules', 'dist', 'build', '.git', '.vite', '.turbo', 'coverage', 'dist-ssr',
])

export function normalizeWwwBuildSpec(raw, appDir) {
  if (!raw || typeof raw !== 'object') return null
  const command = raw.command != null ? String(raw.command).trim() : ''
  if (!command) return null
  const args = Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : []
  const cwd = raw.cwd ? path.resolve(appDir, String(raw.cwd)) : appDir
  const env =
    raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
      ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [String(k), v == null ? '' : String(v)]))
      : {}
  return { command, args, cwd, env }
}

export function resolveSignedStaticBuildSpec(sign, appDir) {
  const fromSign = normalizeWwwBuildSpec(sign?.build, appDir)
  if (fromSign) return fromSign
  if (FileUtils.existsSync(path.join(appDir, 'package.json'))) {
    return { command: 'pnpm', args: ['build'], cwd: appDir, env: {} }
  }
  return null
}

function maxMtimeMs(target, maxFiles = 8000) {
  let newest = 0
  let seen = 0
  function visit(abs) {
    if (seen >= maxFiles) return
    const st = FileUtils.statSync(abs)
    if (!st) return
    if (st.isFile()) {
      seen += 1
      if (st.mtimeMs > newest) newest = st.mtimeMs
      return
    }
    if (!st.isDirectory()) return
    if (st.mtimeMs > newest) newest = st.mtimeMs
    for (const name of FileUtils.readDirSync(abs) || []) {
      if (seen >= maxFiles) return
      if (BUILD_WALK_SKIP.has(name)) continue
      visit(path.join(abs, name))
    }
  }
  visit(target)
  return newest
}

export function maxWwwSourceMtimeMs(appDir) {
  const files = [
    'package.json', 'pnpm-lock.yaml', 'vite.config.js', 'vite.config.mjs',
    'vite.config.ts', 'index.html', 'sign.json',
  ]
  let newest = 0
  for (const rel of files) {
    const abs = path.join(appDir, rel)
    const st = FileUtils.statSync(abs)
    if (st?.mtimeMs > newest) newest = st.mtimeMs
  }
  for (const rel of ['src', 'public']) {
    const abs = path.join(appDir, rel)
    if (!FileUtils.existsSync(abs)) continue
    const t = maxMtimeMs(abs)
    if (t > newest) newest = t
  }
  return newest
}

export function resolveSignedStaticOutDir(appDir, sign) {
  const resolved = resolveWwwStaticRoot(appDir, sign)
  if (resolved?.via && resolved.via !== '.' && resolved.root) return resolved.root
  const rel =
    (sign?.staticRoot && String(sign.staticRoot).trim()) ||
    (sign?.outDir && String(sign.outDir).trim()) ||
    'dist'
  return path.resolve(appDir, rel)
}

export function isSignedStaticBuildStale(appDir, sign) {
  const outDir = resolveSignedStaticOutDir(appDir, sign)
  const indexHtml = path.join(outDir, 'index.html')
  if (!FileUtils.existsSync(indexHtml)) return true
  let distNewest = FileUtils.statSync(indexHtml)?.mtimeMs || 0
  const assetsNewest = maxMtimeMs(outDir)
  if (assetsNewest > distNewest) distNewest = assetsNewest
  if (!distNewest) return true
  const srcNewest = maxWwwSourceMtimeMs(appDir)
  if (!srcNewest) return false
  return srcNewest > distNewest + 2
}

function runCommand(command, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, BROWSER: 'none' },
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (c) => { stdout += c })
    child.stderr?.on('data', (c) => { stderr += c })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, code: 0 })
      else {
        const detail = (stderr || stdout || '').trim().slice(0, 800)
        reject(new Error(`${command} ${args.join(' ')} 退出码 ${code}${detail ? ` — ${detail}` : ''}`))
      }
    })
  })
}

export async function runSignedStaticBuild(appDir, sign, label = appDir) {
  const spec = resolveSignedStaticBuildSpec(sign, appDir)
  if (!spec) return false
  await runCommand(spec.command, spec.args, { cwd: spec.cwd, env: spec.env })
  const msg = `前端构建完成: ${label}`
  if (typeof Bot !== 'undefined' && Bot?.makeLog) Bot.makeLog('success', msg, 'www-build')
  else console.log(`[www-build] ${msg}`)
  return true
}

/** 扫描 plugins/<插件>/www/<应用>/sign.json */
export function discoverSignedWwwApps() {
  const root = resolveProjectPath(PLUGINS_DIR)
  const apps = []
  if (!FileUtils.existsSync(root)) return apps
  for (const plugin of FileUtils.readDirSync(root) || []) {
    const www = path.join(root, plugin, 'www')
    if (!FileUtils.existsSync(www)) continue
    for (const folder of FileUtils.readDirSync(www) || []) {
      const appDir = path.join(www, folder)
      if (!FileUtils.statSync(appDir)?.isDirectory()) continue
      const signPath = path.join(appDir, 'sign.json')
      const { ok, value: sign } = readWwwSignFile(signPath)
      if (!ok || !sign) continue
      if (shouldProxyFrontend(sign)) continue
      if (String(sign.staticRoot || '').trim() === '.') continue
      apps.push({ appDir, folder, plugin, sign, label: `${plugin}/www/${folder}` })
    }
  }
  return apps
}

/**
 * 启动前 / pnpm run build:www：按 stale 构建静态前端
 * @param {{ log?: (level: string, msg: string) => void }} [opts]
 */
export async function buildSignedStaticWwwBeforeRuntime(opts = {}) {
  const log = opts.log || ((level, msg) => {
    if (typeof Bot !== 'undefined' && Bot.makeLog) Bot.makeLog(level, msg, 'www-build')
    else console.log(`[www-build][${level}] ${msg}`)
  })

  if (process.env.XRK_SKIP_WWW_BUILD === '1') {
    return { skipped: true, built: [], failed: [] }
  }

  const built = []
  const failed = []
  for (const app of discoverSignedWwwApps()) {
    if (!isSignedStaticBuildStale(app.appDir, app.sign)) continue
    try {
      log('info', `构建 ${app.label}…`)
      const ok = await runSignedStaticBuild(app.appDir, app.sign, app.label)
      if (ok) built.push(app.label)
      else failed.push(app.label)
    } catch (err) {
      failed.push(app.label)
      log('error', `${app.label}: ${err?.message || err}`)
    }
  }
  return { skipped: false, built, failed }
}
