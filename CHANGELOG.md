# 3.0.0

* 初始版本

* **请注意：**
  * 此版本为初始版本，可能存在一些问题。
  * 请在使用前仔细阅读文档。

# 3.0.1
* 初步修复了喵崽的固有问题，强化喵崽的ICQQ登录体验，使用了时雨崽的一些底层文件，以确保可以在无喵喵插件环境下使用。
* 重构了状态.js,以config.js为基础，开始重构，包括文件位置，启动方式，支持多开

# 3.0.2
* 修复了部分问题，修复了部分bug，加入浏览器内存监测，实测三十天内存几乎不变
* 剔除了qq.yaml，直接放入data/xrk/，已经实现了多Bot例独立运行并且没有很多的内存占用

# 3.0.3
* 尝试引入类似时雨崽底层的http服务器管理连接逻辑，以方便扩大项目兼容性，重构loader为此后新用途做准备

# 3.0.4
* 修复了部分问题，修复了部分bug，引入了stdin.js，以方便在控制台中使用，引入了commond（cmd）的js，以方便随意调用命令，重构了部分底层代码。
* 增加了示例插件'请假'，‘模拟定时输入’
* 尝试使用时雨崽的服务器方式来启动云崽，记录在启动文件中，全局挂载process.argv，方便差异化启动。
* 增加了部分日志文件，以方便查看日志以调试和规范化记录

# 3.0.5
* 初步实现了守护进程完全挂载，服务器启动后可以通过http随时重启或关机（icqq和其他启动方式都有）
* 借用了时雨崽适配器的全部底层，很多的实现也得益于时雨崽，时雨崽就是艺术品
* commond.js 拆分为 rmj 和 roj，以方便开发：roj 读取对象数组等数值，rmj 用于运行 JavaScript 代码
* 多数文件重构，以方便后续开发，修复了 e.gerReply() 冲突问题，对日志记录进行优化
* 进入稳定版，后续将慢慢更新，锅巴也已适配
* 更新了 Onebot 的更多接口

# 3.1.0
* 渲染器加载器重构：全局挂载 `RendererLoader`，插件可直接使用 `global.RendererLoader.getRenderer()` 截图，减少重复 import
* 渲染器配置支持 `config_default.yaml` 回退，精简 loader 依赖（移除 ObjectUtils、冗余 fs），统一从 renderers/ 与 plugins/*/renderer/ 加载
* Puppeteer / Playwright 渲染器去除 lodash，改用原生 Object.assign 与字符串处理，简化浏览器锁等待逻辑
* 本地 HTML 截图时，若 `tplFile` 为绝对路径则直接按该路径加载，保证同目录 CSS、图片等相对资源正确解析
* 新增 `lib/renderer/README.md`，补充渲染器用法说明（getRenderer、screenshot 参数、tplFile 行为）

# 3.1.1
* 修复部分插件在 Windows 下路径解析异常，统一使用 path 与 file:// 协议处理本地 HTML
* 默认渲染器启动参数精简为常用四项（no-sandbox、disable-setuid-sandbox、disable-dev-shm-usage、disable-gpu），降低无头浏览器启动失败率
* 渲染器相关日志统一带 `[RendererLoader]` / 渲染器名，便于排查
* 文档与注释整理，便于二次开发与插件接入

# 3.1.2
* 向日葵插件（XRK-plugin）截图统一走项目渲染器，移除对根目录 components 的依赖，插件内 takeScreenshot 优先使用 `global.RendererLoader`
* 多 Bot 实例下渲染器配置支持按 `data/server_bots/<uin>/renderers/` 独立配置 puppeteer / playwright
* 修复帮助、网页截图、查天气等应用因渲染器路径或资源加载导致的载入失败或截图无样式问题

# 3.1.3（当前版本）
* 渲染器与插件层进一步收口：删冗余代码、无意义保护逻辑与多余 import，提高对象引用（RendererLoader、getRenderer）复用
* 更新日志与版本号梳理，3.1.x 为当前维护主线
* 依赖与配置说明见 README，渲染器接入详见 `lib/renderer/README.md`
* 文档：USER_GUIDE 端口改为「以实际配置为准」、补充设备 WS 下行类型（reply/asr_interim/asr_final/play_tts_audio）、Event 引用回复与 v3 对话接口说明；FACTORY/README 明确无默认运营商配置项

---

* Yunzai-Bot && XRK-Yunzai && TRSS-Yunzai && Miao-Yunzai && 其他
* 此项目基于 Miao-Yunzai 二次开发，感谢 Miao-Yunzai 的开发者们。
