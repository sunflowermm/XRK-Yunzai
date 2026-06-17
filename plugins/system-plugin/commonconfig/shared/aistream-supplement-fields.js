/**
 * aistream.yaml 中 crawl / tools / agentWorkspace 扩展字段（与 default_config/aistream.yaml 对齐）
 */

function providerScope(label, fields) {
  return {
    type: 'object',
    label,
    component: 'SubForm',
    fields
  };
}

const API_KEY_BASE = {
  apiKey: { type: 'string', label: 'API Key', default: '', component: 'InputPassword' },
  baseUrl: { type: 'string', label: 'Base URL', default: '', component: 'Input' }
};

/** agentWorkspace 段内补充字段（合并进 system.js 既有 SubForm） */
export const AGENT_WORKSPACE_SUPPLEMENT_FIELDS = {
  contextFiles: {
    type: 'array',
    label: '额外注入 Markdown 文件',
    description: '相对工作区根的路径列表，注入 system prompt',
    itemType: 'string',
    default: [],
    component: 'Tags'
  },
  maxCandidatesPerRoot: {
    type: 'number',
    label: '每技能根扫描上限',
    min: 1,
    default: 300,
    component: 'InputNumber'
  },
  maxSkillsLoadedPerSource: {
    type: 'number',
    label: '每来源加载技能上限',
    min: 1,
    default: 200,
    component: 'InputNumber'
  },
  maxSkillsInPrompt: {
    type: 'number',
    label: 'Prompt 内技能条数上限',
    min: 1,
    default: 150,
    component: 'InputNumber'
  },
  maxSkillFileBytes: {
    type: 'number',
    label: '单技能文件字节上限',
    min: 1024,
    default: 256000,
    component: 'InputNumber'
  },
  maxRulesChars: {
    type: 'number',
    label: 'rules 字符上限',
    min: 1000,
    default: 12000,
    component: 'InputNumber'
  },
  maxAgentMdChars: {
    type: 'number',
    label: 'AGENTS.md 字符上限',
    min: 1000,
    default: 12000,
    component: 'InputNumber'
  }
};

