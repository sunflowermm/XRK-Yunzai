/**
 * 首页词云：轻量 chip + 懒加载 popover + 事件委托
 */

import { escapeHtml } from './utils.js';

/** 首屏最多渲染的 chip 数，超出显示「+N」展开 */
export const TAG_CLOUD_VISIBLE_LIMIT = 50;
/** 入场动画 stagger 上限，避免大量插件时动画排队卡顿 */
const STAGGER_CAP = 8;
const PENDING_EXPAND_ATTR = 'data-tag-cloud-pending';

const boundRoots = new WeakSet();

function hashStr(s) {
  let h = 0;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function sizeClass(seed) {
  const sizes = ['tag-cloud-chip--sm', 'tag-cloud-chip--md', 'tag-cloud-chip--lg'];
  return sizes[hashStr(seed) % 3];
}

function toneClass(seed) {
  const tones = [
    'tag-cloud-chip--tone-primary',
    'tag-cloud-chip--tone-success',
    'tag-cloud-chip--tone-warning',
    'tag-cloud-chip--tone-info'
  ];
  return tones[hashStr(seed) % 4];
}

function safeDomId(prefix, seed, index) {
  const base = String(seed ?? 'x')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 40);
  return `${prefix}-${index}-${base || 'n'}`;
}

function encodePayload(payload) {
  try {
    return encodeURIComponent(JSON.stringify(payload));
  } catch {
    return '';
  }
}

function buildPopoverHtml({ tipId, popoverTitle, popoverKey, desc, facts }) {
  const keyLine = popoverKey
    ? `<div class="tag-cloud-chip__popover-key mono">${escapeHtml(popoverKey)}</div>`
    : '';
  const factRows = (facts ?? [])
    .map(({ label: k, value }) => `<li><span>${escapeHtml(k)}</span><em>${escapeHtml(String(value))}</em></li>`)
    .join('');
  return `
    <div class="tag-cloud-chip__popover" id="${tipId}" role="tooltip">
      <div class="tag-cloud-chip__popover-title">${escapeHtml(popoverTitle)}</div>
      ${keyLine}
      <p class="tag-cloud-chip__popover-desc">${escapeHtml(desc)}</p>
      <ul class="tag-cloud-chip__popover-facts">${factRows}</ul>
    </div>
  `;
}

/**
 * 轻量 chip：仅按钮，popover 悬停时再插入 DOM
 */
export function buildTagCloudChip({
  seed,
  tipPrefix,
  index,
  label,
  badge = '',
  extraClass = '',
  popoverTitle,
  popoverKey = '',
  desc,
  facts
}) {
  const tipId = safeDomId(tipPrefix, seed, index);
  const stagger = Math.min(index, STAGGER_CAP);
  const payload = encodePayload({
    tipId,
    popoverTitle: popoverTitle ?? label,
    popoverKey,
    desc: (desc ?? '暂无描述').trim() || '暂无描述',
    facts: facts ?? []
  });
  return `
    <div class="tag-cloud-chip ${sizeClass(seed)} ${toneClass(seed)}${extraClass}" style="--stagger:${stagger}" data-popover="${payload}" role="listitem">
      <button type="button" class="tag-cloud-chip__btn" aria-describedby="${tipId}">
        <span class="tag-cloud-chip__label">${escapeHtml(label)}</span>
        ${badge}
      </button>
    </div>
  `;
}

function ensureChipPopover(chip) {
  if (!chip || chip.querySelector('.tag-cloud-chip__popover')) return;
  const raw = chip.getAttribute('data-popover');
  if (!raw) return;
  let payload;
  try {
    payload = JSON.parse(decodeURIComponent(raw));
  } catch {
    return;
  }
  chip.insertAdjacentHTML('beforeend', buildPopoverHtml(payload));
  chip.removeAttribute('data-popover');
}

