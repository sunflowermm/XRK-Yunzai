/**
 * AIStream 配置读取
 */
import cfg from '../config/config.js';

/** 无 aistream 时返回 {}，供 loader/mcp/tools/crawl 等使用 */
export const getAistreamConfigOptional = () => cfg.aistream ?? {};
