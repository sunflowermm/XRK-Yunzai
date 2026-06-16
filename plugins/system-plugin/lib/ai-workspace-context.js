import { AsyncLocalStorage } from 'node:async_hooks';

const consoleContext = new AsyncLocalStorage();

export function runWithAiConsoleContext(ctx = {}, fn) {
  const parent = consoleContext.getStore() || {};
  const next = { ...parent, ...ctx };
  return consoleContext.run(next, fn);
}

export function getAiConsoleContext() {
  return consoleContext.getStore() || {};
}
