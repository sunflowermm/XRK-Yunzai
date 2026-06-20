import Renderer from './loader.js';

const WRAPPED = Symbol('xrkScreenshotWrapped');

const unavailable = async () => {
  Bot.makeLog('warn', '渲染器未加载，screenshot 不可用', 'Renderer');
  return false;
};

function isImageSegment(val) {
  return val && typeof val === 'object' && val.type === 'image';
}

function toImageSegment(img) {
  if (!img) return img;
  if (isImageSegment(img)) return img;
  if (Buffer.isBuffer(img) || img instanceof Uint8Array || typeof img === 'string') {
    return segment.image(img);
  }
  return img;
}

function wrapScreenshotResult(result) {
  if (!result) return result;
  if (Array.isArray(result)) {
    const ret = result.map(toImageSegment).filter(Boolean);
    return ret.length > 0 ? ret : false;
  }
  return toImageSegment(result);
}

function attachScreenshotMethods(renderer) {
  if (!renderer?.render) {
    return { screenshot: unavailable, screenshots: unavailable, render: unavailable };
  }
  if (renderer[WRAPPED]) return renderer;

  const origScreenshot = renderer.screenshot?.bind(renderer);
  const origRender = renderer.render?.bind(renderer);

  renderer.screenshot = async (name, data = {}) => {
    const img = origScreenshot
      ? await origScreenshot(name, data)
      : await origRender(name, data);
    return wrapScreenshotResult(img);
  };

  renderer.screenshots = async (name, data = {}) => {
    const imgs = await renderer.screenshot(name, { ...data, multiPage: true });
    if (Array.isArray(imgs)) return imgs.length > 0 ? imgs : false;
    return imgs ? [imgs] : false;
  };

  renderer[WRAPPED] = true;
  return renderer;
}

/** 旧版 puppeteer.js / e.runtime.puppeteer 共用入口 */
export default function getPuppeteerCompat(name = null) {
  return attachScreenshotMethods(Renderer.getRenderer(name));
}
