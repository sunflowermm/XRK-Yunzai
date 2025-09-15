import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import v8 from 'v8';
import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';

const execAsync = promisify(exec);

/**
 * Node内存监控器
 * 监控和优化Node.js进程内存使用
 */
class NodeMemoryMonitor extends EventEmitter {
    static instance = null;

    /**
     * 获取单例实例
     * @returns {NodeMemoryMonitor} 监控器实例
     */
    static getInstance() {
        if (!NodeMemoryMonitor.instance) {
            NodeMemoryMonitor.instance = new NodeMemoryMonitor();
        }
        return NodeMemoryMonitor.instance;
    }

    constructor() {
        super();
        this.isRunning = false;
        this.monitorInterval = null;
        this.memoryThreshold = 85; // 默认内存阈值（百分比）
        this.nodeMemoryThreshold = 85; // Node进程内存阈值（百分比）
        this.heapUsageHistory = []; // 保存历史堆内存使用记录
        this.lastGCTime = Date.now(); // 上次垃圾回收时间
        this.gcMinInterval = 600000; // 最小垃圾回收间隔（10分钟）
        this.snapshotDir = path.join(process.cwd(), 'data', 'diagnostics'); // 快照存储目录
        this.maxSnapshots = 3; // 最多保留的堆快照数量
        this.lastLeakCheck = Date.now(); // 上次内存泄漏检查时间
        this.leakThreshold = 10; // 持续增长内存百分比阈值
        this.autoOptimizeEnabled = true; // 是否启用自动优化
        this.diagnosticsEnabled = false; // 是否启用诊断功能
        this.memoryLimitMB = 0; // 内存限制（MB，0表示自动）
        this.statusData = {
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            pid: process.pid,
            memoryUsage: {},
            systemMemory: {},
            heapStatistics: {},
            lastGC: null,
            metricsHistory: {
                timestamps: [],
                heapUsed: [],
                rss: [],
                systemMemUsed: []
            },
            alerts: []
        };
        this.lastHeapUsedPercent = 0; // 上次堆内存使用率
        this.lastRssPercent = 0; // 上次RSS内存使用率
    }

    /**
     * 启动内存监控
     * @param {Object} options 配置选项
     */
    async start(options = {}) {
        if (this.isRunning) {
            logger.info('Node内存监控已在运行中...');
            return;
        }

        // 更新配置
        this.memoryThreshold = options.memoryThreshold ?? this.memoryThreshold;
        this.nodeMemoryThreshold = options.nodeMemoryThreshold ?? this.nodeMemoryThreshold;
        this.autoOptimizeEnabled = options.autoOptimize ?? this.autoOptimizeEnabled;
        this.diagnosticsEnabled = options.diagnostics ?? this.diagnosticsEnabled;
        this.memoryLimitMB = options.memoryLimitMB ?? this.memoryLimitMB;

        if (this.memoryLimitMB > 0) {
            try {
                v8.setHeapSizeLimit(this.memoryLimitMB * 1024 * 1024);
                logger.info(`已设置Node.js堆内存限制为 ${this.memoryLimitMB}MB`);
            } catch (error) {
                logger.warn(`设置堆内存限制失败: ${error.message}`);
            }
        }

        // 创建快照目录
        if (this.diagnosticsEnabled) {
            try {
                await fs.mkdir(this.snapshotDir, { recursive: true });
            } catch (error) {
                logger.warn(`创建诊断目录失败: ${error.message}`);
                this.diagnosticsEnabled = false;
            }
        }

        const interval = options.interval || 300000; // 默认5分钟
        this.isRunning = true;

        await this.checkMemory();
        this.monitorInterval = setInterval(() => this.checkMemory(), interval);

        logger.info('Node内存监控已启动');
    }

