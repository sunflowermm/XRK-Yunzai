// Path: lib/renderer/playwright.js
// Note: Main implementation of the Playwright renderer. Optimized over Puppeteer:
// - Uses Playwright's modern API for better performance and cross-browser support.
// - Better error handling and logging.
// - Supports multiple browser types (chromium, firefox, webkit).
// - Automatic context management for isolation.
// - Improved health check: periodically checks if browser is responsive.
// - Faster image loading wait using page.waitForSelector and evaluate.
// - Optimized multi-page screenshot with smoother scrolling.
// - Reduced memory usage by closing pages immediately.
// - Added support for custom browser type from config.

import Renderer from "../../../lib/renderer/Renderer.js";
import os from "node:os";
import lodash from "lodash";
import playwright from "playwright";  // Import playwright
import cfg from "../../../lib/config/config.js";
import fs from "node:fs";
import path from "node:path";

const _path = process.cwd();
let mac = "";

export default class PlaywrightRenderer extends Renderer {
  constructor(config = {}) {
    super({
      id: "playwright",
      type: "image",
      render: "screenshot",
    });
    this.browser = null;
    this.lock = false;
    this.shoting = [];
    this.pagePool = new Map();

    // 截图次数和重启阈值
    this.restartNum = config.restartNum || 100;
    this.renderNum = 0;

    // 浏览器配置
    this.browserType = config.browser || "chromium";  // Default to chromium
    this.config = {
      headless: config.headless ?? true,
      args: config.args || [
        "--disable-gpu",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
      channel: config.channel,  // e.g., 'chrome' for system Chrome
      ...config,  // Merge other configs
    };

    // 兼容旧配置 (if migrating from Puppeteer)
    if (config.chromiumPath || cfg?.bot?.chromium_path)
      this.config.executablePath = config.chromiumPath || cfg?.bot?.chromium_path;
    if (config.playwrightWS || cfg?.bot?.playwright_ws)
      this.config.browserURL = config.playwrightWS || cfg?.bot?.playwright_ws;  // Playwright uses browserURL for WS

    // 超时设置
    this.playwrightTimeout = config.playwrightTimeout || cfg?.bot?.playwright_timeout || 120000;

    // 上下文选项
    this.contextOptions = config.contextOptions || {
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      bypassCSP: true,
      reducedMotion: "reduce",
    };

    // 浏览器健康监控
    this.healthCheckTimer = null;
    this.healthCheckInterval = config.healthCheckInterval || 60000;  // 1 minute
    this.browserMacKey = null;

    // 退出时清理资源
    process.on("exit", () => this.cleanup());
  }

  // 获取Mac地址作为唯一标识 (same as Puppeteer)
  async getMac() {
    let mac = "00:00:00:00:00:00";
    try {
      const network = os.networkInterfaces();
      for (const key in network) {
        for (const iface of network[key]) {
          if (iface.mac && iface.mac !== "00:00:00:00:00:00") {
            mac = iface.mac;
            return mac.replace(/:/g, "");
          }
        }
      }
    } catch (e) {
      console.error("获取MAC地址失败:", e);
    }
    return mac.replace(/:/g, "");
  }

  // 浏览器初始化 (optimized: uses playwright.launch with browserType)
  async browserInit() {
    if (this.browser) return this.browser;
    if (this.lock) {
      let waitTime = 0;
      while (this.lock && waitTime < 30000) {
        await new Promise((r) => setTimeout(r, 100));
        waitTime += 100;
      }
      if (this.browser) return this.browser;
      if (this.lock) return false;
    }

    this.lock = true;

    try {
      console.log(`playwright ${this.browserType} 启动中...`);

      if (!mac) {
        mac = await this.getMac();
        this.browserMacKey = `Yz:${this.browserType}:browserURL:${mac}`;
      }

      let browserURL = null;
      try {
        if (this.browserMacKey) {
          browserURL = await redis.get(this.browserMacKey);  // Assuming redis is available, as in reference
        }
      } catch (e) {}

      if (!browserURL && this.config.browserURL) {
        browserURL = this.config.browserURL;
      }

      if (browserURL) {
        try {
          console.log(`尝试连接到现有${this.browserType}实例: ${browserURL}`);
          this.browser = await playwright[this.browserType].connect(browserURL);

          // Test connection with a quick new page
          const testContext = await this.browser.newContext();
          const testPage = await testContext.newPage();
          await testPage.close();
          await testContext.close();
          console.log(`成功连接到现有${this.browserType}实例`);
        } catch (e) {
          console.log(`连接到现有${this.browserType}实例失败: ${e.message}`);
          try {
            if (this.browserMacKey) {
              await redis.del(this.browserMacKey);
            }
          } catch (e) {}
          this.browser = null;
        }
      }

      if (!this.browser) {
        this.browser = await playwright[this.browserType].launch(this.config);

        if (this.browser) {
          console.log(`playwright ${this.browserType} 启动成功`);
          try {
            if (this.browserMacKey) {
              await redis.set(this.browserMacKey, this.browser.wsEndpoint(), {  // Playwright has wsEndpoint()
                EX: 60 * 60 * 24 * 30, // 30天过期
              });
            }
          } catch (e) {
            console.error(`保存浏览器实例信息失败: ${e.message}`);
          }
        }
      }

      if (!this.browser) {
        console.error(`playwright ${this.browserType} 启动失败`);
        this.lock = false;
        return false;
      }

      this.browser.on("disconnected", () => {
        console.warn(`${this.browserType}实例断开连接，将重启`);
        this.browser = null;
        this.restart(true);
      });

      // Start health check timer
      this.startHealthCheck();
    } catch (e) {
      console.error(`浏览器初始化失败: ${e.message}`);
      this.browser = null;
    } finally {
      this.lock = false;
    }

    return this.browser;
  }

  // Start periodic health check (optimization: ensures browser responsiveness)
  startHealthCheck() {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(async () => {
      if (!this.browser || this.shoting.length > 0) return;

      try {
        const context = await this.browser.newContext();
        const page = await context.newPage();
        await page.goto("about:blank", { timeout: 10000 });
        await page.close();
        await context.close();
      } catch (e) {
        console.warn(`浏览器健康检查失败: ${e.message}，将重启`);
        await this.restart(true);
      }
    }, this.healthCheckInterval);
  }

  /**
   * `playwright` 截图 (optimized: uses page.waitForLoadState for better waiting, smoother multi-page handling)
   * @param name
   * @param data 模板参数 (same as reference)
   * @return img 不做segment包裹
   */
  async screenshot(name, data = {}) {
    if (!await this.browserInit()) return false;

    const pageHeight = data.multiPageHeight || 4000;
    const savePath = this.dealTpl(name, data);
    if (!savePath) return false;

    const filePath = path.join(_path, savePath);
    if (!fs.existsSync(filePath)) {
      console.error(`HTML文件不存在: ${filePath}`);
      return false;
    }

    let ret = [];
    let context = null;
    let page = null;
    this.shoting.push(name);
    const start = Date.now();

    try {
      context = await this.browser.newContext(this.contextOptions);
      page = await context.newPage();

      if (!page) throw new Error("无法创建页面");

      const pageGotoParams = lodash.extend(
        { timeout: this.playwrightTimeout, waitUntil: "networkidle" },
        data.pageGotoParams || {}
      );

      const fileUrl = `file://${filePath}`;
      console.log(`[图片生成][${name}] 加载文件: ${fileUrl}`);
      await page.goto(fileUrl, pageGotoParams);

      // Optimized image loading wait
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => {
        return new Promise((resolve) => {
          const timeout = setTimeout(resolve, 1000);
          const images = Array.from(document.querySelectorAll("img"));
          if (images.length === 0) {
            clearTimeout(timeout);
            return resolve();
          }
          let loaded = 0;
          const onLoad = () => {
            loaded++;
            if (loaded === images.length) {
              clearTimeout(timeout);
              resolve();
            }
          };
          images.forEach((img) => {
            if (img.complete) onLoad();
            else {
              img.onload = onLoad;
              img.onerror = onLoad;
            }
          });
        });
      });

      const body = await page.locator("#container").first() || await page.locator("body");
      if (!body) throw new Error("找不到内容元素");

      const boundingBox = await body.boundingBox();

      const screenshotOptions = {
        type: data.imgType || "jpeg",
        fullPage: !data.multiPage,
        omitBackground: data.omitBackground || false,
        quality: data.quality || 90,
        path: data.path || "",
      };

      if (data.imgType === "png") delete screenshotOptions.quality;

      let num = 1;
      if (data.multiPage) {
        screenshotOptions.type = "jpeg";
        screenshotOptions.fullPage = false;  // For multi-page, we clip
        num = Math.ceil(boundingBox.height / pageHeight) || 1;
      }

      if (!data.multiPage) {
        const buff = await body.screenshot(screenshotOptions);
        this.renderNum++;
        const kb = (buff.length / 1024).toFixed(2) + "KB";
        console.log(`[图片生成][${name}][${this.renderNum}次] ${kb} ${Date.now() - start}ms`);
        ret.push(buff);
      } else {
        if (num > 1) {
          await page.setViewportSize({
            width: Math.ceil(boundingBox.width),
            height: pageHeight + 100,
          });
        }

        for (let i = 1; i <= num; i++) {
          if (i !== 1 && i === num) {
            const remainingHeight = parseInt(boundingBox.height) - pageHeight * (num - 1);
            await page.setViewportSize({
              width: Math.ceil(boundingBox.width),
              height: remainingHeight > 0 ? remainingHeight : 100,
            });
          }

          if (i !== 1) {
            await page.evaluate((scrollY) => {
              window.scrollTo(0, scrollY);
            }, pageHeight * (i - 1));
            await page.waitForTimeout(300);  // Playwright's waitForTimeout
          }

          // For multi-page, use clip to avoid fullPage issues
          const clip = (i === num && num > 1) ? {
            x: boundingBox.x,
            y: 0,
            width: boundingBox.width,
            height: boundingBox.height - pageHeight * (i - 1),
          } : null;

          const buff = await (clip ? page.screenshot({ ...screenshotOptions, clip }) : body.screenshot(screenshotOptions));
          this.renderNum++;
          const kb = (buff.length / 1024).toFixed(2) + "KB";
          console.log(`[图片生成][${name}][${i}/${num}] ${kb}`);
          ret.push(buff);

          if (i < num && num > 2) {
            await page.waitForTimeout(200);
          }
        }

        if (num > 1) {
          console.log(`[图片生成][${name}] 处理完成 ${Date.now() - start}ms`);
        }
      }
    } catch (error) {
      console.error(`[图片生成][${name}] 图片生成失败:`, error);
      ret = [];
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      this.shoting = this.shoting.filter((item) => item !== name);
    }

    if (this.renderNum % this.restartNum === 0 && this.renderNum > 0 && this.shoting.length === 0) {
      console.log(`playwright已完成${this.renderNum}次截图，准备重启`);
      this.restart();
    }

    if (ret.length === 0 || !ret[0]) {
      console.error(`[图片生成][${name}] 图片生成为空`);
      return false;
    }

    return data.multiPage ? ret : ret[0];
  }

