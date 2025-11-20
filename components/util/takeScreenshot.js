import fs from 'fs';
import path from 'path';
import cfg from '../../lib/config/config.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import yaml from 'yaml';

const ROOT_PATH = process.cwd();
const DB_PATH = path.join(ROOT_PATH, 'temp/screenshot/screenshot-manager.db');
const OUTPUT_BASE_PATH = path.join(ROOT_PATH, 'plugins/XRK/resources/help_other');
const MAX_RENDER_COUNT = 100;
const MAX_IDLE_TIME = 3600000;
const DEFAULT_IMAGE_PATH = path.join(ROOT_PATH, 'renderers', '截图失败.jpg');
const CONFIG_PATH = path.join(ROOT_PATH, 'data/xrkconfig/config.yaml');

let configs = { screen_shot_quality: 1 };
try {
    if (fs.existsSync(CONFIG_PATH)) {
        configs = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
} catch (e) {
    logger?.info?.('读取配置文件失败，使用默认配置', e);
}

const DEFAULT_CONFIG = {
    width: null,
    height: null,
    quality: 100,
    type: 'jpeg',
    deviceScaleFactor: configs.screen_shot_quality || 1,
    selector: null,
    waitForSelector: null,
    waitForTimeout: null,
    waitUntil: 'networkidle2',
    fullPage: false,
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
    autoHeight: false
};

class ScreenshotManager {
    constructor() {
        this.browser = null;
        this.context = null;
        this.rendererType = null;
        this.renderCount = 0;
        this.lastUsedTime = Date.now();
        this.dbInstance = null;
        this.idleTimer = null;
        this.pageQueue = new Set();
        this.isClosing = false;
        this.browserPromise = null;
        
        process.once('exit', () => this.cleanup());
        process.once('SIGINT', () => this.cleanup());
        process.once('SIGTERM', () => this.cleanup());
        process.once('beforeExit', () => this.cleanup());
    }

    getRendererType() {
        if (this.rendererType) return this.rendererType;
        
        const rendererCfg = cfg.renderer || {};
        const playwrightCfg = rendererCfg.playwright || {};
        const puppeteerCfg = rendererCfg.puppeteer || {};
        
        if (playwrightCfg.enabled !== false && (playwrightCfg.chromiumPath || playwrightCfg.channel)) {
            this.rendererType = 'playwright';
        } else if (puppeteerCfg.enabled !== false) {
            this.rendererType = 'puppeteer';
        } else {
            this.rendererType = 'puppeteer';
        }
        
        return this.rendererType;
    }

    async initBrowser() {
        if (this.browser) return this.browser;
        if (this.browserPromise) return await this.browserPromise;
        
        this.browserPromise = this._createBrowser();
        
        try {
            this.browser = await this.browserPromise;
            return this.browser;
        } finally {
            this.browserPromise = null;
        }
    }

    async _createBrowser() {
        if (this.isClosing) throw new Error('浏览器正在关闭');
        
        const type = this.getRendererType();
        
        try {
            if (type === 'playwright') {
                const playwright = (await import('playwright')).default;
                const rendererCfg = cfg.renderer?.playwright || {};
                const browserType = rendererCfg.browserType || 'chromium';
                const defaultViewport = rendererCfg.viewport || { width: 1280, height: 720, deviceScaleFactor: 1 };
                
                this.browser = await playwright[browserType].launch({
                    headless: rendererCfg.headless !== false,
                    args: rendererCfg.args || [],
                    channel: rendererCfg.channel,
                    executablePath: rendererCfg.chromiumPath
                });
                
                this.context = await this.browser.newContext({
                    viewport: defaultViewport,
                    deviceScaleFactor: defaultViewport.deviceScaleFactor || 1
                });
                
                logger?.info?.('[截图] 使用 playwright 渲染器');
            } else {
                const puppeteer = (await import('puppeteer')).default;
                const rendererCfg = cfg.renderer?.puppeteer || {};
                
                this.browser = await puppeteer.launch({
                    headless: rendererCfg.headless !== false ? 'new' : false,
                    args: rendererCfg.args || [],
                    executablePath: rendererCfg.chromiumPath
                });
                
                logger?.info?.('[截图] 使用 puppeteer 渲染器');
            }
            
            this.renderCount = 0;
            
            if (!this.idleTimer && !this.isClosing) {
                this.idleTimer = setInterval(() => this.checkIdle(), 5 * 60 * 1000);
            }
            
            if (this.browser.on) {
                this.browser.on('disconnected', () => {
                    logger?.warn?.('浏览器断开连接');
                    this.browser = null;
                    this.context = null;
                    this.browserPromise = null;
                });
            }
            
            return this.browser;
        } catch (error) {
            logger?.error?.(`启动${type}失败:`, error);
            if (type === 'playwright') {
                try {
                    const puppeteer = (await import('puppeteer')).default;
                    const rendererCfg = cfg.renderer?.puppeteer || {};
                    
                    this.browser = await puppeteer.launch({
                        headless: rendererCfg.headless !== false ? 'new' : false,
                        args: rendererCfg.args || [],
                        executablePath: rendererCfg.chromiumPath
                    });
                    
                    this.rendererType = 'puppeteer';
                    logger?.info?.('[截图] 回退到 puppeteer 渲染器');
                    return this.browser;
                } catch (e) {
                    logger?.error?.('puppeteer 初始化也失败:', e);
                    throw e;
                }
            }
            throw error;
        }
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
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            if (this.context) {
                await this.context.close().catch(() => {});
                this.context = null;
            }
            
            if (this.browser) {
                await this.browser.close().catch(() => {});
                this.browser = null;
            }
            
            if (this.dbInstance) {
                await this.dbInstance.close().catch(() => {});
                this.dbInstance = null;
            }
        } catch (e) {
            // 忽略清理错误
        }
    }

    async initDB() {
        if (!this.dbInstance) {
            try {
                const dbDir = path.dirname(DB_PATH);
                if (!fs.existsSync(dbDir)) {
                    fs.mkdirSync(dbDir, { recursive: true });
                }
                
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
            } catch (err) {
                logger?.error?.('初始化数据库失败:', err);
                this.dbInstance = { 
                    run: async () => ({ changes: 0 }), 
                    get: async () => null, 
                    all: async () => [], 
                    exec: async () => {}, 
                    close: async () => {} 
                };
            }
        }
        return this.dbInstance;
    }

    checkIdle() {
        if (this.isClosing) return;
        
        const now = Date.now();
        if (now - this.lastUsedTime > MAX_IDLE_TIME && this.browser) {
            logger?.info?.('浏览器实例长时间未使用，释放资源');
            this.browser = null;
            this.context = null;
        }
    }

    async getContentDimensions(page, type) {
        if (type === 'playwright') {
            return await page.evaluate(() => {
                const body = document.body;
                const html = document.documentElement;
                return {
                    width: Math.max(
                        body.scrollWidth, html.scrollWidth,
                        body.offsetWidth, html.offsetWidth,
                        body.clientWidth, html.clientWidth
                    ),
                    height: Math.max(
                        body.scrollHeight, html.scrollHeight,
                        body.offsetHeight, html.offsetHeight,
                        body.clientHeight, html.clientHeight
                    )
                };
            });
        } else {
            return await page.evaluate(() => {
                const body = document.body;
                const html = document.documentElement;
                return {
                    width: Math.max(
                        body.scrollWidth, html.scrollWidth,
                        body.offsetWidth, html.offsetWidth,
                        body.clientWidth, html.clientWidth
                    ),
                    height: Math.max(
                        body.scrollHeight, html.scrollHeight,
                        body.offsetHeight, html.offsetHeight,
                        body.clientHeight, html.clientHeight
                    )
                };
            });
        }
    }

    async executeScreenshot(target, imageName, config) {
        const pageId = Math.random().toString(36).substring(7);
        this.pageQueue.add(pageId);
        
        let page = null;
        
        try {
            await this.initBrowser();
            this.lastUsedTime = Date.now();
            
            const type = this.getRendererType();
            const isUrl = target.startsWith('http') || target.startsWith('https');
            const targetUrl = isUrl ? target : `file://${path.resolve(target)}`;
            
            const rendererCfg = cfg.renderer?.[type] || {};
            const defaultViewport = rendererCfg.viewport || { width: 1280, height: 720, deviceScaleFactor: 1 };
            
            let viewportWidth = config.width || defaultViewport.width;
            let viewportHeight = config.height;
            const deviceScaleFactor = config.deviceScaleFactor || defaultViewport.deviceScaleFactor || 1;
            
            const needAutoHeight = config.height === null || config.height === 'auto' || config.autoHeight || config.fullPage;
            
            if (type === 'playwright') {
                page = await this.context.newPage();
                await page.setDefaultTimeout(config.timeout);
                await page.setDefaultNavigationTimeout(config.timeout);
                
                if (config.userAgent) {
                    await page.setExtraHTTPHeaders({ 'User-Agent': config.userAgent });
                }
                
                await page.goto(targetUrl, {
                    waitUntil: config.waitUntil,
                    timeout: config.timeout
                });
                
                if (config.waitForSelector) {
                    await page.waitForSelector(config.waitForSelector, { timeout: 30000 }).catch(() => {});
                }
                
                if (config.waitForTimeout) {
                    await page.waitForTimeout(config.waitForTimeout);
                }
                
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
                    }).catch(() => {});
                }
                
                if (needAutoHeight) {
                    const contentDims = await this.getContentDimensions(page, type);
                    viewportHeight = contentDims.height;
                    if (config.width === null || config.width === 'auto') {
                        viewportWidth = contentDims.width;
                    }
                } else {
                    viewportHeight = viewportHeight || defaultViewport.height;
                }
                
                await page.setViewportSize({ width: viewportWidth, height: viewportHeight });
                
                const screenshotOptions = {
                    type: config.type,
                    quality: config.type === 'jpeg' ? config.quality : undefined,
                    fullPage: config.fullPage,
                    omitBackground: config.omitBackground
                };
                
                if (config.selector) {
                    const element = await page.locator(config.selector).first();
                    if (element) {
                        const imageBuffer = await element.screenshot(screenshotOptions);
                        return await this.saveImage(imageBuffer, imageName, config);
                    }
                }
                
                const imageBuffer = await page.screenshot(screenshotOptions);
                return await this.saveImage(imageBuffer, imageName, config);
                
            } else {
                page = await this.browser.newPage();
                page.setDefaultTimeout(config.timeout);
                page.setDefaultNavigationTimeout(config.timeout);
                
                if (config.userAgent) {
                    await page.setUserAgent(config.userAgent);
                }
                
                await page.goto(targetUrl, {
                    waitUntil: config.waitUntil,
                    timeout: config.timeout
                });
                
                if (config.waitForSelector) {
                    await page.waitForSelector(config.waitForSelector, { timeout: 30000 }).catch(() => {});
                }
                
                if (config.waitForTimeout) {
                    await page.waitForTimeout(config.waitForTimeout);
                }
                
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
                    }).catch(() => {});
                }
                
                if (needAutoHeight) {
                    const contentDims = await this.getContentDimensions(page, type);
                    viewportHeight = contentDims.height;
                    if (config.width === null || config.width === 'auto') {
                        viewportWidth = contentDims.width;
                    }
                } else {
                    viewportHeight = viewportHeight || defaultViewport.height;
                }
                
                await page.setViewport({
                    width: viewportWidth,
                    height: viewportHeight,
                    deviceScaleFactor: deviceScaleFactor
                });
                
                const screenshotOptions = {
                    type: config.type,
                    quality: config.type === 'jpeg' ? config.quality : undefined,
                    fullPage: config.fullPage,
                    omitBackground: config.omitBackground
                };
                
                if (config.selector) {
                    const element = await page.$(config.selector);
                    if (element) {
                        const imageBuffer = await element.screenshot(screenshotOptions);
                        return await this.saveImage(imageBuffer, imageName, config);
                    }
                }
                
                const imageBuffer = await page.screenshot(screenshotOptions);
                return await this.saveImage(imageBuffer, imageName, config);
            }
            
        } finally {
            if (page) {
                try {
                    await page.close();
                } catch (e) {
                    // 忽略关闭错误
                }
            }
            this.pageQueue.delete(pageId);
        }
    }

    async saveImage(imageBuffer, imageName, config) {
        const imagePath = path.join(OUTPUT_BASE_PATH, `${imageName}.${config.type}`);
        const outputDir = path.dirname(imagePath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        if (Buffer.isBuffer(imageBuffer)) {
            fs.writeFileSync(imagePath, imageBuffer);
        } else if (typeof imageBuffer === 'string') {
            fs.writeFileSync(imagePath, imageBuffer, 'base64');
        } else {
            throw new Error('不支持的图片格式');
        }
        
        this.renderCount++;
        this.lastUsedTime = Date.now();
        
        if (this.renderCount >= MAX_RENDER_COUNT && this.pageQueue.size === 1) {
            logger?.info?.(`渲染次数已达到阈值(${this.renderCount}/${MAX_RENDER_COUNT})，准备重置浏览器...`);
            setTimeout(() => {
                this.browser = null;
                this.context = null;
            }, 1000);
        }
        
        return imagePath;
    }

    useDefaultImage(imageName, config, outputBasePath) {
        const defaultImagePath = path.join(outputBasePath, `${imageName}.${config.type}`);
        try {
            if (fs.existsSync(DEFAULT_IMAGE_PATH)) {
                fs.copyFileSync(DEFAULT_IMAGE_PATH, defaultImagePath);
                return defaultImagePath;
            }
        } catch (error) {
            logger?.error?.('复制默认图片失败:', error);
        }
        return DEFAULT_IMAGE_PATH;
    }
}

