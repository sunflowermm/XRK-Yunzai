import {
  formatBytes,
  formatTime,
  formatNumber,
  formatPercent,
  escapeHtml,
  escapeSelector,
  copyToClipboard as copyTextToClipboard,
  cloneValue,
  isSameValue
} from './modules/utils.js';

import {
  $,
  $$,
  scrollToBottom as domScrollToBottom,
  initLazyLoad,
  setUpdating,
  clearUpdating,
  bindViewportHeightVar
} from './modules/dom.js';

import {
  fileManager,
  compressImage
} from './modules/file-manager.js';

import {
  markdownRenderer
} from './modules/markdown.js';

import {
  pokeHandIconSVG,
  paperclipIconSVG,
  wrenchIconSVG,
  filePreviewIconSVG
} from './modules/ui-kit.js';

import { showToast as showToastUI } from './modules/ui/toast.js';
import { showPromptDialog as showPromptDialogUI } from './modules/ui/prompt-dialog.js';
import { renderHomePage } from './modules/pages/home.js';
import {
  renderWorkflowInfoPanel,
  loadPluginsInfoPanel
} from './modules/pages/home-plugins-workflow.js';
import {
  renderChatPage,
  switchChatMode,
  bindChatEvents,
  unbindChatEvents,
  applyMessageEnter,
  appendChatMessage
} from './modules/pages/chat.js';
import { renderConfigPage } from './modules/pages/config.js';

import {
  updateSystemStatus as updateSystemStatusPanel,
  updateCharts as updateChartsPanel
} from './modules/system-overview.js';

import {
  flattenObject,
  unflattenObject,
  getNestedValue,
  setNestedValue,
  combineConfigPath,
  normalizeFieldValue,
  castValue,
  normalizeTemplatePath,
  buildDefaultsFromFields,
  formatGroupLabel
} from './modules/config-manager.js';

import * as apiDebug from './modules/api-debug.js';
import { configPageMethods } from './modules/config-page.js';
import * as motion from './modules/motion/motion.js';
import { ensurePageLibs } from './modules/runtime-libs.js';
import {
  API,
  buildChatMessagesFromHistory,
  buildDeviceWsUrl,
  fetchApi,
  filterApiConfig,
  getApiKey,
  getHeaders as buildApiHeaders,
  parseAiModelsResponse,
  parseFileUploadUrls,
  setApiKey as persistApiKey
} from './modules/platform.js';

class App {
  constructor() {
    this.serverUrl = window.location.origin;
    this.currentPage = 'home';
    this.currentAPI = null;
    this.apiConfig = null;
    this.selectedFiles = [];
    // this._objectUrls 已迁移到 fileManager 模块
    this.jsonEditor = null;
    this._charts = {};
    this._metricsHistory = { 
      netRx: Array(30).fill(0), 
      netTx: Array(30).fill(0),
      _lastUpdate: null
    };
    this._eventChatHistory = this._loadChatHistory('event');
    /** Event 模式引用回复（回复=引用）：{ id, text }，发送后清空 */
    this._eventReplyTo = null;
    this._aiChatHistory = this._loadChatHistory('ai');
    this._isRestoringHistory = false;
    this._chatMessagesCache = { event: null, ai: null };
    this._chatStreamState = { running: false, source: null };
    this._deviceWs = null;
    this._wsConnecting = false;
    this._configState = null;
    this._schemaCache = {};
    this._llmOptions = { profiles: [], defaultProfile: '' };
    let chatMode = localStorage.getItem('chatMode') || 'event';
    if (chatMode === 'voice') {
      chatMode = 'event';
      localStorage.setItem('chatMode', 'event');
    }
    this._chatMode = chatMode;
    const savedWorkflows = localStorage.getItem('chatWorkflows');
    this._chatSettings = {
      workflows: savedWorkflows ? JSON.parse(savedWorkflows) : [],
      persona: localStorage.getItem('chatPersona') || '',
      provider: localStorage.getItem('chatProvider') || ''
    };
    this._webUserId = null;
    this._activeEventSource = null;
    this._systemThemeWatcher = null;
    this.theme = 'light';
    this._chatPendingTimer = null;
    this._chatQuickTimeout = null;
    this._heartbeatTimer = null;
    this._lastHeartbeatAt = 0;
    this._lastWsMessageAt = 0;
    this._offlineCheckTimer = null;
    this._processedMessageIds = new Set();
    this._latestSystem = null;
    this._homeDataCache = this._loadHomeDataCache();
    this._chartPluginsRegistered = false;
    this._chatEventHandlers = new Map();
    this._routeInitialized = false;
    this._suppressHashChange = false;
    /** API 页侧边栏：'api-list' | 'nav'（返回主菜单） */
    this._apiSidebarView = 'api-list';
    
    this.init();
  }

