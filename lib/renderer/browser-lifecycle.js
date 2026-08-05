/**
 * Puppeteer / Playwright 共用：超时、僵死关闭、致命错误判定
 */

export function isFatalBrowserError(err) {
  return /timeout|timed out|disconnected|Target closed|Session closed|Protocol error|Browser closed|Navigation failed|net::ERR/i.test(
    String(err?.message || err || '')
  );
}

export async function withTimeout(promise, ms, label = 'operation') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** close 卡住时 disconnect / SIGKILL */
export async function safeCloseBrowser(browser, closeTimeoutMs = 8000) {
  if (!browser) return;
  try {
    await withTimeout(
      (async () => {
        try {
          if (typeof browser.pages === 'function') {
            for (const page of await browser.pages()) await page.close().catch(() => {});
          } else if (typeof browser.contexts === 'function') {
            for (const ctx of browser.contexts()) await ctx.close().catch(() => {});
          }
        } catch {}
        await browser.close().catch(() => {});
      })(),
      closeTimeoutMs,
      'browser close'
    );
  } catch {
    try {
      browser.disconnect?.();
    } catch {}
    try {
      browser.process?.()?.kill?.('SIGKILL');
    } catch {}
  }
}
