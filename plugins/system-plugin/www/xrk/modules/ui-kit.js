/**
 * UI 图标工具（避免在 UI 上直接使用 emoji：使用 SVG 更可控）
 */

export function pokeHandIconSVG() {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M7 11l5-5 3 3-5 5"></path>
      <path d="M9 13l-4 4"></path>
      <path d="M16 3l5 5"></path>
      <path d="M2 22l6-6"></path>
    </svg>
  `;
}

export function paperclipIconSVG() {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.19 9.19a1.5 1.5 0 1 1-2.12-2.12l8.13-8.13"></path>
    </svg>
  `;
}

export function wrenchIconSVG() {
  // 通用扳手：用于“工具卡片”标题，不依赖任何 emoji 作为 UI 图标
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:16px;height:16px">
      <path d="M22 19a2 2 0 0 1-2 2h-2l-6-6 3-3 6 6v2z"></path>
      <path d="M14 7l3-3 2 2-3 3-2-2z"></path>
      <path d="M2 22l6-6"></path>
    </svg>
  `;
}

export function filePreviewIconSVG(mimeType = '') {
  const type = String(mimeType ?? '').toLowerCase();

  if (type.startsWith('video/')) {
    return `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:var(--info)">
        <rect x="3" y="6" width="14" height="12" rx="2"></rect>
        <path d="M7 10l6 3-6 3z" fill="currentColor" stroke="none"></path>
        <path d="M17 9l4-2v10l-4-2z" fill="currentColor" stroke="none" opacity="0.75"></path>
      </svg>
    `;
  }

  if (type.startsWith('audio/')) {
    return `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:var(--primary)">
        <path d="M11 5l-5 2v10l5 2z"></path>
        <path d="M19 7a6 6 0 0 1 0 10"></path>
        <path d="M17 9a3.5 3.5 0 0 1 0 6"></path>
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:var(--primary)">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <path d="M14 2v6h6"></path>
      <path d="M8 13h8"></path>
      <path d="M8 17h6"></path>
    </svg>
  `;
}

export function toastIconSVG(type = 'info') {
  const t = String(type ?? '').toLowerCase();

  // 使用 stroke/currentColor，让 toast 的主题色由 CSS 控制
  if (t === 'success') {
    return `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M20 6L9 17l-5-5"></path>
      </svg>
    `;
  }

  if (t === 'error') {
    return `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 6L6 18"></path>
        <path d="M6 6l12 12"></path>
      </svg>
    `;
  }

  if (t === 'warning') {
    return `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <path d="M12 9v4"></path>
        <path d="M12 17h.01"></path>
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10"></circle>
      <path d="M12 16v-4"></path>
      <path d="M12 8h.01"></path>
    </svg>
  `;
}
