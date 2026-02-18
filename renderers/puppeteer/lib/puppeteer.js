import Renderer from "../../../lib/renderer/Renderer.js";
import os from "node:os";
import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";
import cfg from "../../../lib/config/config.js";
import BotUtil from "../../../lib/util.js";
import { cropTopAndBottom } from "../../../lib/renderer/crop.js";
import { toBuffer, toFileUrl } from "../../../lib/renderer/screenshot-utils.js";

export default class PuppeteerRenderer extends Renderer {
  constructor(config = {}) {
    super({
      id: "puppeteer",
      type: "image",
      render: "screenshot",
    });

    this.browser = null;
    this.lock = false;
    this.shoting = [];
    this.shotingUser = [];
    this.mac = "";
    this.browserMacKey = null;

    const rendererCfg = cfg.renderer?.puppeteer || {};
    
    this.restartNum = config.restartNum ?? rendererCfg.restartNum ?? 100;
    this.renderNum = 0;
    this.puppeteerTimeout = config.puppeteerTimeout ?? rendererCfg.puppeteerTimeout ?? 120000;
    this.memoryThreshold = config.memoryThreshold ?? rendererCfg.memoryThreshold ?? 1024;
    this.maxConcurrent = config.maxConcurrent ?? rendererCfg.maxConcurrent ?? 3;
    this._fileCache = new Map();

    this.config = {
      headless: config.headless ?? rendererCfg.headless ?? "new",
      args: config.args ?? rendererCfg.args ?? [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
      executablePath: config.chromiumPath ?? rendererCfg.chromiumPath,
      wsEndpoint: config.puppeteerWS ?? rendererCfg.wsEndpoint,
      ignoreHTTPSErrors: config.ignoreHTTPSErrors ?? rendererCfg.ignoreHTTPSErrors ?? false,
    };

    this.healthCheckTimer = null;

    process.on("exit", () => this.cleanup());
    // 不在此处注册 SIGINT/SIGTERM，由 lib/config/loader.js 统一处理；进程退出时 exit 事件会触发 cleanup
  }

  /** 将 cfg 默认值与调用参数合并，保持 data 优先级最高 */
  normalizeScreenshotData(data = {}) {
    const rendererCfg = cfg.renderer?.puppeteer || {};
    const viewport = rendererCfg.viewport || {};
    return {
      width: viewport.width ?? 1280,
      height: viewport.height ?? 720,
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,

      // 页面加载/等待策略
      waitUntil: rendererCfg.waitUntil ?? "domcontentloaded",
      imageWaitTimeout: rendererCfg.imageWaitTimeout ?? 800,
      fontWaitTimeout: rendererCfg.fontWaitTimeout ?? 800,
      waitImages: rendererCfg.waitImages ?? true,
      waitFonts: rendererCfg.waitFonts ?? true,

      // 输出
      imgType: rendererCfg.imgType ?? "jpeg",
      quality: rendererCfg.quality ?? 85,
      omitBackground: rendererCfg.omitBackground ?? false,

      // 资源拦截（默认仅拦截 media，不拦截 font）
      blockResourceTypes: rendererCfg.blockResourceTypes ?? ["media"],
      // 资源重写（用于把在线字体/图标映射到本地文件，避免服务器无外网）
      resourceRewrite: rendererCfg.resourceRewrite ?? [],

      // 其它
      delayBeforeScreenshot: rendererCfg.delayBeforeScreenshot,
      delayBeforeScreenshotUrl: rendererCfg.delayBeforeScreenshotUrl,
      delayBeforeScreenshotFile: rendererCfg.delayBeforeScreenshotFile,
      pageGotoParams: rendererCfg.pageGotoParams,

      ...data,
    };
  }

  guessContentType(filePath) {
    const ext = String(path.extname(filePath) || "").toLowerCase();
    if (ext === ".woff2") return "font/woff2";
    if (ext === ".woff") return "font/woff";
    if (ext === ".ttf") return "font/ttf";
    if (ext === ".otf") return "font/otf";
    if (ext === ".svg") return "image/svg+xml";
    if (ext === ".png") return "image/png";
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".webp") return "image/webp";
    if (ext === ".css") return "text/css";
    if (ext === ".js") return "application/javascript";
    if (ext === ".json") return "application/json";
    return "application/octet-stream";
  }