const manager = new ScreenshotManager();

export async function takeScreenshot(target, imageName, config = {}) {
    const finalConfig = { ...DEFAULT_CONFIG, ...config };
    
    if (!fs.existsSync(OUTPUT_BASE_PATH)) {
        fs.mkdirSync(OUTPUT_BASE_PATH, { recursive: true });
    }
    
    for (let retryAttempt = 0; retryAttempt <= finalConfig.retryCount; retryAttempt++) {
        try {
            const imagePath = await manager.executeScreenshot(target, imageName, finalConfig);
            return imagePath;
            
        } catch (error) {
            logger?.error?.(`截图失败 (尝试 ${retryAttempt + 1}/${finalConfig.retryCount + 1}):`, error);
            
            const db = await manager.initDB();
            const today = new Date().toISOString().split('T')[0];
            const now = new Date().toISOString();
            await db.run(
                `INSERT INTO error_logs (date, time, error, stack, target) VALUES (?, ?, ?, ?, ?)`,
                today, now, error.message, error.stack, target
            ).catch(() => {});
            
            if (retryAttempt < finalConfig.retryCount) {
                if (error.message.includes('浏览器') || 
                    error.message.includes('Protocol') ||
                    error.message.includes('Target closed') ||
                    error.message.includes('Session closed')) {
                    manager.browser = null;
                    manager.context = null;
                }
                
                await new Promise(resolve => setTimeout(resolve, finalConfig.retryDelay));
                continue;
            }
            
            if (finalConfig.allowFailure) {
                return manager.useDefaultImage(imageName, finalConfig, OUTPUT_BASE_PATH);
            }
            
            throw error;
        }
    }
}