    /**
     * 停止内存监控
     */
    stop() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
        this.isRunning = false;
        logger.info('Node内存监控已停止');
    }

    /**
     * 检查内存使用情况并在必要时采取措施
     */
    async checkMemory() {
        try {
            const memoryUsage = process.memoryUsage();
            const systemMemory = this.getSystemMemoryInfo();
            const heapStats = v8.getHeapStatistics();
            const heapUsedPercent = (memoryUsage.heapUsed / heapStats.heap_size_limit) * 100;
            const rssPercent = (memoryUsage.rss / os.totalmem()) * 100;

            this.updateMetricsHistory(memoryUsage, systemMemory);
            this.statusData.memoryUsage = memoryUsage;
            this.statusData.systemMemory = systemMemory;
            this.statusData.heapStatistics = heapStats;

            const alerts = [];
            let needOptimize = false;

            // 检查系统内存和Node进程内存
            if (systemMemory.usedPercent > this.memoryThreshold) {
                needOptimize = true;
                const alert = `系统内存使用率 ${systemMemory.usedPercent.toFixed(2)}% 超过阈值 ${this.memoryThreshold}%`;
                alerts.push({ type: 'system_memory', message: alert, level: 'warning' });
                logger.warn(alert);
            }

            if (heapUsedPercent > this.nodeMemoryThreshold) {
                needOptimize = true;
                const alert = `Node.js堆内存使用率 ${heapUsedPercent.toFixed(2)}% 超过阈值 ${this.nodeMemoryThreshold}%`;
                alerts.push({ type: 'node_memory', message: alert, level: 'warning' });
                logger.warn(alert);
            }

            // 检查内存泄漏（每30分钟一次）
            const leakAlert = this.checkForMemoryLeaks();
            if (leakAlert) {
                alerts.push(leakAlert);
                needOptimize = true;
            }

            // 只有显著变化时触发事件
            const heapChange = Math.abs(heapUsedPercent - this.lastHeapUsedPercent);
            const rssChange = Math.abs(rssPercent - this.lastRssPercent);
            if (heapChange > 5 || rssChange > 5) {
                this.lastHeapUsedPercent = heapUsedPercent;
                this.lastRssPercent = rssPercent;
                this.emit('memory-check', {
                    timestamp: new Date(),
                    memoryUsage,
                    systemMemory,
                    heapStats,
                    heapUsedPercent,
                    rssPercent,
                    needOptimize,
                    alerts
                });
            }

            if (needOptimize && this.autoOptimizeEnabled) {
                await this.optimizeMemory();
            }

            this.statusData.alerts = alerts;
        } catch (error) {
            logger.error(`内存检查失败: ${error.message}`);
            this.emit('error', error);
        }
    }

    /**
     * 更新历史指标数据
     */
    updateMetricsHistory(memoryUsage, systemMemory) {
        const timestamp = Date.now();
        this.heapUsageHistory.push({ timestamp, heapUsed: memoryUsage.heapUsed, rss: memoryUsage.rss });

        if (this.heapUsageHistory.length > 100) {
            this.heapUsageHistory.shift();
        }

        this.statusData.metricsHistory.timestamps.push(timestamp);
        this.statusData.metricsHistory.heapUsed.push(Math.round(memoryUsage.heapUsed / 1024 / 1024));
        this.statusData.metricsHistory.rss.push(Math.round(memoryUsage.rss / 1024 / 1024));
        this.statusData.metricsHistory.systemMemUsed.push(systemMemory.usedPercent);

        if (this.statusData.metricsHistory.timestamps.length > 100) {
            this.statusData.metricsHistory.timestamps.shift();
            this.statusData.metricsHistory.heapUsed.shift();
            this.statusData.metricsHistory.rss.shift();
            this.statusData.metricsHistory.systemMemUsed.shift();
        }
    }

    /**
     * 检查内存泄漏
     */
    checkForMemoryLeaks() {
        const now = Date.now();
        if (now - this.lastLeakCheck < 30 * 60 * 1000 || this.heapUsageHistory.length < 10) {
            return null;
        }

        this.lastLeakCheck = now;
        const samples = this.heapUsageHistory.slice(-10);
        const firstHeapUsed = samples[0].heapUsed;
        const lastHeapUsed = samples[samples.length - 1].heapUsed;
        const growthPercent = ((lastHeapUsed - firstHeapUsed) / firstHeapUsed) * 100;

        if (growthPercent > this.leakThreshold) {
            const alert = `可能存在内存泄漏，堆内存在监测期内增长了 ${growthPercent.toFixed(2)}%`;
            logger.warn(alert);
            if (this.diagnosticsEnabled) {
                this.createHeapSnapshot(false);
            }
            return { type: 'memory_leak', message: alert, level: 'critical', growthPercent };
        }
        return null;
    }

    /**
     * 优化内存使用
     */
    async optimizeMemory() {
        const now = Date.now();
        if (now - this.lastGCTime < this.gcMinInterval) {
            logger.info(`跳过内存优化，距上次优化不足${this.gcMinInterval / 1000}秒`);
            return;
        }

        logger.info('执行内存优化...');
        if (global.gc) {
            logger.info('执行强制垃圾回收');
            global.gc();
            this.lastGCTime = now;
            this.statusData.lastGC = now;

            const afterGC = process.memoryUsage();
            logger.info(`垃圾回收完成，当前堆内存: ${(afterGC.heapUsed / 1024 / 1024).toFixed(2)}MB`);
            this.emit('gc-completed', { timestamp: new Date(), memoryBefore: this.statusData.memoryUsage, memoryAfter: afterGC });
            this.statusData.memoryUsage = afterGC;
        } else {
            logger.warn('无法执行垃圾回收，请使用 --expose-gc 参数启动Node.js');
        }
    }

    /**
     * 创建堆内存快照
     */
    async createHeapSnapshot(isScheduled = false) {
        if (!this.diagnosticsEnabled) return;

        try {
            const timestamp = new Date().toISOString().replace(/:/g, '-');
            const type = isScheduled ? 'scheduled' : 'leak-suspected';
            const snapshotPath = path.join(this.snapshotDir, `heapsnapshot-${process.pid}-${type}-${timestamp}.heapsnapshot`);

            logger.info(`创建堆内存快照: ${path.basename(snapshotPath)}`);
            const snapshot = v8.getHeapSnapshot();
            const snapshotFile = createWriteStream(snapshotPath);

            let size = 0;
            snapshot.on('data', (chunk) => size += chunk.length);
            snapshot.on('end', () => {
                logger.info(`堆快照完成，大小: ${(size / 1024 / 1024).toFixed(2)}MB`);
                this.compressFile(snapshotPath);
                this.cleanupOldSnapshots();
            });
            snapshot.pipe(snapshotFile);
        } catch (error) {
            logger.error(`创建堆快照失败: ${error.message}`);
        }
    }

    /**
     * 压缩文件
     */
    async compressFile(filePath) {
        try {
            const gzipPath = `${filePath}.gz`;
            await pipeline(createReadStream(filePath), createGzip(), createWriteStream(gzipPath));
            await fs.unlink(filePath);
            logger.info(`文件已压缩: ${path.basename(gzipPath)}`);
        } catch (error) {
            logger.warn(`文件压缩失败: ${error.message}`);
        }
    }

    /**
     * 清理旧快照文件
     */
    async cleanupOldSnapshots() {
        try {
            const files = await fs.readdir(this.snapshotDir);
            const snapshots = files
                .filter(file => file.includes('heapsnapshot') && file.endsWith('.gz'))
                .map(file => ({
                    name: file,
                    path: path.join(this.snapshotDir, file),
                    time: file.match(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/)[0]
                }))
                .sort((a, b) => b.time.localeCompare(a.time));

            if (snapshots.length > this.maxSnapshots) {
                const toDelete = snapshots.slice(this.maxSnapshots);
                for (const snapshot of toDelete) {
                    await fs.unlink(snapshot.path);
                    logger.info(`已删除旧快照: ${snapshot.name}`);
                }
            }
        } catch (error) {
            logger.warn(`清理旧快照失败: ${error.message}`);
        }
    }

    /**
     * 获取系统内存信息
     */
    getSystemMemoryInfo() {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const usedPercent = (usedMem / totalMem) * 100;
        return { total: totalMem, free: freeMem, used: usedMem, usedPercent };
    }

    /**
     * 获取当前状态报告
     */
    getStatusReport() {
        const memUsage = process.memoryUsage();
        const heapStats = v8.getHeapStatistics();
        const sysMemory = this.getSystemMemoryInfo();

        return {
            timestamp: new Date(),
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            uptime: process.uptime(),
            memoryUsage: {
                rss: formatBytes(memUsage.rss),
                heapTotal: formatBytes(memUsage.heapTotal),
                heapUsed: formatBytes(memUsage.heapUsed),
                external: formatBytes(memUsage.external),
                arrayBuffers: formatBytes(memUsage.arrayBuffers || 0)
            },
            heapStatistics: {
                totalHeapSize: formatBytes(heapStats.total_heap_size),
                totalHeapSizeExecutable: formatBytes(heapStats.total_heap_size_executable),
                totalPhysicalSize: formatBytes(heapStats.total_physical_size),
                totalAvailableSize: formatBytes(heapStats.total_available_size),
                usedHeapSize: formatBytes(heapStats.used_heap_size),
                heapSizeLimit: formatBytes(heapStats.heap_size_limit),
                mallocedMemory: formatBytes(heapStats.malloced_memory),
                peakMallocedMemory: formatBytes(heapStats.peak_malloced_memory),
                doesZapGarbage: heapStats.does_zap_garbage
            },
            systemMemory: {
                total: formatBytes(sysMemory.total),
                used: formatBytes(sysMemory.used),
                free: formatBytes(sysMemory.free),
                usedPercent: sysMemory.usedPercent.toFixed(2) + '%'
            },
            monitorStatus: {
                isRunning: this.isRunning,
                memoryThreshold: this.memoryThreshold + '%',
                nodeMemoryThreshold: this.nodeMemoryThreshold + '%',
                autoOptimizeEnabled: this.autoOptimizeEnabled,
                diagnosticsEnabled: this.diagnosticsEnabled
            }
        };
    }

    /**
     * 生成内存使用情况报告
     */
    async generateReport() {
        try {
            const report = this.getStatusReport();
            logger.line();
            logger.info(logger.gradient('Node内存监控报告'));
            logger.info(`Node版本: ${report.nodeVersion}`);
            logger.info(`平台: ${report.platform} (${report.arch})`);
            logger.info(`运行时间: ${formatTime(report.uptime)}`);
            logger.info(`进程ID: ${process.pid}`);
            logger.line();
            logger.info(`RSS内存: ${report.memoryUsage.rss}`);
            logger.info(`堆内存: ${report.memoryUsage.heapUsed} / ${report.memoryUsage.heapTotal}`);
            logger.info(`堆大小限制: ${report.heapStatistics.heapSizeLimit}`);
            logger.info(`系统内存: ${report.systemMemory.used} / ${report.systemMemory.total} (${report.systemMemory.usedPercent})`);
            logger.line();
            logger.info(`监控状态: ${report.monitorStatus.isRunning ? '运行中' : '已停止'}`);
            logger.info(`内存阈值: 系统=${report.monitorStatus.memoryThreshold}, Node=${report.monitorStatus.nodeMemoryThreshold}`);
            logger.info(`自动优化: ${report.monitorStatus.autoOptimizeEnabled ? '已启用' : '已禁用'}`);
            logger.info(`诊断功能: ${report.monitorStatus.diagnosticsEnabled ? '已启用' : '已禁用'}`);
            logger.line();
            return report;
        } catch (error) {
            logger.error(`生成报告失败: ${error.message}`);
            return null;
        }
    }

    /**
     * 尝试修复系统内存问题
     */
    async fixMemoryIssues(options = { aggressive: false }) {
        try {
            logger.info('开始内存问题修复...');
            if (global.gc) {
                logger.info('执行完全垃圾回收');
                global.gc(true);
                await new Promise(resolve => setTimeout(resolve, 500));
                global.gc(true);
                const memUsage = process.memoryUsage();
                logger.info(`垃圾回收后堆内存: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`);
            }

            if (options.aggressive && this.diagnosticsEnabled) {
                await this.createHeapSnapshot(false);
            }

            if (options.aggressive) {
                if (process.platform === 'linux') {
                    await execAsync('sync && echo 1 > /proc/sys/vm/drop_caches').catch(err => 
                        logger.warn(`Linux缓存释放失败 (可能需要root权限): ${err.message}`)
                    );
                } else if (process.platform === 'win32') {
                    await execAsync('powershell -Command "& {[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()}"')
                        .catch(err => logger.warn(`Windows内存优化失败: ${err.message}`));
                }
            }

            this.emit('request-redis-cleanup', { aggressive: options.aggressive });
            return true;
        } catch (error) {
            logger.error(`内存问题修复失败: ${error.message}`);
            return false;
        }
    }
}

