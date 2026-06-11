import os from 'os';
import v8 from 'v8';
import { exec } from 'child_process';
import { promisify } from 'util';
import EventEmitter from 'events';

const execAsync = promisify(exec);

const WIN_BROWSER_PS = "$ProgressPreference='SilentlyContinue'; 'chrome','msedge' | ForEach-Object { Get-Process -Name $_ -ErrorAction SilentlyContinue } | Select-Object Id,StartTime,Path | ConvertTo-Csv -NoTypeInformation";

function toPowerShellEncoded(script) {
    return Buffer.from(script, 'utf16le').toString('base64');
}

async function runWindowsProcessList() {
    const b64 = toPowerShellEncoded(WIN_BROWSER_PS);
    try {
        const { stdout } = await execAsync(`powershell -NoProfile -EncodedCommand ${b64}`, { timeout: 15000, windowsHide: true });
        return stdout;
    } catch (err) {
        if (err.stdout?.includes('"Id"')) return err.stdout;
        throw err;
    }
}

/** 仅匹配 Bot 渲染器启动的浏览器，避免误杀用户桌面 Chrome/Edge */
const MANAGED_BROWSER_RE = /--headless|remote-debugging-port|puppeteer|playwright|user-data-dir/i;
const BROWSER_NAME_RE = /chrome|chromium|msedge/i;

/**
 * 系统监控：内存 / CPU / 托管浏览器进程
 */
class SystemMonitor extends EventEmitter {
    static instance = null;

    isRunning = false;
    monitorInterval = null;
    reportInterval = null;
    config = {};
    lastOptimizeTime = 0;
    _browserProbeDisabled = false;
    browserCache = { data: [], timestamp: 0, ttl: 5000 };
    cpuHistory = [];
    memoryHistory = [];
    leakDetection = {
        enabled: false,
        threshold: 0.1,
        checkInterval: 300000,
        lastCheck: 0,
        baseline: null,
        growthRate: []
    };

    static getInstance() {
        if (!SystemMonitor.instance) {
            SystemMonitor.instance = new SystemMonitor();
        }
        return SystemMonitor.instance;
    }

    constructor() {
        super();
    }

    async start(config) {
        if (this.isRunning) return;

        this.config = {
            enabled: config?.enabled !== false,
            interval: config?.interval || 120000,
            browser: {
                enabled: config?.browser?.enabled !== false,
                maxInstances: config?.browser?.maxInstances || 5,
                reserveNewest: config?.browser?.reserveNewest !== false
            },
            memory: {
                enabled: config?.memory?.enabled !== false,
                systemThreshold: config?.memory?.systemThreshold || 85,
                nodeThreshold: config?.memory?.nodeThreshold || 85,
                autoOptimize: config?.memory?.autoOptimize !== false,
                gcInterval: config?.memory?.gcInterval || 600000,
                leakDetection: {
                    enabled: config?.memory?.leakDetection?.enabled === true,
                    threshold: config?.memory?.leakDetection?.threshold ?? 0.1,
                    checkInterval: config?.memory?.leakDetection?.checkInterval ?? 300000
                }
            },
            cpu: {
                enabled: config?.cpu?.enabled !== false,
                threshold: config?.cpu?.threshold || 90
            },
            optimize: {
                aggressive: config?.optimize?.aggressive === true,
                autoRestart: config?.optimize?.autoRestart === true,
                restartThreshold: config?.optimize?.restartThreshold || 95
            },
            report: {
                enabled: config?.report?.enabled !== false,
                interval: config?.report?.interval || 3600000
            }
        };

        if (!this.config.enabled) return;

        this.isRunning = true;

        const leakConfig = this.config.memory.leakDetection;
        this.leakDetection.enabled = leakConfig.enabled;
        this.leakDetection.threshold = leakConfig.threshold;
        this.leakDetection.checkInterval = leakConfig.checkInterval;

        this.safeRun(() => this.checkSystem(), '系统监控首次检查');

        this.monitorInterval = setInterval(() => {
            this.safeRun(() => this.checkSystem(), '系统监控检查');
        }, this.config.interval);

        if (this.config.report.enabled) {
            this.reportInterval = setInterval(() => {
                this.safeRun(() => this.generateReport(), '系统监控报告生成');
            }, this.config.report.interval);
        }
    }