  async init() {
    initLazyLoad();
    this.bindEvents();
    bindViewportHeightVar();
    this.loadSettings();
    motion.initMotion();

    // API 配置需在路由到 api 页面前就绪；LLM/WS 仅在 chat 页按需加载
    await this.loadAPIConfig();

    const connectionPromise = this.checkConnection();
    this.handleRoute();
    await connectionPromise;

    window.addEventListener('hashchange', () => this.handleRoute());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.checkConnection();
        if (this._needsDeviceWs()) {
          this.ensureDeviceWs();
        }
      }
    });
    this._statusUpdateTimer = setInterval(() => {
      if (this.currentPage === 'home' && !document.hidden && !this._statusLoading) {
        this.loadSystemStatus().catch(() => {});
      }
    }, 60000);

    window.addEventListener('beforeunload', () => {
      if (this._statusUpdateTimer) {
        clearInterval(this._statusUpdateTimer);
      }
      this._unbindChatEvents();
      this._releaseDeviceWs();
      this._revokeAllObjectUrls();
      motion.disposeMotion();
    });
  }

  _renderMermaidIn(container) {
    markdownRenderer.renderMermaidIn(container);
  }

  /**
   * 从 DataTransfer 中提取文件（兼容不同浏览器/客户端：items 与 files）
   * @param {DataTransfer} dt
   * @returns {File[]}
   */
  _extractFilesFromDataTransfer(dt) {
    try {
      if (!dt) return [];
      const out = [];
      const items = Array.from(dt.items ?? []);
      if (items.length) {
        for (const it of items) {
          if (it && it.kind === 'file') {
            const f = it.getAsFile?.();
            if (f) out.push(f);
          }
        }
      }
      if (!out.length && dt.files && dt.files.length) {
        return Array.from(dt.files);
      }
      return out;
    } catch {
      try {
        return Array.from(dt?.files ?? []);
      } catch {
        return [];
      }
    }
  }

  // 文件管理方法 - 包装器（调用模块函数）
  _safeRevokeObjectURL(url) {
    fileManager.safeRevokeObjectURL(url);
  }

  _createTrackedObjectURL(file) {
    return fileManager.createTrackedObjectURL(file);
  }

  _revokeAllObjectUrls() {
    fileManager.revokeAllObjectUrls();
  }

  async loadAPIConfig() {
    try {
      const res = await fetch('api-config.json');
      const raw = await res.json();
      this.apiConfig = filterApiConfig(raw);
    } catch (e) {
      console.error('Failed to load API config:', e);
    }
  }

  async loadLlmOptions(force = false) {
    if (!force && this._llmOptionsLoading) {
      return this._llmOptionsLoadingPromise ?? Promise.resolve();
    }
    if (!force && (this._llmOptions?.profiles?.length || this._llmOptions?.workflows?.length)) {
      return Promise.resolve();
    }

    this._llmOptionsLoading = true;
    this._llmOptionsLoadingPromise = (async () => {
      try {
        const res = await fetchApi(this.serverUrl, API.aiModels);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        this._llmOptions = parseAiModelsResponse(data);
      } catch (e) {
        console.warn('未能加载 LLM 档位信息:', e.message || e);
      } finally {
        this._llmOptionsLoading = false;
        this._llmOptionsLoadingPromise = null;
      }
    })();

    return this._llmOptionsLoadingPromise;
  }

  /** 同步侧边栏主菜单 / API 列表显隐（API 页内「返回」与路由共用） */
  applySidebarShell(page = this.currentPage) {
    const navMenu = $('#navMenu');
    const apiListContainer = $('#apiListContainer');
    if (!navMenu || !apiListContainer) return;

    if (page === 'api' && this._apiSidebarView === 'nav') {
      navMenu.style.display = 'flex';
      apiListContainer.style.display = 'none';
      return;
    }

    if (page === 'api') {
      navMenu.style.display = 'none';
      apiListContainer.style.display = 'flex';
      return;
    }

    navMenu.style.display = 'flex';
    apiListContainer.style.display = 'none';
  }

  showApiMainNav() {
    if (this.currentPage !== 'api') return;
    this._apiSidebarView = 'nav';
    this.applySidebarShell('api');
  }

  showApiListNav() {
    if (this.currentPage !== 'api') return;
    this._apiSidebarView = 'api-list';
    this.applySidebarShell('api');
  }

  bindEvents() {
    const menuBtn = $('#menuBtn');
    const sidebarClose = $('#sidebarClose');
    const overlay = $('#overlay');
    const apiListBackBtn = $('#apiListBackBtn');
    const themeToggle = $('#themeToggle');
    const saveApiKeyBtn = $('#saveApiKeyBtn');
    const apiKeyForm = $('#apiKeyForm');
    const apiKeyToggleBtn = $('#apiKeyToggleBtn');
    const navContainer = $('#navMenu');

    menuBtn?.addEventListener('click', () => this.toggleSidebar());
    sidebarClose?.addEventListener('click', () => this.closeSidebar());
    overlay?.addEventListener('click', () => this.closeSidebar());

    apiListBackBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.showApiMainNav();
    });

    themeToggle?.addEventListener('click', () => this.toggleTheme());

    if (apiKeyForm) {
      apiKeyForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.saveApiKey();
      });
    }
    saveApiKeyBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      this.saveApiKey();
    });
    apiKeyToggleBtn?.addEventListener('click', () => this.toggleApiKeyBox());

    navContainer?.addEventListener('click', (e) => {
      const navItem = e.target.closest('.nav-item');
      if (navItem) {
        e.preventDefault();
        const page = navItem.dataset.page;
        if (page) void this.navigateTo(page);
      }
    });
    
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && this.currentAPI) {
        e.preventDefault();
        this.executeRequest();
      }
    });
  }
  
  toggleApiKeyBox() {
    $('#apiKeyBox').classList.toggle('show');
  }

  loadSettings() {
    const savedKey = getApiKey();
    if (savedKey) {
      $('#apiKey').value = savedKey;
    }
    
    const storedTheme = localStorage.getItem('theme');
    if (storedTheme === 'dark' || storedTheme === 'light') {
      this.applyTheme(storedTheme);
      this.disableSystemThemeSync();
    } else {
      this.applyTheme(this.detectSystemTheme());
      this.enableSystemThemeSync();
    }
  }

  detectSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  enableSystemThemeSync() {
    if (this._systemThemeWatcher) return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (event) => {
      if (!localStorage.getItem('theme')) {
        this.applyTheme(event.matches ? 'dark' : 'light');
      }
    };
      mql.addEventListener('change', handler);
    this._systemThemeWatcher = { mql, handler };
  }

  disableSystemThemeSync() {
    if (!this._systemThemeWatcher) return;
    const { mql, handler } = this._systemThemeWatcher;
    mql.removeEventListener('change', handler);
    this._systemThemeWatcher = null;
  }

  applyTheme(theme, { persist = false } = {}) {
    const nextTheme = theme === 'dark' ? 'dark' : 'light';
    this.theme = nextTheme;
    document.body.classList.toggle('dark', nextTheme === 'dark');
    document.documentElement?.setAttribute('data-theme', nextTheme);
    if (persist) {
      localStorage.setItem('theme', nextTheme);
      this.disableSystemThemeSync();
    }
  }

  toggleTheme() {
    const nextTheme = this.theme === 'dark' ? 'light' : 'dark';
    this.applyTheme(nextTheme, { persist: true });
    this.showToast(nextTheme === 'dark' ? '已切换到暗色主题' : '已切换到亮色主题', 'info');
  }

  toggleSidebar() {
    const sidebar = $('#sidebar');
    const open = !sidebar?.classList.contains('open');
    motion.setSidebarOpen(open);
  }

  openSidebar() {
    motion.setSidebarOpen(true);
  }

  closeSidebar() {
    motion.setSidebarOpen(false);
  }

  saveApiKey() {
    const key = $('#apiKey').value.trim();
    if (!key) {
      this.showToast('请输入 API Key', 'warning');
      return;
    }
    persistApiKey(key);
    this.showToast('API Key 已保存', 'success');
    this.checkConnection();
    if (this.currentPage === 'chat') {
      this.loadLlmOptions(true).catch(() => {});
      if (this._needsDeviceWs()) {
        this._releaseDeviceWs();
        this.ensureDeviceWs();
      }
    }
    if (window.location.hash === '#/config') this.renderConfig();
  }

  getHeaders() {
    return buildApiHeaders();
  }

  async checkConnection() {
    // 防止重复请求
    if (this._connectionChecking) return;
    this._connectionChecking = true;
    
    try {
      const res = await fetchApi(this.serverUrl, API.status, { timeout: 5000 });
      
      const status = $('#connectionStatus');
      if (!status) return;
      
      if (res && res.ok) {
        status.classList.add('online');
        const statusText = status.querySelector('.status-text');
        if (statusText) statusText.textContent = '已连接';
      } else {
        status.classList.remove('online');
        const statusText = status.querySelector('.status-text');
        if (statusText) statusText.textContent = res ? '未授权' : '连接失败';
      }
    } catch (error) {
      const status = $('#connectionStatus');
      if (!status) return;
      
      status.classList.remove('online');
      const statusText = status.querySelector('.status-text');
      if (statusText) {
        const isTimeout = error.name === 'AbortError' || error.name === 'TimeoutError';
        statusText.textContent = isTimeout ? '连接超时' : '连接失败';
      }
    } finally {
      this._connectionChecking = false;
    }
  }

  handleRoute() {
    if (this._suppressHashChange) {
      this._suppressHashChange = false;
      return;
    }
    const hash = location.hash.replace(/^#\/?/, '') || (localStorage.getItem('lastPage') || 'home');
    const page = hash.split('?')[0];
    void this.navigateTo(page);
  }

  async navigateTo(page) {
    const normalizedPage = page || 'home';
    if (this._routeInitialized && this.currentPage === normalizedPage) {
      if (normalizedPage === 'api') {
        this.showApiListNav();
      }
      return;
    }

    const prevPage = this.currentPage;

    if (prevPage === 'chat' && normalizedPage !== 'chat') {
      this._unbindChatEvents();
      this.stopActiveStream();
      this._releaseDeviceWs();
    }

    this.currentPage = normalizedPage;
    try {
      document.body.dataset.page = normalizedPage;
    } catch {}
    try {
      localStorage.setItem('lastPage', normalizedPage);
    } catch {}

    const navItems = $$('.nav-item');
    navItems.forEach(item => {
      const active = item.dataset.page === normalizedPage;
      item.classList.toggle('active', active);
      if (active) {
        item.setAttribute('aria-current', 'page');
      } else {
        item.removeAttribute('aria-current');
      }
    });

    const titles = { home: '系统概览', chat: 'AI 对话', config: '配置管理', api: 'API 调试' };
    const headerTitle = $('#headerTitle');
    if (headerTitle) {
      headerTitle.textContent = titles[normalizedPage] || normalizedPage;
    }

    const isMobile = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;

    if (normalizedPage === 'api') {
      this._apiSidebarView = 'api-list';
      this.applySidebarShell('api');
      this.renderAPIGroups();
      if (isMobile) {
        this.openSidebar();
      }
    } else {
      this.applySidebarShell(normalizedPage);
      if (isMobile) {
        this.closeSidebar();
      }
    }

    switch (normalizedPage) {
      case 'home':
        await ensurePageLibs('home');
        this.renderHome();
        break;
      case 'chat':
        await ensurePageLibs('chat');
        markdownRenderer.initMermaid();
        await this.renderChat();
        break;
      case 'config': this.renderConfig(); break;
      case 'api': this.renderAPI(); break;
      default:
        await ensurePageLibs('home');
        this.renderHome();
    }

    if (location.hash !== `#/${normalizedPage}`) {
      this._suppressHashChange = true;
      location.hash = `#/${normalizedPage}`;
    }

    this._routeInitialized = true;
  }

  async renderHome() {
    return renderHomePage(this);
  }
  
  /**
   * 应用首页数据（支持缓存数据平滑过渡）
   */
  _applyHomeData(data) {
    if (!data) return;
    
    // 更新系统状态（包括统计卡片和图表）- 缓存数据也要显示
    this.updateSystemStatus(data);
    
    // 更新各个面板（平滑过渡）
    this.renderBotsPanel(data.bots ?? []);
    renderWorkflowInfoPanel(this, data.workflows ?? {}, data.panels ?? {});
  }
  
  /**
   * 加载首页数据并更新（后台更新，平滑过渡）
   */
  async _loadHomeDataAndUpdate() {
    try {
      // 并行加载系统状态和插件信息
      await Promise.all([
        this.loadSystemStatus(),
        loadPluginsInfoPanel(this)
      ]);
    } catch (error) {
      console.warn('首页数据加载失败:', error);
    }
  }
  
  /**
   * 从 localStorage 加载首页数据缓存
   */
  _loadHomeDataCache() {
    try {
      const cached = localStorage.getItem('homeDataCache');
      if (!cached) return null;
      
        const data = JSON.parse(cached);
        const cacheTime = data._cacheTime || 0;
      const CACHE_TTL = 5 * 60 * 1000; // 5分钟
      
      if (Date.now() - cacheTime < CACHE_TTL) {
          return data;
      }
    } catch (e) {
      console.warn('[缓存] 加载失败:', e);
    }
    return null;
  }
  
  _saveHomeDataCache(data) {
    try {
      const cacheData = {
        ...data,
        _cacheTime: Date.now()
      };
      localStorage.setItem('homeDataCache', JSON.stringify(cacheData));
      this._homeDataCache = cacheData;
    } catch (e) {
      console.warn('[缓存] 保存失败:', e);
    }
  }

  /**
   * 加载系统状态（企业级统一方法）
   * 从后端获取系统概览数据，包括机器人、工作流、网络等信息
   */
  async loadSystemStatus() {
    // 防止重复请求
    if (this._statusLoading) {
      return this._statusLoadingPromise || Promise.resolve();
    }
    
    this._statusLoading = true;
    this._statusLoadingPromise = (async () => {
      try {
      const res = await fetchApi(this.serverUrl, API.systemOverview, {
        query: 'withHistory=1',
        timeout: 10000
      });
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      
      const data = await res.json();
      
      if (!data.success) {
        throw new Error(data.error || '获取系统状态失败');
      }
      
      this._latestSystem = data;
      this._saveHomeDataCache(data);
      this._applyHomeData(data);
      
    } catch (e) {
        if (e.name !== 'AbortError' && e.name !== 'TimeoutError') {
          console.warn('[系统状态] 加载失败:', e.message);
        }
        
        const cachedData = this._latestSystem || this._homeDataCache;
        if (cachedData) {
          this._applyHomeData(cachedData);
        }
      } finally {
        this._statusLoading = false;
        this._statusLoadingPromise = null;
    }
    })();
    
    return this._statusLoadingPromise;
  }
  
  renderBotsPanel(bots = []) {
    const botsInfo = document.getElementById('botsInfo');
    if (!botsInfo) return;
    
    // 添加更新标记，用于CSS过渡
    setUpdating(botsInfo);
    
    if (!Array.isArray(bots) || !bots.length) {
      botsInfo.innerHTML = '<div style="color:var(--text-muted);padding:16px">暂无机器人</div>';
      setTimeout(() => clearUpdating(botsInfo), 300);
      return;
    }
      
        botsInfo.innerHTML = `
          <div style="display:grid;gap:0">
        ${bots.map((bot, index) => `
          <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;${index < bots.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}transition:background var(--transition);cursor:pointer" onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background='transparent'">
            <div style="width:40px;height:40px;border-radius:16px;background:var(--bg-muted);display:flex;align-items:center;justify-content:center;font-weight:600;color:var(--primary)">
              ${(bot.nickname || '').slice(0,2) || (bot.uin || '').slice(-2) || '??'}
            </div>
                <div style="flex:1;min-width:0;text-align:left">
              <div style="font-weight:600;color:var(--text-primary);margin-bottom:4px;font-size:14px;text-align:left">${this.escapeHtml(bot.nickname ?? bot.uin)}</div>
                  <div style="font-size:12px;color:var(--text-muted);line-height:1.4;text-align:left">
                    ${bot.tasker || '未知 Tasker'}${bot.device ? '' : ` · ${(bot.stats && bot.stats.friends) || 0} 好友 · ${(bot.stats && bot.stats.groups) || 0} 群组`}
                  </div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
                  ${bot.avatar && !bot.device ? `
                    <img src="${bot.avatar}" 
                         alt="${bot.nickname}" 
                         style="width:44px;height:44px;border-radius:50%;object-fit:cover;border:2px solid var(--border);background:var(--bg-input);flex-shrink:0"
                         onerror="this.style.display='none'">
                  ` : ''}
                  <div style="width:10px;height:10px;border-radius:50%;background:${bot.online ? 'var(--success)' : 'var(--text-muted)'};flex-shrink:0;box-shadow:0 0 0 2px ${bot.online ? 'var(--success-light)' : 'transparent'}"></div>
                </div>
              </div>
            `).join('')}
          </div>
        `;
    
    clearUpdating(botsInfo);
  }

  renderMarkdown(text) {
    return markdownRenderer.render(text);
  }

  updateSystemStatus(data) {
    return updateSystemStatusPanel(this, data);
  }

  updateCharts(cpu, mem) {
    return updateChartsPanel(this, cpu, mem);
  }

  async renderChat() {
    return renderChatPage(this);
  }

  async _switchChatMode(mode) {
    return switchChatMode(this, mode);
  }


  /** 共用：将历史消息渲染到 chatMessages 容器，不处理缓存与滚动 */
  _renderHistoryIntoBox(box, history) {
    if (!box) return;
    if (!Array.isArray(history) || history.length === 0) {
      box.innerHTML = '';
      return;
    }
    box.style.overflow = 'hidden';
    box.innerHTML = '';
    this._isRestoringHistory = true;
    try {
      const sorted = [...history].sort((a, b) => (a.ts || 0) - (b.ts || 0));
      sorted.forEach(m => {
        try { this._renderHistoryMessage(m); } catch (e) {}
      });
    } finally {
      this._isRestoringHistory = false;
      box.style.overflow = '';
    }
  }

  async _renderAISettings() {
    await this.loadLlmOptions();
    const providers = (this._llmOptions?.profiles || []).map(p => ({
      value: p.key || p.provider || p.label || '',
      label: p.label || p.key || p.provider || ''
    })).filter(p => p.value);
    
    // 后端已仅返回“带 MCP 工具”的工作流，这里直接作为 MCP 工具工作流多选
    const allWorkflows = (this._llmOptions?.workflows || []).map(w => ({
      value: w.key || w.name || '',
      label: w.label || w.description || w.key || w.name || ''
    })).filter(w => w.value);
    
    const selectedWorkflows = Array.isArray(this._chatSettings.workflows) 
      ? this._chatSettings.workflows 
      : (this._chatSettings.workflow ? [this._chatSettings.workflow] : []);
    
    return `
      <div class="ai-settings-panel" id="aiSettingsPanel">
        <button type="button" class="ai-settings-mobile-toggle" id="aiSettingsMobileToggle" aria-expanded="false" aria-controls="aiSettingsContent">
          <span>AI 设置</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
        <div class="ai-settings-content" id="aiSettingsContent">
        <div class="ai-settings-section">
          <label class="ai-settings-label">运营商</label>
          <select id="aiProviderSelect" class="ai-settings-select">
            <option value="">默认</option>
            ${providers.map(p => `<option value="${p.value}" ${this._chatSettings.provider === p.value ? 'selected' : ''}>${p.label}</option>`).join('')}
          </select>
        </div>
        <div class="ai-settings-section">
          <label class="ai-settings-label">人设</label>
          <textarea id="aiPersonaInput" class="ai-settings-textarea" placeholder="自定义人设...">${this._chatSettings.persona || ''}</textarea>
        </div>
        <div class="ai-settings-section">
          <label class="ai-settings-label">MCP 工具工作流</label>
          <div class="ai-settings-checkboxes">
            ${allWorkflows.map(w => `
              <label class="ai-settings-checkbox">
                <input type="checkbox" id="workflow_${w.value}" value="${w.value}" ${selectedWorkflows.includes(w.value) ? 'checked' : ''}>
                <span>${w.label}</span>
              </label>
            `).join('')}
          </div>
        </div>
        <div class="ai-settings-section">
          <div class="ai-settings-row">
            <label class="ai-settings-label ai-settings-label-inline">远程 MCP 配置</label>
            <button id="remoteMCPConfigBtn" class="ai-settings-btn" title="管理远程MCP服务器配置（如必应搜索等）">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 20h9"/>
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
              </svg>
              <span>配置</span>
            </button>
          </div>
          <p class="ai-settings-desc">
            配置外部MCP服务器（如必应中文搜索），支持原生JSON格式
          </p>
        </div>
        </div>
      </div>
    `;
  }
  
  _unbindChatEvents() {
    return unbindChatEvents(this);
  }

  _bindChatEvents() {
    return bindChatEvents(this);
  }

  _bindDropArea(el, options = {}) {
    if (!el || typeof options.onFiles !== 'function') return;

    let dragDepth = 0;
    const setActive = (active) => {
      options.onDragStateChange?.(active);
    };

    const prevent = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };

    el.addEventListener('dragenter', (e) => {
      prevent(e);
      dragDepth++;
      setActive(true);
    });
    el.addEventListener('dragover', prevent);
    el.addEventListener('dragleave', (e) => {
      prevent(e);
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setActive(false);
    });
    el.addEventListener('drop', (e) => {
      prevent(e);
      dragDepth = 0;
      setActive(false);
      const dropped = this._extractFilesFromDataTransfer(e.dataTransfer);
      options.onFiles(dropped);
    });
  }

  _isAIMode() { return this._chatMode === 'ai'; }
  _isEventMode() { return this._chatMode === 'event'; }

  _getHistoryStorageKey(mode) {
    const m = mode ?? this._chatMode;
    return m === 'ai' ? 'aiChatHistory' : 'eventChatHistory';
  }

  _getCurrentChatHistory() {
    return this._getChatHistoryByMode(this._chatMode);
  }

  _getChatHistoryByMode(mode) {
    const prop = mode === 'ai' ? '_aiChatHistory' : '_eventChatHistory';
    if (!Array.isArray(this[prop])) {
      this[prop] = [];
    }
    return this[prop];
  }

  _loadChatHistory(mode) {
    try {
      const cached = localStorage.getItem(this._getHistoryStorageKey(mode));
      if (!cached) return [];
      const parsed = JSON.parse(cached);
      if (!Array.isArray(parsed)) {
        console.warn(`[${mode}聊天历史] 数据格式无效，已重置`);
        localStorage.removeItem(this._getHistoryStorageKey(mode));
        return [];
      }
      return parsed;
    } catch (e) {
      console.warn(`[${mode}聊天历史] 加载失败:`, e);
      return [];
    }
  }

  _saveChatHistory() {
    try {
      const MAX_HISTORY = 200;
      const history = this._getCurrentChatHistory();
      const historyToSave = Array.isArray(history) ? history.slice(-MAX_HISTORY) : [];
      localStorage.setItem(this._getHistoryStorageKey(), JSON.stringify(historyToSave));
      
      const box = document.getElementById('chatMessages');
      if (box) {
        this._chatMessagesCache[this._chatMode] = {
          scrollTop: box.scrollTop,
          scrollHeight: box.scrollHeight,
          html: box.innerHTML
        };
      }
    } catch (e) {
      console.warn('[聊天历史] 保存失败:', e);
    }
  }

  restoreChatHistory() {
    const box = document.getElementById('chatMessages');
    if (!box || this._isRestoringHistory) return;
    this._renderHistoryIntoBox(box, this._getCurrentChatHistory());
    requestAnimationFrame(() => this.scrollToBottom(false));
  }

  _applyMessageEnter(div, animate = true) {
    return applyMessageEnter(this, div, animate);
  }

  appendChat(role, text, options = {}) {
    return appendChatMessage(this, role, text, options);
  }
  
  _addMessageActions(msgElement, role, text, messageId) {
    if (!msgElement) return;
    
    // 检查是否已有操作按钮，避免重复添加
    if (msgElement.querySelector('.chat-message-actions')) return;
    
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'chat-message-actions';
    
    // 提取消息中的所有文本内容（包括markdown渲染后的文本）
    const extractText = (element) => {
      let text = '';
      const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );
      let node;
      while (node = walker.nextNode()) {
        text += node.textContent + ' ';
      }
      return text.trim();
    };
    
    const messageText = text || extractText(msgElement);
    
    // 所有消息都有复制按钮
    if (messageText) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'chat-action-btn chat-copy-btn';
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg><span>复制</span>';
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.copyToClipboard(messageText, '已复制到剪贴板', '复制失败，请检查浏览器权限');
      });
      actionsContainer.appendChild(copyBtn);
    }
    
    // 消息内包含图片时：保存图片（点开预览即可见，预览内可保存）
    const msgImages = msgElement.querySelectorAll('.chat-image-container .chat-image');
    if (msgImages.length > 0) {
      const saveImgBtn = document.createElement('button');
      saveImgBtn.className = 'chat-action-btn chat-save-image-btn';
      saveImgBtn.title = '查看并保存图片';
      saveImgBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>保存图片</span>';
      saveImgBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const src = msgImages[0].currentSrc || msgImages[0].src;
        if (src) this.showImagePreview(src);
      });
      actionsContainer.appendChild(saveImgBtn);
    }

    // Event 模式：引用按钮（回复=引用，与后端 getReply 协议一致）
    if (this._isEventMode() && messageText) {
      const quoteBtn = document.createElement('button');
      quoteBtn.className = 'chat-action-btn chat-quote-btn';
      quoteBtn.title = '引用回复';
      quoteBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10h10v8H3zM11 10h10v8H11z"/><path d="M7 6V4M17 6V4"/></svg><span>引用</span>';
      quoteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._eventReplyTo = { id: messageId, text: messageText };
        this._updateEventQuoteStrip();
        const input = document.getElementById('chatInput');
        if (input) { input.focus(); }
      });
      actionsContainer.appendChild(quoteBtn);
    }

    // 用户消息：撤回按钮
    if (role === 'user') {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'chat-action-btn chat-delete-btn';
      deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg><span>撤回</span>';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._deleteMessage(messageId);
      });
      actionsContainer.appendChild(deleteBtn);
    }

    // AI消息：删除按钮（Event模式不显示重新生成）
    if (role === 'assistant') {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'chat-action-btn chat-delete-btn';
      deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg><span>删除</span>';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._deleteMessage(messageId);
      });
      actionsContainer.appendChild(deleteBtn);
      
      // 只在AI模式显示重新生成按钮
      if (this._isAIMode()) {
        const regenBtn = document.createElement('button');
        regenBtn.className = 'chat-action-btn chat-regen-btn';
        regenBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 003.51 15M3.51 9a9 9 0 0016.98 6"/></svg><span>重新生成</span>';
        regenBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._regenerateMessage(messageId);
        });
        actionsContainer.appendChild(regenBtn);
      }
    }
    
    if (actionsContainer.children.length > 0) {
      msgElement.appendChild(actionsContainer);
    }
  }
  
  /** 每调用一次生成一张工具卡片，卡片外显工具名；多个工具则生成多张卡 */
  _addToolBlocks(msgElement, tools) {
    if (!msgElement || !Array.isArray(tools) || tools.length === 0) return;
    tools.forEach((tool) => {
      const name = tool.name || tool.function?.name || '工具';
      const args = tool.arguments ?? tool.function?.arguments ?? {};
      const result = tool.result ?? tool.content ?? '';
      const argsText = typeof args === 'string' ? args : (() => { try { return JSON.stringify(args, null, 2); } catch { return String(args); } })();
      let resultText = '';
      try {
        resultText = typeof result === 'string' ? (() => { try { return JSON.stringify(JSON.parse(result), null, 2); } catch { return result; } })() : JSON.stringify(result, null, 2);
      } catch {
        resultText = String(result);
      }
      const block = document.createElement('div');
      block.className = 'chat-tool-block';
      const header = document.createElement('div');
      header.className = 'chat-tool-block-header';
      header.innerHTML = `<span class="chat-tool-block-icon">${wrenchIconSVG()}</span><span class="chat-tool-block-title">${this.escapeHtml(name)}</span><span class="chat-tool-block-toggle">展开</span>`;
      const content = document.createElement('div');
      content.className = 'chat-tool-block-content';
      content.hidden = true;
      content.innerHTML = `
        <div class="chat-tool-block-item-body">
          <div class="chat-tool-block-item-section"><span class="chat-tool-block-label">参数</span><pre class="chat-tool-block-code">${this.escapeHtml(argsText)}</pre></div>
          <div class="chat-tool-block-item-section"><span class="chat-tool-block-label">结果</span><pre class="chat-tool-block-code">${this.escapeHtml(resultText)}</pre></div>
        </div>
      `;
      // 可键盘访问：让“展开/收起”对屏幕阅读器与键盘用户可用
      header.setAttribute('role', 'button');
      header.tabIndex = 0;
      header.setAttribute('aria-expanded', 'false');
      const toggle = () => {
        const open = content.hidden;
        content.hidden = !open;
        header.querySelector('.chat-tool-block-toggle').textContent = open ? '收起' : '展开';
        header.setAttribute('aria-expanded', String(open));
      };
      header.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle();
      });
      header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
      block.appendChild(header);
      block.appendChild(content);
      msgElement.appendChild(block);
    });
  }

  _addToolBlock(msgElement, tools) {
    this._addToolBlocks(msgElement, tools);
  }
  
  
  _deleteMessage(messageId) {
    const box = document.getElementById('chatMessages');
    if (!box) return;
    const allMessages = box.querySelectorAll(`[data-message-id="${messageId}"]`);
    if (allMessages.length === 0) return;

    const role = allMessages[0].dataset.role;
    if (role !== 'user' && role !== 'assistant') return;

    allMessages.forEach(msg => msg.remove());
    const history = this._getCurrentChatHistory();
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].id === messageId) {
        history.splice(i, 1);
        this._saveChatHistory();
        break;
      }
    }
    this.showToast(role === 'user' ? '消息已撤回' : '消息已删除', 'success');
  }
  
  _regenerateMessage(messageId) {
    const box = document.getElementById('chatMessages');
    if (!box) return;
    
    const msgElement = box.querySelector(`[data-message-id="${messageId}"]`);
    if (!msgElement) return;
    
    const role = msgElement.dataset.role;
    if (role !== 'assistant') {
      this.showToast('只能重新生成 AI 回复', 'warning');
      return;
    }
    
    const history = this._getCurrentChatHistory();
    const assistantIndex = history.findIndex(m => m.id === messageId);
    if (assistantIndex < 0) return;
    
    const userIndex = assistantIndex - 1;
    if (userIndex < 0 || history[userIndex].role !== 'user') {
      this.showToast('找不到对应的用户消息', 'warning');
      return;
    }
    
    msgElement.remove();
    history.splice(assistantIndex, 1);
    this._saveChatHistory();
    
    const userMessage = history[userIndex];
    const userText = userMessage.text || '';
    
    if (userText.trim()) {
      this.sendAIMessage(userText, []);
    }
    
    this.showToast('正在重新生成...', 'info');
  }

  /**
   * 渲染单条历史消息（供 restoreChatHistory 复用，避免重复分支）
   */
  _renderHistoryMessage(m) {
    if (m.type === 'chat-record' || (m.type === 'record' && m.messages)) {
      this.appendChatRecord(m.messages ?? [], m.title ?? '', m.description ?? '', false);
    } else if (m.segments && Array.isArray(m.segments)) {
      const hasToolsInSegments = m.segments.some(s => s && s.type === 'tools');
      const options = { messageId: m.id };
      if (!hasToolsInSegments && m.mcpTools?.length) {
        options.mcpTools = m.mcpTools;
      }
      this.appendSegments(m.segments, false, m.role || 'assistant', options);
    } else if (m.type === 'image' && m.url) {
      this.appendSegments([{ type: 'image', url: m.url }], false, m.role || 'assistant');
    } else if (m.role && m.text) {
      this.appendChat(m.role, m.text, { persist: false, mcpTools: m.mcpTools, messageId: m.id });
    }
  }

  /** 将缓存的文本段刷入一条 chat-text 并清空（去重 appendSegments 内重复逻辑） */
  _flushTextParts(div, textParts, useMarkdown = true) {
    if (!textParts || textParts.length === 0) return;
    const textDiv = document.createElement('div');
    textDiv.className = 'chat-text' + (useMarkdown ? ' chat-markdown' : '');
    textDiv.innerHTML = useMarkdown ? this.renderMarkdown(textParts.join('')) : this.escapeHtml(textParts.join(''));
    div.appendChild(textDiv);
    textParts.length = 0;
  }

  /**
   * 按顺序渲染 segments（文本、图片、引用/回复、戳一戳等，与 chat/device 协议一致）
   * @param {Array} segments - 消息段数组
   * @param {boolean} persist - 是否持久化到历史记录
   * @param {string} role - 'user' | 'assistant'
   * @param {{ mcpTools?: Array, messageId?: string }} options - 可选配置：
   *   - mcpTools：展示工具调用方块
   *   - messageId：显式指定消息 ID，便于与历史记录对齐（用于恢复历史、撤回/重新生成等场景）
   * @returns {HTMLElement|null} 创建的消息容器
   */
  appendSegments(segments, persist = true, role = 'assistant', options = {}) {
    if (!segments || segments.length === 0) return;

    const box = document.getElementById('chatMessages');
    if (!box) return;

    const { mcpTools = null, messageId: providedMessageId = null } = options;

    const div = document.createElement('div');
    const messageId = providedMessageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    div.id = messageId;
    const roleKey = role === 'user' ? 'user' : 'assistant';
    div.className = `chat-message ${roleKey}${this._isRestoringHistory ? '' : ' message-enter'}`;
    div.dataset.messageId = messageId;
    div.dataset.role = roleKey;

    const textParts = [];
    const allText = [];

    segments.forEach(seg => {
      if (typeof seg === 'string') {
        textParts.push(seg);
        allText.push(seg);
      } else if (seg.type === 'text') {
        const text = seg.text ?? '';
        if (text.trim()) {
          textParts.push(text);
          allText.push(text);
        }
      } else if (seg.type === 'image') {
        this._flushTextParts(div, textParts);
        const url = seg.url;
        if (url) {
          const imgContainer = document.createElement('div');
          imgContainer.className = 'chat-image-container';
          const img = document.createElement('img');
          img.src = url;
          img.alt = '图片';
          img.className = 'chat-image';
          img.loading = 'lazy';
          img.style.cursor = 'pointer';
          img.title = '点击查看大图';
          
          img.onload = () => img.classList.add('loaded');
          img.onerror = () => {
            img.classList.add('loaded');
            img.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iI2RkZCIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBmb250LWZhbWlseT0iQXJpYWwiIGZvbnQtc2l6ZT0iMTQiIGZpbGw9IiM5OTkiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGR5PSIuM2VtIj7lm77niYfliqDovb3lpLHotKU8L3RleHQ+PC9zdmc+';
            img.alt = '图片加载失败';
          };
          
          // 使用当前 src 打开预览，避免后续更新 src（如从 blob: 替换为服务器 URL）时预览仍指向旧地址
          img.addEventListener('click', () => this.showImagePreview(img.currentSrc || img.src));
          imgContainer.appendChild(img);
          div.appendChild(imgContainer);
        }
      } else if (seg.type === 'video') {
        this._flushTextParts(div, textParts);
        const url = seg.url;
        if (url) {
          const videoContainer = document.createElement('div');
          videoContainer.className = 'chat-video-container';
          const video = document.createElement('video');
          video.src = url;
          video.controls = true;
          video.className = 'chat-video';
          video.preload = 'metadata';
          video.title = seg.name || '视频';
          video.onloadedmetadata = () => {};
          video.onerror = () => {
            videoContainer.innerHTML = '<div class="chat-media-placeholder">视频加载失败</div>';
          };
          videoContainer.appendChild(video);
          div.appendChild(videoContainer);
        }
      } else if (seg.type === 'record') {
        this._flushTextParts(div, textParts);
        const url = seg.url || seg.file || seg.data?.file;
        if (url) {
          const audioContainer = document.createElement('div');
          audioContainer.className = 'chat-audio-container';
          const audio = document.createElement('audio');
          audio.src = url;
          audio.controls = true;
          audio.controlsList = 'nodownload';
          audio.className = 'chat-audio';
          audio.preload = 'metadata';
          audio.title = seg.name || '语音';
          audio.onerror = () => {
            audioContainer.innerHTML = `
              <div class="chat-media-placeholder small">
                <div>音频加载失败（可能由于跨域限制）</div>
                <a href="${url}" target="_blank" style="color: var(--primary); text-decoration: underline; margin-top: 4px; display: inline-block;">点击在新窗口打开</a>
              </div>
            `;
          };
          audioContainer.appendChild(audio);
          div.appendChild(audioContainer);
        }
      } else if (seg.type === 'at') {
        // @ 提及：显示为特殊样式，添加到文本中
        const qq = seg.qq ?? seg.user_id ?? '';
        const name = seg.name ?? '';
        const atText = name ? `@${name}` : (qq ? `@${qq}` : '@未知用户');
        const atHtml = `<span class="chat-at" data-qq="${this.escapeHtml(String(qq))}" data-name="${this.escapeHtml(name)}">${this.escapeHtml(atText)}</span>`;
        textParts.push(atHtml);
        allText.push(atText);
      } else if (seg.type === 'tools' && Array.isArray(seg.tools) && seg.tools.length > 0) {
        this._flushTextParts(div, textParts);
        const wrap = document.createElement('div');
        wrap.className = 'chat-segment chat-segment-tools';
        this._addToolBlocks(wrap, seg.tools);
        div.appendChild(wrap);
      } else if (seg.type === 'reply') {
        // 回复：显示为引用样式
        if (textParts.length > 0) {
          const textDiv = document.createElement('div');
          textDiv.className = 'chat-text chat-markdown';
          textDiv.innerHTML = this.renderMarkdown(textParts.join(''));
          div.appendChild(textDiv);
          textParts.length = 0;
        }
        
        const replyDiv = document.createElement('div');
        replyDiv.className = 'chat-reply';
        const replyText = seg.text || '引用消息';
        replyDiv.innerHTML = `<div class="chat-reply-content">${this.escapeHtml(replyText)}</div>`;
        div.appendChild(replyDiv);
      } else if (seg.type === 'file') {
        this._flushTextParts(div, textParts);
        const url = seg.url || seg.file;
        if (url) {
          const fileDiv = document.createElement('div');
          fileDiv.className = 'chat-file';
          const fileName = seg.name || '文件';
          fileDiv.innerHTML = `
            <a href="${url}" download="${fileName}" class="chat-file-link">
              <span class="chat-file-icon" aria-hidden="true">${paperclipIconSVG()}</span>
              <span class="chat-file-name">${this.escapeHtml(fileName)}</span>
            </a>
          `;
          div.appendChild(fileDiv);
        }
      } else if (seg.type === 'poke') {
        this._flushTextParts(div, textParts);
        const pokeWrap = document.createElement('div');
        pokeWrap.className = 'chat-poke';
        pokeWrap.innerHTML = `<span class="chat-poke-icon" aria-hidden="true">${pokeHandIconSVG()}</span><span class="chat-poke-text">戳了戳${seg.name ? ` ${this.escapeHtml(seg.name)}` : '你'}</span>`;
        div.appendChild(pokeWrap);
        allText.push('[戳一戳]');
      } else if (seg.type === 'markdown' || seg.type === 'raw') {
        this._flushTextParts(div, textParts);
        const contentRaw = seg.data ?? seg.markdown ?? seg.raw ?? '';
        const content = String(contentRaw);
        if (content.trim()) {
          const contentDiv = document.createElement('div');
          contentDiv.className = seg.type === 'markdown' ? 'chat-markdown' : 'chat-raw';
          contentDiv.innerHTML = seg.type === 'markdown' ? this.renderMarkdown(content) : this.escapeHtml(content);
          div.appendChild(contentDiv);
        }
      } else if (seg.type === 'button') {
        this._flushTextParts(div, textParts);
        const buttons = Array.isArray(seg.data) ? seg.data : (seg.data ? [seg.data] : []);
        if (buttons.length > 0) {
          const buttonContainer = document.createElement('div');
          buttonContainer.className = 'chat-buttons';
          buttons.forEach((btn, idx) => {
            const button = document.createElement('button');
            button.className = 'chat-button';
            button.textContent = btn.text ?? btn.label ?? `按钮${idx + 1}`;
            button.title = btn.tooltip ?? '';
            if (btn.action || btn.onClick) {
              button.addEventListener('click', () => {
                if (typeof btn.onClick === 'function') {
                  btn.onClick();
                } else if (btn.action) {
                  // 按钮动作处理
                  if (btn.action === 'copy' && btn.data) {
                    navigator.clipboard.writeText(btn.data).then(() => {
                      this.showToast('已复制到剪贴板', 'success');
                    }).catch(() => {});
                  }
                }
              });
            }
            buttonContainer.appendChild(button);
          });
          div.appendChild(buttonContainer);
        }
      } else if (seg.type && seg.type !== 'forward' && seg.type !== 'node') {
        this._flushTextParts(div, textParts);
        const customDiv = document.createElement('div');
        customDiv.className = `chat-custom chat-custom-${seg.type}`;
        if (seg.data) {
          if (typeof seg.data === 'string') {
            customDiv.textContent = seg.data;
          } else if (typeof seg.data === 'object') {
            customDiv.textContent = JSON.stringify(seg.data, null, 2);
          }
        } else {
          customDiv.textContent = `[${seg.type}]`;
        }
        div.appendChild(customDiv);
      }
    });

    this._flushTextParts(div, textParts);
    if (div.children.length === 0 && !(mcpTools && mcpTools.length > 0)) return;

    if (mcpTools && Array.isArray(mcpTools) && mcpTools.length > 0) {
      this._addToolBlock(div, mcpTools);
    }
    const fullText = allText.join('').trim();
    this._addMessageActions(div, role, fullText, messageId);

    box.appendChild(div);
    this._renderMermaidIn(div);

    if (!this._isRestoringHistory) this.scrollToBottom();
    this._applyMessageEnter(div, persist);

    if (persist) {
      const normalizedSegments = segments.map(s => {
        if (typeof s === 'string') return { type: 'text', text: s };
        return s;
      });
      const historyItem = {
        role: role === 'user' ? 'user' : 'assistant',
        segments: normalizedSegments,
        ts: Date.now(),
        id: messageId
      };
      if (mcpTools?.length) historyItem.mcpTools = mcpTools;
      this._getCurrentChatHistory().push(historyItem);
      this._saveChatHistory();
    }
    return div;
  }

  appendImageMessage(url, persist = true) {
    return this.appendSegments([{ type: 'image', url }], persist, 'assistant');
  }

  appendUserImageMessage(url, persist = true) {
    return this.appendSegments([{ type: 'image', url }], persist, 'user');
  }

  /** 下载图片：支持 data/blob/http(s)，跨域时 fetch 转 blob 再下载 */
  async _downloadImage(url) {
    if (!url) return;
    const name = `image-${Date.now()}.png`;
    try {
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        const a = document.createElement('a');
        a.download = name;
        a.href = url;
        a.click();
        this.showToast('图片已保存', 'success');
        return;
      }
      const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(res.statusText);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.download = name;
      a.href = href;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 2000);
      this.showToast('图片已保存', 'success');
    } catch (e) {
      this.showToast('保存失败：' + (e.message || '无法下载'), 'error');
    }
  }

  showImagePreview(url) {
    let modal = document.getElementById('imagePreviewModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'imagePreviewModal';
      modal.className = 'image-preview-modal';
      modal.innerHTML = `
        <div class="image-preview-overlay"></div>
        <div class="image-preview-container">
          <button class="image-preview-close" aria-label="关闭">&times;</button>
          <button class="image-preview-save" aria-label="保存">保存</button>
          <img class="image-preview-img" src="" alt="预览图片" />
        </div>
      `;
      document.body.appendChild(modal);
      const overlay = modal.querySelector('.image-preview-overlay');
      const closeBtn = modal.querySelector('.image-preview-close');
      const saveBtn = modal.querySelector('.image-preview-save');
      overlay.addEventListener('click', () => this.closeImagePreview());
      closeBtn.addEventListener('click', () => this.closeImagePreview());
      saveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const img = modal.querySelector('.image-preview-img');
        const src = img?.currentSrc || img?.src;
        if (src) this._downloadImage(src);
      });
      const onEsc = (e) => {
        if (e.key === 'Escape' && modal.style.display === 'flex') this.closeImagePreview();
      };
      document.addEventListener('keydown', onEsc);
    }
    const img = modal.querySelector('.image-preview-img');
    if (img) img.src = url;
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  closeImagePreview() {
    const modal = document.getElementById('imagePreviewModal');
    if (modal) {
      modal.style.display = 'none';
      document.body.style.overflow = '';
    }
  }

  appendChatRecord(messages, title = '', description = '', persist = true) {
    const box = document.getElementById('chatMessages');
    if (!box) return;

    const messagesArray = Array.isArray(messages) ? messages : [messages];
    if (messagesArray.length === 0) return;
    
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const recordId = `record_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const div = document.createElement('div');
    div.id = messageId;
    div.className = `chat-message assistant chat-record${this._isRestoringHistory ? '' : ' message-enter'}`;
    div.dataset.recordId = recordId;
    div.dataset.messageId = messageId;

    let content = '';
    // 统一显示header（即使没有title也显示，保持格式一致）
    if (title || description) {
      content += `<div class="chat-record-header">
        ${title ? `<div class="chat-record-title">${this.escapeHtml(title)}</div>` : ''}
        ${description ? `<div class="chat-record-description">${this.escapeHtml(description)}</div>` : ''}
      </div>`;
    }

    content += '<div class="chat-record-content">';
    messagesArray.forEach((msg) => {
      const text = typeof msg === 'string' ? msg : (msg.message || msg.content || String(msg));
      if (text && text.trim()) {
        content += `<div class="chat-record-item">${this.renderMarkdown(text)}</div>`;
      }
    });
    content += '</div>';

    div.innerHTML = content;
    box.appendChild(div);
    // 记录卡片里也可能包含 Mermaid 图表，这里统一触发一次局部渲染
    this._renderMermaidIn(div);
    
    if (!this._isRestoringHistory) {
    this.scrollToBottom();
    }

    this._applyMessageEnter(div, persist);

    // 保存到聊天历史（仅在需要持久化时）
    if (persist) {
      const recordData = {
        role: 'assistant',
        type: 'record',
        title: title ?? '',
        description: description ?? '',
        messages: messagesArray,
        ts: Date.now(),
        recordId
      };
      this._getCurrentChatHistory().push(recordData);
      this._saveChatHistory();
    }
    
    return div;
  }

  /**
   * 格式化字节数
   * @param {number} bytes - 字节数
   * @returns {string} 格式化后的字符串
   */
  // 格式化方法 - 包装器（调用模块函数）
  formatBytes(bytes) {
    return formatBytes(bytes);
  }

  formatTime(seconds) {
    return formatTime(seconds);
  }

  formatNumber(num) {
    return formatNumber(num);
  }

  formatPercent(value, total) {
    return formatPercent(value, total);
  }

  clearChat() {
    this._revokeAllObjectUrls();
    this.clearChatStreamState();
    this._clearEventReplyState();
    const history = this._getCurrentChatHistory();
    history.length = 0;
    this._saveChatHistory();
    const box = document.getElementById('chatMessages');
    if (box) box.innerHTML = '';
    this._chatMessagesCache[this._chatMode] = null;
  }

  /**
   * 处理文件选择（AI模式仅图片，Event模式支持所有媒体）
   */
  handleImageSelect(files) {
    if (!files || files.length === 0) return;
    
    const previewContainer = document.getElementById('chatImagePreview');
    if (!previewContainer) return;
    
    const isAIMode = this._isAIMode();
    this._selectedImages = this._selectedImages ?? [];
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      
      // AI模式仅支持图片
      if (isAIMode && !file.type.startsWith('image/')) {
        this.showToast('只能上传图片文件', 'warning');
        continue;
      }
      
      // 检查文件大小（限制为 100MB）
      const maxSize = isAIMode ? 10 * 1024 * 1024 : 100 * 1024 * 1024;
      if (file.size > maxSize) {
        this.showToast(`文件 ${file.name} 超过 ${isAIMode ? '10' : '100'}MB 限制`, 'warning');
        continue;
      }

      // 预览使用 objectURL
      const previewUrl = isAIMode && file.type.startsWith('image/') 
        ? this._createTrackedObjectURL(file)
        : null;
      this._selectedImages.push({
        file,
        previewUrl,
        id: `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      });
      this.updateImagePreview();
    }
    
    const imageInput = document.getElementById('chatImageInput');
    if (imageInput) imageInput.value = '';
  }

  /**
   * 压缩/缩放图片（减少上传体积与多模态 token 消耗，提高响应速度）
   * @returns {Promise<File>}
   */
  // 图片压缩 - 包装器（调用模块函数）
  async compressImageFile(file) {
    return await compressImage(file, {
      maxDimension: 1280,
      quality: 0.82,
      softLimit: 900 * 1024,
      outputType: 'image/jpeg'
    });
  }
  
  /**
   * 更新文件预览（AI模式显示图片，Event模式显示所有文件）
   */
  updateImagePreview() {
    const previewContainer = document.getElementById('chatImagePreview');
    if (!previewContainer) return;
    
    if (!this._selectedImages || this._selectedImages.length === 0) {
      previewContainer.style.display = 'none';
      previewContainer.innerHTML = '';
      return;
    }
    
    const isAIMode = this._isAIMode();
    previewContainer.style.display = 'flex';
    previewContainer.innerHTML = this._selectedImages.map((item) => {
      const isImage = item.file.type.startsWith('image/');
      if (isImage && item.previewUrl) {
        return `
        <div class="chat-image-preview-item" data-file-id="${item.id}">
          <img src="${item.previewUrl}" alt="预览">
          <button class="chat-image-preview-remove" data-file-id="${item.id}" title="移除">×</button>
        </div>
        `;
      } else {
        const fileIcon = filePreviewIconSVG(item.file.type);
        const fileSize = (item.file.size / 1024 / 1024).toFixed(2);
        return `
        <div class="chat-image-preview-item" data-file-id="${item.id}">
          <div class="chat-file-preview">
            <div class="chat-file-preview-icon">${fileIcon}</div>
            <div class="chat-file-preview-info">
              <div class="chat-file-preview-name">${this.escapeHtml(item.file.name)}</div>
              <div class="chat-file-preview-size">${fileSize} MB</div>
            </div>
          </div>
          <button class="chat-image-preview-remove" data-file-id="${item.id}" title="移除">×</button>
        </div>
        `;
      }
    }).join('');
    
    previewContainer.querySelectorAll('.chat-image-preview-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const fileId = btn.dataset.fileId;
        this.removeImagePreview(fileId);
      });
    });
  }
  
  /**
   * 移除文件预览
   */
  removeImagePreview(fileId) {
    if (!this._selectedImages) return;
    const item = this._selectedImages.find(img => img.id === fileId);
    if (item?.previewUrl) {
      this._safeRevokeObjectURL(item.previewUrl);
    }
    this._selectedImages = this._selectedImages.filter(img => img.id !== fileId);
    this.updateImagePreview();
  }
  
  /**
   * 清空图片预览
   */
  clearImagePreview(options = {}) {
    const keepUrls = options?.keepUrls instanceof Set
      ? options.keepUrls
      : (Array.isArray(options?.keepUrls) ? new Set(options.keepUrls) : null);
    // 释放所有 objectURL
    (this._selectedImages ?? []).forEach(img => {
      if (img?.previewUrl) {
        if (keepUrls && keepUrls.has(img.previewUrl)) return;
        this._safeRevokeObjectURL(img.previewUrl);
      }
    });
    this._selectedImages = [];
    this.updateImagePreview();
  }

  async sendChatMessage() {
    const input = document.getElementById('chatInput');
    const text = input?.value?.trim() ?? '';
    const images = this._selectedImages ?? [];
    
    if (!text && images.length === 0) return;
    
    input.value = '';
    
    try {
      if (this._isAIMode()) {
        await this.sendAIMessage(text, images);
      } else {
        await this.sendEventMessage(text, images);
      }
    } catch (e) {
      this.showToast(`发送失败: ${e.message}`, 'error');
    }
  }

  async sendEventMessage(text, images) {
    if (text && images.length === 0) {
        const replyTo = this._eventReplyTo;
        this._clearEventReplyState();
        if (replyTo) {
          const segments = [
            { type: 'reply', id: replyTo.id, text: replyTo.text },
            { type: 'text', text }
          ];
          this.appendSegments(segments, true, 'user');
          this.sendDeviceMessage(text, { source: 'manual', message: segments, skipAppend: true });
        } else {
          this.appendChat('user', text);
          this.sendDeviceMessage(text, { source: 'manual', skipAppend: true });
        }
        this.scrollToBottom();
        return;
      }

      if (images.length > 0) {
        const keepPreviewUrls = new Set();
        const pendingFileNodes = [];
        
        for (const item of images) {
          const file = item.file;
          const fileType = file.type;
          let segmentType = 'file';
          let displayUrl = null;
          
          if (fileType.startsWith('image/')) {
            segmentType = 'image';
            displayUrl = this._createTrackedObjectURL(file) || item.previewUrl;
            if (displayUrl) keepPreviewUrls.add(displayUrl);
          } else if (fileType.startsWith('video/')) {
            segmentType = 'video';
            displayUrl = this._createTrackedObjectURL(file) || item.previewUrl;
            if (displayUrl) keepPreviewUrls.add(displayUrl);
          } else if (fileType.startsWith('audio/')) {
            segmentType = 'record';
            displayUrl = this._createTrackedObjectURL(file) || item.previewUrl;
            if (displayUrl) keepPreviewUrls.add(displayUrl);
          }
          
          const segment = displayUrl ? { type: segmentType, url: displayUrl, name: file.name } : { type: 'file', url: null, name: file.name };
          const node = this.appendSegments([segment], false, 'user');
          pendingFileNodes.push({ node, file, displayUrl, segmentType });
        }
        
        this.clearImagePreview({ keepUrls: keepPreviewUrls });
        
        const uploadedUrls = await this.sendChatMessageWithImages(text, images);

        if (Array.isArray(uploadedUrls) && uploadedUrls.length > 0) {
          for (let i = 0; i < pendingFileNodes.length; i++) {
            const u = uploadedUrls[i];
            if (!u) continue;
            const item = pendingFileNodes[i];
            const file = item.file;
            
            try {
              if (item.segmentType === 'image') {
                const imgEl = item.node?.querySelector('img.chat-image, img');
                if (imgEl) imgEl.src = u;
              } else if (item.segmentType === 'video') {
                const videoEl = item.node?.querySelector('video.chat-video, video');
                if (videoEl) videoEl.src = u;
              } else if (item.segmentType === 'record') {
                const audioEl = item.node?.querySelector('audio.chat-audio, audio');
                if (audioEl) audioEl.src = u;
              }
            } catch {}
            
            if (item.displayUrl && String(item.displayUrl).startsWith('blob:')) {
              this._safeRevokeObjectURL(item.displayUrl);
            }
            
            const segmentType = file.type.startsWith('image/') ? 'image' :
                              file.type.startsWith('video/') ? 'video' :
                              file.type.startsWith('audio/') ? 'record' : 'file';
            this._getCurrentChatHistory().push({ 
              role: 'user', 
              segments: [{ type: segmentType, url: u, name: file.name }], 
              ts: Date.now() + i 
            });
          }
          this._saveChatHistory();
        }
      }
    this.scrollToBottom();
  }
  
  /**
   * 按顺序渲染：支持 segments（文本与工具穿插）或 (fullText, mcpTools) 兼容旧用法。工具卡片出现在对应调用位置。
   */
  _updateStreamingMarkdown(assistantMsg, segmentsOrFullText, mcpToolsOptional) {
    const segments = Array.isArray(segmentsOrFullText) && segmentsOrFullText.length > 0 && segmentsOrFullText[0]?.type
      ? segmentsOrFullText
      : [{ type: 'text', text: segmentsOrFullText || '' }, ...(mcpToolsOptional?.length ? [{ type: 'tools', tools: mcpToolsOptional }] : [])];
    assistantMsg.innerHTML = '';
    segments.forEach((seg) => {
      if (seg.type === 'text') {
        if (seg.text.trim()) {
          const wrap = document.createElement('div');
          wrap.className = 'chat-segment chat-segment-text';
          const content = document.createElement('div');
          content.className = 'chat-content chat-markdown';
          content.innerHTML = this.renderMarkdown(seg.text);
          wrap.appendChild(content);
          assistantMsg.appendChild(wrap);
        }
      } else if (seg.type === 'tools' && seg.tools?.length) {
        const wrap = document.createElement('div');
        wrap.className = 'chat-segment chat-segment-tools';
        this._addToolBlocks(wrap, seg.tools);
        assistantMsg.appendChild(wrap);
      }
    });
    this.scrollToBottom(true);
  }

  /**
   * 解析 v3 SSE 流，产出 segments 以在调用位置穿插展示工具卡片。onDelta(delta, state) 中 state.segments 与 state.currentText 反映当前顺序。
   * @returns {Promise<{ fullText: string, mcpTools: Array, segments: Array, error: Error|null }>}
   */
  async _parseV3Stream(response, callbacks = {}) {
    const state = { fullText: '', currentText: '', segments: [], mcpTools: [], error: null };
    const { onDelta, onError } = callbacks;
    if (!response.ok || !response.body) {
      state.error = new Error(`HTTP ${response.status}: ${await response.text().catch(() => '')}`);
      if (onError) onError(state.error);
      return state;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            state.segments.push({ type: 'text', text: state.currentText });
            return state;
          }
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          if (json.error) {
            state.error = new Error(json.error.message || 'AI 请求失败');
            if (onError) onError(state.error);
            return state;
          }
          if (json.mcp_tools && Array.isArray(json.mcp_tools) && json.mcp_tools.length > 0) {
            // 基本防御：忽略完全空对象的占位 mcp_tools
            const tools = json.mcp_tools.filter((tool) => {
              if (!tool) return false;
              if (tool.name) return true;
              if (tool.function?.name) return true;
              if (tool.result || tool.content) return true;
              return false;
            });
            if (tools.length > 0) {
              state.segments.push({ type: 'text', text: state.currentText });
              state.currentText = '';
              state.segments.push({ type: 'tools', tools });
              state.mcpTools = state.mcpTools.concat(tools);
              if (onDelta) onDelta('', state);
            }
          }
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) {
            state.fullText += delta;
            state.currentText += delta;
            if (onDelta) onDelta(delta, state);
          }
        }
      }
      state.segments.push({ type: 'text', text: state.currentText });
    } finally {
      reader.releaseLock?.();
    }
    return state;
  }

  /**
   * 创建流式消息元素
   * @param {string} additionalClass - 额外的 CSS 类
   * @returns {HTMLElement} 消息元素
   */
  _createStreamingMessage(additionalClass = '') {
    const box = document.getElementById('chatMessages');
    const assistantMsg = document.createElement('div');
    assistantMsg.className = `chat-message assistant streaming ${additionalClass} message-enter`.trim();
    assistantMsg.dataset.messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    assistantMsg.dataset.role = 'assistant';
    box.appendChild(assistantMsg);
    this._applyMessageEnter(assistantMsg, false);
    return assistantMsg;
  }

  /**
   * 发送带图片的消息到后端
   */
  async sendAIMessage(text, images) {
    try {
      // 立即清空图片预览
      if (images.length > 0) {
        this.clearImagePreview();
      }
      
      // 为本次消息创建统一的 messageId，确保文字和图片可以一起撤回
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      if (text) {
        this.appendChat('user', text, { messageId });
      }

      // AI 模式下：图片既要用于识图，也要在聊天记录中显示
      if (images.length > 0) {
        try {
          const urls = await this._uploadImagesCore(images);
          if (Array.isArray(urls) && urls.length > 0) {
            // 为每张图片创建消息，使用相同的 messageId
            urls.forEach((u) => {
              const imgMsg = this.appendSegments([{ type: 'image', url: u }], false, 'user');
              if (imgMsg) {
                imgMsg.dataset.messageId = messageId;
                imgMsg.dataset.role = 'user';
              }
            });
            // 保存到历史记录，使用统一的 messageId
            const history = this._getCurrentChatHistory();
            history.push({
              role: 'user',
              segments: urls.map(u => ({ type: 'image', url: u })),
              ts: Date.now(),
              id: messageId
            });
            this._saveChatHistory();
          }
        } catch (e) {
          // 上传失败不影响后续识图（仍然走 base64），只提示一次
          this.showToast(`图片上传失败: ${e.message}`, 'warning');
        }
      }

      const messages = buildChatMessagesFromHistory(this._getCurrentChatHistory());

      if (images.length > 0) {
        const imageParts = [];
        for (const img of images) {
          const compressed = await this.compressImageFile(img.file);
          const base64 = await this.fileToBase64(compressed);
          imageParts.push({
            type: 'image_url',
            image_url: { url: base64 }
          });
        }
        let lastMsg = messages.length ? messages[messages.length - 1] : null;
        if (!lastMsg || lastMsg.role !== 'user') {
          lastMsg = { role: 'user', content: text || '' };
          messages.push(lastMsg);
        }
        if (typeof lastMsg.content === 'string') {
          lastMsg.content = [
            { type: 'text', text: lastMsg.content },
            ...imageParts
          ];
        } else if (Array.isArray(lastMsg.content)) {
          lastMsg.content.push(...imageParts);
        }
      }

      const provider = this._chatSettings.provider || this._llmOptions?.defaultProfile || '';
      const persona = this._chatSettings.persona || '';

      // 构造消息列表：历史 + 本次用户输入（可选人设）
      let finalMessages = persona
        ? [{ role: 'system', content: persona }, ...messages]
        : [...messages];

      // 如果本轮请求涉及 Mermaid/画图，额外补充一条系统提示，规范图表生成规则
      const mermaidHintNeeded = /```mermaid|mermaid|gantt|flowchart|graph TD|sequenceDiagram|classDiagram/i.test(text || '');
      if (mermaidHintNeeded) {
        const mermaidRules = [
          '你生成 Markdown + Mermaid 图表时必须严格遵守：',
          '1. 每一张图使用单独的 ```mermaid 代码块，不要在一个代码块里混合多张图（例如 gantt 和 graph）。',
          '2. gantt 图必须写在以 “gantt” 开头的代码块中，并包含：',
          '   - 一行 dateFormat YYYY-MM-DD（紧跟在 gantt 后的几行内，不要乱顺序）。',
          '   - 每个任务一行，ID 必须是英文或数字（如 a1、dev1），不能用中文或带空格；引用前置任务用 after ID。',
          '3. 避免在 Mermaid 代码块外部继续追加同一张图的语法；如果要画第二张图，请新开一个 ```mermaid 代码块。',
          '4. 如果只是解释图表含义，请把说明文字写在代码块外面。'
        ].join('\n');
        finalMessages.unshift({ role: 'system', content: mermaidRules });
      }

      // 如果用户选择了provider，使用用户选择的；否则不传model，让后端使用aistream.yaml配置的默认Provider
      const requestBody = {
        messages: finalMessages,
        stream: true
      };
      
      // 只有用户明确选择了provider时才传model参数
      if (provider) {
        requestBody.model = provider;
      }

      // AI 模式下，工作流只用于限定 MCP 工具作用域：
      // - 这里的 workflows 实际表示“启用 MCP 工具的工作流列表”
      // - API 端不再区分主/次工作流，仅按 streams 白名单注入 tools
      const workflows = Array.isArray(this._chatSettings.workflows)
        ? this._chatSettings.workflows.filter(Boolean)
        : [];

      if (workflows.length > 0) {
        requestBody.workflow = {
          workflows
        };
      }

      this._chatStreamState = { running: true, source: 'ai' };
      this.updateChatStatus('AI 生成中...');
      this.setChatInteractionState(true);


      const response = await fetchApi(this.serverUrl, API.chatCompletions, {
        method: 'POST',
        body: requestBody
      });

      let assistantMsg = null;
      const state = await this._parseV3Stream(response, {
        onDelta: (_d, s) => {
          if (!assistantMsg) assistantMsg = this._createStreamingMessage();
          this._updateStreamingMarkdown(assistantMsg, [...(s.segments || []), { type: 'text', text: s.currentText ?? s.fullText ?? '' }]);
        },
        onError: (err) => this.showToast(`AI 请求失败: ${err.message}`, 'error')
      });

      const { fullText, mcpTools, segments, error: streamError } = state;
      if (assistantMsg) assistantMsg.classList.remove('streaming');
      this.clearChatStreamState();
      this.clearImagePreview();
      if (!streamError && assistantMsg) {
        this._updateStreamingMarkdown(assistantMsg, (segments && segments.length) ? segments : fullText, (segments && segments.length) ? undefined : mcpTools);
        this._addMessageActions(assistantMsg, 'assistant', fullText, assistantMsg.dataset.messageId);
        const historyItem = { role: 'assistant', text: fullText, ts: Date.now(), id: assistantMsg.dataset.messageId };
        if (segments && segments.length > 0) historyItem.segments = segments;
        else if (mcpTools?.length) historyItem.mcpTools = mcpTools;
        this._getCurrentChatHistory().push(historyItem);
        this._saveChatHistory();
        this._renderMermaidIn(assistantMsg);
      }
    } catch (error) {
      this.showToast(`AI 请求失败: ${error.message}`, 'error');
      this.clearChatStreamState();
    }
  }


  async fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async _uploadImagesCore(files) {
    if (!files || files.length === 0) return [];
    const isAIMode = this._isAIMode();
    const uploadFd = new FormData();
    for (const item of files) {
      const file = item.file;
      const fileToUpload = isAIMode && file.type.startsWith('image/')
        ? await this.compressImageFile(file)
        : file;
      uploadFd.append('file', fileToUpload);
    }

    const uploadResp = await fetchApi(this.serverUrl, API.fileUpload, {
      method: 'POST',
      upload: true,
      body: uploadFd
    });

    if (!uploadResp.ok) {
      const raw = await uploadResp.text().catch(() => '');
      let msg = uploadResp.statusText || (isAIMode ? '图片上传失败' : '文件上传失败');
      try {
        const j = raw ? JSON.parse(raw) : null;
        msg = j?.message || j?.error || msg;
      } catch {}
      throw new Error(msg);
    }

    const uploadData = await uploadResp.json().catch(() => null);
    const urls = parseFileUploadUrls(uploadData);

    if (urls.length === 0) {
      throw new Error(isAIMode ? '图片上传成功但未返回可用的 file_url' : '文件上传成功但未返回可用的 file_url');
    }

    return urls;
  }

  async sendChatMessageWithImages(text, files) {
    if (files.length === 0) {
      this.sendDeviceMessage(text, { source: 'manual' });
      return [];
    }

    const urls = await this._uploadImagesCore(files);

    const segments = [];
    if (this._eventReplyTo && this._isEventMode()) {
      segments.push({ type: 'reply', id: this._eventReplyTo.id, text: this._eventReplyTo.text });
      this._clearEventReplyState();
    }
    if ((text ?? '').trim()) {
      segments.push({ type: 'text', text: (text ?? '').trim() });
    }
    // 根据文件类型创建对应的segment
    urls.forEach((u, index) => {
      const file = files[index]?.file;
      if (!file) return;
      
      const fileType = file.type;
      let segmentType = 'file';
      if (fileType.startsWith('image/')) {
        segmentType = 'image';
      } else if (fileType.startsWith('video/')) {
        segmentType = 'video';
      } else if (fileType.startsWith('audio/')) {
        segmentType = 'record';
      }
      
      segments.push({ 
        type: segmentType, 
        url: u, 
        name: file.name,
        data: { url: u, file: u } 
      });
    });

    this.sendDeviceMessage(text || ' ', { source: 'manual', message: segments, skipAppend: true });
    return urls;
  }
  
  scrollToBottom(smooth = false) {
    const box = document.getElementById('chatMessages');
    if (!box) return;
    domScrollToBottom(box, smooth);
  }

  /**
   * 初始化聊天控件
   */
  initChatControls() {
    this.updateChatStatus();
    this.setChatInteractionState(this._chatStreamState.running);
  }

  /**
   * 获取当前人设
   * @returns {string} 人设文本
   */
  getCurrentPersona() {
    return this._chatSettings.persona?.trim() ?? '';
  }

  /**
   * 更新聊天状态显示
   * @param {string} message - 状态消息
   */
  updateChatStatus(message) {
    const statusEl = document.getElementById('chatStreamStatus');
    if (!statusEl) return;
    
    const isRunning = this._chatStreamState.running;
    statusEl.textContent = isRunning
      ? (message || '文本生成中...')
      : '空闲';
    statusEl.classList.toggle('active', isRunning);
  }
  
  _updateEventQuoteStrip() {
    const strip = document.getElementById('eventQuoteStrip');
    if (!strip) return;
    const textEl = strip.querySelector('.event-quote-text');
    if (this._eventReplyTo?.text) {
      strip.style.display = 'flex';
      if (textEl) textEl.textContent = this._eventReplyTo.text.length > 80 ? this._eventReplyTo.text.slice(0, 80) + '…' : this._eventReplyTo.text;
    } else {
      strip.style.display = 'none';
      if (textEl) textEl.textContent = '';
    }
  }

  /** Event 专用：清空引用回复状态，避免与其他 mode 互串；非 Event 下 strip 不存在会 no-op */
  _clearEventReplyState() {
    this._eventReplyTo = null;
    this._updateEventQuoteStrip();
  }

  /**
   * 设置聊天交互状态（禁用/启用输入）
   * @param {boolean} streaming - 是否正在流式输出
   */
  setChatInteractionState(streaming) {
    const input = document.getElementById('chatInput');
    const sendBtn = document.getElementById('chatSendBtn');
    
    if (input) {
      input.disabled = streaming;
      input.placeholder = streaming
        ? (this._isAIMode() ? 'AI 正在处理...' : '正在处理...')
        : '输入消息...';
    }
    if (sendBtn) {
      sendBtn.disabled = streaming;
    }
  }
  
  /**
   * 清除聊天流状态
   */
  clearChatStreamState() {
    this._chatStreamState = { running: false, source: null };
    this.updateChatStatus();
    this.setChatInteractionState(false);
    this.clearChatPendingTimer();
  }
  
  /**
   * 清除聊天待处理定时器
   */
  clearChatPendingTimer() {
    if (this._chatPendingTimer) {
      clearTimeout(this._chatPendingTimer);
      this._chatPendingTimer = null;
    }
    if (this._chatQuickTimeout) {
      clearTimeout(this._chatQuickTimeout);
      this._chatQuickTimeout = null;
    }
  }
  
  stopActiveStream() {
    if (this._activeEventSource) {
      try {
        this._activeEventSource.close();
      } catch {}
      this._activeEventSource = null;
    }
    this.clearChatStreamState();
  }
  
  cancelAIStream() {
    if (!this._chatStreamState.running) return;
    this.stopActiveStream();
    const streamingMsg = document.querySelector('.chat-message.assistant.streaming');
    if (streamingMsg) {
      streamingMsg.remove();
    }
    this.showToast('已中断 AI 输出', 'info');
  }

  // ========== 配置管理 ==========
  renderConfig() {
    return renderConfigPage(this);
  }


  mapTypeToComponent(type) {
    switch ((type ?? '').toLowerCase()) {
      case 'boolean': return 'Switch';
      case 'number': return 'InputNumber';
      case 'object':
      case 'map': return 'SubForm';
      default: return 'Input';
    }
  }

  formatGroupLabel(label) {
    return formatGroupLabel(label);
  }

  normalizeFieldValue(value, meta, typeHint) {
    return normalizeFieldValue(value, meta, typeHint);
  }

  castValue(value, type) {
    return castValue(value, type);
  }

  getFlatFieldDefinition(path) {
    if (!this._configState?.flatSchema) return null;
    const exact = this._configState.flatSchema.find(field => field.path === path);
    if (exact) return exact;
    const normalized = this.normalizeTemplatePath(path);
    return this._configState.flatSchema.find(field => this.normalizeTemplatePath(field.path) === normalized);
  }


  normalizeTemplatePath(path = '') {
    return normalizeTemplatePath(path);
  }

  buildDefaultsFromFields(fields = {}) {
    return buildDefaultsFromFields(fields, this._cloneValue.bind(this));
  }

  // 配置管理方法 - 包装器（调用模块函数）
  getNestedValue(obj = {}, path = '') {
    return getNestedValue(obj, path);
  }

  setNestedValue(source = {}, path = '', value) {
    return setNestedValue(source, path, value);
  }

  combinePath(base, tail) {
    return combineConfigPath(base, tail);
  }

  flattenObject(obj, prefix = '', out = {}) {
    return flattenObject(obj, prefix, out);
  }

  unflattenObject(flat = {}) {
    return unflattenObject(flat);
  }

  // 值比较 - 包装器（调用模块函数）
  isSameValue(a, b) {
    return isSameValue(a, b);
  }

  _cloneFlat(data) {
    const clone = {};
    Object.entries(data ?? {}).forEach(([k, v]) => {
      clone[k] = cloneValue(v);
    });
    return clone;
  }

  _cloneValue(value) {
    return cloneValue(value);
  }

  // 选择器转义 - 包装器（调用模块函数）
  escapeSelector(value = '') {
    return escapeSelector(value);
  }

  // 转义 HTML - 包装器（调用模块函数）
  escapeHtml(value = '') {
    return escapeHtml(value);
  }

  // ========== WebSocket ==========
  getWebUserId() {
    if (!this._webUserId) {
      this._webUserId = localStorage.getItem('webUserId');
      if (!this._webUserId) {
        this._webUserId = `webclient_${Date.now()}`;
        localStorage.setItem('webUserId', this._webUserId);
      }
    }
    return this._webUserId;
  }

  _needsDeviceWs(page = this.currentPage) {
    return page === 'chat' && !this._isAIMode();
  }

  // 清理 WebSocket 相关定时器
  _clearWsTimers() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._offlineCheckTimer) {
      clearInterval(this._offlineCheckTimer);
      this._offlineCheckTimer = null;
    }
  }

  _releaseDeviceWs() {
    this._clearWsTimers();
    const ws = this._deviceWs;
    if (!ws) {
      this._wsConnecting = false;
      return;
    }
    this._deviceWs = null;
    this._wsConnecting = false;
    try {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close(1000, 'released');
    } catch {}
  }

  async ensureDeviceWs() {
    const state = this._deviceWs?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
    
    // 防止重复连接：如果正在连接中，直接返回
    if (this._wsConnecting) return;
    this._wsConnecting = true;
    
    // 清理旧的连接和定时器
    try {
      this._deviceWs?.close();
    } catch {}
    this._deviceWs = null;
    this._clearWsTimers();
    
    const wsUrl = buildDeviceWsUrl(this.serverUrl);
    const deviceId = this.getWebUserId();
    
    try {
      this._deviceWs = new WebSocket(wsUrl);
      
      this._deviceWs.onopen = () => {
        this._wsConnecting = false;
        this._deviceWs.device_id = deviceId;
        
        // 注册设备
        this._deviceWs.send(JSON.stringify({
          type: 'register',
          device_id: deviceId,
          device_type: 'web',
          device_name: 'Web客户端',
          capabilities: ['display'],
          user_id: this.getWebUserId()
        }));
        
        const now = Date.now();
        this._lastHeartbeatAt = now;
        this._lastWsMessageAt = now;

        // 主动心跳：每 30 秒向后端发送一次心跳
        this._heartbeatTimer = setInterval(() => {
          if (this._deviceWs?.readyState === WebSocket.OPEN) {
            try {
              this._deviceWs.send(JSON.stringify({
                type: 'heartbeat',
                timestamp: Date.now()
              }));
              this._lastHeartbeatAt = Date.now();
            } catch (e) {
              console.warn('[WebSocket] 心跳发送失败:', e);
            }
          }
        }, 30000);

        // 前端兜底离线检测：31 分钟内无活跃则强制重连
        const OFFLINE_TIMEOUT = 31 * 60 * 1000;
        this._offlineCheckTimer = setInterval(() => {
          const lastActive = Math.max(this._lastHeartbeatAt || 0, this._lastWsMessageAt || 0);
          if (lastActive && Date.now() - lastActive > OFFLINE_TIMEOUT) {
            console.warn('[WebSocket] 检测到长时间无响应，强制重连');
            this._deviceWs?.close();
            this._deviceWs = null;
            this.ensureDeviceWs();
          }
        }, 60000);
        
        // 更新连接状态
        const status = $('#connectionStatus');
        if (status) {
          status.classList.add('online');
          const statusText = status.querySelector('.status-text');
          if (statusText) statusText.textContent = '已连接';
        }
      };
      
      this._deviceWs.onmessage = (e) => {
        try {
          this._lastWsMessageAt = Date.now();
          const data = JSON.parse(e.data);
          this.handleWsMessage(data);
        } catch (err) {
          console.warn('[WebSocket] 消息解析失败:', err);
        }
      };
      
      this._deviceWs.onclose = (event) => {
        this._wsConnecting = false;
        this._clearWsTimers();
        this._deviceWs = null;

        // 非正常关闭且仍在需要 WS 的 chat 模式时才重连
        if (event.code !== 1000 && this._needsDeviceWs()) {
          const delay = event.code === 1006 ? 3000 : 5000;
          setTimeout(() => {
            if (!this._deviceWs && this._needsDeviceWs()) {
              this.ensureDeviceWs();
            }
          }, delay);
        }
      };
      
      this._deviceWs.onerror = (e) => {
        this._wsConnecting = false;
        console.warn('[WebSocket] 连接错误:', e);
      };
    } catch (e) {
      this._wsConnecting = false;
      console.warn('[WebSocket] 连接失败:', e);
    }
  }


  _ensureDeviceWsReady() {
    this.ensureDeviceWs();
    const ws = this._deviceWs;
    if (ws?.readyState === WebSocket.OPEN) return ws;
    if (ws?.readyState !== WebSocket.CONNECTING) this.showToast('设备通道未连接，正在重连...', 'warning');
    return null;
  }

  _devicePayloadBase() {
    const ws = this._deviceWs;
    return {
      device_id: ws?.device_id || this.getWebUserId(),
      device_type: 'web',
      user_id: this.getWebUserId(),
      isMaster: true
    };
  }

  sendDeviceMessage(text, meta = {}) {
    const payloadText = (text || '').trim();
    if (!payloadText) return;

    let ws = this._ensureDeviceWsReady();
    if (!ws) {
      if (this._deviceWs?.readyState === WebSocket.CONNECTING) {
        const t = setInterval(() => {
          if (this._deviceWs?.readyState === WebSocket.OPEN) {
            clearInterval(t);
            this.sendDeviceMessage(text, meta);
          } else if (this._deviceWs?.readyState === WebSocket.CLOSED) {
            clearInterval(t);
            this.showToast('设备通道连接失败', 'error');
          }
        }, 500);
        setTimeout(() => { clearInterval(t); if (this._deviceWs?.readyState !== WebSocket.OPEN) this.showToast('设备通道连接超时', 'warning'); }, 5000);
      }
      return;
    }

    const msg = {
      ...this._devicePayloadBase(),
      type: 'message',
      channel: 'web-chat',
      text: payloadText,
      message: Array.isArray(meta.message) ? meta.message : undefined,
      meta: {
        persona: this.getCurrentPersona(),
        source: meta.source || 'manual',
        ...meta.meta
      }
    };

    // 未由调用方追加时，在此统一追加用户消息并持久化，保证 Web/Event 模式有完整聊天历史
    if (!meta.skipAppend) {
      if (Array.isArray(meta.message) && meta.message.length > 0) {
        this.appendSegments(meta.message, true, 'user');
      } else if (payloadText) {
        this.appendChat('user', payloadText, { persist: true });
      }
    }

    try {
      ws.send(JSON.stringify(msg));
      this._chatStreamState = { running: true, source: meta.source || 'manual' };
      this.updateChatStatus('AI 处理中...');
      this.setChatInteractionState(true);

      this.clearChatPendingTimer();
      
      // 快速超时：2.5秒内如果没有响应，认为没有流被触发，快速退出
      this._chatQuickTimeout = setTimeout(() => {
        if (this._chatStreamState.running) {
          this.clearChatStreamState();
          // 不显示提示，静默退出
        }
      }, 2500);
      
      // 长超时：60秒作为兜底
      this._chatPendingTimer = setTimeout(() => {
        if (this._chatStreamState.running) {
          this.clearChatStreamState();
          this.showToast('AI 暂无响应，请稍后再试', 'warning');
        }
      }, 60000);
    } catch (e) {
      this.showToast('发送失败: ' + e.message, 'error');
      this.clearChatStreamState();
    }
  }

  /** OneBot v11：通知类事件（如戳一戳）走 notice，不走 message */
  sendDeviceNotice(notice_type, sub_type, payload = {}) {
    const ws = this._ensureDeviceWsReady();
    if (!ws) return;
    ws.send(JSON.stringify({
      ...this._devicePayloadBase(),
      type: 'notice',
      notice_type,
      sub_type,
      ...payload
    }));
  }

  handleWsMessage(data) {
    const messageId = data.event_id || `${data.type}_${data.timestamp || Date.now()}_${JSON.stringify(data).slice(0, 50)}`;
    if (this._processedMessageIds.has(messageId)) return;
    this._processedMessageIds.add(messageId);
    if (this._processedMessageIds.size > 1000) {
      const firstId = this._processedMessageIds.values().next().value;
      this._processedMessageIds.delete(firstId);
    }

    switch (data.type) {
      case 'heartbeat':
        this._lastWsMessageAt = Date.now();
        break;
      case 'reply': {
        const segments = Array.isArray(data.segments) ? data.segments : [];
        if (segments.length === 0 && data.text) segments.push({ type: 'text', text: data.text });
        this.clearChatStreamState();
        const replyOptions = (data.mcp_tools && data.mcp_tools.length > 0) ? { mcpTools: data.mcp_tools } : {};
        if (data.title || data.description) {
          const messages = segments
            .filter(seg => typeof seg === 'string' || seg.type === 'text' || seg.type === 'raw')
            .map(seg => typeof seg === 'string' ? seg : (seg.text || seg.data?.text || ''))
            .filter(text => text.trim());
          if (messages.length > 0) this.appendChatRecord(messages, data.title || '', data.description || '', true);
          segments.filter(s => ['image', 'video', 'record'].includes(s.type) && s.url).forEach(seg => {
            if (seg.type === 'image') this.appendImageMessage(seg.url, true);
            else this.appendSegments([seg], true, 'assistant');
          });
        } else {
          this.appendSegments(segments, true, 'assistant', replyOptions);
        }
        break;
      }
      case 'error':
        {
          const errorMsg = String(data.message ?? '').trim();
          if (errorMsg) {
            this.showToast(errorMsg, 'error');
          // 错误时也显示在聊天中
            this.appendChat('system', `错误: ${errorMsg}`, { persist: true, withCopyBtn: false });
          }
        }
        this.clearChatStreamState();
        break;
      case 'register_response':
        // 设备注册响应
        if (data.device) {
          this._deviceWs.device_id = data.device.device_id;
        }
        break;
      case 'heartbeat_response':
        // 心跳响应，更新活跃时间
        this._lastWsMessageAt = Date.now();
        break;
      case 'typing':
        // 显示正在输入状态
        if (data.typing) {
          this.updateChatStatus('AI 正在输入...');
        } else {
          this.updateChatStatus();
        }
        break;
    }
  }

  // ========== Toast ==========
  async copyToClipboard(text, successMessage = '已复制到剪贴板', failMessage = '复制失败，请检查浏览器权限') {
    const ok = await copyTextToClipboard(text);
    this.showToast(ok ? successMessage : failMessage, ok ? 'success' : 'error');
    return ok;
  }

  showToast(message, type = 'info') {
    showToastUI(message, type);
  }
}

// 初始化应用

Object.assign(App.prototype, configPageMethods);

const API_PROTOTYPE_METHODS = [
  'renderAPI', 'renderAPIGroups', 'selectAPI', 'renderParamInput', 'renderFileUpload',
  'setupFileUpload', 'handleFiles', 'findAPIById', 'updateJSONPreview', 'buildRequestData',
  'initJSONEditor', 'loadCodeMirror', 'formatJSONPreview', 'copyJSON', 'fillExample',
  'executeRequest', 'executeFileUpload', 'renderResponse'
];
for (const method of API_PROTOTYPE_METHODS) {
  App.prototype[method] = function (...args) {
    return apiDebug[method](this, ...args);
  };
}

new App();