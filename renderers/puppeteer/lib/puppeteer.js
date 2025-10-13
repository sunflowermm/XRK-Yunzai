import Renderer from "../../../lib/renderer/Renderer.js";
import os from "node:os";
import lodash from "lodash";
import puppeteer from "puppeteer";
import cfg from "../../../lib/config/config.js";
import fs from "node:fs";
import path from "node:path";
import BotUtil from "../../../lib/common/util.js";

const _path = process.cwd();

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
    this.mac = "";
    this.browserMacKey = null;

    const rendererCfg = cfg.renderer?.puppeteer || {};
    this.restartNum = config.restartNum !== undefined ? config.restartNum : (rendererCfg.restartNum !== undefined ? rendererCfg.restartNum : 100);
    this.renderNum = 0;
    this.puppeteerTimeout = config.puppeteerTimeout !== undefined ? config.puppeteerTimeout : (rendererCfg.puppeteerTimeout !== undefined ? rendererCfg.puppeteerTimeout : 120000);
    
    // 内存管理配置
    this.memoryThreshold = config.memoryThreshold !== undefined ? config.memoryThreshold : (rendererCfg.memoryThreshold !== undefined ? rendererCfg.memoryThreshold : 1024);
    this.maxConcurrent = config.maxConcurrent !== undefined ? config.maxConcurrent : (rendererCfg.maxConcurrent !== undefined ? rendererCfg.maxConcurrent : 3);

    this.config = {
      headless: config.headless !== undefined ? config.headless : (rendererCfg.headless !== undefined ? rendererCfg.headless : "new"),
      args: config.args !== undefined ? config.args : (rendererCfg.args !== undefined ? rendererCfg.args : [
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--allow-file-access-from-files',
        // 移除会导致内存问题的参数
        // '--no-zygote',
        // '--single-process',
        // '--disable-features=site-per-process',
        '--disable-infobars',
        '--disable-notifications',
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        // 添加内存优化参数
        '--js-flags=--max-old-space-size=512',
        '--disable-accelerated-2d-canvas',
        '--disable-accelerated-jpeg-decoding',
        '--disable-accelerated-mjpeg-decode',
        '--disable-accelerated-video-decode',
        '--disable-software-rasterizer',
      ]),
      executablePath: config.chromiumPath !== undefined ? config.chromiumPath : rendererCfg.chromiumPath,
      wsEndpoint: config.puppeteerWS !== undefined ? config.puppeteerWS : rendererCfg.wsEndpoint,
    };

    this.healthCheckTimer = null;
    this.memoryCheckTimer = null;

    process.on("exit", () => this.cleanup());
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

  async browserInit() {
    if (this.browser) return this.browser;

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
      BotUtil.makeLog("puppeteer Chromium 启动中...", "info");

      if (!this.mac) {
        this.mac = await this.getMac();
        this.browserMacKey = `Yz:chromium:browserWSEndpoint:${this.mac}`;
      }

      let browserWSEndpoint = null;
      if (this.browserMacKey) {
        try {
          browserWSEndpoint = await redis.get(this.browserMacKey);
        } catch (e) {}
      }
      if (!browserWSEndpoint && this.config.wsEndpoint) {
        browserWSEndpoint = this.config.wsEndpoint;
      }

      if (browserWSEndpoint) {
        try {
          BotUtil.makeLog(`尝试连接到现有Chromium实例: ${browserWSEndpoint}`, "info");
          this.browser = await puppeteer.connect({
            browserWSEndpoint,
            defaultViewport: null,
          });

          const pages = await this.browser.pages().catch(() => null);
          if (pages) {
            BotUtil.makeLog(`成功连接到现有Chromium实例`, "info");
          } else {
            BotUtil.makeLog(`连接的Chromium实例不可用，将启动新实例`, "warn");
            await this.browser.close().catch(() => {});
            this.browser = null;
            if (this.browserMacKey) {
              await redis.del(this.browserMacKey).catch(() => {});
            }
          }
        } catch (e) {
          BotUtil.makeLog(`连接到现有Chromium实例失败: ${e.message}`, "warn");
          if (this.browserMacKey) {
            await redis.del(this.browserMacKey).catch(() => {});
          }
        }
      }

      if (!this.browser) {
        this.browser = await puppeteer.launch(this.config).catch(err => {
          BotUtil.makeLog(`启动Chromium失败: ${err.message}`, "error");
          if (err.message.includes("Could not find Chromium")) {
            BotUtil.makeLog("没有正确安装 Chromium，可以尝试执行安装命令：node node_modules/puppeteer/install.js", "error");
          } else if (err.message.includes("cannot open shared object file")) {
            BotUtil.makeLog("没有正确安装 Chromium 运行库", "error");
          }
          return null;
        });

        if (this.browser) {
          BotUtil.makeLog(`puppeteer Chromium 启动成功 ${this.browser.wsEndpoint()}`, "info");
          if (this.browserMacKey) {
            try {
              await redis.set(this.browserMacKey, this.browser.wsEndpoint(), { EX: 60 * 60 * 24 * 30 });
            } catch (e) {
              BotUtil.makeLog(`保存浏览器实例信息失败: ${e.message}`, "error");
            }
          }
        }
      }

      if (!this.browser) {
        BotUtil.makeLog("puppeteer Chromium 启动失败", "error");
        return false;
      }

      this.browser.on("disconnected", () => {
        BotUtil.makeLog("Chromium实例断开连接，将重启", "warn");
        this.browser = null;
        this.restart(true);
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
      if (!this.browser || this.shoting.length > 0) return;
      try {
        // 轻量级检查
        await this.browser.pages();
      } catch (e) {
        BotUtil.makeLog(`健康检查失败: ${e.message}, 准备重启`, "warn");
        await this.restart(true);
      }
    }, 120000); // 120秒
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

    const filePath = path.join(_path, lodash.trim(savePath, "."));
    if (!fs.existsSync(filePath)) {
      BotUtil.makeLog(`HTML文件不存在: ${filePath}`, "error");
      return false;
    }

    let ret = [];
    let page = null;
    this.shoting.push(name);
    const start = Date.now();

    try {
      page = await this.browser.newPage();
      if (!page) throw new Error("无法创建页面");

      // 禁用不必要的资源
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const resourceType = request.resourceType();
        if (['font', 'media'].includes(resourceType)) {
          request.abort();
        } else {
          request.continue();
        }
      });

      await page.setViewport({
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
      });

      const pageGotoParams = lodash.extend(
        { timeout: this.puppeteerTimeout, waitUntil: "domcontentloaded" }, // 改用domcontentloaded
        data.pageGotoParams || {}
      );

      const fileUrl = `file://${filePath}`;
      BotUtil.makeLog(`[图片生成][${name}] 加载文件: ${fileUrl}`, "debug");
      await page.goto(fileUrl, pageGotoParams);

      // 优化图片等待
      await page.evaluate(() => new Promise(resolve => {
        const timeout = setTimeout(resolve, 800);
        const images = document.querySelectorAll("img");
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

      const body = (await page.$("#container")) || (await page.$("body"));
      if (!body) throw new Error("找不到内容元素");

      const boundingBox = await body.boundingBox();

      const screenshotOptions = {
        type: data.imgType !== undefined ? data.imgType : "jpeg",
        omitBackground: data.omitBackground !== undefined ? data.omitBackground : false,
        quality: data.quality !== undefined ? data.quality : 85, // 降低质量
        path: data.path !== undefined ? data.path : "",
      };

      if (data.imgType === "png") delete screenshotOptions.quality;

      let num = 1;
      if (data.multiPage) {
        screenshotOptions.type = "jpeg";
        num = Math.ceil(boundingBox.height / pageHeight) || 1;
      }

      if (!data.multiPage) {
        const buff = await body.screenshot(screenshotOptions);
        const buffer = Buffer.isBuffer(buff) ? buff : Buffer.from(buff);
        this.renderNum++;
        const kb = (buffer.length / 1024).toFixed(2) + "KB";
        BotUtil.makeLog(`[图片生成][${name}][${this.renderNum}次] ${kb} ${Date.now() - start}ms`, "info");
        ret.push(buffer);
      } else {
        if (num > 1) {
          await page.setViewport({
            width: Math.ceil(boundingBox.width),
            height: Math.min(pageHeight + 100, 2000),
          });
        }

        for (let i = 1; i <= num; i++) {
          if (i !== 1 && i === num) {
            const remainingHeight = Math.min(parseInt(boundingBox.height) - pageHeight * (num - 1), 2000);
            await page.setViewport({
              width: Math.ceil(boundingBox.width),
              height: remainingHeight > 0 ? remainingHeight : 100,
            });
          }

          if (i !== 1) {
            await page.evaluate(scrollY => window.scrollTo(0, scrollY), pageHeight * (i - 1));
            await new Promise(resolve => setTimeout(resolve, 100));
          }

          const buff = num === 1 ? await body.screenshot(screenshotOptions) : await page.screenshot(screenshotOptions);
          const buffer = Buffer.isBuffer(buff) ? buff : Buffer.from(buff);
          this.renderNum++;
          const kb = (buffer.length / 1024).toFixed(2) + "KB";
          BotUtil.makeLog(`[图片生成][${name}][${i}/${num}] ${kb}`, "debug");
          ret.push(buffer);

          if (i < num && num > 2) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }

        if (num > 1) {
          BotUtil.makeLog(`[图片生成][${name}] 处理完成 ${Date.now() - start}ms`, "info");
        }
      }
    } catch (error) {
      BotUtil.makeLog(`[图片生成][${name}] 图片生成失败: ${error.message}`, "error");
      ret = [];
    } finally {
      if (page) {
        // 移除监听器
        page.removeAllListeners('request');
        await page.close().catch(() => {});
      }
      this.shoting = this.shoting.filter(item => item !== name);
    }

    // 定期重启
    if (this.renderNum % this.restartNum === 0 && this.renderNum > 0 && this.shoting.length === 0) {
      BotUtil.makeLog(`puppeteer已完成${this.renderNum}次截图，准备重启`, "info");
      setTimeout(() => this.restart(), 2000);
    }

    if (ret.length === 0 || !ret[0]) {
      BotUtil.makeLog(`[图片生成][${name}] 图片生成为空`, "error");
      return false;
    }

    return data.multiPage ? ret : ret[0];
  }

  async restart(force = false) {
    if (!this.browser || this.lock) return;

    if (!force && (this.renderNum % this.restartNum !== 0 || this.shoting.length > 0)) return;

    BotUtil.makeLog(`puppeteer Chromium ${force ? "强制" : "计划"}重启...`, "warn");

    try {
      const currentEndpoint = this.browser.wsEndpoint();
      
      // 关闭所有页面
      const pages = await this.browser.pages();
      for (const page of pages) {
        await page.close().catch(() => {});
      }
      
      await this.browser.close().catch(err => BotUtil.makeLog(`关闭浏览器实例失败: ${err.message}`, "error"));
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
      
      if (this.memoryCheckTimer) {
        clearInterval(this.memoryCheckTimer);
        this.memoryCheckTimer = null;
      }

      // 触发GC
      if (global.gc) {
        global.gc();
      }
    } catch (err) {
      BotUtil.makeLog(`重启浏览器出错: ${err.message}`, "error");
    }

    return true;
  }

  async cleanup() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    
    if (this.memoryCheckTimer) {
      clearInterval(this.memoryCheckTimer);
      this.memoryCheckTimer = null;
    }

    if (this.browser) {
      const pages = await this.browser.pages().catch(() => []);
      for (const page of pages) {
        await page.close().catch(() => {});
      }
      await this.browser.close().catch(() => {});
      this.browser = null;
    }

    BotUtil.makeLog("Puppeteer资源已清理完成", "info");
  }
}