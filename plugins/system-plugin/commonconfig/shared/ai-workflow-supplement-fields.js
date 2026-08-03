/**
 * ai-workflow.yaml 中 crawl / tools / agentWorkspace 扩展字段（与 default_config/ai-workflow.yaml 对齐）
 * webSearch 各 Provider 的 label 须带提供商名，避免控制台扁平表单里一排同名「API Key」。
 */

function providerScope(label, description, fields) {
  return {
    type: 'object',
    label,
    description,
    component: 'SubForm',
    fields
  };
}

/** @param {string} name 提供商显示名 */
function providerApiFields(name, extra = {}) {
  const who = name || '该搜索提供商';
  return {
    apiKey: {
      type: 'string',
      label: `${name} API Key`,
      description: `${who} 的鉴权密钥。留空则跳过，不参与 web_search 自动选择。`,
      default: '',
      component: 'InputPassword',
      layout: 'full'
    },
    baseUrl: {
      type: 'string',
      label: `${name} Base URL（可选）`,
      description: `一般留空用官方默认地址。仅自建或反向代理 ${who} 时填写 API 根 URL。`,
      default: '',
      component: 'Input',
      layout: 'full'
    },
    ...extra
  };
}

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
  },
  includeDiagnostics: {
    type: 'boolean',
    label: '包含诊断提示',
    description: '缺失 MEMORY 等关键文件时追加简短诊断（默认关闭）',
    default: false,
    component: 'Switch'
  },
  maxDiagnosticsChars: {
    type: 'number',
    label: '诊断提示最大字符',
    min: 100,
    default: 2000,
    component: 'InputNumber'
  },
  maxSubagentsChars: {
    type: 'number',
    label: 'Agents 清单最大字符',
    min: 100,
    default: 4000,
    component: 'InputNumber'
  }
};

