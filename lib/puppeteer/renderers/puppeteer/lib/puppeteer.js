import Renderer from "../../../renderer/Renderer.js";
import os from "node:os";
import lodash from "lodash";
import puppeteer from "puppeteer";
import cfg from "../../../../config/config.js";
import fs from "node:fs";

const _path = process.cwd();
let mac = "";

export default class Puppeteer extends Renderer {
  constructor(config = {}) {
    super({
      id: "puppeteer",
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
    this.config = {
      headless: config.headless || "new",
      args: config.args || [
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-setuid-sandbox",
        "--no-zygote",
      ],
    };

    // 兼容旧配置
    if (config.chromiumPath || cfg?.bot?.chromium_path)
      this.config.executablePath = config.chromiumPath || cfg?.bot?.chromium_path;
    if (config.puppeteerWS || cfg?.bot?.puppeteer_ws)
      this.config.wsEndpoint = config.puppeteerWS || cfg?.bot?.puppeteer_ws;

    // 超时设置
    this.puppeteerTimeout = config.puppeteerTimeout || cfg?.bot?.puppeteer_timeout || 0;

    // 浏览器健康监控
    this.healthCheckTimer = null;
    this.browserMacKey = null;

    // 退出时清理资源
    process.on("exit", () => this.cleanup());
  }

  // 获取Mac地址作为唯一标识
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
      logger.debug("获取MAC地址失败:", e);
    }
    return mac.replace(/:/g, "");
  }

  // 浏览器初始化
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
      logger.info("puppeteer Chromium 启动中...");

      if (!mac) {
        mac = await this.getMac();
        this.browserMacKey = `Yz:chromium:browserWSEndpoint:${mac}`;
      }

      let browserWSEndpoint = null;
      try {
        if (this.browserMacKey) {
          browserWSEndpoint = await redis.get(this.browserMacKey);
        }
      } catch (e) {}

      if (!browserWSEndpoint && this.config.wsEndpoint) {
        browserWSEndpoint = this.config.wsEndpoint;
      }

      if (browserWSEndpoint) {
        try {
          logger.info(`尝试连接到现有Chromium实例: ${browserWSEndpoint}`);
          this.browser = await puppeteer.connect({
            browserWSEndpoint,
            defaultViewport: null,
          });

          const pages = await this.browser.pages().catch(() => null);
          if (pages) {
            logger.info(`成功连接到现有Chromium实例`);
          } else {
            logger.info(`连接的Chromium实例不可用，将启动新实例`);
            try {
              await this.browser.close().catch(() => {});
            } catch (e) {}
            this.browser = null;

            try {
              if (this.browserMacKey) {
                await redis.del(this.browserMacKey);
              }
            } catch (e) {}
          }
        } catch (e) {
          logger.info(`连接到现有Chromium实例失败: ${e.message}`);
          try {
            if (this.browserMacKey) {
              await redis.del(this.browserMacKey);
            }
          } catch (e) {}
        }
      }

      if (!this.browser) {
        this.browser = await puppeteer.launch(this.config).catch((err) => {
          logger.error(`启动Chromium失败: ${err.message}`);
          if (err.message.includes("Could not find Chromium")) {
            logger.error("没有正确安装 Chromium，可以尝试执行安装命令：node node_modules/puppeteer/install.js");
          } else if (err.message.includes("cannot open shared object file")) {
            logger.error("没有正确安装 Chromium 运行库");
          }
          return null;
        });

        if (this.browser) {
          logger.info(`puppeteer Chromium 启动成功 ${this.browser.wsEndpoint()}`);
          try {
            if (this.browserMacKey) {
              await redis.set(this.browserMacKey, this.browser.wsEndpoint(), {
                EX: 60 * 60 * 24 * 30, // 30天过期
              });
            }
          } catch (e) {
            logger.error(`保存浏览器实例信息失败: ${e.message}`);
          }
        }
      }

      if (!this.browser) {
        logger.error("puppeteer Chromium 启动失败");
        this.lock = false;
        return false;
      }