  /** 
   * 重启浏览器 (optimized: closes contexts first for cleaner restart)
   * @param {boolean} force - 是否强制重启
   */
  async restart(force = false) {
    if (!this.browser || this.lock) return;

    if (!force && (this.renderNum % this.restartNum !== 0 || this.shoting.length > 0)) return;

    console.log(`playwright ${this.browserType} ${force ? "强制" : "计划"}重启...`);

    try {
      // Close all contexts first
      const contexts = this.browser.contexts();
      for (const ctx of contexts) {
        await ctx.close().catch((err) => console.error("关闭上下文失败:", err));
      }

      await this.browser.close().catch((err) => console.error("关闭浏览器实例失败:", err));
      this.browser = null;

      try {
        if (this.browserMacKey) {
          await redis.del(this.browserMacKey);
        }
      } catch (e) {
        console.error(`Redis删除浏览器实例失败:`, e);
      }

      this.renderNum = 0;

      if (this.healthCheckTimer) {
        clearInterval(this.healthCheckTimer);
        this.healthCheckTimer = null;
      }
    } catch (err) {
      console.error("重启浏览器出错:", err);
    }

    return true;
  }

  /**
   * 清理资源 (optimized: clears health timer and closes browser safely)
   */
  async cleanup() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    if (this.browser) {
      try {
        await this.browser.close().catch(() => {});
      } catch (e) {}
      this.browser = null;
    }

    console.log("Playwright资源已清理完成");
  }
}