/**
 * 启动引导用浏览器状态 / Playwright Chromium 安装（对齐 XRK-AGT bootstrap-deps）
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { FileUtils } from './file-utils.js';
import { findSystemBrowser } from './system-browser.js';
import { resolveProjectPath } from '../config/config-constants.js';

/** Playwright CfT 走官方 CDN（国内镜像常缺 builds/cft） */
const PLAYWRIGHT_CDN = 'https://cdn.playwright.dev';
const PLAYWRIGHT_DOWNLOAD_ENV = {
  PLAYWRIGHT_DOWNLOAD_HOST: PLAYWRIGHT_CDN,
  PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST: PLAYWRIGHT_CDN,
};

function isPlaywrightPackageInstalled(rootDir) {
  return FileUtils.existsSync(path.join(rootDir, 'node_modules', 'playwright', 'package.json'));
}

/**
 * @returns {Promise<{
 *   playwrightInstalled: boolean,
 *   browserInstalled: boolean,
 *   executablePath: string | null,
 *   systemBrowserPath: string | null,
 *   needsBrowserReminder: boolean
 * }>}
 */
export async function getBrowserStatus(rootDir = resolveProjectPath()) {
  const systemBrowserPath = findSystemBrowser();

  if (!isPlaywrightPackageInstalled(rootDir)) {
    return {
      playwrightInstalled: false,
      browserInstalled: false,
      executablePath: null,
      systemBrowserPath,
      needsBrowserReminder: !systemBrowserPath,
    };
  }

  try {
    const { chromium } = await import('playwright');
    const executablePath = chromium.executablePath();
    const browserInstalled = FileUtils.existsSync(executablePath);
    const canLaunch = !!(systemBrowserPath || browserInstalled);
    return {
      playwrightInstalled: true,
      browserInstalled,
      executablePath,
      systemBrowserPath,
      needsBrowserReminder: !canLaunch,
    };
  } catch {
    return {
      playwrightInstalled: false,
      browserInstalled: false,
      executablePath: null,
      systemBrowserPath,
      needsBrowserReminder: !systemBrowserPath,
    };
  }
}

/** 引导阶段打印可用浏览器（避免首次截图才发现） */
export async function logBrowserEnvironment(logger, rootDir = resolveProjectPath()) {
  const systemBrowserPath = findSystemBrowser();
  if (systemBrowserPath) {
    await logger.success?.(`渲染浏览器: 系统 ${systemBrowserPath}`);
    return;
  }

  const status = await getBrowserStatus(rootDir);
  if (status.browserInstalled && status.executablePath) {
    await logger.success?.(`渲染浏览器: Playwright ${status.executablePath}`);
  } else if (status.needsBrowserReminder) {
    await logger.warning?.(
      '渲染浏览器: 未检测到系统浏览器或 Playwright Chromium（主菜单「Playwright 浏览器」可安装）'
    );
  }
}

function spawnPnpmPlaywrightInstall(rootDir, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'playwright', 'install', 'chromium'], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, ...extraEnv },
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`playwright install chromium 退出码 ${code}`));
    });
  });
}

export async function installPlaywrightChromium(rootDir = resolveProjectPath()) {
  const extraEnv =
    process.env.PLAYWRIGHT_DOWNLOAD_HOST === undefined ? PLAYWRIGHT_DOWNLOAD_ENV : {};
  await spawnPnpmPlaywrightInstall(rootDir, extraEnv);
}
