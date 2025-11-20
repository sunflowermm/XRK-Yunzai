import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import yaml from 'yaml';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import Puppeteer from '../../renderers/puppeteer/lib/puppeteer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const ROOT_PATH = process.cwd();
const DB_PATH = path.join(ROOT_PATH, 'trash', 'screenshot', 'screenshot-manager.db');
const OUTPUT_BASE_PATH = path.join(ROOT_PATH, 'plugins', 'XRK', 'resources', 'help_other');
const MAX_RENDER_COUNT = 100;
const MAX_IDLE_TIME = 3600000;
const DEFAULT_IMAGE_PATH = path.join(ROOT_PATH, 'renderers', '截图失败.jpg');
const CONFIG_PATH = path.join(ROOT_PATH, 'data', 'xrkconfig', 'config.yaml');

const MIN_DIMENSION = 320;
const MAX_DIMENSION = 32768;

let browserExecutablePath = null;
try {
  const rcPath = path.join(ROOT_PATH, '.puppeteerrc.cjs');
  if (fs.existsSync(rcPath)) {
    const puppeteerConfig = require(rcPath);
    browserExecutablePath = puppeteerConfig?.executablePath ?? null;
  }
} catch (error) {
  logger?.warn?.('无法加载 .puppeteerrc.cjs，将使用默认浏览器路径', error);
}

let configs = { screen_shot_quality: 1 };
try {
  if (fs.existsSync(CONFIG_PATH)) {
    configs = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || configs;
  } else {
    logger?.info?.('未找到 data/xrkconfig/config.yaml，使用默认截图配置');
  }
} catch (error) {
  logger?.info?.('读取 data/xrkconfig/config.yaml 失败，使用默认截图配置', error);
}

const DEFAULT_CONFIG = {
  width: 'auto',
  height: 'auto',
  quality: 100,
  type: 'jpeg',
  deviceScaleFactor: configs.screen_shot_quality || 1,
  selector: null,
  waitForSelector: null,
  waitForTimeout: null,
  waitUntil: 'networkidle2',
  fullPage: true,
  topCutRatio: 0,
  bottomCutRatio: 0,
  leftCutRatio: 0,
  rightCutRatio: 0,
  cacheTime: 3600,
  emulateDevice: null,
  userAgent: null,
  timeout: 120000,
  scrollToBottom: true,
  cookies: null,
  allowFailure: true,
  authentication: null,
  clip: null,
  omitBackground: false,
  encoding: 'binary',
  hideScrollbars: true,
  javascript: true,
  dark: false,
  retryCount: 2,
  retryDelay: 1000,
  autoHeight: true
};

function ensureDir(targetPath) {
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }
}

function clampDimension(value, fallback) {
  const candidate = Number.isFinite(value) ? value : fallback;
  const rounded = Math.round(candidate || MIN_DIMENSION);
  return Math.min(Math.max(rounded, MIN_DIMENSION), MAX_DIMENSION);
}

function isAuto(value) {
  return value === undefined || value === null || value === 'auto';
}

function toFileUrl(target) {
  if (/^https?:\/\//i.test(target)) {
    return target;
  }

  const resolvedPath = path.resolve(target);
  const normalized = resolvedPath.replace(/\\/g, '/');

  if (process.platform === 'win32') {
    const drive = normalized.match(/^([A-Za-z]:)/);
    if (drive) {
      const rest = normalized.slice(drive[0].length);
      return `file:///${drive[0]}${encodeURI(rest).replace(/#/g, '%23')}`;
    }
  }

  return `file://${encodeURI(normalized).replace(/#/g, '%23')}`;
}

async function waitImagesLoaded(page) {
  await page.evaluate(() => {
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      const images = document.querySelectorAll('img');
      if (images.length === 0) {
        clearTimeout(timeout);
        resolve();
        return;
      }

      let loaded = 0;
      const done = () => {
        loaded += 1;
        if (loaded >= images.length) {
          clearTimeout(timeout);
          resolve();
        }
      };

      images.forEach((img) => {
        if (img.complete) {
          done();
        } else {
          img.onload = done;
          img.onerror = done;
        }
      });
    });
  }).catch(() => {});
}

