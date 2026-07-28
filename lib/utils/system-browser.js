/**
 * 系统 Chromium / Chrome / Edge 探测（对齐 XRK-AGT system-browser.cjs）
 */
import { arch, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { FileUtils } from './file-utils.js';

export const currentPlatform = platform();
export const currentArch = arch();

const LINUX_BINS = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'microsoft-edge',
  'microsoft-edge-stable',
];

const LINUX_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
  '/usr/bin/microsoft-edge',
  '/opt/microsoft/msedge/msedge',
];

const WIN_PATHS = [
  path.join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env.ProgramFiles || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
];

const DARWIN_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

function isExecutable(filePath) {
  try {
    if (!filePath || !FileUtils.existsSync(filePath)) return false;
    if (currentPlatform !== 'win32') {
      const st = FileUtils.statSync(filePath);
      if (!st) return false;
      return !!(st.mode & parseInt('111', 8));
    }
    return true;
  } catch {
    return false;
  }
}

function tryWhich(bin) {
  try {
    const found = execFileSync('which', [bin], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return isExecutable(found) ? found : null;
  } catch {
    return null;
  }
}

/** @returns {string | null} */
export function findSystemBrowser() {
  if (['linux', 'android'].includes(currentPlatform)) {
    for (const bin of LINUX_BINS) {
      const found = tryWhich(bin);
      if (found) return found;
    }
    for (const browserPath of LINUX_PATHS) {
      if (isExecutable(browserPath)) return browserPath;
    }
    return null;
  }

  const paths =
    currentPlatform === 'win32' ? WIN_PATHS : currentPlatform === 'darwin' ? DARWIN_PATHS : [];

  for (const browserPath of paths) {
    if (isExecutable(browserPath)) return browserPath;
  }
  return null;
}

/** @returns {string | null} */
export function pickBrowserPath(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 配置 → env → 系统探测
 * @returns {string | null}
 */
export function resolveChromiumExecutable(configuredPath) {
  return (
    pickBrowserPath(configuredPath) ||
    pickBrowserPath(process.env.PUPPETEER_EXECUTABLE_PATH) ||
    pickBrowserPath(process.env.CHROME_PATH) ||
    findSystemBrowser()
  );
}

/** @deprecated 使用 resolveChromiumExecutable */
export function resolvePlaywrightExecutable(configuredPath) {
  return resolveChromiumExecutable(configuredPath);
}

/** 仅包含 Playwright launch 有效字段（避免 null/wsEndpoint 触发校验失败） */
export function buildPlaywrightLaunchOptions({ headless, args, channel, configuredPath } = {}) {
  const opts = { headless: headless ?? true, args: args ?? [] };
  const ch = pickBrowserPath(channel);
  if (ch) opts.channel = ch;
  const executablePath = resolveChromiumExecutable(configuredPath);
  if (executablePath) opts.executablePath = executablePath;
  return opts;
}
