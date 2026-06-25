import Renderer from "../../../lib/renderer/Renderer.js";
import os from "node:os";
import puppeteer from "puppeteer";
import path from "node:path";
import cfg from "../../../lib/config/config.js";
import BotUtil from "../../../lib/util.js";
import { FileUtils } from "../../../lib/utils/file-utils.js";
import { cropTopAndBottom } from "../../../lib/renderer/crop.js";
import { toBuffer, toFileUrl, isScreenshotClip, toStringList } from "../../../lib/renderer/screenshot-utils.js";
import { resolveProjectPath } from "../../../lib/config/config-constants.js";

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
    this.healthCheckInterval = config.healthCheckInterval ?? rendererCfg.healthCheckInterval ?? 120000;
    this.idleRestartMs = config.idleRestartMs ?? rendererCfg.idleRestartMs ?? 14400000;
    this.maxRetries = config.maxRetries ?? rendererCfg.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? rendererCfg.retryDelay ?? 2000;
    this.lastActivityAt = Date.now();
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

  normalizeScreenshotData(data = {}) {
    const rendererCfg = cfg.renderer?.puppeteer || {};
    const viewport = rendererCfg.viewport || {};
    return {
      width: viewport.width ?? 1280,
      height: viewport.height ?? 720,
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
      waitUntil: rendererCfg.waitUntil ?? "domcontentloaded",
      imageWaitTimeout: rendererCfg.imageWaitTimeout ?? 800,
      fontWaitTimeout: rendererCfg.fontWaitTimeout ?? 800,
      waitImages: rendererCfg.waitImages ?? true,
      waitFonts: rendererCfg.waitFonts ?? true,
      imgType: rendererCfg.imgType ?? "jpeg",
      quality: rendererCfg.quality ?? 85,
      omitBackground: rendererCfg.omitBackground ?? false,
      blockResourceTypes: rendererCfg.blockResourceTypes ?? ["media"],
      resourceRewrite: rendererCfg.resourceRewrite ?? [],
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
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(resolveProjectPath(), filePath);
    if (this._fileCache.has(abs)) return this._fileCache.get(abs);
    const buf = FileUtils.readFileSync(abs, null);
    if (buf) this._fileCache.set(abs, buf);
    return buf;
  }

  getBlockResourceTypes(d) {
    const rendererCfg = cfg.renderer?.puppeteer || {};
    const types = Array.isArray(d.blockResourceTypes)
      ? d.blockResourceTypes
      : (Array.isArray(rendererCfg.blockResourceTypes) ? rendererCfg.blockResourceTypes : ["media"]);
    return Array.from(new Set(types.filter(t => typeof t === "string" && t)));
  }

  async setupRequestRoute(page, d, name) {
    const blockTypes = this.getBlockResourceTypes(d);
    const rewriteRules = this.getResourceRewriteRules(d);
    if (blockTypes.length === 0 && rewriteRules.length === 0) return;
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      const reqUrl = request.url();
      for (const rule of rewriteRules) {
        if (!this.matchRewrite(rule, reqUrl)) continue;
        try {
          if (rule.toUrl) return await request.continue({ url: rule.toUrl });
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
      if (blockTypes.includes(request.resourceType())) request.abort();
      else request.continue();
    });
  }

  selectorTimeout(d) {
    return Number.isFinite(d.selectorTimeout) ? d.selectorTimeout : 15000;
  }

  async waitForExprs(page, exprs, timeout) {
    for (const fn of toStringList(exprs)) {
      await page.waitForFunction(fn, { timeout }).catch(() => {});
    }
  }

  async waitForSels(page, sels, timeout) {
    for (const sel of toStringList(sels)) {
      await page.waitForSelector(sel, { timeout }).catch(() => {});
    }
  }

  async waitImagesLoaded(page, ms) {
    if (!(ms > 0)) return;
    await page.evaluate((waitMs) => new Promise(resolve => {
      const timeout = setTimeout(resolve, waitMs);
      const images = Array.from(document.querySelectorAll("img"));
      if (images.length === 0) { clearTimeout(timeout); return resolve(); }
      let loaded = 0;
      const done = () => { loaded++; if (loaded === images.length) { clearTimeout(timeout); resolve(); } };
      images.forEach(img => img.complete ? done() : (img.onload = img.onerror = done));
    }), ms);
  }

  async waitFontsReady(page, ms) {
    if (!(ms > 0)) return;
    await page.evaluate((waitMs) => new Promise((resolve) => {
      if (!document.fonts?.ready) return resolve();
      const timeout = setTimeout(resolve, waitMs);
      document.fonts.ready
        .then(() => { clearTimeout(timeout); resolve(); })
        .catch(() => { clearTimeout(timeout); resolve(); });
    }), ms);
  }

  buildScreenshotOpts(d) {
    const imgType = String(d.imgType ?? "jpeg").toLowerCase();
    const opts = {
      type: imgType === "png" ? "png" : "jpeg",
      omitBackground: d.omitBackground ?? false,
      quality: d.quality ?? 85,
      timeout: Number.isFinite(d.screenshotTimeout) ? d.screenshotTimeout : this.puppeteerTimeout,
    };
    if (opts.type === "png") delete opts.quality;
    if (d.path) opts.path = d.path;
    return opts;
  }

  async evalBeforeScreenshot(page, script, name) {
    if (typeof script !== "string" || !script.trim()) return null;
    try {
      const result = await page.evaluate(script);
      return isScreenshotClip(result) ? result : null;
    } catch (e) {
      BotUtil.makeLog("debug", `[${name}] pageEvaluateBeforeScreenshot: ${e?.message || e}`, "PuppeteerRenderer");
      return null;
    }
  }

  async captureScreenshot(page, d, name, start, useUrl, pageHeight) {
    const screenshotOpts = this.buildScreenshotOpts(d);
    const fullPage = d.fullPage === true || (useUrl && d.fullPage !== false);
    const hasSelector = typeof d.selector === "string" && d.selector.trim();
    const staticClip = isScreenshotClip(d.clip) ? d.clip : null;
    const hasPreShot = staticClip || hasSelector || (typeof d.pageEvaluateBeforeScreenshot === "string" && d.pageEvaluateBeforeScreenshot.trim());
    const defaultDelay = useUrl ? (d.delayBeforeScreenshotUrl ?? 1500) : (d.delayBeforeScreenshotFile ?? 0);
    const delayMs = (fullPage || hasPreShot) ? (d.delayBeforeScreenshot ?? defaultDelay) : 0;
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));

    const clip = (await this.evalBeforeScreenshot(page, d.pageEvaluateBeforeScreenshot, name)) || staticClip;
    const timeout = this.selectorTimeout(d);
    const scrollTop = async () => {
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await new Promise(r => setTimeout(r, 150));
    };

    if (isScreenshotClip(clip)) {
      await scrollTop();
      const buf = toBuffer(await page.screenshot({ ...screenshotOpts, clip }));
      if (buf) {
        BotUtil.makeLog("info", `[${name}][${this.renderNum + 1}] clip ${clip.width}x${clip.height} ${Date.now() - start}ms`, "PuppeteerRenderer");
        return [buf];
      }
      return [];
    }
    if (hasSelector) {
      await page.waitForSelector(d.selector, { timeout }).catch(() => {});
      const el = await page.$(d.selector);
      if (el) {
        const buf = toBuffer(await el.screenshot(screenshotOpts));
        if (buf) {
          BotUtil.makeLog("info", `[${name}][${this.renderNum + 1}] selector ${Date.now() - start}ms`, "PuppeteerRenderer");
          return [buf];
        }
      }
      return [];
    }
    if (fullPage) {
      let buf = toBuffer(await page.screenshot({ ...screenshotOpts, fullPage: true }));
      const cropTop = d.cropTopPercent;
      const cropBottom = d.cropBottomPercent;
      if (buf && ((typeof cropTop === "number" && cropTop > 0 && cropTop < 1) || (typeof cropBottom === "number" && cropBottom > 0 && cropBottom < 1))) {
        const cropped = await cropTopAndBottom(buf, cropTop || 0, cropBottom || 0);
        if (cropped) buf = cropped;
      }
      if (buf) {
        BotUtil.makeLog("info", `[${name}][${this.renderNum + 1}] fullPage ${(buf.length / 1024).toFixed(2)}KB ${Date.now() - start}ms`, "PuppeteerRenderer");
        return [buf];
      }
      return [];
    }

    const body = (await page.$("#container")) || (await page.$("body"));
    if (!body) throw new Error("No body element found");
    const boundingBox = await body.boundingBox();
    if (!boundingBox) {
      const buf = toBuffer(await page.screenshot({ ...screenshotOpts, fullPage: false }));
      return buf ? [buf] : [];
    }

    const num = d.multiPage ? Math.ceil(boundingBox.height / pageHeight) || 1 : 1;
    if (d.multiPage) screenshotOpts.type = "jpeg";
    if (num === 1) {
      const buf = toBuffer(await body.screenshot(screenshotOpts));
      if (buf) BotUtil.makeLog("info", `[${name}][${this.renderNum + 1}] ${(buf.length / 1024).toFixed(2)}KB ${Date.now() - start}ms`, "PuppeteerRenderer");
      return buf ? [buf] : [];
    }

    const ret = [];
    await page.setViewport({ width: Math.ceil(boundingBox.width), height: Math.min(pageHeight + 100, 2000) });
    for (let i = 1; i <= num; i++) {
      if (i === num && num > 1) {
        await page.setViewport({
          width: Math.ceil(boundingBox.width),
          height: Math.min(parseInt(boundingBox.height) - pageHeight * (num - 1), 2000) || 100,
        });
      }
      if (i !== 1) {
        await page.evaluate((y) => window.scrollTo(0, y), pageHeight * (i - 1));
        await new Promise(r => setTimeout(r, 100));
      }
      const buf = toBuffer(i === 1 ? await body.screenshot(screenshotOpts) : await page.screenshot(screenshotOpts));
      if (buf) ret.push(buf);
      if (i < num && num > 2) await new Promise(r => setTimeout(r, 100));
    }
    BotUtil.makeLog("info", `[${name}] multiPage ${num} ${Date.now() - start}ms`, "PuppeteerRenderer");
    return ret;
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

  async connectToExisting(browserWSEndpoint, retries = 0) {
    try {
      const browser = await puppeteer.connect({
        browserWSEndpoint,
        defaultViewport: null,
      });
      const page = await browser.newPage();
      await page.goto("about:blank", { timeout: 5000 });
      await page.close();
      return browser;
    } catch (e) {
      if (retries < this.maxRetries - 1) {
        await new Promise(r => setTimeout(r, this.retryDelay * Math.pow(2, retries)));
        return this.connectToExisting(browserWSEndpoint, retries + 1);
      }
      BotUtil.makeLog("warn", `Failed to connect to existing Chromium: ${e.message}`, "PuppeteerRenderer");
      if (this.browserMacKey) await redis.del(this.browserMacKey).catch(() => {});
      return null;
    }
  }

  async browserInit() {
    if (this.browser) {
      try {
        if (!this.browser.isConnected()) throw new Error("disconnected");
        await this.browser.version();
        return this.browser;
      } catch (e) {
        BotUtil.makeLog("warn", `Existing browser invalid: ${e.message}`, "PuppeteerRenderer");
        this.browser = null;
        if (this.browserMacKey) await redis.del(this.browserMacKey).catch(() => {});
      }
    }
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
        BotUtil.makeLog("info", `Connecting to existing Chromium instance: ${browserWSEndpoint}`, "PuppeteerRenderer");
        this.browser = await this.connectToExisting(browserWSEndpoint);
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

      if (this.idleRestartMs > 0 && Date.now() - this.lastActivityAt > this.idleRestartMs) {
        BotUtil.makeLog("info", "Chromium idle timeout, restarting...", "PuppeteerRenderer");
        await this.restart(true);
        return;
      }

      try {
        if (!this.browser.isConnected()) throw new Error("disconnected");
        await this.browser.version();
      } catch (e) {
        BotUtil.makeLog("warn", `Health check failed: ${e.message}, restarting...`, "PuppeteerRenderer");
        await this.restart(true);
      }
    }, this.healthCheckInterval);
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

    if (this.idleRestartMs > 0 && Date.now() - this.lastActivityAt > this.idleRestartMs) {
      await this.restart(true);
      if (!await this.browserInit()) {
        if (isUserTriggered) this.shotingUser = this.shotingUser.filter(i => i !== name);
        else this.shoting = this.shoting.filter(i => i !== name);
        return false;
      }
    }

    const wantTpl = Boolean(d.tplFile);
    const useUrl = !wantTpl && d.url && /^https?:\/\//i.test(String(d.url));
    const pageHeight = d.multiPageHeight ?? 4000;
    let savePath = null;
    let directFilePath = null;
    if (!useUrl) {
      const tpl = d.tplFile;
      if (typeof tpl === "string" && path.isAbsolute(tpl) && FileUtils.existsSync(tpl)) {
        directFilePath = path.resolve(tpl);
      } else {
        savePath = this.dealTpl(name, d);
        if (!savePath) return false;
      }
    }
    const filePath = useUrl ? null : (directFilePath || path.join(resolveProjectPath(), String(savePath).replace(/^\.\/?/, "")));
    if (!useUrl && (typeof filePath !== "string" || !FileUtils.existsSync(filePath))) {
      BotUtil.makeLog("error", `HTML file does not exist: ${filePath}`, "PuppeteerRenderer");
      return false;
    }

    let ret = [];
    let page = null;
    const start = Date.now();

    try {
      page = await this.browser.newPage();
      await this.setupRequestRoute(page, d, name);

      await page.setViewport({
        width: d.width,
        height: d.height,
        deviceScaleFactor: d.deviceScaleFactor,
      });

      const pageGotoParams = Object.assign(
        { timeout: this.puppeteerTimeout, waitUntil: d.waitUntil || "domcontentloaded" },
        d.pageGotoParams || {}
      );
      await page.goto(useUrl ? d.url : toFileUrl(filePath), pageGotoParams);

      if (typeof d.pageStyle === "string" && d.pageStyle.trim()) {
        await page.addStyleTag({ content: d.pageStyle }).catch(() => {});
      }

      const timeout = this.selectorTimeout(d);
      await this.waitForExprs(page, d.waitForFunctionList, timeout);
      if (typeof d.pageEvaluate === "string" && d.pageEvaluate.trim()) {
        try {
          await page.evaluate(d.pageEvaluate);
        } catch (e) {
          BotUtil.makeLog("debug", `[${name}] pageEvaluate: ${e?.message || e}`, "PuppeteerRenderer");
        }
      }
      await this.waitForExprs(page, d.waitForFunctionAfterList, timeout);
      await this.waitForSels(page, d.waitForSelectorList, timeout);

      if (d.waitImages !== false) {
        await this.waitImagesLoaded(page, Number.isFinite(d.imageWaitTimeout) ? d.imageWaitTimeout : 800);
      }
      if (d.waitFonts !== false) {
        await this.waitFontsReady(page, Number.isFinite(d.fontWaitTimeout) ? d.fontWaitTimeout : 800);
      }

      ret = await this.captureScreenshot(page, d, name, start, useUrl, pageHeight);
      this.renderNum += ret.length;
      if (ret.length > 0) this.lastActivityAt = Date.now();
    } catch (error) {
      BotUtil.makeLog("error", `[${name}] Screenshot failed: ${error.message}`, "PuppeteerRenderer");
      if (/timeout|timed out|disconnected|Target closed/i.test(error.message)) {
        setTimeout(() => this.restart(true), 500);
      }
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
      this.lastActivityAt = Date.now();

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