  getResourceRewriteRules(d) {
    const rendererCfg = cfg.renderer?.puppeteer || {};
    const list = []
      .concat(Array.isArray(rendererCfg.resourceRewrite) ? rendererCfg.resourceRewrite : [])
      .concat(Array.isArray(d.resourceRewrite) ? d.resourceRewrite : []);
    return list
      .filter(r => r && typeof r === "object")
      .map(r => ({
        match: r.match,
        type: r.type || "substring",
        toUrl: r.toUrl || r.to_url,
        toFile: r.toFile || r.to_file,
        contentType: r.contentType || r.content_type,
      }))
      .filter(r => typeof r.match === "string" && r.match && (typeof r.toUrl === "string" || typeof r.toFile === "string"));
  }

  matchRewrite(rule, url) {
    if (!rule || !url) return false;
    if (rule.type === "regex") {
      try {
        return new RegExp(rule.match).test(url);
      } catch {
        return false;
      }
    }
    return String(url).includes(rule.match);
  }

  readCacheFile(filePath) {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    if (this._fileCache.has(abs)) return this._fileCache.get(abs);
    try {
      const buf = fs.readFileSync(abs);
      this._fileCache.set(abs, buf);
      return buf;
    } catch {
      return null;
    }
  }

  /** 计算要拦截的资源类型 */
  getBlockResourceTypes(d) {
    const rendererCfg = cfg.renderer?.puppeteer || {};
    const types = Array.isArray(d.blockResourceTypes)
      ? d.blockResourceTypes
      : (Array.isArray(rendererCfg.blockResourceTypes) ? rendererCfg.blockResourceTypes : ["media"]);
    return Array.from(new Set(types.filter(t => typeof t === "string" && t)));
  }

