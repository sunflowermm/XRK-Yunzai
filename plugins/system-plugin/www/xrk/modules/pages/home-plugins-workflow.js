/**
 * 首页「插件与工作流」词云展示（悬停/聚焦显示详情）
 * 由 renderHome → _applyHomeData / _loadHomeDataAndUpdate 驱动
 */

import { escapeHtml } from '../utils.js';
import { setUpdating, clearUpdating } from '../dom.js';
import { API, fetchApi } from '../platform.js';
import {
  buildTagCloudChip,
  buildTagCloudFingerprint,
  markTagCloudRendered,
  mountTagCloud,
  shouldSkipTagCloudRender,
  TAG_CLOUD_VISIBLE_LIMIT
} from '../tag-cloud.js';

function formatLoadTime(ms) {
  const n = Number(ms) || 0;
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(2)}s`;
}

function buildPluginFacts(p) {
  const facts = [{ label: '优先级', value: p.priority ?? '—' }];
  if (p.rule != null) facts.push({ label: '规则条数', value: Number(p.rule) || 0 });
  if (p.task != null) facts.push({ label: '定时任务', value: p.task > 0 ? '是' : '否' });
  return facts;
}

function pluginToChipPayload(p, i) {
  const key = p.key ?? p.name ?? `p${i}`;
  const label = p.name ?? p.key ?? 'plugin';
  return {
    seed: key,
    tipPrefix: 'plg-tip',
    index: i,
    label,
    popoverTitle: label,
    popoverKey: String(key),
    desc: (p.dsc ?? '暂无描述').trim() || '暂无描述',
    facts: buildPluginFacts(p)
  };
}

function renderPluginChips(plugins, startIndex = 0) {
  return plugins
    .map((p, i) => buildTagCloudChip(pluginToChipPayload(p, startIndex + i)))
    .join('');
}

/**
 * 渲染插件摘要词云（依赖 /api/plugins/summary）
 */
export async function loadPluginsInfoPanel(app) {
  const box = document.getElementById('pluginsInfo');
  if (!box) return;

  setUpdating(box);

  try {
    const res = await fetchApi(app.serverUrl, API.pluginsSummary, { timeout: 5000 });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    if (!data.success) {
      throw new Error(data.message ?? data.error ?? '获取插件信息失败');
    }

    const summary = data.summary ?? {};
    const plugins = Array.isArray(data.plugins) ? data.plugins : [];
    const fingerprint = buildTagCloudFingerprint('plugins', { summary, plugins });

    if (shouldSkipTagCloudRender(box, fingerprint)) {
      clearUpdating(box);
      return;
    }

    const totalPlugins = summary.totalPlugins ?? plugins.length;
    const pluginsWithRules = summary.withRules ?? 0;
    const pluginsWithTasks = summary.withTasks ?? summary.taskCount ?? 0;
    const loadTime = summary.totalLoadTime ?? 0;

    const metaHtml = `
      <div class="home-cloud-meta" aria-label="插件汇总">
        <span class="home-cloud-meta__item"><strong class="home-cloud-meta__num home-cloud-meta__num--primary">${totalPlugins}</strong><span class="home-cloud-meta__lbl">总插件</span></span>
        <span class="home-cloud-meta__sep" aria-hidden="true">·</span>
        <span class="home-cloud-meta__item"><strong class="home-cloud-meta__num home-cloud-meta__num--success">${pluginsWithRules}</strong><span class="home-cloud-meta__lbl">有规则</span></span>
        <span class="home-cloud-meta__sep" aria-hidden="true">·</span>
        <span class="home-cloud-meta__item"><strong class="home-cloud-meta__num home-cloud-meta__num--warning">${pluginsWithTasks}</strong><span class="home-cloud-meta__lbl">定时</span></span>
        <span class="home-cloud-meta__sep" aria-hidden="true">·</span>
        <span class="home-cloud-meta__item"><strong class="home-cloud-meta__num home-cloud-meta__num--info">${escapeHtml(formatLoadTime(loadTime))}</strong><span class="home-cloud-meta__lbl">加载</span></span>
      </div>
    `;

    if (!plugins.length) {
      box.innerHTML = `${metaHtml}<div class="home-cloud-empty">暂无插件条目</div>`;
      markTagCloudRendered(box, fingerprint);
      return;
    }

    const limit = TAG_CLOUD_VISIBLE_LIMIT;
    const visible = limit > 0 && plugins.length > limit ? plugins.slice(0, limit) : plugins;
    const pending = limit > 0 && plugins.length > limit
      ? plugins.slice(limit).map((p, i) => pluginToChipPayload(p, limit + i))
      : [];

    mountTagCloud(box, metaHtml, renderPluginChips(visible, 0), {
      total: plugins.length,
      limit,
      pendingItems: pending
    });
    markTagCloudRendered(box, fingerprint);
  } catch (e) {
    delete box.dataset.tagCloudFp;
    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
      box.innerHTML = '<div class="home-cloud-empty">加载超时</div>';
    } else {
      console.warn('[插件信息] 加载失败:', e);
      box.innerHTML = `<div class="home-cloud-empty">加载失败：${escapeHtml(e.message || '未知错误')}</div>`;
    }
  } finally {
    setTimeout(() => clearUpdating(box), 50);
  }
}

/**
 * 渲染工作流词云（数据来自系统状态快照 workflows + panels.workflows）
 */
export function renderWorkflowInfoPanel(app, workflows = {}, panels = {}) {
  const box = document.getElementById('workflowInfo');
  if (!box) return;

  const panelWf = panels.workflows ?? {};
  const stats = panelWf.stats ?? workflows.stats ?? {};
  const total = stats.total ?? panelWf.total ?? workflows.total ?? 0;
  const items = Array.isArray(workflows.items) && workflows.items.length
    ? workflows.items
    : (panelWf.items ?? []);

  const fingerprint = buildTagCloudFingerprint('workflows', { total, items });

  if (shouldSkipTagCloudRender(box, fingerprint)) {
    return;
  }

  setUpdating(box);

  if (!total && !items.length) {
    box.innerHTML = '<div class="home-cloud-empty">暂无工作流数据</div>';
    markTagCloudRendered(box, fingerprint);
    clearUpdating(box);
    return;
  }

  const enabled = stats.enabled ?? panelWf.enabled ?? workflows.enabled ?? 0;
  const metaHtml = `
    <div class="home-cloud-meta" aria-label="工作流汇总">
      <span class="home-cloud-meta__item"><strong class="home-cloud-meta__num home-cloud-meta__num--primary">${enabled}/${total}</strong><span class="home-cloud-meta__lbl">启用 / 总数</span></span>
    </div>
  `;

  if (!items.length) {
    box.innerHTML = `${metaHtml}<div class="home-cloud-empty">暂无工作流条目</div>`;
    markTagCloudRendered(box, fingerprint);
    clearUpdating(box);
    return;
  }

  const chips = items
    .map((item, i) => {
      const name = item.name ?? 'workflow';
      const on = item.enabled !== false;
      return buildTagCloudChip({
        seed: `${name}-${i}`,
        tipPrefix: 'wf-tip',
        index: i,
        label: name,
        badge: on ? '' : '<span class="tag-cloud-chip__badge" aria-hidden="true">停</span>',
        extraClass: on ? '' : ' tag-cloud-chip--disabled',
        popoverTitle: name,
        desc: (item.description ?? '').trim() || '暂无描述',
        facts: [
          { label: '优先级', value: item.priority ?? '—' },
          { label: '状态', value: on ? '已启用' : '未启用' }
        ]
      });
    })
    .join('');

  mountTagCloud(box, metaHtml, chips, { total: items.length, limit: 0 });
  markTagCloudRendered(box, fingerprint);
  clearUpdating(box);
}