async function getContentDimensions(page) {
  return await page
    .evaluate(() => {
      const body = document.body;
      const html = document.documentElement;
      return {
        width: Math.max(
          body.scrollWidth,
          html.scrollWidth,
          body.offsetWidth,
          html.offsetWidth,
          body.clientWidth,
          html.clientWidth
        ),
        height: Math.max(
          body.scrollHeight,
          html.scrollHeight,
          body.offsetHeight,
          html.offsetHeight,
          body.clientHeight,
          html.clientHeight
        )
      };
    })
    .catch(() => ({ width: 1280, height: 720 }));
}

class ScreenshotManager {
  constructor() {
    this.browser = null;
    this.browserPromise = null;
    this.renderCount = 0;
    this.lastUsedTime = Date.now();
    this.dbInstance = null;
    this.idleTimer = null;
    this.pageQueue = new Set();
    this.isClosing = false;

    process.once('exit', () => this.cleanup());
    process.once('SIGINT', () => this.cleanup());
    process.once('SIGTERM', () => this.cleanup());
    process.once('beforeExit', () => this.cleanup());
  }

  async cleanup() {
    if (this.isClosing) return;
    this.isClosing = true;

    try {
      if (this.idleTimer) {
        clearInterval(this.idleTimer);
        this.idleTimer = null;
      }

      if (this.pageQueue.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (this.browser) {
        try {
          const pages = await this.browser.pages();
          await Promise.all(pages.map((page) => page.close().catch(() => {})));
          await this.browser.close();
        } catch {
          // ignore close errors
        }
        this.browser = null;
      }

      if (this.dbInstance) {
        await this.dbInstance.close().catch(() => {});
        this.dbInstance = null;
      }
    } catch {
      // ignore cleanup errors
    }
  }

  async initDB() {
    if (this.dbInstance) return this.dbInstance;

    try {
      ensureDir(path.dirname(DB_PATH));
      this.dbInstance = await open({
        filename: DB_PATH,
        driver: sqlite3.Database
      });

      await this.dbInstance.exec(`
        CREATE TABLE IF NOT EXISTS screenshot_cache (
          target TEXT,
          config TEXT,
          image_path TEXT,
          created_at INTEGER,
          PRIMARY KEY (target, config)
        );
        CREATE TABLE IF NOT EXISTS render_stats (
          date TEXT,
          total_renders INTEGER DEFAULT 0,
          PRIMARY KEY (date)
        );
        CREATE TABLE IF NOT EXISTS error_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT,
          time TEXT,
          error TEXT,
          stack TEXT,
          target TEXT
        );
      `);
    } catch (error) {
      logger?.error?.('初始化截图数据库失败:', error);
      this.dbInstance = {
        run: async () => ({ changes: 0 }),
        get: async () => null,
        all: async () => [],
        exec: async () => {},
        close: async () => {}
      };
    }

    return this.dbInstance;
  }

  async getBrowser() {
    if (this.isClosing) {
      throw new Error('浏览器正在关闭');
    }

    this.lastUsedTime = Date.now();

    if (this.browser) {
      try {
        await this.browser.version();
        return this.browser;
      } catch {
        logger?.warn?.('现有浏览器实例不可用，准备重建');
        this.browser = null;
        this.browserPromise = null;
      }
    }

    if (this.browserPromise) {
      return this.browserPromise;
    }

    this.browserPromise = this._createBrowser();

    try {
      this.browser = await this.browserPromise;
      return this.browser;
    } finally {
      this.browserPromise = null;
    }
  }

  async _createBrowser() {
    if (this.isClosing) {
      throw new Error('浏览器正在关闭');
    }

    try {
      const puppeteerOptions = {
        headless: 'new',
        args: [
          '--disable-gpu',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--allow-file-access-from-files',
          '--disable-infobars',
          '--disable-notifications',
          '--window-size=1920,1080',
          '--disable-blink-features=AutomationControlled',
          '--disable-extensions',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding'
        ],
        puppeteerTimeout: 60000
      };

      if (browserExecutablePath) {
        puppeteerOptions.executablePath = browserExecutablePath;
      }

      const renderer = new Puppeteer(puppeteerOptions);
      const browser = await renderer.browserInit();

      if (!browser) {
        throw new Error('浏览器实例创建失败');
      }

      this.renderCount = 0;

      if (!this.idleTimer) {
        this.idleTimer = setInterval(() => this.checkIdle(), 5 * 60 * 1000);
      }

      browser.on('disconnected', () => {
        logger?.warn?.('浏览器断开连接，等待重新创建');
        if (this.browser === browser) {
          this.browser = null;
          this.browserPromise = null;
        }
      });

      return browser;
    } catch (error) {
      logger?.error?.('启动Chromium失败:', error);
      throw error;
    }
  }

  async resetBrowser() {
    if (this.isClosing) return;

    const oldBrowser = this.browser;
    this.browser = null;
    this.browserPromise = null;

    if (oldBrowser) {
      try {
        const pages = await oldBrowser.pages();
        await Promise.all(pages.map((page) => page.close().catch(() => {})));
        setTimeout(async () => {
          try {
            await oldBrowser.close();
          } catch {
            // ignore
          }
        }, 1000);
      } catch (error) {
        logger?.error?.('关闭旧浏览器失败:', error);
      }
    }

    try {
      await this.getBrowser();
    } catch (error) {
      logger?.error?.('重置浏览器失败:', error);
    }
  }

  checkIdle() {
    if (this.isClosing || !this.browser) return;
    if (Date.now() - this.lastUsedTime > MAX_IDLE_TIME) {
      logger?.info?.('浏览器长时间未使用，开始释放资源');
      this.resetBrowser();
    }
  }

  async configurePage(page, config) {
    if (config.authentication) {
      await page.authenticate(config.authentication);
    }

    if (config.cookies) {
      await page.setCookie(...config.cookies);
    }

    if (config.userAgent) {
      await page.setUserAgent(config.userAgent);
    }

    if (config.emulateDevice) {
      try {
        const puppeteer = await import('puppeteer');
        const device = puppeteer.devices?.[config.emulateDevice];
        if (device) {
          await page.emulate(device);
        }
      } catch (error) {
        logger?.debug?.('模拟设备失败，使用默认视口', error);
      }
    }

    const defaultWidth = clampDimension(
      isAuto(config.width) ? 1280 : Number(config.width),
      1280
    );
    const defaultHeight = clampDimension(
      isAuto(config.height) ? 720 : Number(config.height),
      720
    );

    await page.setViewport({
      width: defaultWidth,
      height: defaultHeight,
      deviceScaleFactor: config.deviceScaleFactor
    });

    await page.setJavaScriptEnabled(config.javascript);

    if (config.dark) {
      await page.emulateMediaFeatures([
        { name: 'prefers-color-scheme', value: 'dark' }
      ]);
    }

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false
      });
    });
  }

  async waitForPage(page, config) {
    if (config.waitForSelector) {
      await page
        .waitForSelector(config.waitForSelector, { timeout: 30000 })
        .catch((err) => logger?.warn?.(`等待选择器失败: ${config.waitForSelector}`, err));
    }

    if (config.waitForTimeout) {
      await page.waitForTimeout(config.waitForTimeout);
    }

    if (config.scrollToBottom) {
      await page
        .evaluate(async () => {
          await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
              window.scrollBy(0, distance);
              totalHeight += distance;
              if (totalHeight >= document.body.scrollHeight) {
                clearInterval(timer);
                window.scrollTo(0, 0);
                resolve();
              }
            }, 100);
          });
        })
        .catch((err) => logger?.warn?.('滚动到底部失败:', err));
    }

    if (config.hideScrollbars) {
      await page
        .evaluate(() => {
          document.documentElement.style.overflow = 'hidden';
          document.body.style.overflow = 'hidden';
        })
        .catch((err) => logger?.warn?.('隐藏滚动条失败:', err));
    }

    await waitImagesLoaded(page);
  }

  async prepareScreenshotOptions(page, config) {
    const options = {
      type: config.type,
      quality: config.type === 'jpeg' ? config.quality : undefined,
      fullPage: config.fullPage,
      omitBackground: config.omitBackground,
      encoding: config.encoding === 'base64' ? 'base64' : 'binary'
    };

    if (config.fullPage && !config.clip) {
      return options;
    }

    const dims = await getContentDimensions(page);
    let { width, height } = dims;

    let x = Math.floor(width * config.leftCutRatio);
    width -= x + Math.floor(width * config.rightCutRatio);
    let y = Math.floor(height * config.topCutRatio);
    height -= y + Math.floor(height * config.bottomCutRatio);

    width = Math.max(width, 1);
    height = Math.max(height, 1);

    options.clip = {
      x,
      y,
      width,
      height
    };

    if (config.clip) {
      options.clip = {
        x: config.clip.x ?? x,
        y: config.clip.y ?? y,
        width: config.clip.width ?? width,
        height: config.clip.height ?? height
      };
    }

    if (config.selector) {
      const handle = await page.$(config.selector);
      if (handle) {
        const box = await handle.boundingBox();
        if (box) {
          options.clip = {
            x: Math.max(box.x, 0),
            y: Math.max(box.y, 0),
            width: Math.max(box.width, 1),
            height: Math.max(box.height, 1)
          };
        }
      }
    }

    return options;
  }

  async executeScreenshot(target, imageName, config) {
    const pageId = Math.random().toString(36).slice(2);
    this.pageQueue.add(pageId);

    let page = null;

    try {
      const browser = await this.getBrowser();
      page = await browser.newPage();
      page.setDefaultTimeout(config.timeout);
      page.setDefaultNavigationTimeout(config.timeout);

      await this.configurePage(page, config);

      await page.goto(toFileUrl(target), {
        waitUntil: config.waitUntil,
        timeout: config.timeout - 5000
      });

      await this.waitForPage(page, config);

      const contentDimensions = await getContentDimensions(page);
      const finalWidth = clampDimension(
        isAuto(config.width) ? contentDimensions.width : Number(config.width),
        contentDimensions.width
      );
      const finalHeight = clampDimension(
        isAuto(config.height) ? contentDimensions.height : Number(config.height),
        contentDimensions.height
      );

      if (!config.fullPage) {
        await page.setViewport({
          width: finalWidth,
          height: finalHeight,
          deviceScaleFactor: config.deviceScaleFactor
        });
      }

      const screenshotOptions = await this.prepareScreenshotOptions(page, {
        ...config,
        width: finalWidth,
        height: finalHeight
      });

      const buffer = await page.screenshot(screenshotOptions);
      const imagePath = path.join(OUTPUT_BASE_PATH, `${imageName}.${config.type}`);
      ensureDir(path.dirname(imagePath));

      if (typeof buffer === 'string') {
        fs.writeFileSync(imagePath, buffer, 'base64');
      } else {
        fs.writeFileSync(imagePath, buffer);
      }

      this.renderCount += 1;
      this.lastUsedTime = Date.now();

      if (this.renderCount >= MAX_RENDER_COUNT && this.pageQueue.size === 1) {
        logger?.info?.(
          `截图次数达到阈值(${this.renderCount}/${MAX_RENDER_COUNT})，准备重置浏览器`
        );
        setTimeout(() => this.resetBrowser(), 1000);
      }

      return imagePath;
    } finally {
      if (page) {
        try {
          await page.close();
        } catch {
          // ignore
        }
      }
      this.pageQueue.delete(pageId);
    }
  }

  useDefaultImage(imageName, config) {
    const defaultOutput = path.join(OUTPUT_BASE_PATH, `${imageName}.${config.type}`);
    try {
      ensureDir(path.dirname(defaultOutput));
      if (fs.existsSync(DEFAULT_IMAGE_PATH)) {
        fs.copyFileSync(DEFAULT_IMAGE_PATH, defaultOutput);
        return defaultOutput;
      }
    } catch (error) {
      logger?.error?.('复制默认截图失败:', error);
    }
    return DEFAULT_IMAGE_PATH;
  }
}

