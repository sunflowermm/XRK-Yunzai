import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import si from 'systeminformation';
import cfg from '../../../lib/config/config.js';
import { collectBotInventory } from '../../../lib/http/utils/botInventory.js';

const execAsync = promisify(exec);

let __lastNetSample = null;
let __netSampler = null;
let __netHist = [];
const __netRecent = [];
const NET_HISTORY_LIMIT = 24 * 60;
const NET_RECENT_LIMIT = 60;
const NET_SAMPLE_MS = 3_000;

// CPU 采样缓存（单一方法：os.cpus 快照法）
let __cpuCache = { percent: 0, ts: 0 };
let __cpuTimer = null;
let __cpuPrevSnap = null;
function __sampleCpuOnce() {
  try {
    const cpus = os.cpus();
    if (!cpus || cpus.length === 0) return;
    if (!__cpuPrevSnap) { __cpuPrevSnap = cpus; return; }
    let idleDelta = 0, totalDelta = 0;
    for (let i = 0; i < cpus.length; i++) {
      const t1 = __cpuPrevSnap[i].times, t2 = cpus[i].times;
      const idle = Math.max(0, t2.idle - t1.idle);
      const total = Math.max(0,
        (t2.user - t1.user) + (t2.nice - t1.nice) + (t2.sys - t1.sys) + (t2.irq - t1.irq) + idle
      );
      idleDelta += idle; totalDelta += total;
    }
    __cpuPrevSnap = cpus;
    if (totalDelta > 0) {
      const usedPct = +(((totalDelta - idleDelta) / totalDelta) * 100).toFixed(2);
      __cpuCache = { percent: usedPct, ts: Date.now() };
    }
  } catch {
    // CPU 采样失败，忽略错误
  }
}

let __fsCache = { disks: [], ts: 0 };
let __procCache = { top5: [], ts: 0 };
let __fsTimer = null;
let __procTimer = null;

async function __sampleNetWindows() {
  try {
    const { stdout } = await execAsync(
      'powershell -NoProfile -Command "$a = Get-NetAdapterStatistics | Where-Object { $_.InterfaceDescription -notlike \"*Loopback*\" -and $_.InterfaceDescription -notlike \"*Virtual*\" }; if ($a) { $r = ($a | Measure-Object -Property ReceivedBytes -Sum).Sum; $t = ($a | Measure-Object -Property SentBytes -Sum).Sum; \"$r|$t\" } else { \"0|0\" }"',
      { timeout: 5000, maxBuffer: 1024 * 1024 }
    );
    const p = stdout.trim().split('|');
    if (p.length === 2) return { rxBytes: parseFloat(p[0]) || 0, txBytes: parseFloat(p[1]) || 0 };
  } catch {}
  return null;
}

async function __sampleNetOnce() {
  try {
    const stats = await si.networkStats().catch(() => []);
    let rxBytes = 0, txBytes = 0;
    if (Array.isArray(stats)) {
      for (const n of stats) {
        rxBytes += Number(n.rx_bytes || 0);
        txBytes += Number(n.tx_bytes || 0);
      }
    }
    if (process.platform === 'win32' && rxBytes === 0 && txBytes === 0) {
      const win = await __sampleNetWindows();
      if (win) { rxBytes = win.rxBytes; txBytes = win.txBytes; }
    }
    const now = Date.now();
    const tsMin = Math.floor(now / 60000) * 60000;
    let rxSec = 0, txSec = 0;
    if (__lastNetSample) {
      const dt = Math.max(0.1, (now - __lastNetSample.ts) / 1000);
      const rxDelta = rxBytes - __lastNetSample.rx;
      const txDelta = txBytes - __lastNetSample.tx;
      if (rxDelta >= 0) rxSec = rxDelta / dt;
      if (txDelta >= 0) txSec = txDelta / dt;
    }
    __lastNetSample = { ts: now, rx: rxBytes, tx: txBytes };
    __netRecent.push({ ts: now, rxSec, txSec });
    if (__netRecent.length > NET_RECENT_LIMIT) __netRecent.shift();
    if (rxSec > 0 || txSec > 0) {
      if (__netHist.length && __netHist[__netHist.length - 1].ts === tsMin) {
        const last = __netHist[__netHist.length - 1];
        __netHist[__netHist.length - 1] = { ts: tsMin, rxSec: Math.max(last.rxSec, rxSec), txSec: Math.max(last.txSec, txSec) };
      } else {
        __netHist.push({ ts: tsMin, rxSec, txSec });
        if (__netHist.length > NET_HISTORY_LIMIT) __netHist.shift();
      }
    }
  } catch {
    // 网络采样失败，忽略错误
  }
}

