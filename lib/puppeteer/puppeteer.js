import Renderer from '../renderer/loader.js';

/**
 * 旧版插件兼容入口：委托 RendererLoader，提供 screenshot / screenshots。
 * 大量第三方插件仍 import lib/puppeteer/puppeteer.js。
 */
const renderer = Renderer.getRenderer();
if (renderer) {
  renderer.screenshot = async (name, data) => {
    const img = await renderer.render(name, data);
    return img ? segment.image(img) : img;
  };
  renderer.screenshots = async (name, data) => {
    data.multiPage = true;
    const imgs = (await renderer.render(name, data)) || [];
    const ret = [];
    for (const img of imgs) {
      ret.push(img ? segment.image(img) : img);
    }
    return ret.length > 0 ? ret : false;
  };
}

export default renderer;
