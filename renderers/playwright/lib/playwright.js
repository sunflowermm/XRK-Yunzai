import Renderer from "../../../lib/renderer/Renderer.js";
import os from "node:os";
import lodash from "lodash";
import playwright from "playwright";
import cfg from "../../../lib/config/config.js";
import fs from "node:fs";
import path from "node:path";
import BotUtil from "../../../lib/util.js";

const _path = process.cwd();

/**
 * Playwright-based browser renderer for screenshot generation
 * Supports browser instance reuse, memory management, and health monitoring
 */
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
    this.isClosing = false;
    this.mac = "";
    this.browserMacKey = null;

    const rendererCfg = cfg.renderer?.playwright || {};
    
    this.restartNum = config.restartNum ?? rendererCfg.restartNum ?? 100;
    this.renderNum = 0;
    this.browserType = config.browser ?? rendererCfg.browserType ?? "chromium";
    this.playwrightTimeout = config.playwrightTimeout ?? rendererCfg.playwrightTimeout ?? 120000;
    this.healthCheckInterval = config.healthCheckInterval ?? rendererCfg.healthCheckInterval ?? 120000;
    this.maxRetries = config.maxRetries ?? rendererCfg.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? rendererCfg.retryDelay ?? 2000;
    this.memoryThreshold = config.memoryThreshold ?? rendererCfg.memoryThreshold ?? 1024;
    this.maxConcurrent = config.maxConcurrent ?? rendererCfg.maxConcurrent ?? 3;

    this.config = {
      headless: config.headless ?? rendererCfg.headless ?? true,
      args: config.args ?? rendererCfg.args ?? [
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-breakpad",
        "--disable-component-extensions-with-background-pages",
        "--disable-features=TranslateUI,BlinkGenPropertyTrees",
        "--disable-ipc-flooding-protection",
        "--disable-renderer-backgrounding",
        "--force-color-profile=srgb",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-first-run",
        "--enable-automation",
        "--password-store=basic",
        "--use-mock-keychain",
        "--disable-blink-features=AutomationControlled",
        "--js-flags=--max-old-space-size=512",
        "--disable-accelerated-2d-canvas",
        "--disable-accelerated-jpeg-decoding",
        "--disable-accelerated-mjpeg-decode",
        "--disable-accelerated-video-decode",
      ],
      channel: config.channel ?? rendererCfg.channel,
      executablePath: config.chromiumPath ?? rendererCfg.chromiumPath,
      wsEndpoint: config.playwrightWS ?? rendererCfg.wsEndpoint,
    };

    this.contextOptions = config.contextOptions ?? rendererCfg.contextOptions ?? {
      viewport: { 
        width: rendererCfg.viewport?.width ?? 1280, 
        height: rendererCfg.viewport?.height ?? 720 
      },
      deviceScaleFactor: rendererCfg.viewport?.deviceScaleFactor ?? 1,
      bypassCSP: rendererCfg.contextOptions?.bypassCSP ?? true,
      reducedMotion: rendererCfg.contextOptions?.reducedMotion ?? "reduce",
    };

    this.healthCheckTimer = null;

    process.on("exit", () => this.cleanup());
    process.on("SIGINT", () => this.cleanup());
    process.on("SIGTERM", () => this.cleanup());
  }

  /**
   * Retrieve system MAC address for browser instance identification
   */
  async getMac() {
    let macAddr = "000000000000";
    try {
      const network = os.networkInterfaces();
      for (const key in network) {
        for (const iface of network[key]) {
          if (iface.mac && iface.mac !== "00:00:00:00:00:00") {
            return iface.mac.replace(/:/g, "");
          }
        }
      }
    } catch (e) {
      BotUtil.makeLog("error", `Failed to get MAC address: ${e.message}`, "PlaywrightRenderer");
    }
    return macAddr;
  }

  /**
   * Attempt to connect to existing browser instance with retry logic
   */
  async connectToExisting(wsEndpoint, retries = 0) {
    const delay = this.retryDelay * Math.pow(2, retries);
    try {
      BotUtil.makeLog("info", `Connecting to existing ${this.browserType} instance (attempt ${retries + 1}/${this.maxRetries})`, "PlaywrightRenderer");
      
      const browser = await playwright[this.browserType].connect(wsEndpoint, { timeout: 10000 });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto("about:blank", { timeout: 5000 });
      await page.close();
      await context.close();

      BotUtil.makeLog("info", `Successfully connected to existing ${this.browserType} instance`, "PlaywrightRenderer");
      return browser;
    } catch (e) {
      BotUtil.makeLog("warn", `Connection failed: ${e.message}`, "PlaywrightRenderer");
      
      if (retries < this.maxRetries - 1) {
        await new Promise(r => setTimeout(r, delay));
        return this.connectToExisting(wsEndpoint, retries + 1);
      }
      
      if (this.browserMacKey) {
        try {
          await redis.del(this.browserMacKey);
          BotUtil.makeLog("info", "Cleaned up invalid browser instance record", "PlaywrightRenderer");
        } catch {
          // Redis 删除失败，忽略错误
        }
      }
      return null;
    }
  }

  /**
   * Initialize browser instance with connection reuse and health monitoring
   */
  async browserInit() {
    if (this.browser) {
      try {
        this.browser.contexts();
        return this.browser;
      } catch (e) {
        BotUtil.makeLog("warn", `Existing browser instance invalid: ${e.message}`, "PlaywrightRenderer");
        this.browser = null;
      }
    }

    if (this.lock) {
      let waitTime = 0;
      while (this.lock && waitTime < 30000) {
        await new Promise(r => setTimeout(r, 100));
        waitTime += 100;
      }
      if (this.browser) return this.browser;
      if (this.lock) return false;
    }

    this.lock = true;
    try {
      BotUtil.makeLog("info", `Starting playwright ${this.browserType}...`, "PlaywrightRenderer");

      if (!this.mac) {
        this.mac = await this.getMac();
        this.browserMacKey = `Yz:${this.browserType}:browserURL:${this.mac}`;
      }

      let wsEndpoint = null;
      if (this.browserMacKey) {
        try {
          wsEndpoint = await redis.get(this.browserMacKey);
        } catch {
          // Redis 获取失败，使用配置的 wsEndpoint
        }
      }
      if (!wsEndpoint && this.config.wsEndpoint) {
        wsEndpoint = this.config.wsEndpoint;
      }

      if (wsEndpoint) {
        this.browser = await this.connectToExisting(wsEndpoint);
      }

      if (!this.browser) {
        BotUtil.makeLog("info", `Launching new ${this.browserType} instance...`, "PlaywrightRenderer");
        this.browser = await playwright[this.browserType].launch(this.config);
        
        if (this.browser) {
          BotUtil.makeLog("info", `Playwright ${this.browserType} started successfully`, "PlaywrightRenderer");
          const endpoint = this.browser.wsEndpoint();
          
          if (endpoint && this.browserMacKey) {
            try {
              await redis.set(this.browserMacKey, endpoint, { EX: 60 * 60 * 24 * 30 });
              BotUtil.makeLog("debug", "Browser instance saved to Redis", "PlaywrightRenderer");
            } catch (e) {
              BotUtil.makeLog("warn", `Failed to save browser instance: ${e.message}`, "PlaywrightRenderer");
            }
          }
        }
      }

      if (!this.browser) {
        BotUtil.makeLog("error", `Playwright ${this.browserType} failed to start`, "PlaywrightRenderer");
        return false;
      }

      this.browser.on("disconnected", async () => {
        BotUtil.makeLog("warn", `${this.browserType} instance disconnected`, "PlaywrightRenderer");
        this.browser = null;
        
        if (this.browserMacKey) {
          try {
            await redis.del(this.browserMacKey);
          } catch {
            // Redis 删除失败，忽略错误
          }
        }
        
        if (!this.isClosing) {
          await this.restart(true);
        }
      });

      this.startHealthCheck();
    } catch (e) {
      BotUtil.makeLog("error", `Browser initialization failed: ${e.message}`, "PlaywrightRenderer");
      this.browser = null;
    } finally {
      this.lock = false;
    }

    return this.browser;
  }

  /**
   * Start periodic health check for browser instance
   */
  startHealthCheck() {
    if (this.healthCheckTimer) return;
    
    this.healthCheckTimer = setInterval(async () => {
      if (!this.browser || this.shoting.length > 0 || this.isClosing) return;
      
      try {
        this.browser.contexts();
      } catch (e) {
        BotUtil.makeLog("warn", `Health check failed: ${e.message}, restarting...`, "PlaywrightRenderer");
        await this.restart(true);
      }
    }, this.healthCheckInterval);
  }

  /**
   * 截图。data：url | tplFile+saveId；width/height；fullPage；delayBeforeScreenshot；waitUntil；
   * imgType/quality/omitBackground/path；imageWaitTimeout；multiPage/multiPageHeight；pageGotoParams；clip {x,y,width,height}。
   */
  async screenshot(name, data = {}) {
    while (this.shoting.length >= this.maxConcurrent) {
      await new Promise(r => setTimeout(r, 100));
    }

    if (!await this.browserInit()) return false;

    const useUrl = data.url && /^https?:\/\//i.test(String(data.url));
    const pageHeight = data.multiPageHeight ?? 4000;
    let savePath = null;
    if (!useUrl) {
      savePath = this.dealTpl(name, data);
      if (!savePath) return false;
    }

    const filePath = useUrl ? null : path.join(_path, savePath);
    if (!useUrl && !fs.existsSync(filePath)) {
      BotUtil.makeLog("error", `HTML file does not exist: ${filePath}`, "PlaywrightRenderer");
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
      if (!page) throw new Error("Failed to create page");

      await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        if (['font', 'media'].includes(resourceType)) {
          route.abort();
        } else {
          route.continue();
        }
      });

      const viewportWidth = data.width ?? 1280;
      const viewportHeight = data.height ?? 720;
      await page.setViewportSize({ width: viewportWidth, height: viewportHeight });

      const pageGotoParams = lodash.extend(
        { timeout: this.playwrightTimeout, waitUntil: data.waitUntil || "domcontentloaded" },
        data.pageGotoParams || {}
      );

      const loadUrl = useUrl ? data.url : `file://${filePath}`;
      BotUtil.makeLog("debug", `[${name}] Loading: ${useUrl ? data.url : loadUrl}`, "PlaywrightRenderer");
      await page.goto(loadUrl, pageGotoParams);

      const imageWait = data.imageWaitTimeout ?? 800;
      await page.evaluate((ms) => new Promise(resolve => {
        const timeout = setTimeout(resolve, ms);
        const images = Array.from(document.querySelectorAll("img"));
        if (images.length === 0) { clearTimeout(timeout); return resolve(); }
        let loaded = 0;
        const done = () => { loaded++; if (loaded === images.length) { clearTimeout(timeout); resolve(); } };
        images.forEach(img => img.complete ? done() : (img.onload = img.onerror = done));
      }), imageWait);

      const fullPage = data.fullPage === true || (useUrl && data.fullPage !== false);
      const screenshotOpts = {
        type: data.imgType ?? "jpeg",
        omitBackground: data.omitBackground ?? false,
        quality: data.quality ?? 85,
        path: data.path ?? "",
      };
      if (data.imgType === "png") delete screenshotOpts.quality;

      const delayMs = fullPage ? (data.delayBeforeScreenshot ?? (useUrl ? 1500 : 0)) : 0;
      if (delayMs > 0) await page.waitForTimeout(delayMs);

      if (fullPage) {
        const buff = await page.screenshot({ ...screenshotOpts, fullPage: true });
        this.renderNum++;
        BotUtil.makeLog("info", `[${name}][${this.renderNum}] fullPage ${(buff.length / 1024).toFixed(2)}KB ${Date.now() - start}ms`, "PlaywrightRenderer");
        ret.push(buff);
      } else if (data.clip && typeof data.clip === 'object' && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(data.clip[k]))) {
        const buff = await page.screenshot({ ...screenshotOpts, clip: data.clip });
        this.renderNum++;
        BotUtil.makeLog("info", `[${name}][${this.renderNum}] clip ${(buff.length / 1024).toFixed(2)}KB ${Date.now() - start}ms`, "PlaywrightRenderer");
        ret.push(buff);
      } else {
        const body = (await page.locator("#container").first()) || (await page.locator("body"));
        if (!body) throw new Error("Content element not found");
        const boundingBox = await body.boundingBox();
        let num = data.multiPage ? Math.ceil(boundingBox.height / pageHeight) || 1 : 1;
        if (data.multiPage) screenshotOpts.type = "jpeg";

        if (num === 1) {
          const buff = await body.screenshot(screenshotOpts);
          this.renderNum++;
          BotUtil.makeLog("info", `[${name}][${this.renderNum}] ${(buff.length / 1024).toFixed(2)}KB ${Date.now() - start}ms`, "PlaywrightRenderer");
          ret.push(buff);
        } else {
          if (num > 1) await page.setViewportSize({ width: Math.ceil(boundingBox.width), height: Math.min(pageHeight + 100, 2000) });
          for (let i = 1; i <= num; i++) {
            if (i !== 1 && i === num) {
              const h = Math.min(parseInt(boundingBox.height) - pageHeight * (num - 1), 2000);
              await page.setViewportSize({ width: Math.ceil(boundingBox.width), height: h > 0 ? h : 100 });
            }
            if (i !== 1) {
              await page.evaluate((y) => window.scrollTo(0, y), pageHeight * (i - 1));
              await page.waitForTimeout(100);
            }
            const clip = (i === num && num > 1) ? { x: boundingBox.x, y: 0, width: boundingBox.width, height: Math.min(boundingBox.height - pageHeight * (i - 1), pageHeight) } : null;
            const buff = clip ? await page.screenshot({ ...screenshotOpts, clip }) : await body.screenshot(screenshotOpts);
            ret.push(buff);
            this.renderNum++;
            if (i < num && num > 2) await page.waitForTimeout(100);
          }
          BotUtil.makeLog("info", `[${name}] multiPage ${num} ${Date.now() - start}ms`, "PlaywrightRenderer");
        }
      }
    } catch (error) {
      BotUtil.makeLog("error", `[${name}] Screenshot failed: ${error.message}`, "PlaywrightRenderer");
      ret = [];
    } finally {
      if (page) {
        try {
          await page.close({ runBeforeUnload: false });
        } catch {
          // 页面关闭失败，忽略错误
        }
      }
      if (context) {
        try {
          await context.close();
        } catch {
          // 上下文关闭失败，忽略错误
        }
      }
      this.shoting = this.shoting.filter(item => item !== name);
    }

    if (this.renderNum % this.restartNum === 0 && this.renderNum > 0 && this.shoting.length === 0) {
      BotUtil.makeLog("info", `Completed ${this.renderNum} screenshots, restarting browser...`, "PlaywrightRenderer");
      setTimeout(() => this.restart(), 2000);
    }

    if (ret.length === 0 || !ret[0]) {
      BotUtil.makeLog("error", `[${name}] Screenshot result is empty`, "PlaywrightRenderer");
      return false;
    }

    return data.multiPage ? ret : ret[0];
  }

  /**
   * Restart browser instance with cleanup
   */
  async restart(force = false) {
    if (!this.browser || this.lock || this.isClosing) return;
    if (!force && (this.renderNum % this.restartNum !== 0 || this.shoting.length > 0)) return;

    BotUtil.makeLog("warn", `${this.browserType} ${force ? "forced" : "scheduled"} restart...`, "PlaywrightRenderer");
    this.isClosing = true;

    try {
      const contexts = this.browser.contexts();
      for (const ctx of contexts) {
        await ctx.close().catch(() => {});
      }
      await this.browser.close();
      this.browser = null;

      if (this.browserMacKey) {
        await redis.del(this.browserMacKey).catch(() => {});
      }

      this.renderNum = 0;

      if (this.healthCheckTimer) {
        clearInterval(this.healthCheckTimer);
        this.healthCheckTimer = null;
      }

      global.gc();

      BotUtil.makeLog("info", `${this.browserType} restart completed`, "PlaywrightRenderer");
    } catch (err) {
      BotUtil.makeLog("error", `Restart failed: ${err.message}`, "PlaywrightRenderer");
    } finally {
      this.isClosing = false;
    }

    return true;
  }

  /**
   * Clean up all resources on process exit
   */
  async cleanup() {
    this.isClosing = true;

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    if (this.browser) {
      const contexts = this.browser.contexts();
      for (const ctx of contexts) {
        await ctx.close().catch(() => {});
      }
      await this.browser.close().catch(() => {});
      this.browser = null;
    }

    if (this.browserMacKey) {
      await redis.del(this.browserMacKey).catch(() => {});
    }

    if (!global._rendererCleanupLogged) {
      BotUtil.makeLog("info", "Renderer resources cleaned up", "Renderer");
      global._rendererCleanupLogged = true;
    }
  }
}