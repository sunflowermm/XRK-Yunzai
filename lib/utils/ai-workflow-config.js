/**
 * AI 工作流配置读取
 */
import cfg from '../config/config.js';

/** 无 ai-workflow 配置时返回 {}，供 loader/mcp/tools/crawl 等使用 */
export const getAiWorkflowConfigOptional = () => cfg.aiWorkflow ?? {};