/** aistream.crawl 完整 schema.fields */
export const AISTREAM_CRAWL_FIELDS = {
  webFetch: {
    type: 'object',
    label: 'web_fetch',
    description: 'URL 抓取、SSRF、Readability、Firecrawl 回退',
    component: 'SubForm',
    fields: {
      timeoutSeconds: { type: 'number', label: '超时（秒）', min: 1, default: 30, component: 'InputNumber' },
      cacheTtlMinutes: { type: 'number', label: '缓存 TTL（分钟）', min: 0, default: 15, component: 'InputNumber' },
      maxChars: { type: 'number', label: '正文最大字符', min: 100, default: 50000, component: 'InputNumber' },
      maxResponseBytes: { type: 'number', label: '响应体最大字节', min: 32000, default: 2000000, component: 'InputNumber' },
      maxRedirects: { type: 'number', label: '最大重定向次数', min: 0, default: 3, component: 'InputNumber' },
      pinDns: { type: 'boolean', label: 'DNS 钉扎（SSRF）', default: true, component: 'Switch' },
      readabilityEnabled: { type: 'boolean', label: 'Readability 提取', default: true, component: 'Switch' },
      userAgent: { type: 'string', label: 'User-Agent', default: '', component: 'Input' },
      firecrawlApiKey: { type: 'string', label: 'Firecrawl API Key', default: '', component: 'InputPassword' },
      firecrawlBaseUrl: { type: 'string', label: 'Firecrawl Base URL', default: 'https://api.firecrawl.dev', component: 'Input' },
      firecrawlEnabled: { type: 'boolean', label: '启用 Firecrawl 回退', default: false, component: 'Switch' }
    }
  },
  webSearch: {
    type: 'object',
    label: 'web_search',
    description: '开放域检索（13 提供商；无 Key 时 parallel-free）',
    component: 'SubForm',
    fields: {
      enabled: { type: 'boolean', label: '启用 web_search', default: true, component: 'Switch' },
      provider: { type: 'string', label: '默认提供商', default: '', component: 'Input' },
      timeoutSeconds: { type: 'number', label: '超时（秒）', min: 1, default: 20, component: 'InputNumber' },
      cacheTtlMinutes: { type: 'number', label: '缓存 TTL（分钟）', min: 0, default: 15, component: 'InputNumber' },
      region: { type: 'string', label: '区域', default: '', component: 'Input' },
      safeSearch: { type: 'string', label: 'SafeSearch', enum: ['off', 'moderate', 'strict'], default: 'moderate', component: 'Select' },
      country: { type: 'string', label: '国家/地区', default: '', component: 'Input' },
      parallelFree: providerScope('Parallel Free', {
        url: { type: 'string', label: 'MCP URL', default: 'https://search.parallel.ai/mcp', component: 'Input' }
      }),
      brave: providerScope('Brave', API_KEY_BASE),
      perplexity: providerScope('Perplexity', {
        ...API_KEY_BASE,
        openRouterApiKey: { type: 'string', label: 'OpenRouter API Key', default: '', component: 'InputPassword' },
        model: { type: 'string', label: 'Model', default: '', component: 'Input' }
      }),
      exa: providerScope('Exa', API_KEY_BASE),
      tavily: providerScope('Tavily', API_KEY_BASE),
      parallel: providerScope('Parallel', API_KEY_BASE),
      gemini: providerScope('Gemini', {
        ...API_KEY_BASE,
        model: { type: 'string', label: 'Model', default: '', component: 'Input' }
      }),
      kimi: providerScope('Kimi', {
        ...API_KEY_BASE,
        model: { type: 'string', label: 'Model', default: '', component: 'Input' }
      }),
      minimax: providerScope('MiniMax', {
        ...API_KEY_BASE,
        region: { type: 'string', label: 'Region', default: '', component: 'Input' },
        apiHost: { type: 'string', label: 'API Host', default: '', component: 'Input' }
      }),
      firecrawl: providerScope('Firecrawl', API_KEY_BASE),
      searxng: providerScope('SearXNG', {
        baseUrl: { type: 'string', label: 'Base URL', default: '', component: 'Input' },
        categories: { type: 'string', label: 'Categories', default: '', component: 'Input' },
        language: { type: 'string', label: 'Language', default: '', component: 'Input' }
      }),
      ollama: providerScope('Ollama', {
        baseUrl: { type: 'string', label: 'Base URL', default: 'http://127.0.0.1:11434', component: 'Input' },
        apiKey: { type: 'string', label: 'API Key', default: '', component: 'InputPassword' },
        cloudApiKey: { type: 'string', label: 'Cloud API Key', default: '', component: 'InputPassword' }
      })
    }
  },
  browser: {
    type: 'object',
    label: 'browser MCP',
    description: '浏览器自动化；启动参数另合并 renderer/playwright',
    component: 'SubForm',
    fields: {
      browserType: { type: 'string', label: '浏览器类型', enum: ['chromium', 'firefox', 'webkit'], default: 'chromium', component: 'Select' },
      headless: { type: 'boolean', label: '无头模式', default: true, component: 'Switch' },
      wsEndpoint: { type: 'string', label: 'WebSocket 端点', default: '', component: 'Input' },
      executablePath: { type: 'string', label: '可执行文件路径', default: '', component: 'Input' },
      launchTimeoutMs: { type: 'number', label: '启动超时（ms）', min: 5000, default: 120000, component: 'InputNumber' },
      navigationTimeoutMs: { type: 'number', label: '导航超时（ms）', min: 1000, default: 60000, component: 'InputNumber' },
      maxTextChars: { type: 'number', label: '正文最大字符', min: 1000, default: 50000, component: 'InputNumber' },
      screenshotMaxBytes: { type: 'number', label: '截图最大字节', min: 64000, default: 4194304, component: 'InputNumber' },
      screenshotFontDir: { type: 'string', label: '截图字体目录', default: '', component: 'Input' },
      screenshotFontUrlBase: { type: 'string', label: '截图字体 URL 前缀', default: '', component: 'Input' },
      screenshotFontFiles: { type: 'array', label: '截图字体文件', itemType: 'string', default: [], component: 'Tags' },
      ssrfPolicy: {
        type: 'object',
        label: 'SSRF 策略',
        component: 'SubForm',
        fields: {
          allowPrivateNetwork: { type: 'boolean', label: '允许内网', default: false, component: 'Switch' },
          dangerouslyAllowPrivateNetwork: { type: 'boolean', label: '危险：强制允许内网', default: false, component: 'Switch' }
        }
      }
    }
  }
};

/** aistream.tools 完整 schema.fields */
export const AISTREAM_TOOLS_FIELDS = {
  file: {
    type: 'object',
    label: '文件工具',
    description: 'tools 工作流 read/grep/run 等工作区与限额',
    component: 'SubForm',
    fields: {
      workspace: { type: 'string', label: '工作区路径', description: '留空使用默认 Agent 工作区', default: '', component: 'Input' },
      maxReadChars: { type: 'number', label: 'read 最大字符', min: 1000, default: 500000, component: 'InputNumber' },
      readRawPreviewChars: { type: 'number', label: '原始预览字符', min: 2000, default: 20000, component: 'InputNumber' },
      grepMaxResults: { type: 'number', label: 'grep 最大结果', min: 1, max: 500, default: 100, component: 'InputNumber' },
      runEnabled: { type: 'boolean', label: '允许 run 命令', default: true, component: 'Switch' },
      runTimeoutMs: { type: 'number', label: 'run 超时（ms）', min: 1000, default: 120000, component: 'InputNumber' },
      maxCommandOutputChars: { type: 'number', label: '命令输出最大字符', min: 1000, default: 200000, component: 'InputNumber' }
    }
  }
};