/**
 * 格式化字节大小为可读格式
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * 格式化时间（秒）为可读格式
 */
function formatTime(seconds) {
    const days = Math.floor(seconds / 86400);
    seconds %= 86400;
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    seconds = Math.floor(seconds % 60);
    const parts = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分钟`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);
    return parts.join(' ');
}

/**
 * 内存监控API
 */
export class NodeMemoryAPI {
    static async startMonitoring(options = {}) {
        const monitor = NodeMemoryMonitor.getInstance();
        await monitor.start(options);
        return true;
    }

    static stopMonitoring() {
        const monitor = NodeMemoryMonitor.getInstance();
        monitor.stop();
        return true;
    }

    static async getReport() {
        const monitor = NodeMemoryMonitor.getInstance();
        return await monitor.generateReport();
    }

    static async optimizeMemory(aggressive = false) {
        const monitor = NodeMemoryMonitor.getInstance();
        return await monitor.fixMemoryIssues({ aggressive });
    }

    static async createHeapSnapshot() {
        const monitor = NodeMemoryMonitor.getInstance();
        await monitor.createHeapSnapshot(false);
        return true;
    }

    static isRunning() {
        return NodeMemoryMonitor.getInstance().isRunning;
    }

    static getMemoryUsage() {
        return {
            process: process.memoryUsage(),
            system: NodeMemoryMonitor.getInstance().getSystemMemoryInfo()
        };
    }

    static getSystemInfo() {
        return {
            platform: process.platform,
            arch: process.arch,
            nodeVersion: process.version,
            cpus: os.cpus().length,
            totalMemory: formatBytes(os.totalmem()),
            uptime: formatTime(os.uptime())
        };
    }
}

export const memoryMonitor = NodeMemoryMonitor.getInstance();
export default NodeMemoryAPI;