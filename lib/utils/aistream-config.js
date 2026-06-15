/**
 * AIStream 配置工具（自 XRK-AGT system-Core 复制，已去除 ASR/TTS）
 */
import cfg from '../config/config.js';

/** 无 aistream 时返回 {}，供 loader/mcp/tools/crawl 等使用 */
export const getAistreamConfigOptional = () => cfg.aistream ?? {};