    stop() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
        if (this.reportInterval) {
            clearInterval(this.reportInterval);
            this.reportInterval = null;
        }
        this.isRunning = false;
        logger.info('系统监控已停止');
    }

    async safeRun(task, label = '系统任务') {
        try {
            await task();
        } catch (error) {
            logger.error(`${label}失败: ${error?.stack || error?.message || error}`);
        }
    }

    async checkSystem() {
        if (!this.isRunning || !this.config.enabled) return;

        try {
            const status = {
                timestamp: Date.now(),
                memory: this.config.memory?.enabled ? await this.checkMemory() : null,
                cpu: this.config.cpu?.enabled ? await this.checkCPU() : null,
                browser: this.config.browser?.enabled ? await this.checkBrowser() : null,
                leak: this.leakDetection.enabled ? this.detectMemoryLeak() : null
            };

            if (status.leak) {
                logger.warn(`潜在堆内存持续增长: ${(status.leak.growthPercent).toFixed(2)}%（仅告警，不自动优化）`);
            }

            const needOptimize = this.analyzeStatus(status);
            if (needOptimize && this.config.memory?.autoOptimize) {
                await this.optimizeSystem(status);
            }

            this.emit('status', status);
        } catch (error) {
            logger.error(`系统检查失败: ${error.message}`);
        }
    }

    async checkMemory() {
        const processMemory = process.memoryUsage();
        const systemMemory = this.getSystemMemory();
        const heapStats = v8.getHeapStatistics();

        const heapUsedPercent = (processMemory.heapUsed / heapStats.heap_size_limit) * 100;
        const systemUsedPercent = systemMemory.usedPercent;

        this.memoryHistory.push({
            timestamp: Date.now(),
            heapUsed: processMemory.heapUsed,
            systemUsed: systemMemory.used
        });
        if (this.memoryHistory.length > 50) this.memoryHistory.shift();

        return {
            process: {
                heapUsed: processMemory.heapUsed,
                heapTotal: processMemory.heapTotal,
                rss: processMemory.rss,
                heapUsedPercent
            },
            system: {
                total: systemMemory.total,
                used: systemMemory.used,
                free: systemMemory.free,
                usedPercent: systemUsedPercent
            },
            warning: heapUsedPercent > this.config.memory.nodeThreshold ||
                systemUsedPercent > this.config.memory.systemThreshold
        };
    }

    async checkCPU() {
        const startUsage = process.cpuUsage();
        const startTime = Date.now();
        await new Promise(resolve => setTimeout(resolve, 1000));

        const endUsage = process.cpuUsage(startUsage);
        const elapsedTime = Date.now() - startTime;
        const cpuPercent = ((endUsage.user + endUsage.system) / 1000 / elapsedTime) * 100;
        const loadAvg = os.loadavg();

        this.cpuHistory.push({ timestamp: Date.now(), usage: cpuPercent });
        if (this.cpuHistory.length > 30) this.cpuHistory.shift();

        return {
            usage: cpuPercent,
            loadAvg: loadAvg[0],
            cores: os.cpus().length,
            warning: cpuPercent > this.config.cpu.threshold
        };
    }

    async checkBrowser() {
        if (!this.config.browser?.enabled || this._browserProbeDisabled) {
            return null;
        }

        const now = Date.now();
        if (this.browserCache.data.length > 0 &&
            (now - this.browserCache.timestamp) < this.browserCache.ttl) {
            return { processes: this.browserCache.data, fromCache: true };
        }

        const processes = await this.detectBrowserProcesses();
        const maxInstances = this.config.browser.maxInstances;

        if (processes.length > maxInstances) {
            logger.warn(`托管浏览器进程过多 (${processes.length}/${maxInstances})，执行清理...`);
            await this.cleanupBrowsers(processes);
            const remaining = await this.detectBrowserProcesses();
            this.browserCache = { data: remaining, timestamp: now, ttl: 5000 };
            return {
                count: remaining.length,
                processes: remaining,
                cleaned: processes.length - remaining.length
            };
        }

        this.browserCache = { data: processes, timestamp: now, ttl: 5000 };
        return { count: processes.length, processes };
    }

    isManagedBrowserProcess(proc) {
        const text = `${proc.command || ''} ${proc.path || ''}`;
        return MANAGED_BROWSER_RE.test(text);
    }

    isBrowserProcess(proc) {
        const text = `${proc.command || ''} ${proc.path || ''}`;
        return BROWSER_NAME_RE.test(text);
    }

    filterManagedBrowsers(processes) {
        return processes.filter(p => this.isBrowserProcess(p) && this.isManagedBrowserProcess(p));
    }

    async detectBrowserProcesses() {
        if (this._browserProbeDisabled) return [];

        const platform = process.platform;

        try {
            if (platform === 'win32') {
                const stdout = await runWindowsProcessList();
                return this.filterManagedBrowsers(this.parseWin32BrowserCsv(stdout));
            }

            const command = platform === 'darwin'
                ? 'ps -ax -o pid=,etime=,command='
                : 'ps -eo pid=,etime=,cmd=';

            const { stdout } = await execAsync(command, { timeout: 15000, windowsHide: true });
            return this.filterManagedBrowsers(this.parseBrowserProcesses(stdout, platform));
        } catch (error) {
            const msg = error?.message || String(error);
            if (platform === 'win32') {
                this._browserProbeDisabled = true;
                logger.debug('[SystemMonitor] 浏览器进程探测不可用，已关闭此项检查');
            } else {
                logger.debug(`[SystemMonitor] 获取浏览器进程失败: ${msg}`);
            }
            return [];
        }
    }

    parseWin32BrowserCsv(output) {
        const processes = [];
        for (const line of output.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('"Id"')) continue;
            const match = trimmed.match(/^"(\d+)","([^"]*)","([^"]*)"$/);
            if (!match) continue;
            const pid = parseInt(match[1], 10);
            if (Number.isNaN(pid)) continue;
            const path = match[3];
            processes.push({
                pid,
                startTime: this.parseStartTime(match[2], 'win32'),
                command: path,
                path
            });
        }
        return processes.sort((a, b) => b.startTime - a.startTime);
    }

    parseBrowserProcesses(output, platform) {
        const processes = [];
        const lines = output.split('\n').filter(line => line.trim());

        for (const line of lines) {
            try {
                const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
                if (!match) continue;
                const pid = parseInt(match[1], 10);
                if (Number.isNaN(pid)) continue;

                processes.push({
                    pid,
                    startTime: this.parseStartTime(match[2], platform),
                    command: match[3]
                });
            } catch {
                continue;
            }
        }

        return processes.sort((a, b) => b.startTime - a.startTime);
    }

    parseStartTime(timeStr, platform) {
        if (platform === 'win32') {
            const t = Date.parse(timeStr);
            return Number.isFinite(t) ? t : Date.now();
        }

        const now = Date.now();
        const parts = timeStr.split(/[-:]/);
        let totalMs = 0;
        if (parts.length === 2) {
            totalMs = (parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10)) * 1000;
        } else if (parts.length === 3) {
            totalMs = (parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10)) * 1000;
        }
        return now - totalMs;
    }

    async cleanupBrowsers(processes) {
        const maxInstances = this.config.browser.maxInstances;
        const reserveNewest = this.config.browser.reserveNewest !== false;
        const sorted = [...processes].sort((a, b) => b.startTime - a.startTime);
        const toRemove = reserveNewest
            ? sorted.slice(maxInstances)
            : sorted.slice(0, sorted.length - maxInstances);

        if (toRemove.length === 0) return 0;

        let cleaned = 0;
        await Promise.allSettled(toRemove.map(async (proc) => {
            try {
                const cmd = process.platform === 'win32'
                    ? `taskkill /F /PID ${proc.pid}`
                    : `kill -15 ${proc.pid}`;
                await execAsync(cmd, { timeout: 3000, windowsHide: true });
                cleaned++;
            } catch (e) {
                if (e.message?.includes('not found') || e.message?.includes('No such process')) {
                    cleaned++;
                }
            }
        }));

        if (cleaned > 0) {
            logger.info(`已清理 ${cleaned} 个托管浏览器进程 (保留 ${maxInstances} 个)`);
        }
        return cleaned;
    }

    analyzeStatus(status) {
        const issues = [];

        if (status.memory?.warning) issues.push('memory');
        if (status.cpu?.warning) issues.push('cpu');

        if (this.config.optimize?.autoRestart &&
            status.memory?.system?.usedPercent > this.config.optimize.restartThreshold) {
            logger.error(`系统内存超过 ${this.config.optimize.restartThreshold}%，建议重启`);
            this.emit('critical', { type: 'memory', status });
        }

        return issues.length > 0;
    }

    detectMemoryLeak() {
        if (!this.leakDetection.enabled) return null;

        const now = Date.now();
        if (now - this.leakDetection.lastCheck < this.leakDetection.checkInterval) {
            return null;
        }

        const heapUsed = process.memoryUsage().heapUsed;

        if (!this.leakDetection.baseline) {
            this.leakDetection.baseline = heapUsed;
            this.leakDetection.lastCheck = now;
            return null;
        }

        const growth = (heapUsed - this.leakDetection.baseline) / this.leakDetection.baseline;
        this.leakDetection.growthRate.push({ timestamp: now, growth, heapUsed });
        if (this.leakDetection.growthRate.length > 10) {
            this.leakDetection.growthRate.shift();
        }

        this.leakDetection.lastCheck = now;

        if (this.leakDetection.growthRate.length < 5) return null;

        const recentGrowth = this.leakDetection.growthRate.slice(-5);
        const avgGrowth = recentGrowth.reduce((sum, r) => sum + r.growth, 0) / recentGrowth.length;

        if (avgGrowth <= this.leakDetection.threshold) return null;

        const growthPercent = avgGrowth * 100;
        this.emit('leak', {
            growth: avgGrowth,
            baseline: this.leakDetection.baseline,
            current: heapUsed,
            history: this.leakDetection.growthRate
        });

        return {
            growth: avgGrowth,
            current: heapUsed,
            baseline: this.leakDetection.baseline,
            growthPercent
        };
    }

    async optimizeSystem() {
        const now = Date.now();
        const gcInterval = this.config.memory?.gcInterval || 600000;
        if (now - this.lastOptimizeTime < gcInterval) return;

        logger.info('执行系统优化...');
        this.lastOptimizeTime = now;

        const beforeMem = process.memoryUsage();

        if (typeof global.gc === 'function') {
            global.gc();
            logger.info('已执行垃圾回收');
        }

        await new Promise(resolve => setTimeout(resolve, 100));

        this.browserCache = { data: [], timestamp: 0, ttl: 5000 };
        this.cpuHistory = this.cpuHistory.slice(-10);
        this.memoryHistory = this.memoryHistory.slice(-10);

        if (this.config.optimize?.aggressive && typeof global.gc === 'function') {
            await new Promise(resolve => setTimeout(resolve, 500));
            global.gc();
            if (process.platform === 'linux') {
                await execAsync('sync').catch(() => {});
            }
        }

        const afterMem = process.memoryUsage();
        const freed = beforeMem.heapUsed - afterMem.heapUsed;

        logger.info(`优化完成，当前堆内存: ${(afterMem.heapUsed / 1024 / 1024).toFixed(2)}MB`);
        if (freed > 0) {
            logger.info(`释放内存: ${(freed / 1024 / 1024).toFixed(2)}MB (${(freed / beforeMem.heapUsed * 100).toFixed(2)}%)`);
        }

        if (afterMem.heapUsed < this.leakDetection.baseline * 0.9) {
            this.leakDetection.baseline = afterMem.heapUsed;
            this.leakDetection.growthRate = [];
        }

        this.emit('optimized', { before: beforeMem, after: afterMem, freed });
    }

    generateReport() {
        const memory = this.getSystemMemory();
        const processMemory = process.memoryUsage();
        const heapStats = v8.getHeapStatistics();
        const loadAvg = os.loadavg();

        logger.line();
        logger.info(logger.gradient('系统监控报告'));
        logger.info(`时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
        logger.info(`系统: ${process.platform} | Node: ${process.version}`);
        logger.info(`运行时长: ${this.formatUptime(process.uptime())}`);
        logger.line();
        logger.info(`系统内存: ${this.formatBytes(memory.used)} / ${this.formatBytes(memory.total)} (${memory.usedPercent.toFixed(1)}%)`);
        logger.info(`Node堆内存: ${this.formatBytes(processMemory.heapUsed)} / ${this.formatBytes(heapStats.heap_size_limit)} (${((processMemory.heapUsed / heapStats.heap_size_limit) * 100).toFixed(1)}%)`);
        logger.info(`CPU负载: ${loadAvg[0].toFixed(2)} | 核心数: ${os.cpus().length}`);

        if (this.config.browser?.enabled && this.browserCache.data.length > 0) {
            logger.info(`托管浏览器进程: ${this.browserCache.data.length} 个`);
        }

        logger.line();
    }

    getSystemMemory() {
        const total = os.totalmem();
        const free = os.freemem();
        const used = total - free;
        return { total, free, used, usedPercent: (used / total) * 100 };
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
    }

    formatUptime(seconds) {
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const parts = [];
        if (d > 0) parts.push(`${d}天`);
        if (h > 0) parts.push(`${h}时`);
        if (m > 0) parts.push(`${m}分`);
        return parts.join('') || '< 1分';
    }
}

export default SystemMonitor;