function __ensureNetSampler() {
  if (__netSampler) return;
  // 预热两次，避免首次为0
  (async () => {
    await __sampleNetOnce();
    setTimeout(__sampleNetOnce, 1_000);
  })();
  __netSampler = setInterval(__sampleNetOnce, NET_SAMPLE_MS);
}

function __getNetHistory24h() {
  const now = Date.now();
  const start = Math.floor((now - 24 * 60 * 60 * 1000) / 60000) * 60000;
  const recent = __netHist.filter(p => p.ts >= start);
  return recent.length ? recent : __netHist.slice(-60);
}

function __getNetRecent() {
  const recent = __netRecent.slice(-NET_RECENT_LIMIT);
  if (recent.length >= NET_RECENT_LIMIT) return recent;
  const last = recent[recent.length - 1] || { rxSec: 0, txSec: 0 };
  const now = Date.now();
  while (recent.length < NET_RECENT_LIMIT) {
    recent.unshift({ ts: now - (NET_RECENT_LIMIT - recent.length) * NET_SAMPLE_MS, rxSec: last.rxSec, txSec: last.txSec });
  }
  return recent;
}

async function __refreshFsCache() {
  try {
    const fsSize = await si.fsSize().catch(() => []);
    const disks = Array.isArray(fsSize) ? fsSize.map(d => ({
      fs: d.fs || d.mount || d.type || 'disk',
      mount: d.mount || d.fs || '',
      size: Number(d.size || 0),
      used: Number(d.used || 0),
      use: Number(d.use || 0)
    })) : [];
    __fsCache = { disks, ts: Date.now() };
  } catch {
    // 文件系统缓存刷新失败，忽略错误
  }
}

async function __refreshProcCache() {
  try {
    const procs = await si.processes().catch(() => ({ list: [] }));
    const list = procs && procs.list || [];
    // 计算Top5（按CPU，其次内存）
    const top5 = list
      .map(p => ({ pid: p.pid, name: p.name, cpu: Number(p.pcpu || p.cpu || 0), mem: Number(p.pmem || p.mem || 0) }))
      .sort((a, b) => b.cpu - a.cpu || b.mem - a.mem)
      .slice(0, 5);
    __procCache = { top5, ts: Date.now() };
  } catch {
    // 进程缓存刷新失败，忽略错误
  }
}

function __ensureSysSamplers() {
  if (!__fsTimer) {
    __refreshFsCache();
    __fsTimer = setInterval(__refreshFsCache, 30_000);
  }
  if (!__procTimer) {
    __refreshProcCache();
    __procTimer = setInterval(__refreshProcCache, 10_000);
  }
  if (!__cpuTimer) {
    __cpuPrevSnap = os.cpus();
    setTimeout(__sampleCpuOnce, 600); // 预热一次，避免首次为0
    __cpuTimer = setInterval(__sampleCpuOnce, 2_000);
  }
}

function __getNetworkStats() {
  const out = {};
  for (const [name, interfaces] of Object.entries(os.networkInterfaces() || {})) {
    for (const iface of interfaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        out[name] = { address: iface.address, netmask: iface.netmask, mac: iface.mac };
        break;
      }
    }
  }
  return out;
}

