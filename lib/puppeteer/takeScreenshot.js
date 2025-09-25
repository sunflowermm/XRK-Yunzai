import fs from 'fs';
import path from 'path';
import Puppeteer from './renderers/puppeteer/lib/puppeteer.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import yaml from 'yaml';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// 获取 require 函数来加载 .puppeteerrc.cjs
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// 全局常量
const ROOT_PATH = process.cwd();
const DB_PATH = path.join(ROOT_PATH, 'temp/screenshot/screenshot-manager.db');
const OUTPUT_BASE_PATH = path.join(ROOT_PATH, 'plugins/XRK/resources/help_other');
const MAX_RENDER_COUNT = 100;
const MAX_IDLE_TIME = 3600000;
const DEFAULT_IMAGE_PATH = path.join(ROOT_PATH, 'renderers', '截图失败.jpg');
const CONFIG_PATH = path.join(ROOT_PATH, 'data/xrkconfig/config.yaml');

// 获取浏览器可执行文件路径
let browserExecutablePath = null;
try {
    const puppeteerConfig = require(path.join(ROOT_PATH, '.puppeteerrc.cjs'));
    browserExecutablePath = puppeteerConfig.executablePath;
    logger.info(`使用浏览器路径: ${browserExecutablePath}`);
} catch (e) {
    logger.warn('无法加载 .puppeteerrc.cjs，将使用默认浏览器路径');
}

// 读取配置
let configs = { screen_shot_quality: 1 };
try {
    if (fs.existsSync(CONFIG_PATH)) {
        configs = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } else {
        logger.info('未找到配置文件，使用默认配置');
    }
} catch (e) {
    logger.info('读取配置文件失败，使用默认配置', e);
}

// 全局变量
let browser = null;
let isBrowserCreating = false;
let renderCount = 0;
let lastUsedTime = Date.now();
let dbInstance = null;
let idleTimer = null;

// 默认配置
const DEFAULT_CONFIG = {
    width: null,                  // 截图宽度
    height: null,                 // 截图高度
    quality: 100,                 // JPEG 图片质量 (1-100)
    type: 'jpeg',                 // 图片类型 (jpeg, png)
    deviceScaleFactor: 1,         // 设备缩放比例，默认从 configs 获取
    selector: null,               // 截取特定元素的 CSS 选择器
    waitForSelector: null,        // 等待特定元素出现的 CSS 选择器
    waitForTimeout: null,         // 等待固定时间 (毫秒)
    waitUntil: 'networkidle2',    // 页面加载完成条件
    fullPage: false,              // 是否截取整个页面
    topCutRatio: 0,               // 顶部裁剪比例
    bottomCutRatio: 0,            // 底部裁剪比例
    leftCutRatio: 0,              // 左侧裁剪比例
    rightCutRatio: 0,             // 右侧裁剪比例
    cacheTime: 3600,              // 缓存时间 (秒)
    emulateDevice: null,          // 模拟设备
    userAgent: null,              // 自定义 User-Agent
    timeout: 120000,              // 总超时时间 (毫秒)
    scrollToBottom: true,         // 是否滚动到底部
    cookies: null,                // 自定义 Cookie
    allowFailure: true,           // 允许失败并返回默认图片
    authentication: null,         // HTTP 认证
    clip: null,                   // 裁剪区域
    omitBackground: false,        // 是否省略背景
    encoding: 'binary',           // 图片编码
    hideScrollbars: true,         // 隐藏滚动条
    javascript: true,             // 是否启用 JavaScript
    dark: false,                  // 暗黑模式
    retryCount: 2,                // 重试次数
    retryDelay: 1000              // 重试间隔 (毫秒)
};

DEFAULT_CONFIG.deviceScaleFactor = configs.screen_shot_quality || 1;

