/**
 * 爬虫 / 外联抓取统一入口（供 web / browser 工作流使用）
 */
export { SsrFBlockedError } from './ssrf-guard.js';
export {
  buildWebFetchRuntime,
  runWebFetch,
  DEFAULT_FETCH_MAX_CHARS
} from './web-fetch-executor.js';
export { PlaywrightAgentSession } from './playwright-session.js';
export { createLocalFontScreenshotHelper } from './page-screenshot-enhance.js';
export { buildBrowserRuntime } from './crawl-config.js';
export {
  buildWebSearchRuntime,
  runWebSearch,
  listWebSearchProviders,
  WEB_SEARCH_PROVIDERS
} from './web-search-executor.js';