function __getSystemInfo() {
  // 仅使用同一方法的缓存；若缓存过期则触发一次轻量采样
  if (!__cpuCache.ts || (Date.now() - __cpuCache.ts > 5_000)) {
    __sampleCpuOnce();
  }
  const cpuPct = __cpuCache.percent || 0;

  // 基础信息（极快）
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsage = process.memoryUsage();

  const lastNet = __lastNetSample || { ts: Date.now(), rx: 0, tx: 0 };
  const rxBytes = Number(lastNet.rx || 0);
  const txBytes = Number(lastNet.tx || 0);
  let rxSec = 0, txSec = 0;
  if (__netRecent.length > 0) {
    const recent = __netRecent.slice(-3);
    rxSec = recent.reduce((s, p) => s + (p.rxSec || 0), 0) / recent.length;
    txSec = recent.reduce((s, p) => s + (p.txSec || 0), 0) / recent.length;
  } else if (__netHist.length > 0) {
    const last = __netHist[__netHist.length - 1];
    rxSec = Number(last.rxSec || 0);
    txSec = Number(last.txSec || 0);
  }

  // 磁盘 & 进程：直接使用缓存，必要时后台刷新
  const disks = Array.isArray(__fsCache.disks) ? __fsCache.disks : [];
  if (!__fsTimer || (Date.now() - (__fsCache.ts || 0) > 60_000)) __refreshFsCache();

  const processesTop5 = Array.isArray(__procCache.top5) ? __procCache.top5 : [];
  if (!__procTimer || (Date.now() - (__procCache.ts || 0) > 20_000)) __refreshProcCache();

  return {
    cpuPct,
    cpus,
    totalMem,
    freeMem,
    usedMem,
    memUsage,
    rxBytes,
    txBytes,
    rxSec,
    txSec,
    disks,
    processesTop5
  };
}

async function __buildSystemResponse(systemInfo, Bot, includeHist = false) {
  const { cpuPct, cpus, totalMem, freeMem, usedMem, memUsage, rxBytes, txBytes, rxSec, txSec, disks, processesTop5 } = systemInfo;
  const siMem = await si.mem().catch(() => ({}));
  const bots = collectBotInventory(Bot);
  const netRecent = __getNetRecent();

  return {
    success: true,
    timestamp: Date.now(),
    system: {
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      nodeVersion: process.version,
      uptime: process.uptime(),
      cpu: {
        model: (cpus[0] && cpus[0].model) || 'Unknown',
        cores: cpus.length,
        usage: process.cpuUsage(),
        percent: cpuPct,
        loadavg: (os.loadavg && os.loadavg()) || [0, 0, 0]
      },
      memory: {
        total: totalMem,
        free: freeMem,
        used: usedMem,
        usagePercent: ((usedMem / totalMem) * 100).toFixed(2),
        process: {
          rss: memUsage.rss,
          heapTotal: memUsage.heapTotal,
          heapUsed: memUsage.heapUsed,
          external: memUsage.external,
          arrayBuffers: memUsage.arrayBuffers
        }
      },
      swap: {
        total: Number(siMem?.swaptotal || 0),
        used: Number(siMem?.swapused || 0),
        usagePercent: siMem?.swaptotal ? +(((siMem.swapused || 0) / siMem.swaptotal) * 100).toFixed(2) : 0
      },
      disks,
      net: { rxBytes, txBytes },
      netRates: { rxSec, txSec },
      netRecent,
      netHistory24h: includeHist ? __getNetHistory24h() : [],
      network: __getNetworkStats()
    },
    bot: {
      url: Bot.url,
      port: Bot.port,
      startTime: Bot.stat?.start_time ?? Date.now() / 1000,
      uptime: Bot.stat?.start_time ? (Date.now() / 1000) - Bot.stat.start_time : process.uptime()
    },
    bots,
    processesTop5,
    adapters: Bot.adapter
  };
}

// 提取配置序列化函数
function serialize(obj, seen = new WeakSet()) {
  if (typeof obj === 'function') {
    return obj.toString();
  }
  if (!obj || typeof obj !== 'object') {
    return obj;
  }
  if (seen.has(obj)) {
    return '[Circular]';
  }
  seen.add(obj);
  if (Array.isArray(obj)) {
    return obj.map(item => serialize(item, seen));
  }
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = serialize(value, seen);
  }
  return result;
}

// 提取 includeHist 判断逻辑
function __shouldIncludeHistory(req) {
  return (req.query && req.query.hist === '24h') || (req.query && req.query.withHistory === '1') || (req.query && req.query.withHistory === 'true');
}