  async getMac() {
    try {
      for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces) {
          if (iface.mac && iface.mac !== "00:00:00:00:00:00") return iface.mac.replace(/:/g, "");
        }
      }
    } catch (e) {
      BotUtil.makeLog("error", `getMac: ${e.message}`, "PuppeteerRenderer");
    }
    return "000000000000";
  }

  async browserInit() {
    if (this.browser) return this.browser;
    if (this.lock) {
      const deadline = Date.now() + (this.config.browserInitWaitMax ?? 60000);
      while (this.lock && !this.browser && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
      if (this.browser) return this.browser;
      if (this.lock) {
        BotUtil.makeLog("warn", "Browser init wait timeout, screenshot skipped", "PuppeteerRenderer");
        return false;
      }
    }

    this.lock = true;
    try {
      BotUtil.makeLog("info", "Starting puppeteer Chromium...", "PuppeteerRenderer");

      if (!this.mac) {
        this.mac = await this.getMac();
        this.browserMacKey = `Yz:chromium:browserWSEndpoint:${this.mac}`;
      }

      let browserWSEndpoint = null;
      if (this.browserMacKey) {
        try {
          browserWSEndpoint = await redis.get(this.browserMacKey);
        } catch {}
      }
      if (!browserWSEndpoint && this.config.wsEndpoint) {
        browserWSEndpoint = this.config.wsEndpoint;
      }

      if (browserWSEndpoint) {
        try {
          BotUtil.makeLog("info", `Connecting to existing Chromium instance: ${browserWSEndpoint}`, "PuppeteerRenderer");
          this.browser = await puppeteer.connect({
            browserWSEndpoint,
            defaultViewport: null,
          });

          const pages = await this.browser.pages().catch(() => null);
          if (!pages || !Array.isArray(pages)) {
            await this.browser.close().catch(() => {});
            this.browser = null;
            if (this.browserMacKey) await redis.del(this.browserMacKey).catch(() => {});
          }
        } catch (e) {
          BotUtil.makeLog("warn", `Failed to connect to existing Chromium: ${e.message}`, "PuppeteerRenderer");
          if (this.browserMacKey) {
            await redis.del(this.browserMacKey).catch(() => {});
          }
        }
      }

      if (!this.browser) {
        this.browser = await puppeteer.launch(this.config).catch(err => {
          BotUtil.makeLog("error", `Failed to start Chromium: ${err.message}`, "PuppeteerRenderer");
          
          if (err.message.includes("Could not find Chromium")) {
            BotUtil.makeLog("error", "Chromium not installed. Try: node node_modules/puppeteer/install.js", "PuppeteerRenderer");
          } else if (err.message.includes("cannot open shared object file")) {
            BotUtil.makeLog("error", "Chromium runtime libraries not installed", "PuppeteerRenderer");
          }
          return null;
        });

        if (this.browser) {
          BotUtil.makeLog("info", `Puppeteer Chromium started successfully: ${this.browser.wsEndpoint()}`, "PuppeteerRenderer");
          
          if (this.browserMacKey) {
            try {
              await redis.set(this.browserMacKey, this.browser.wsEndpoint(), { EX: 60 * 60 * 24 * 30 });
            } catch (e) {
              BotUtil.makeLog("error", `Failed to save browser instance: ${e.message}`, "PuppeteerRenderer");
            }
          }
        }
      }

      if (!this.browser) {
        BotUtil.makeLog("error", "Puppeteer Chromium failed to start", "PuppeteerRenderer");
        return false;
      }

      this.browser.on("disconnected", () => {
        BotUtil.makeLog("warn", "Chromium instance disconnected, restarting...", "PuppeteerRenderer");
        this.browser = null;
        this.restart(true);
      });

      this.startHealthCheck();
    } catch (e) {
      BotUtil.makeLog("error", `Browser initialization failed: ${e.message}`, "PuppeteerRenderer");
      this.browser = null;
    } finally {
      this.lock = false;
    }

    return this.browser;
  }

  startHealthCheck() {
    if (this.healthCheckTimer) return;
    
    this.healthCheckTimer = setInterval(async () => {
      if (!this.browser || this.shoting.length > 0 || this.shotingUser.length > 0) return;
      
      try {
        await this.browser.pages();
      } catch (e) {
        BotUtil.makeLog("warn", `Health check failed: ${e.message}, restarting...`, "PuppeteerRenderer");
        await this.restart(true);
      }
    }, 120000);
  }

  async screenshot(name, data = {}) {
    const d = this.normalizeScreenshotData(data);
    const isUserTriggered = data.priority === true || data.userTriggered === true;
    if (isUserTriggered) {
      while (this.shotingUser.length >= 1) {
        await new Promise(r => setTimeout(r, 100));
      }
      this.shotingUser.push(name);
    } else {
      while (this.shoting.length + this.shotingUser.length >= this.maxConcurrent) {
        await new Promise(r => setTimeout(r, 100));
      }
      this.shoting.push(name);
    }

    if (!await this.browserInit()) {
      if (isUserTriggered) this.shotingUser = this.shotingUser.filter(i => i !== name);
      else this.shoting = this.shoting.filter(i => i !== name);
      return false;
    }

    const useUrl = d.url && /^https?:\/\//i.test(String(d.url));
    const pageHeight = d.multiPageHeight ?? 4000;
    let savePath = null;
    let directFilePath = null;
    if (!useUrl) {
      const tpl = d.tplFile;
      if (typeof tpl === "string" && path.isAbsolute(tpl) && fs.existsSync(tpl)) {
        directFilePath = path.resolve(tpl);
      } else {
        savePath = this.dealTpl(name, d);
        if (!savePath) return false;
      }
    }
    const filePath = useUrl ? null : (directFilePath || path.join(process.cwd(), String(savePath).replace(/^\.\/?/, "")));
    if (!useUrl && (typeof filePath !== "string" || !fs.existsSync(filePath))) {
      BotUtil.makeLog("error", `HTML file does not exist: ${filePath}`, "PuppeteerRenderer");
      return false;
    }

    let ret = [];
    let page = null;
    const start = Date.now();

    try {
      page = await this.browser.newPage();

      const blockTypes = this.getBlockResourceTypes(d);
      const rewriteRules = this.getResourceRewriteRules(d);
      if (blockTypes.length > 0 || rewriteRules.length > 0) {
        await page.setRequestInterception(true);
        page.on("request", async (request) => {
          const reqUrl = request.url();
          // 先处理 URL 重写（优先级高于 block），用于离线/内网部署的字体、图标等
          for (const rule of rewriteRules) {
            if (!this.matchRewrite(rule, reqUrl)) continue;
            try {
              if (rule.toUrl) {
                return await request.continue({ url: rule.toUrl });
              }
              if (rule.toFile) {
                const buf = this.readCacheFile(rule.toFile);
                if (buf) {
                  return await request.respond({
                    status: 200,
                    contentType: rule.contentType || this.guessContentType(rule.toFile),
                    body: buf,
                  });
                }
              }
            } catch (e) {
              BotUtil.makeLog("debug", `[${name}] rewrite failed: ${e?.message || e}`, "PuppeteerRenderer");
            }
          }
          const resourceType = request.resourceType();
          if (blockTypes.includes(resourceType)) request.abort();
          else request.continue();
        });
      }

      const viewportWidth = d.width;
      const viewportHeight = d.height;
      const deviceScaleFactor = d.deviceScaleFactor;
      await page.setViewport({
        width: viewportWidth,
        height: viewportHeight,
        deviceScaleFactor,
      });

      const pageGotoParams = Object.assign(
        { timeout: this.puppeteerTimeout, waitUntil: d.waitUntil || "domcontentloaded" },
        d.pageGotoParams || {}
      );

      const loadUrl = useUrl ? d.url : toFileUrl(filePath);
      await page.goto(loadUrl, pageGotoParams);

      if (d.waitImages !== false) {
        const imageWait = Number.isFinite(d.imageWaitTimeout) ? d.imageWaitTimeout : 800;
        if (imageWait > 0) {
          await page.evaluate((ms) => new Promise(resolve => {
            const timeout = setTimeout(resolve, ms);
            const images = Array.from(document.querySelectorAll("img"));
            if (images.length === 0) { clearTimeout(timeout); return resolve(); }
            let loaded = 0;
            const done = () => { loaded++; if (loaded === images.length) { clearTimeout(timeout); resolve(); } };
            images.forEach(img => img.complete ? done() : (img.onload = img.onerror = done));
          }), imageWait);
        }
      }

      if (d.waitFonts !== false) {
        const fontWait = Number.isFinite(d.fontWaitTimeout) ? d.fontWaitTimeout : 800;
        if (fontWait > 0) {
          await page.evaluate((ms) => new Promise((resolve) => {
            // 部分环境 document.fonts 不可用，直接跳过
            if (!document.fonts || !document.fonts.ready) return resolve();
            const timeout = setTimeout(resolve, ms);
            document.fonts.ready
              .then(() => { clearTimeout(timeout); resolve(); })
              .catch(() => { clearTimeout(timeout); resolve(); });
          }), fontWait);
        }
      }

      const fullPage = d.fullPage === true || (useUrl && d.fullPage !== false);
      const imgType = String(d.imgType ?? "jpeg").toLowerCase();
      const screenshotOpts = {
        type: imgType === "png" ? "png" : "jpeg",
        omitBackground: d.omitBackground ?? false,
        quality: d.quality ?? 85,
      };
      if (screenshotOpts.type === "png") delete screenshotOpts.quality;
      if (d.path) screenshotOpts.path = d.path;

      const defaultDelay = useUrl ? (d.delayBeforeScreenshotUrl ?? 1500) : (d.delayBeforeScreenshotFile ?? 0);
      const delayMs = fullPage ? (d.delayBeforeScreenshot ?? defaultDelay) : 0;
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));

      if (fullPage) {
        let buf = toBuffer(await page.screenshot({ ...screenshotOpts, fullPage: true }));
        const cropTop = d.cropTopPercent;
        const cropBottom = d.cropBottomPercent;
        if (buf && ((typeof cropTop === "number" && cropTop > 0 && cropTop < 1) || (typeof cropBottom === "number" && cropBottom > 0 && cropBottom < 1))) {
          const cropped = await cropTopAndBottom(buf, cropTop || 0, cropBottom || 0);
          if (cropped) buf = cropped;
        }
        if (buf) ret.push(buf);
        this.renderNum++;
        if (ret[0]) BotUtil.makeLog("info", `[${name}][${this.renderNum}] fullPage ${(ret[0].length / 1024).toFixed(2)}KB ${Date.now() - start}ms`, "PuppeteerRenderer");
      } else if (d.clip && typeof d.clip === "object" && ["x", "y", "width", "height"].every(k => Number.isFinite(d.clip[k]))) {
        const buf = toBuffer(await page.screenshot({ ...screenshotOpts, clip: d.clip }));
        if (buf) ret.push(buf);
        this.renderNum++;
        if (ret.length) BotUtil.makeLog("info", `[${name}][${this.renderNum}] clip ${Date.now() - start}ms`, "PuppeteerRenderer");
      } else {
        const body = (await page.$("#container")) || (await page.$("body"));
        if (!body) throw new Error("No body element found");
        const boundingBox = await body.boundingBox();
        if (!boundingBox) {
          const buf = toBuffer(await page.screenshot({ ...screenshotOpts, fullPage: false }));
          if (buf) ret.push(buf);
          this.renderNum++;
        } else {
          let num = d.multiPage ? Math.ceil(boundingBox.height / pageHeight) || 1 : 1;
          if (d.multiPage) screenshotOpts.type = "jpeg";
        if (num === 1) {
          const buf = toBuffer(await body.screenshot(screenshotOpts));
          if (buf) ret.push(buf);
          this.renderNum++;
          if (ret[0]) BotUtil.makeLog("info", `[${name}][${this.renderNum}] ${(ret[0].length / 1024).toFixed(2)}KB ${Date.now() - start}ms`, "PuppeteerRenderer");
        } else {
          await page.setViewport({ width: Math.ceil(boundingBox.width), height: Math.min(pageHeight + 100, 2000) });
          for (let i = 1; i <= num; i++) {
            if (i === num && num > 1) await page.setViewport({ width: Math.ceil(boundingBox.width), height: Math.min(parseInt(boundingBox.height) - pageHeight * (num - 1), 2000) || 100 });
            if (i !== 1) {
              await page.evaluate((y) => window.scrollTo(0, y), pageHeight * (i - 1));
              await new Promise(r => setTimeout(r, 100));
            }
            const buf = toBuffer(i === 1 ? await body.screenshot(screenshotOpts) : await page.screenshot(screenshotOpts));
            if (buf) ret.push(buf);
            this.renderNum++;
            if (i < num && num > 2) await new Promise(r => setTimeout(r, 100));
          }
          BotUtil.makeLog("info", `[${name}] multiPage ${num} ${Date.now() - start}ms`, "PuppeteerRenderer");
        }
        }
      }
    } catch (error) {
      BotUtil.makeLog("error", `[${name}] Screenshot failed: ${error.message}`, "PuppeteerRenderer");
      ret = [];
    } finally {
      if (page) {
        page.removeAllListeners("request");
        await page.close().catch(() => {});
      }
      if (isUserTriggered) this.shotingUser = this.shotingUser.filter(i => i !== name);
      else this.shoting = this.shoting.filter(i => i !== name);
    }

    if (this.renderNum % this.restartNum === 0 && this.renderNum > 0 && this.shoting.length === 0 && this.shotingUser.length === 0) {
      BotUtil.makeLog("info", `Completed ${this.renderNum} screenshots, restarting browser...`, "PuppeteerRenderer");
      setTimeout(() => this.restart(), 2000);
    }

    if (ret.length === 0 || !ret[0]) {
      BotUtil.makeLog("error", `[${name}] Screenshot result is empty`, "PuppeteerRenderer");
      return false;
    }

    return data.multiPage ? ret : ret[0];
  }

  async restart(force = false) {
    if (!this.browser || this.lock) return;
    if (!force && (this.renderNum % this.restartNum !== 0 || this.shoting.length > 0 || this.shotingUser.length > 0)) return;

    BotUtil.makeLog("warn", `Puppeteer Chromium ${force ? "forced" : "scheduled"} restart...`, "PuppeteerRenderer");

    try {
      const currentEndpoint = this.browser.wsEndpoint();
      try {
        for (const page of await this.browser.pages()) await page.close().catch(() => {});
      } catch (_) {}
      await this.browser.close().catch(err => 
        BotUtil.makeLog("error", `Failed to close browser: ${err.message}`, "PuppeteerRenderer")
      );
      this.browser = null;

      if (this.browserMacKey) {
        const storedEndpoint = await redis.get(this.browserMacKey).catch(() => null);
        if (storedEndpoint === currentEndpoint) {
          await redis.del(this.browserMacKey).catch(() => {});
        }
      }

      this.renderNum = 0;

      if (this.healthCheckTimer) {
        clearInterval(this.healthCheckTimer);
        this.healthCheckTimer = null;
      }

      global.gc();
      
      BotUtil.makeLog("info", "Browser restart completed", "PuppeteerRenderer");
    } catch (err) {
      BotUtil.makeLog("error", `Restart failed: ${err.message}`, "PuppeteerRenderer");
    }

    return true;
  }

  async cleanup() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    if (this.browser) {
      try {
        for (const page of await this.browser.pages()) await page.close().catch(() => {});
      } catch (_) {}
      await this.browser.close().catch(() => {});
      this.browser = null;
    }

    if (this.browserMacKey) {
      await redis.del(this.browserMacKey).catch(() => {});
    }
    BotUtil.makeLog("info", "Renderer resources cleaned up", "Renderer");
  }
}