// 初始化数据库
async function initDB() {
    if (!dbInstance) {
        try {
            const dbDir = path.dirname(DB_PATH);
            if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
            dbInstance = await open({
                filename: DB_PATH,
                driver: sqlite3.Database
            });
            await dbInstance.exec(`
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
        } catch (err) {
            logger.error('初始化数据库失败:', err);
            dbInstance = { run: async () => ({ changes: 0 }), get: async () => null, all: async () => [], exec: async () => {}, close: async () => {} };
        }
    }
    return dbInstance;
}

// 获取浏览器实例
async function getBrowser() {
    lastUsedTime = Date.now();
    if (browser) {
        try {
            const page = await browser.newPage();
            await page.close();
            return browser;
        } catch (e) {
            logger.warn('现有浏览器实例不可用，将创建新实例');
            browser = null;
        }
    }
    if (isBrowserCreating) {
        let waitTime = 0;
        while (isBrowserCreating && waitTime < 30000) {
            await new Promise(resolve => setTimeout(resolve, 500));
            waitTime += 500;
            if (browser) return browser;
        }
    }
    isBrowserCreating = true;
    try {
        const puppeteerOptions = {
            headless: 'new',
            args: [
                '--disable-gpu', 
                '--no-sandbox', 
                '--disable-dev-shm-usage', 
                '--disable-setuid-sandbox', 
                '--no-zygote', 
                '--disable-web-security', 
                '--allow-file-access-from-files', 
                '--disable-features=site-per-process', 
                '--disable-infobars', 
                '--disable-notifications', 
                '--window-size=1920,1080',
                '--disable-blink-features=AutomationControlled'
            ],
            puppeteerTimeout: 60000
        };
        
        // 如果有检测到的浏览器路径，使用它
        if (browserExecutablePath) {
            puppeteerOptions.executablePath = browserExecutablePath;
        }
        
        logger.info('puppeteer Chromium 启动中...');
        const puppeteerInstance = new Puppeteer(puppeteerOptions);
        browser = await puppeteerInstance.browserInit();
        if (!browser) throw new Error('浏览器实例创建失败');
        logger.info('puppeteer Chromium 启动成功');
        renderCount = 0;
        if (!idleTimer) idleTimer = setInterval(checkIdle, 5 * 60 * 1000);
        return browser;
    } catch (error) {
        logger.error('启动Chromium失败:', error);
        throw error;
    } finally {
        isBrowserCreating = false;
    }
}

// 重置浏览器
async function resetBrowser() {
    if (!browser) return;
    const oldBrowser = browser;
    browser = null;
    try {
        const puppeteerOptions = {
            headless: 'new',
            args: [
                '--disable-gpu', 
                '--no-sandbox', 
                '--disable-dev-shm-usage', 
                '--disable-setuid-sandbox', 
                '--no-zygote', 
                '--disable-web-security', 
                '--allow-file-access-from-files', 
                '--disable-features=site-per-process', 
                '--disable-infobars', 
                '--disable-notifications', 
                '--window-size=1920,1080',
                '--disable-blink-features=AutomationControlled'
            ],
            puppeteerTimeout: 60000
        };
        
        // 如果有检测到的浏览器路径，使用它
        if (browserExecutablePath) {
            puppeteerOptions.executablePath = browserExecutablePath;
        }
        
        const puppeteerInstance = new Puppeteer(puppeteerOptions);
        browser = await puppeteerInstance.browserInit();
        setTimeout(async () => {
            await puppeteerInstance.stop(oldBrowser);
        }, 5000);
        renderCount = 0;
        lastUsedTime = Date.now();
    } catch (error) {
        logger.error('重置浏览器失败:', error);
    }
}

// 检查浏览器空闲状态
function checkIdle() {
    const now = Date.now();
    if (now - lastUsedTime > MAX_IDLE_TIME && browser) {
        logger.info('浏览器实例长时间未使用，释放资源');
        if (browser) {
            browser.close().catch(err => logger.error('关闭浏览器失败:', err));
            browser = null;
        }
    }
}

// 配置页面
async function configurePage(page, config) {
    if (config.authentication) await page.authenticate(config.authentication);
    if (config.cookies) await page.setCookie(...config.cookies);
    if (config.userAgent) await page.setUserAgent(config.userAgent);
    if (config.emulateDevice) {
        try {
            const puppeteer = await import('puppeteer');
            const device = puppeteer.devices[config.emulateDevice];
            if (device) await page.emulate(device);
            else await page.setViewport({ width: config.width || 800, height: config.height || 600, deviceScaleFactor: config.deviceScaleFactor });
        } catch (err) {
            logger.debug('模拟设备失败:', err);
            await page.setViewport({ width: config.width || 800, height: config.height || 600, deviceScaleFactor: config.deviceScaleFactor });
        }
    } else {
        await page.setViewport({ width: config.width || 800, height: config.height || 600, deviceScaleFactor: config.deviceScaleFactor });
    }
    await page.setJavaScriptEnabled(config.javascript);
    if (config.dark) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
}

// 等待页面加载
async function waitForPage(page, config) {
    if (config.waitForSelector) {
        await page.waitForSelector(config.waitForSelector, { timeout: 30000 })
            .catch(err => logger.warn(`等待选择器失败: ${config.waitForSelector}`, err));
    }
    if (config.waitForTimeout) await page.waitForTimeout(config.waitForTimeout);
    if (config.scrollToBottom) {
        await page.evaluate(async () => {
            await new Promise(resolve => {
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
        }).catch(err => logger.warn('滚动到底部失败:', err));
    }
    if (config.hideScrollbars) {
        await page.evaluate(() => { 
            document.documentElement.style.overflow = 'hidden'; 
            document.body.style.overflow = 'hidden'; 
        }).catch(err => logger.warn('隐藏滚动条失败:', err));
    }
}

// 准备截图选项
async function prepareScreenshotOptions(page, config) {
    const options = {
        type: config.type,
        quality: config.type === 'jpeg' ? config.quality : undefined,
        fullPage: config.fullPage,
        omitBackground: config.omitBackground,
        encoding: config.encoding === 'base64' ? 'base64' : 'binary'
    };
    if (config.fullPage || (config.clip && typeof config.clip === 'object')) {
        if (config.clip) options.clip = config.clip;
        return options;
    }
    const contentDimensions = await page.evaluate(() => ({
        width: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth, document.body.offsetWidth, document.documentElement.offsetWidth, document.body.clientWidth, document.documentElement.clientWidth),
        height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, document.body.offsetHeight, document.documentElement.offsetHeight, document.body.clientHeight, document.documentElement.clientHeight)
    })).catch(() => ({ width: 800, height: 600 }));
    let { width, height } = contentDimensions;
    let x = Math.floor(width * config.leftCutRatio);
    width -= x + Math.floor(width * config.rightCutRatio);
    let y = Math.floor(height * config.topCutRatio);
    height -= y + Math.floor(height * config.bottomCutRatio);
    width = Math.max(width, 1);
    height = Math.max(height, 1);
    options.clip = { x, y, width, height };
    if (config.selector) {
        const elementHandle = await page.$(config.selector);
        if (elementHandle) {
            const box = await elementHandle.boundingBox();
            if (box) {
                const clipX = Math.max(x, box.x);
                const clipY = Math.max(y, box.y);
                const clipWidth = Math.min(width, box.width);
                const clipHeight = Math.min(height, box.height);
                if (clipWidth > 0 && clipHeight > 0) {
                    options.clip = { x: clipX, y: clipY, width: clipWidth, height: clipHeight };
                }
            }
        }
    }
    return options;
}

// 使用默认图片
function useDefaultImage(imageName, config, outputBasePath) {
    const defaultImagePath = path.join(outputBasePath, `${imageName}.${config.type}`);
    try {
        fs.copyFileSync(DEFAULT_IMAGE_PATH, defaultImagePath);
        return defaultImagePath;
    } catch (error) {
        logger.error('复制默认图片失败:', error);
        return DEFAULT_IMAGE_PATH;
    }
}

/**
 * 获取截图
 * @param {string} target - 目标 URL 或文件路径
 * @param {string} imageName - 输出图片名称
 * @param {object} config - 截图配置
 * @returns {Promise<string>} 图片路径
 */
export async function takeScreenshot(target, imageName, config = {}) {
    const finalConfig = { ...DEFAULT_CONFIG, ...config };
    if (!fs.existsSync(OUTPUT_BASE_PATH)) fs.mkdirSync(OUTPUT_BASE_PATH, { recursive: true });

    let page;
    for (let retryAttempt = 0; retryAttempt <= finalConfig.retryCount; retryAttempt++) {
        try {
            const browser = await getBrowser();
            page = await browser.newPage();
            await configurePage(page, finalConfig);
            const isUrl = target.startsWith('http') || target.startsWith('https');
            await page.goto(isUrl ? target : `file://${target}`, { 
                waitUntil: finalConfig.waitUntil, 
                timeout: finalConfig.timeout - 5000 
            });
            await waitForPage(page, finalConfig);
            const contentDimensions = await page.evaluate(() => ({
                width: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth, document.body.offsetWidth, document.documentElement.offsetWidth, document.body.clientWidth, document.documentElement.clientWidth),
                height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, document.body.offsetHeight, document.documentElement.offsetHeight, document.body.clientHeight, document.documentElement.clientHeight)
            }));
            const finalWidth = finalConfig.width || contentDimensions.width;
            const finalHeight = finalConfig.height || contentDimensions.height;
            if (!finalConfig.fullPage) {
                await page.setViewport({ 
                    width: finalWidth, 
                    height: finalHeight, 
                    deviceScaleFactor: finalConfig.deviceScaleFactor 
                });
            }
            const screenshotOptions = await prepareScreenshotOptions(page, { 
                ...finalConfig, 
                width: finalWidth, 
                height: finalHeight 
            });
            const imageBuffer = await page.screenshot(screenshotOptions);
            const imagePath = path.join(OUTPUT_BASE_PATH, `${imageName}.${finalConfig.type}`);
            if (typeof imageBuffer === 'string') {
                fs.writeFileSync(imagePath, imageBuffer, 'base64');
            } else {
                fs.writeFileSync(imagePath, imageBuffer);
            }
            renderCount++;
            lastUsedTime = Date.now();
            if (renderCount >= MAX_RENDER_COUNT) {
                logger.info(`渲染次数已达到阈值(${renderCount}/${MAX_RENDER_COUNT})，准备重置浏览器...`);
                setTimeout(() => resetBrowser(), 1000);
            }

            return imagePath;
        } catch (error) {
            logger.error(`截图失败 (尝试 ${retryAttempt + 1}/${finalConfig.retryCount + 1}):`, error);
            const db = await initDB();
            const today = new Date().toISOString().split('T')[0];
            const now = new Date().toISOString();
            await db.run(
                `INSERT INTO error_logs (date, time, error, stack, target) VALUES (?, ?, ?, ?, ?)`, 
                today, now, error.message, error.stack, target
            ).catch(err => logger.debug('记录错误失败:', err));

            if (retryAttempt < finalConfig.retryCount) {
                if (page) await page.close().catch(() => {});
                if (error.message.includes('浏览器') || error.message.includes('Protocol')) {
                    await resetBrowser();
                }
                await new Promise(resolve => setTimeout(resolve, finalConfig.retryDelay));
                continue;
            }
            if (finalConfig.allowFailure) {
                return useDefaultImage(imageName, finalConfig, OUTPUT_BASE_PATH);
            }
            throw error;
        } finally {
            if (page) await page.close().catch(err => logger.debug('关闭页面失败:', err));
        }
    }
}