function updatePopoverFlip(chip) {
  if (!chip) return;
  const r = chip.getBoundingClientRect();
  chip.classList.toggle('popover-flip', r.top < 96);
}

function bindTagCloudInteractions(root) {
  if (!root || boundRoots.has(root)) return;
  boundRoots.add(root);

  const onChip = (chip) => {
    if (!chip?.classList.contains('tag-cloud-chip')) return;
    ensureChipPopover(chip);
    updatePopoverFlip(chip);
  };

  root.addEventListener(
    'mouseover',
    (e) => {
      const chip = e.target.closest?.('.tag-cloud-chip');
      if (!chip || !root.contains(chip)) return;
      if (chip.contains(e.relatedTarget)) return;
      onChip(chip);
    },
    { passive: true }
  );

  root.addEventListener(
    'focusin',
    (e) => {
      onChip(e.target.closest?.('.tag-cloud-chip'));
    },
    { passive: true }
  );

  root.addEventListener(
    'touchstart',
    (e) => {
      onChip(e.target.closest?.('.tag-cloud-chip'));
    },
    { passive: true }
  );

  root.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.tag-cloud-expand');
    if (!btn || !root.contains(btn)) return;
    const raw = root.getAttribute(PENDING_EXPAND_ATTR);
    if (raw) {
      try {
        const items = JSON.parse(decodeURIComponent(raw));
        const html = items
          .map((item, i) => buildTagCloudChip({ ...item, index: item.index ?? i }))
          .join('');
        btn.insertAdjacentHTML('beforebegin', html);
      } catch {
        /* ignore malformed pending payload */
      }
      root.removeAttribute(PENDING_EXPAND_ATTR);
    } else {
      const hidden = root.querySelector('.tag-cloud__hidden');
      if (hidden) {
        while (hidden.firstChild) {
          root.insertBefore(hidden.firstChild, btn);
        }
        hidden.remove();
      }
    }
    btn.remove();
  });
}

/**
 * @param {HTMLElement} box 面板根节点（含 meta + cloud）
 * @param {string} metaHtml
 * @param {string} chipsHtml
 * @param {{ total?: number, limit?: number, pendingItems?: object[] }} [opts]
 */
export function mountTagCloud(box, metaHtml, chipsHtml, opts = {}) {
  const total = opts.total ?? 0;
  const pendingItems = opts.pendingItems ?? [];
  const useCompact = total > 24 || (total === 0 && chipsHtml && chipsHtml.split('tag-cloud-chip').length > 26);

  if (!chipsHtml) {
    box.innerHTML = metaHtml;
    delete box.dataset.tagCloudFp;
    return;
  }

  const compactClass = useCompact ? ' tag-cloud--compact' : '';
  box.innerHTML = `${metaHtml}<div class="tag-cloud${compactClass}" role="list">${chipsHtml}</div>`;

  const cloud = box.querySelector('.tag-cloud');
  if (cloud) {
    bindTagCloudInteractions(cloud);
    if (pendingItems.length) {
      cloud.setAttribute(PENDING_EXPAND_ATTR, encodePayload(pendingItems));
      const expand = document.createElement('button');
      expand.type = 'button';
      expand.className = 'tag-cloud-expand';
      expand.textContent = `+${pendingItems.length}`;
      expand.setAttribute('aria-label', `展开其余 ${pendingItems.length} 项`);
      cloud.appendChild(expand);
    }
  }
}

/** 内容未变则跳过整页重绘 */
export function shouldSkipTagCloudRender(container, fingerprint) {
  return Boolean(fingerprint && container?.dataset.tagCloudFp === fingerprint);
}

export function markTagCloudRendered(container, fingerprint) {
  if (container && fingerprint) container.dataset.tagCloudFp = fingerprint;
}

export function buildTagCloudFingerprint(kind, payload) {
  try {
    return `${kind}:${JSON.stringify(payload)}`;
  } catch {
    return '';
  }
}