/**
 * 核心系统API
 * 提供系统状态、配置查询、健康检查等基础功能
 */
export default {
  name: 'core',
  dsc: '核心系统API',
  priority: 200,
  init: async (app, Bot) => {
    __ensureNetSampler();
    __ensureSysSamplers();
  },

  routes: [
    {
      method: 'GET',
      path: '/api/system/status',
      handler: async (req, res, Bot) => {
        try {
          const systemInfo = __getSystemInfo();
          const includeHist = __shouldIncludeHistory(req);
          const response = await __buildSystemResponse(systemInfo, Bot, includeHist);
          res.json(response);
        } catch (error) {
          res.status(500).json({
            success: false,
            error: error.message
          });
        }
      }
    },

    {
      method: 'GET',
      path: '/api/status',
      handler: async (req, res, Bot) => {
        const bots = collectBotInventory(Bot);

        res.json({
          success: true,
          system: {
            platform: os.platform(),
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            nodeVersion: process.version
          },
          bot: {
            url: Bot.url,
            port: Bot.port,
            startTime: Bot.stat.start_time,
            uptime: (Date.now() / 1000) - Bot.stat.start_time
          },
          bots,
          adapters: Bot.adapter
        });
      }
    },

    {
      method: 'GET',
      path: '/api/config',
      handler: async (req, res, Bot) => {

        res.json({
          success: true,
          config: serialize(cfg)
        });
      }
    },

    {
      method: 'GET',
      path: '/api/health',
      handler: async (req, res, Bot) => {
        const redisOk = await global.redis.ping().then(() => true).catch(() => false);
        
        res.json({
          status: 'healthy',
          timestamp: Date.now(),
          services: {
            bot: Bot.uin.length > 0 ? 'operational' : 'degraded',
            redis: redisOk ? 'operational' : 'down',
            api: 'operational'
          }
        });
      }
    },

    {
      method: 'GET',
      path: '/api/system/overview',
      handler: async (req, res, Bot) => {

        try {
          res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
          res.set('Pragma', 'no-cache');

          const systemInfo = __getSystemInfo();
          const includeHist = __shouldIncludeHistory(req);
          const response = await __buildSystemResponse(systemInfo, Bot, includeHist);

          // 与 www/xrk updateSystemStatus 对齐：panels.metrics 来自 system
          const sys = response.system || {};
          const mem = sys.memory || {};
          const memPct = mem.total > 0 ? ((mem.used / mem.total) * 100).toFixed(1) : 0;
          const disk0 = Array.isArray(sys.disks) && sys.disks[0];
          const diskPct = disk0 && disk0.size > 0 ? ((disk0.used / disk0.size) * 100).toFixed(1) : 0;
          const panels = {
            metrics: {
              cpu: sys.cpu?.percent ?? 0,
              memory: Number(memPct),
              disk: Number(diskPct),
              net: sys.netRates ? { rxSec: sys.netRates.rxSec, txSec: sys.netRates.txSec } : {}
            }
          };

          let workflows = { stats: {}, items: [], total: 0 };
          try {
            const stats = Bot.StreamLoader?.getStats?.() ?? null;
            const allStreams = Bot.StreamLoader?.getAllStreams?.() ?? [];
            const enabledStreams = allStreams.filter(s => s.config && s.config.enabled !== false);
            workflows = {
              stats: {
                total: allStreams.length,
                enabled: enabledStreams.length,
                embeddingReady: stats?.embedding?.ready ?? 0,
                provider: stats?.embedding?.provider || 'bm25'
              },
              items: allStreams.map(s => ({
                name: s.name || 'unknown',
                description: s.description || '',
                enabled: s.config && s.config.enabled !== false,
                embeddingReady: s.embeddingConfig?.enabled === true
              })),
              total: allStreams.length
            };
            panels.workflows = workflows;
          } catch (e) {
            Bot.makeLog('error', '获取工作流信息失败', 'CoreAPI', e);
          }

          res.json({
            ...response,
            workflows,
            panels
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            error: error.message
          });
        }
      }
    }
  ]
};