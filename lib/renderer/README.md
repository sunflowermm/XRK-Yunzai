# 渲染器

渲染器加载器从 `renderers/`、`plugins/<名>/renderer/` 加载渲染器；配置优先读 `config.yaml`，不存在则读 `config_default.yaml`。加载器通过 `lib/renderer/loader.js` 的 default 导出使用。

## 用法

- **获取渲染器**：插件内优先通过 **e.runtime.getRenderer()** 或 **e.runtime.puppeteer**（当前渲染器）；需按名称取时用 **e.runtime.getRenderer(name)**。非事件上下文（如无 e）可 `import RendererLoader from 'lib/renderer/loader.js'` 后调用 `RendererLoader.getRenderer(name)`。
- **截图**：`renderer.screenshot(name, data)`  
  - `name`：截图标识（saveId）。  
  - `data` 参数组成（均由调用方传入，底层无业务默认值）：
    - `url`：要打开的 URL（与本地 HTML 二选一）。
    - `tplFile`、`saveId`：本地 HTML 路径；若为绝对路径且文件存在则直接按该路径加载，CSS/图片等相对路径以该文件所在目录为基准。
    - `width`、`height`：视口宽高。
    - `deviceScaleFactor`：设备像素比。
    - `fullPage`：是否整页截图。
    - `waitUntil`：页面加载策略（如 `domcontentloaded`、`networkidle2`）。
    - `imageWaitTimeout`：等待页面内图片加载的毫秒数。
    - `delayBeforeScreenshot`：截屏前延迟毫秒数（常用于 fullPage 等待滚动/动画）。
    - `imgType`：输出图片类型（如 `png`、`jpeg`）。
    - `quality`：输出质量（如 jpeg 时有效）。
    - `omitBackground`：是否透明底。
    - `path`：若需落盘时的文件路径。
    - `clip`：裁剪区域 `{ x, y, width, height }`（与 fullPage 二选一，像素值）。
    - `cropTopPercent`、`cropBottomPercent`：仅在与 `fullPage: true` 同时使用时有效；传入 0–1 之间的数表示裁掉顶部/底部的比例，不传则不裁；可只传其一或同时传，两者之和须小于 1。
    - `multiPage`：是否分页截图（多张）。
    - `pageGotoParams`：透传的页面 goto 选项。
  - 插件传入所需参数即可得到对应截屏结果，底层不做具体数值或默认裁剪。
- **列表**：需要渲染器列表时，import 加载器后使用 `RendererLoader.listRenderers()`、`RendererLoader.hasRenderer(name)`。