/** ai-workflow.crawl 完整 schema.fields */
export const AI_WORKFLOW_CRAWL_FIELDS = {
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
    description: '联网搜索：全局选项 + 各 Provider 凭据（只用到的填 Key，其余留空）',
    component: 'SubForm',
    fields: {
      enabled: {
        type: 'boolean',
        label: '启用 web_search',
        description: '关闭后 Agent / MCP 无法调用 web_search 工具',
        default: true,
        component: 'Switch'
      },
      provider: {
        type: 'string',
        label: '默认提供商 ID',
        description:
          '强制指定一家：brave / perplexity / exa / tavily / parallel / parallel-free / gemini / kimi / minimax / firecrawl / ollama / searxng / duckduckgo。留空=按已填 Key 自动选；都无 Key 时用 parallel-free，再回退 duckduckgo',
        default: '',
        component: 'Input',
        layout: 'full'
      },
      timeoutSeconds: {
        type: 'number',
        label: '搜索超时（秒）',
        description: '单次搜索 API 最长等待；超时则失败或换回退提供商',
        min: 1,
        default: 20,
        component: 'InputNumber'
      },
      cacheTtlMinutes: {
        type: 'number',
        label: '结果缓存（分钟）',
        description: '相同查询命中内存缓存的时长；0=不缓存',
        min: 0,
        default: 15,
        component: 'InputNumber'
      },
      region: {
        type: 'string',
        label: 'DuckDuckGo region',
        description: '仅 duckduckgo 使用。地区码，如 wt-wt（全球）、us-en、cn-zh；留空用默认',
        default: '',
        component: 'Input'
      },
      safeSearch: {
        type: 'string',
        label: 'DuckDuckGo SafeSearch',
        description: '仅 duckduckgo：strict / moderate / off',
        enum: ['off', 'moderate', 'strict'],
        default: 'moderate',
        component: 'Select'
      },
      country: {
        type: 'string',
        label: '国家码（2 字母，可选）',
        description: '部分付费 Provider（如 Brave）的地区偏好，ISO 3166-1，如 CN、US；不用可留空',
        default: '',
        component: 'Input'
      },
      parallelFree: providerScope(
        'parallel-free（免 Key）',
        '默认零配置搜索：走 Parallel 免费 MCP，无需 API Key',
        {
          url: {
            type: 'string',
            label: 'parallel-free MCP URL',
            description: '免费搜索 MCP 地址；一般保持默认即可',
            default: 'https://search.parallel.ai/mcp',
            component: 'Input',
            layout: 'full'
          }
        }
      ),
      brave: providerScope('Brave', 'Brave Search API（需 api.brave.com 密钥）', providerApiFields('Brave')),
      perplexity: providerScope('Perplexity', 'Perplexity 搜索；可直连或经 OpenRouter', {
        ...providerApiFields('Perplexity'),
        openRouterApiKey: {
          type: 'string',
          label: 'Perplexity · OpenRouter Key（可选）',
          description:
            '走 OpenRouter 中转 Perplexity 时填此项；与上方「Perplexity API Key」二选一，不要两个都填',
          default: '',
          component: 'InputPassword',
          layout: 'full'
        },
        model: {
          type: 'string',
          label: 'Perplexity Model（可选）',
          description: '覆盖默认模型名；直连与 OpenRouter 均可；留空用内置默认',
          default: '',
          component: 'Input',
          layout: 'full'
        }
      }),
      exa: providerScope('Exa', 'Exa 神经搜索 API', providerApiFields('Exa')),
      tavily: providerScope('Tavily', 'Tavily 搜索 API', providerApiFields('Tavily')),
      parallel: providerScope(
        'Parallel（付费）',
        'Parallel.ai 付费搜索（与上方免 Key 的 parallel-free 不同）',
        providerApiFields('Parallel 付费')
      ),
      gemini: providerScope('Gemini', 'Google Gemini 带联网的搜索能力', {
        ...providerApiFields('Gemini'),
        model: {
          type: 'string',
          label: 'Gemini Model（可选）',
          description: 'Gemini 模型名，留空用内置默认',
          default: '',
          component: 'Input',
          layout: 'full'
        }
      }),
      kimi: providerScope('Kimi / Moonshot', '月之暗面（Moonshot）搜索接口', {
        ...providerApiFields('Kimi'),
        model: {
          type: 'string',
          label: 'Kimi Model（可选）',
          description: 'Kimi 模型名，留空用内置默认',
          default: '',
          component: 'Input',
          layout: 'full'
        }
      }),
      minimax: providerScope('MiniMax', 'MiniMax 搜索；可指定 region / host', {
        ...providerApiFields('MiniMax'),
        region: {
          type: 'string',
          label: 'MiniMax Region',
          description: 'global=国际 / cn=国内；留空则按下方 API Host 推断',
          enum: ['', 'global', 'cn'],
          default: '',
          component: 'Select'
        },
        apiHost: {
          type: 'string',
          label: 'MiniMax API Host（可选）',
          description: '自定义主机名；含国内域名时按 cn 处理；一般留空',
          default: '',
          component: 'Input',
          layout: 'full'
        }
      }),
      firecrawl: providerScope(
        'Firecrawl Search',
        'Firecrawl 搜索（可与 scrape 共用同一套密钥）',
        providerApiFields('Firecrawl')
      ),
      searxng: providerScope('SearXNG', '自建 SearXNG 元搜索；填实例地址即可，无需商业 Key', {
        baseUrl: {
          type: 'string',
          label: 'SearXNG 实例 URL',
          description: '必填才启用，如 http://127.0.0.1:8080',
          default: '',
          component: 'Input',
          layout: 'full'
        },
        categories: {
          type: 'string',
          label: 'SearXNG categories（可选）',
          description: 'categories 参数，如 general 或 general,news；留空用实例默认',
          default: '',
          component: 'Input'
        },
        language: {
          type: 'string',
          label: 'SearXNG language（可选）',
          description: 'language 参数，如 zh-CN、en；留空用实例默认',
          default: '',
          component: 'Input'
        }
      }),
      ollama: providerScope('Ollama', '本地 Ollama 或 Ollama Cloud 的 web search', {
        baseUrl: {
          type: 'string',
          label: 'Ollama Base URL',
          description: '本地服务地址，默认 http://127.0.0.1:11434',
          default: 'http://127.0.0.1:11434',
          component: 'Input',
          layout: 'full'
        },
        apiKey: {
          type: 'string',
          label: 'Ollama 本地 API Key（可选）',
          description: '仅当本地实例开启了鉴权时填写',
          default: '',
          component: 'InputPassword',
          layout: 'full'
        },
        cloudApiKey: {
          type: 'string',
          label: 'Ollama Cloud API Key（可选）',
          description: '使用 Ollama 云端搜索时填写；与本地地址二选场景',
          default: '',
          component: 'InputPassword',
          layout: 'full'
        }
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
          allowPrivateNetwork: { type: 'boolean', label: '允许内网（慎用）', description: '开启后 browser/web_fetch 可访问私网地址', default: false, component: 'Switch' }
        }
      }
    }
  }
};

/** ai-workflow.tools 完整 schema.fields */
export const AI_WORKFLOW_TOOLS_FIELDS = {
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
      runEnabled: { type: 'boolean', label: '允许 run 命令', description: '默认关闭；开启后 loopback 也强制 API Key', default: false, component: 'Switch' },
      runTimeoutMs: { type: 'number', label: 'run 超时（ms）', min: 1000, default: 120000, component: 'InputNumber' },
      maxCommandOutputChars: { type: 'number', label: '命令输出最大字符', min: 1000, default: 200000, component: 'InputNumber' }
    }
  }
};
