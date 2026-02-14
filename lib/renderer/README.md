# 渲染器

启动后 `global.RendererLoader` 为渲染器加载器实例，可从 `renderers/`、`plugins/<名>/renderer/` 加载渲染器；配置优先读 `config.yaml`，不存在则读 `config_default.yaml`。

## 用法

- **获取当前渲染器**：`global.RendererLoader.getRenderer()` 或 `getRenderer(name)`，未传 name 时使用配置中的 `renderer.name`（默认 `puppeteer`）。
- **截图**：`renderer.screenshot(name, data)`  
  - `name`：截图标识（saveId）。  
  - `data` 常用字段：
    - `url`：要打开的 URL（与本地 HTML 二选一）。
    - `tplFile` + `saveId`：本地 HTML 路径；**若为绝对路径且文件存在，则直接按该路径加载（不经过 dealTpl），CSS/图片等相对路径以该文件所在目录为基准。**
    - `width` / `height`：视口宽高。
    - `fullPage`：是否整页截图。
    - `waitUntil`：页面加载策略（如 `domcontentloaded`）。
    - `imageWaitTimeout`：等待图片加载毫秒数。
    - `imgType`：如 `png`、`jpeg`。
    - `clip`：裁剪区域 `{ x, y, width, height }`。
- **列表**：`RendererLoader.listRenderers()`、`RendererLoader.hasRenderer(name)`。

插件中建议优先使用 `global.RendererLoader.getRenderer()`，避免重复动态 import。
