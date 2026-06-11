import BotUtil from '../util.js';
import Renderer from './loader.js';

const unavailable = async () => {
  BotUtil.makeLog('warn', '渲染器未加载，screenshot 不可用', 'Renderer');
  return false;
};

function attachScreenshotMethods(renderer) {
  if (!renderer?.render) {
    return { screenshot: unavailable, screenshots: unavailable, render: unavailable };
  }
  if (!renderer.screenshot) {
    renderer.screenshot = async (name, data) => {
      const img = await renderer.render(name, data);
      return img ? segment.image(img) : img;
    };
  }
  if (!renderer.screenshots) {
    renderer.screenshots = async (name, data) => {
      data.multiPage = true;
      const imgs = (await renderer.render(name, data)) || [];
      const ret = imgs.map((img) => (img ? segment.image(img) : img));
      return ret.length > 0 ? ret : false;
    };
  }
  return renderer;
}

/** 旧版 puppeteer.js / e.runtime.puppeteer 共用入口 */
export default function getPuppeteerCompat(name = null) {
  return attachScreenshotMethods(Renderer.getRenderer(name));
}