const manager = new ScreenshotManager();

export async function takeScreenshot(target, imageName, config = {}) {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  ensureDir(OUTPUT_BASE_PATH);

  for (let attempt = 0; attempt <= finalConfig.retryCount; attempt += 1) {
    try {
      return await manager.executeScreenshot(target, imageName, finalConfig);
    } catch (error) {
      logger?.error?.(
        `截图失败 (尝试 ${attempt + 1}/${finalConfig.retryCount + 1}):`,
        error
      );

      const db = await manager.initDB();
      const today = new Date().toISOString().split('T')[0];
      const now = new Date().toISOString();
      await db
        .run(
          `INSERT INTO error_logs (date, time, error, stack, target) VALUES (?, ?, ?, ?, ?)`,
          today,
          now,
          error.message,
          error.stack,
          target
        )
        .catch((err) => logger?.debug?.('记录截图错误失败:', err));

      if (attempt < finalConfig.retryCount) {
        if (
          error.message.includes('浏览器') ||
          error.message.includes('Protocol') ||
          error.message.includes('Target closed') ||
          error.message.includes('Session closed')
        ) {
          await manager.resetBrowser();
        }

        await new Promise((resolve) => setTimeout(resolve, finalConfig.retryDelay));
        continue;
      }

      if (finalConfig.allowFailure) {
        return manager.useDefaultImage(imageName, finalConfig);
      }

      throw error;
    }
  }
}
