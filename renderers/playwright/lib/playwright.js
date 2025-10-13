import Renderer from "../../../lib/renderer/Renderer.js";
import os from "node:os";
import lodash from "lodash";
import playwright from "playwright";
import cfg from "../../../lib/config/config.js";
import fs from "node:fs";
import path from "node:path";
import BotUtil from "../../../lib/common/util.js";

const _path = process.cwd();

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
    this.restartNum = config.restartNum !== undefined ? config.restartNum : (rendererCfg.restartNum !== undefined ? rendererCfg.restartNum : 100);
    this.renderNum = 0;
    this.browserType = config.browser !== undefined ? config.browser : (rendererCfg.browserType !== undefined ? rendererCfg.browserType : "chromium");
    this.playwrightTimeout = config.playwrightTimeout !== undefined ? config.playwrightTimeout : (rendererCfg.playwrightTimeout !== undefined ? rendererCfg.playwrightTimeout : 120000);
    this.healthCheckInterval = config.healthCheckInterval !== undefined ? config.healthCheckInterval : (rendererCfg.healthCheckInterval !== undefined ? rendererCfg.healthCheckInterval : 120000); // 增加到120s
    this.maxRetries = config.maxRetries !== undefined ? config.maxRetries : (rendererCfg.maxRetries !== undefined ? rendererCfg.maxRetries : 3);
    this.retryDelay = config.retryDelay !== undefined ? config.retryDelay : (rendererCfg.retryDelay !== undefined ? rendererCfg.retryDelay : 2000);
    
    // 内存管理配置
    this.memoryThreshold = config.memoryThreshold !== undefined ? config.memoryThreshold : (rendererCfg.memoryThreshold !== undefined ? rendererCfg.memoryThreshold : 1024); // MB
    this.maxConcurrent = config.maxConcurrent !== undefined ? config.maxConcurrent : (rendererCfg.maxConcurrent !== undefined ? rendererCfg.maxConcurrent : 3);

    this.config = {
      headless: config.headless !== undefined ? config.headless : (rendererCfg.headless !== undefined ? rendererCfg.headless : true),
      args: config.args !== undefined ? config.args : (rendererCfg.args !== undefined ? rendererCfg.args : [
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
        // 移除 --single-process 避免内存累积
        // "--single-process",
        // "--disable-features=site-per-process",
        // 添加内存优化参数
        "--js-flags=--max-old-space-size=512",
        "--disable-accelerated-2d-canvas",
        "--disable-accelerated-jpeg-decoding",
        "--disable-accelerated-mjpeg-decode",
        "--disable-accelerated-video-decode",
      ]),
      channel: config.channel !== undefined ? config.channel : rendererCfg.channel,
      executablePath: config.chromiumPath !== undefined ? config.chromiumPath : rendererCfg.chromiumPath,
      wsEndpoint: config.playwrightWS !== undefined ? config.playwrightWS : rendererCfg.wsEndpoint,
    };

    this.contextOptions = config.contextOptions !== undefined ? config.contextOptions : (rendererCfg.contextOptions !== undefined ? rendererCfg.contextOptions : {
      viewport: { 
        width: rendererCfg.viewport?.width !== undefined ? rendererCfg.viewport.width : 1280, 
        height: rendererCfg.viewport?.height !== undefined ? rendererCfg.viewport.height : 720 
      },
      deviceScaleFactor: rendererCfg.viewport?.deviceScaleFactor !== undefined ? rendererCfg.viewport.deviceScaleFactor : 1,
      bypassCSP: rendererCfg.contextOptions?.bypassCSP !== undefined ? rendererCfg.contextOptions.bypassCSP : true,
      reducedMotion: rendererCfg.contextOptions?.reducedMotion !== undefined ? rendererCfg.contextOptions.reducedMotion : "reduce",
    });

    this.healthCheckTimer = null;
    this.memoryCheckTimer = null;

    process.on("exit", () => this.cleanup());
    process.on("SIGINT", () => this.cleanup());
    process.on("SIGTERM", () => this.cleanup());
  }

  async getMac() {
    let macAddr = "000000000000";
    try {
      const network = os.networkInterfaces();
      for (const key in network) {
        for (const iface of network[key]) {
          if (iface.mac && iface.mac !== "00:00:00:00:00:00") {
            macAddr = iface.mac.replace(/:/g, "");
            return macAddr;
          }
        }
      }
    } catch (e) {
      BotUtil.makeLog(`获取MAC地址失败: ${e.message}`, "error");
    }
    return macAddr;
  }

  async connectToExisting(wsEndpoint, retries = 0) {
    const delay = this.retryDelay * Math.pow(2, retries);
    try {
      BotUtil.makeLog(`尝试连接现有${this.browserType}实例 (重试${retries + 1}/${this.maxRetries})`, "info");
      const browser = await playwright[this.browserType].connect(wsEndpoint, { timeout: 10000 });

      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto("about:blank", { timeout: 5000 });
      await page.close();
      await context.close();

      BotUtil.makeLog(`成功连接到现有${this.browserType}实例`, "info");
      return browser;
    } catch (e) {
      BotUtil.makeLog(`连接失败: ${e.message}`, "warn");
      if (retries < this.maxRetries - 1) {
        await new Promise(r => setTimeout(r, delay));
        return this.connectToExisting(wsEndpoint, retries + 1);
      }
      if (this.browserMacKey) {
        try {
          await redis.del(this.browserMacKey);
          BotUtil.makeLog(`已清理失效的浏览器实例记录`, "info");
        } catch (e) {}
      }
      return null;
    }
  }

  async browserInit() {
    if (this.browser) {
      try {
        this.browser.contexts();
        return this.browser;
      } catch (e) {
        BotUtil.makeLog(`现有浏览器实例失效: ${e.message}`, "warn");
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
      BotUtil.makeLog(`playwright ${this.browserType} 启动中...`, "info");

      if (!this.mac) {
        this.mac = await this.getMac();
        this.browserMacKey = `Yz:${this.browserType}:browserURL:${this.mac}`;
      }

      let wsEndpoint = null;
      if (this.browserMacKey) {
        try {
          wsEndpoint = await redis.get(this.browserMacKey);
        } catch (e) {}
      }
      if (!wsEndpoint && this.config.wsEndpoint) {
        wsEndpoint = this.config.wsEndpoint;
      }

      if (wsEndpoint) {
        this.browser = await this.connectToExisting(wsEndpoint);
      }

      if (!this.browser) {
        BotUtil.makeLog(`启动新${this.browserType}实例...`, "info");
        this.browser = await playwright[this.browserType].launch(this.config);
        if (this.browser) {
          BotUtil.makeLog(`playwright ${this.browserType} 启动成功`, "info");
          const endpoint = this.browser.wsEndpoint();
          if (endpoint && this.browserMacKey) {
            try {
              await redis.set(this.browserMacKey, endpoint, { EX: 60 * 60 * 24 * 30 });
              BotUtil.makeLog(`浏览器实例已保存到Redis`, "debug");
            } catch (e) {
              BotUtil.makeLog(`保存浏览器实例失败: ${e.message}`, "warn");
            }
          }
        }
      }

      if (!this.browser) {
        BotUtil.makeLog(`playwright ${this.browserType} 启动失败`, "error");
        return false;
      }

      this.browser.on("disconnected", async () => {
        BotUtil.makeLog(`${this.browserType}实例断开连接`, "warn");
        this.browser = null;
        if (this.browserMacKey) {
          try {
            await redis.del(this.browserMacKey);
          } catch (e) {}
        }
        if (!this.isClosing) {
          await this.restart(true);
        }
      });

      this.startHealthCheck();
    } catch (e) {
      BotUtil.makeLog(`浏览器初始化失败: ${e.message}`, "error");
      this.browser = null;
    } finally {
      this.lock = false;
    }

    return this.browser;
  }

  startHealthCheck() {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(async () => {
      if (!this.browser || this.shoting.length > 0 || this.isClosing) return;
      try {
        this.browser.contexts();
      } catch (e) {
        BotUtil.makeLog(`健康检查失败: ${e.message}, 准备重启`, "warn");
        await this.restart(true);
      }
    }, this.healthCheckInterval);
  }

  async screenshot(name, data = {}) {
    // 并发控制
    while (this.shoting.length >= this.maxConcurrent) {
      await new Promise(r => setTimeout(r, 100));
    }

    if (!await this.browserInit()) return false;

    const pageHeight = data.multiPageHeight !== undefined ? data.multiPageHeight : 4000;
    const savePath = this.dealTpl(name, data);
    if (!savePath) return false;

    const filePath = path.join(_path, savePath);
    if (!fs.existsSync(filePath)) {
      BotUtil.makeLog(`HTML文件不存在: ${filePath}`, "error");
      return false;
    }

    let ret = [];
    let context = null;
    let page = null;
    this.shoting.push(name);
    const start = Date.now();

    try {
      // 创建独立上下文，资源隔离
      context = await this.browser.newContext(this.contextOptions);
      page = await context.newPage();
      if (!page) throw new Error("无法创建页面");

      // 禁用不必要的资源加载
      await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        if (['font', 'media'].includes(resourceType)) {
          route.abort();
        } else {
          route.continue();
        }
      });

      const pageGotoParams = lodash.extend(
        { timeout: this.playwrightTimeout, waitUntil: "domcontentloaded" }, // 改用domcontentloaded减少等待
        data.pageGotoParams || {}
      );

      const fileUrl = `file://${filePath}`;
      await page.goto(fileUrl, pageGotoParams);

      // 优化图片等待逻辑
      await page.evaluate(() => new Promise(resolve => {
        const timeout = setTimeout(resolve, 800); // 减少超时时间
        const images = Array.from(document.querySelectorAll("img"));
        if (images.length === 0) {
          clearTimeout(timeout);
          return resolve();
        }
        let loaded = 0;
        const checkComplete = () => {
          loaded++;
          if (loaded === images.length) {
            clearTimeout(timeout);
            resolve();
          }
        };
        images.forEach(img => {
          if (img.complete) checkComplete();
          else {
            img.onload = checkComplete;
            img.onerror = checkComplete;
          }
        });
      }));

      const body = (await page.locator("#container").first()) || (await page.locator("body"));
      if (!body) throw new Error("找不到内容元素");

      const boundingBox = await body.boundingBox();

      const screenshotOptions = {
        type: data.imgType !== undefined ? data.imgType : "jpeg",
        fullPage: !data.multiPage,
        omitBackground: data.omitBackground !== undefined ? data.omitBackground : false,
        quality: data.quality !== undefined ? data.quality : 85, // 降低质量减少内存
        path: data.path !== undefined ? data.path : "",
      };

      if (data.imgType === "png") delete screenshotOptions.quality;

      let num = 1;
      if (data.multiPage) {
        screenshotOptions.type = "jpeg";
        screenshotOptions.fullPage = false;
        num = Math.ceil(boundingBox.height / pageHeight) || 1;
      }

      if (!data.multiPage) {
        const buff = await body.screenshot(screenshotOptions);
        this.renderNum++;
        const kb = (buff.length / 1024).toFixed(2) + "KB";
        BotUtil.makeLog(`[${name}][${this.renderNum}次] ${kb} ${Date.now() - start}ms`, "info");
        ret.push(buff);
      } else {
        if (num > 1) {
          await page.setViewportSize({
            width: Math.ceil(boundingBox.width),
            height: Math.min(pageHeight + 100, 2000), // 限制最大视口
          });
        }

        for (let i = 1; i <= num; i++) {
          if (i !== 1 && i === num) {
            const remainingHeight = Math.min(parseInt(boundingBox.height) - pageHeight * (num - 1), 2000);
            await page.setViewportSize({
              width: Math.ceil(boundingBox.width),
              height: remainingHeight > 0 ? remainingHeight : 100,
            });
          }

          if (i !== 1) {
            await page.evaluate(scrollY => window.scrollTo(0, scrollY), pageHeight * (i - 1));
            await page.waitForTimeout(100); // 减少等待时间
          }

          const clip = (i === num && num > 1) ? {
            x: boundingBox.x,
            y: 0,
            width: boundingBox.width,
            height: Math.min(boundingBox.height - pageHeight * (i - 1), pageHeight),
          } : null;

          const buff = clip ? await page.screenshot({ ...screenshotOptions, clip }) : await body.screenshot(screenshotOptions);
          this.renderNum++;
          const kb = (buff.length / 1024).toFixed(2) + "KB";
          BotUtil.makeLog(`[${name}][${i}/${num}] ${kb}`, "debug");
          ret.push(buff);

          if (i < num && num > 2) {
            await page.waitForTimeout(100);
          }
        }

        if (num > 1) {
          BotUtil.makeLog(`[${name}] 处理完成 ${Date.now() - start}ms`, "info");
        }
      }
    } catch (error) {
      BotUtil.makeLog(`[${name}] 截图失败: ${error.message}`, "error");
      ret = [];
    } finally {
      // 确保资源清理
      if (page) {
        try {
          await page.close({ runBeforeUnload: false });
        } catch (e) {}
      }
      if (context) {
        try {
          await context.close();
        } catch (e) {}
      }
      this.shoting = this.shoting.filter(item => item !== name);
    }

    // 定期重启
    if (this.renderNum % this.restartNum === 0 && this.renderNum > 0 && this.shoting.length === 0) {
      BotUtil.makeLog(`已完成${this.renderNum}次截图, 准备重启浏览器`, "info");
      setTimeout(() => this.restart(), 2000);
    }

    if (ret.length === 0 || !ret[0]) {
      BotUtil.makeLog(`[${name}] 截图结果为空`, "error");
      return false;
    }

    return data.multiPage ? ret : ret[0];
  }

  async restart(force = false) {
    if (!this.browser || this.lock || this.isClosing) return;

    if (!force && (this.renderNum % this.restartNum !== 0 || this.shoting.length > 0)) return;

    BotUtil.makeLog(`${this.browserType} ${force ? "强制" : "计划"}重启...`, "warn");
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
      
      if (this.memoryCheckTimer) {
        clearInterval(this.memoryCheckTimer);
        this.memoryCheckTimer = null;
      }

      // 触发GC
      if (global.gc) {
        global.gc();
      }

      BotUtil.makeLog(`${this.browserType}重启完成`, "info");
    } catch (err) {
      BotUtil.makeLog(`重启失败: ${err.message}`, "error");
    } finally {
      this.isClosing = false;
    }

    return true;
  }

  async cleanup() {
    this.isClosing = true;

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    
    if (this.memoryCheckTimer) {
      clearInterval(this.memoryCheckTimer);
      this.memoryCheckTimer = null;
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

    BotUtil.makeLog("Playwright资源已清理", "info");
  }
}