      this.browser.on("disconnected", () => {
        logger.warn("Chromium实例断开连接，将重启");
        this.browser = null;
        this.restart(true);
      });
    } catch (e) {
      logger.error(`浏览器初始化失败: ${e.message}`);
      this.browser = null;
    } finally {
      this.lock = false;
    }

    return this.browser;
  }

  /**
   * `chromium` 截图
   * @param name
   * @param data 模板参数
   * @param data.tplFile 模板路径，必传
   * @param data.saveId  生成html名称，为空name代替
   * @param data.imgType  screenshot参数，生成图片类型：jpeg，png
   * @param data.quality  screenshot参数，图片质量 0-100，jpeg是可传，默认90
   * @param data.omitBackground  screenshot参数，隐藏默认的白色背景，背景透明。默认不透明
   * @param data.path   screenshot参数，截图保存路径。截图图片类型将从文件扩展名推断出来。如果是相对路径，则从当前路径解析。如果没有指定路径，图片将不会保存到硬盘。
   * @param data.multiPage 是否分页截图，默认false
   * @param data.multiPageHeight 分页状态下页面高度，默认4000
   * @param data.pageGotoParams 页面goto时的参数
   * @return img 不做segment包裹
   */
  async screenshot(name, data = {}) {
    if (!await this.browserInit()) return false;

    const pageHeight = data.multiPageHeight || 4000;
    const savePath = this.dealTpl(name, data);
    if (!savePath) return false;

    const filePath = `${_path}${lodash.trim(savePath, ".")}`;
    if (!fs.existsSync(filePath)) {
      logger.error(`HTML文件不存在: ${filePath}`);
      return false;
    }

    let ret = [];
    let page = null;
    this.shoting.push(name);
    const start = Date.now();

    try {
      page = await this.browser.newPage();
      if (!page) throw new Error("无法创建页面");

      await page.setViewport({
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
      });

      const pageGotoParams = lodash.extend(
        { timeout: 120000, waitUntil: "networkidle2" },
        data.pageGotoParams || {}
      );

      const fileUrl = `file://${filePath}`;
      logger.debug(`[图片生成][${name}] 加载文件: ${fileUrl}`);
      await page.goto(fileUrl, pageGotoParams);

      await page.evaluate(() => {
        return new Promise((resolve) => {
          const timeout = setTimeout(resolve, 1000);
          const images = document.querySelectorAll("img");
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

      const body = (await page.$("#container")) || (await page.$("body"));
      if (!body) throw new Error("找不到内容元素");

      const boundingBox = await body.boundingBox();

      const screenshotOptions = {
        type: data.imgType || "jpeg",
        omitBackground: data.omitBackground || false,
        quality: data.quality || 90,
        path: data.path || "",
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
        logger.mark(`[图片生成][${name}][${this.renderNum}次] ${kb} ${logger.green(`${Date.now() - start}ms`)}`);
        ret.push(buffer);
      } else {
        if (num > 1) {
          await page.setViewport({
            width: Math.ceil(boundingBox.width),
            height: pageHeight + 100,
          });
        }

        for (let i = 1; i <= num; i++) {
          if (i !== 1 && i === num) {
            const remainingHeight = parseInt(boundingBox.height) - pageHeight * (num - 1);
            await page.setViewport({
              width: Math.ceil(boundingBox.width),
              height: remainingHeight > 0 ? remainingHeight : 100,
            });
          }

          if (i !== 1) {
            await page.evaluate((scrollY) => {
              window.scrollTo(0, scrollY);
            }, pageHeight * (i - 1));
            await new Promise((resolve) => setTimeout(resolve, 300));
          }

          const buff = num === 1 ? await body.screenshot(screenshotOptions) : await page.screenshot(screenshotOptions);
          const buffer = Buffer.isBuffer(buff) ? buff : Buffer.from(buff);
          this.renderNum++;
          const kb = (buffer.length / 1024).toFixed(2) + "KB";
          logger.mark(`[图片生成][${name}][${i}/${num}] ${kb}`);
          ret.push(buffer);

          if (i < num && num > 2) {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }

        if (num > 1) {
          logger.mark(`[图片生成][${name}] 处理完成 ${logger.green(`${Date.now() - start}ms`)}`);
        }
      }
    } catch (error) {
      logger.error(`[图片生成][${name}] 图片生成失败:`, error);
      ret = [];
    } finally {
      if (page) page.close().catch(() => {});
      this.shoting = this.shoting.filter((item) => item !== name);
    }

    if (this.renderNum % this.restartNum === 0 && this.renderNum > 0 && this.shoting.length === 0) {
      logger.info(`puppeteer已完成${this.renderNum}次截图，准备重启`);
      this.restart();
    }

    if (ret.length === 0 || !ret[0]) {
      logger.error(`[图片生成][${name}] 图片生成为空`);
      return false;
    }

    return data.multiPage ? ret : ret[0];
  }

  /** 
   * 重启浏览器
   * @param {boolean} force - 是否强制重启
   */
  async restart(force = false) {
    if (!this.browser || this.lock) return;

    if (!force && (this.renderNum % this.restartNum !== 0 || this.shoting.length > 0)) return;

    logger.info(`puppeteer Chromium ${force ? "强制" : "计划"}重启...`);

    try {
      const currentEndpoint = this.browser.wsEndpoint();
      await this.browser.close().catch((err) => logger.error("关闭浏览器实例失败:", err));
      this.browser = null;

      try {
        if (this.browserMacKey) {
          const storedEndpoint = await redis.get(this.browserMacKey);
          if (storedEndpoint === currentEndpoint) await redis.del(this.browserMacKey);
        }
      } catch (e) {
        logger.error(`Redis删除浏览器实例失败:`, e);
      }

      this.renderNum = 0;

      if (this.healthCheckTimer) {
        clearInterval(this.healthCheckTimer);
        this.healthCheckTimer = null;
      }
    } catch (err) {
      logger.error("重启浏览器出错:", err);
    }

    return true;
  }

  /**
   * 清理资源
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

    logger.info("Puppeteer资源已清理完成");
  }
}