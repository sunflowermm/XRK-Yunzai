import path from 'path';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import EventEmitter from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import fs from 'fs';

const execAsync = promisify(exec);
const ROOT_PATH = process.cwd();

// SQLite数据库配置
const DB_PATH = path.join(ROOT_PATH, 'data/shot/browser-manager.db');

/**
 * 数据库管理类
 * 负责浏览器监控相关的数据存储
 */
class DB {
    static instance = null;
    
    static async getInstance() {
        if (!DB.instance) {
            try {
                const dbDir = path.dirname(DB_PATH);
                if (!fs.existsSync(dbDir)) {
                    fs.mkdirSync(dbDir, { recursive: true });
                }
                
                DB.instance = await open({
                    filename: DB_PATH,
                    driver: sqlite3.Database
                });
                
                await DB.instance.exec(`
                    CREATE TABLE IF NOT EXISTS system_browser_stats (
                        timestamp INTEGER PRIMARY KEY,
                        browser_count INTEGER,
                        memory_usage REAL,
                        cpu_load REAL
                    );

                    CREATE TABLE IF NOT EXISTS browser_monitor_status (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        is_running INTEGER DEFAULT 0,
                        last_started INTEGER,
                        pid INTEGER
                    );
                    
                    CREATE TABLE IF NOT EXISTS browser_instances (
                        pid INTEGER PRIMARY KEY,
                        name TEXT,
                        start_time INTEGER,
                        last_seen INTEGER,
                        command TEXT,
                        is_main_process INTEGER DEFAULT 1
                    );
                `);

                // 初始化监控状态表
                const status = await DB.instance.get('SELECT * FROM browser_monitor_status WHERE id = 1');
                if (!status) {
                    await DB.instance.run(
                        'INSERT INTO browser_monitor_status (id, is_running, last_started, pid) VALUES (1, 0, 0, 0)'
                    );
                }
            } catch (err) {
                logger.error('数据库初始化失败，使用内存模式:', err);
                return {
                    run: async () => ({ changes: 0 }),
                    get: async () => null,
                    all: async () => [],
                    exec: async () => {},
                    close: async () => {}
                };
            }
        }
        
        return DB.instance;
    }
    
    static async close() {
        if (DB.instance) {
            try {
                await DB.instance.close();
            } catch (e) {
                // 静默处理关闭错误
            }
            DB.instance = null;
        }
    }
}

/**
 * 系统浏览器监控器
 * 检测系统中运行的Chrome/Chromium实例并管理其生命周期
 */
class BrowserMonitor extends EventEmitter {
    static instance = null;
    
    static getInstance() {
        if (!BrowserMonitor.instance) {
            BrowserMonitor.instance = new BrowserMonitor();
        }
        return BrowserMonitor.instance;
    }
    
    constructor() {
        super();
        this.isMonitoring = false;
        this.monitorInterval = null;
        this.reportInterval = null;
        this.knownBrowserPIDs = new Set();
        this.maxAllowedInstances = 3; // 最大允许的浏览器实例数
        this.memoryThreshold = 80; // 内存使用率阈值（百分比）
        this.reserveNewest = true; // 保留最新打开的浏览器实例
        this.db = null;
        this.lastReport = 0; // 上次报告时间
        this.reportFrequency = 3600000; // 每小时报告一次（毫秒）
        this.browserProcesses = []; // 保存最近检测到的浏览器进程
        this.errorCounts = {}; // 记录错误次数，防止重复记录相同错误
        this.processStartTimes = new Map(); // 记录进程启动时间
        this.reconnectAttempts = 0; // 数据库重连尝试次数
        this.maxReconnectAttempts = 5; // 最大重连次数
        this.browserProcessCache = { // 缓存检测到的浏览器进程
            data: [],
            timestamp: 0,
            ttl: 5000
        };
    }
    
    /**
     * 初始化监控器
     */
    async init() {
        try {
            this.db = await DB.getInstance();
            const status = await this.db.get('SELECT * FROM browser_monitor_status WHERE id = 1');
            
            if (status && status.is_running === 1) {
                const pidExists = await this.checkProcessExists(status.pid);
                
                if (pidExists) {
                    logger.debug(`检测到浏览器监控已在运行 (PID: ${status.pid})，跳过初始化`);
                    return false;
                } else {
                    await this.db.run(
                        'UPDATE browser_monitor_status SET is_running = 0 WHERE id = 1'
                    );
                    logger.debug('浏览器监控状态已重置');
                }
            }
            
            // 更新监控状态
            await this.db.run(
                'UPDATE browser_monitor_status SET is_running = 1, last_started = ?, pid = ? WHERE id = 1',
                Date.now(),
                process.pid
            );
            await this.cleanupStaleInstances();
            logger.debug('浏览器监控器初始化完成');
            return true;
        } catch (error) {
            logger.debug('浏览器监控器初始化失败:', error);
            return false;
        }
    }

    /**
     * 清理过期的浏览器实例记录
     */
    async cleanupStaleInstances() {
        try {
            const oneDayAgo = Date.now() - 86400000;
            await this.db.run(
                'DELETE FROM browser_instances WHERE last_seen < ?',
                oneDayAgo
            );
            logger.debug('已清理过期的浏览器实例记录');
        } catch (error) {
            logger.debug('清理过期实例记录失败:', error);
        }
    }

    /**
     * 检查进程是否存在
     * @param {number} pid - 进程ID
     * @returns {Promise<boolean>} 进程是否存在
     */
    async checkProcessExists(pid) {
        try {
            if (!pid || isNaN(parseInt(pid))) return false;
            
            if (process.platform === 'win32') {
                const { stdout } = await execAsync(`tasklist /FI "PID eq ${pid}" /NH`);
                return stdout.trim().includes(String(pid));
            } else {
                try {
                    const { stdout } = await execAsync(`ps -p ${pid} -o pid=`);
                    return stdout.trim() !== '';
                } catch (e) {
                    return false;
                }
            }
        } catch (error) {
            return false;
        }
    }

    /**
     * 启动系统浏览器监控
     * @param {number} interval - 监控间隔（毫秒）
     * @param {Object} options - 配置选项
     * @param {number} options.maxInstances - 最大允许的浏览器实例数
     * @param {number} options.memoryThreshold - 内存使用率阈值（百分比）
     * @param {number} options.reportFrequency - 状态报告频率（毫秒）
     * @param {boolean} options.reserveNewest - 是否保留最新打开的实例
     */
    async startMonitoring(interval = 30000, options = {}) {
        if (this.isMonitoring) {
            logger.debug('浏览器监控已在运行，忽略重复启动请求');
            return;
        }
        if (options.maxInstances) {
            this.maxAllowedInstances = options.maxInstances;
        }
        
        if (options.memoryThreshold) {
            this.memoryThreshold = options.memoryThreshold;
        }
        
        if (options.reportFrequency) {
            this.reportFrequency = options.reportFrequency;
        }
        
        if (options.hasOwnProperty('reserveNewest')) {
            this.reserveNewest = options.reserveNewest;
        }
        
        this.isMonitoring = true;
        await this.monitorTask();
        this.monitorInterval = setInterval(() => this.monitorTask(), interval);
        this.reportInterval = setInterval(() => this.reportStatus(), this.reportFrequency);
        
        logger.debug(`浏览器监控已启动，间隔: ${interval}ms，最大实例数: ${this.maxAllowedInstances}，保留最新实例: ${this.reserveNewest ? '是' : '否'}`);
    }
    
    /**
     * 停止系统浏览器监控
     */
    async stopMonitoring() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
        
        if (this.reportInterval) {
            clearInterval(this.reportInterval);
            this.reportInterval = null;
        }
        
        this.isMonitoring = false;
        
        if (this.db) {
            try {
                await this.db.run(
                    'UPDATE browser_monitor_status SET is_running = 0 WHERE id = 1'
                );
            } catch (error) {
                // 静默处理错误
            }
        }
        
        logger.debug('浏览器监控已停止');
    }
    
    /**
     * 监控任务
     * 检测浏览器进程并根据需要进行清理
     */
    async monitorTask() {
        try {
            const systemStatus = await this.getSystemStatus();
            this.emit('system-status', systemStatus);
            
            this.browserProcesses = systemStatus.browserProcesses;
            
            let needCleanup = false;
            let cleanupReason = '';
            
            if (systemStatus.browserCount > this.maxAllowedInstances) {
                needCleanup = true;
                cleanupReason = `检测到过多浏览器实例: ${systemStatus.browserCount}/${this.maxAllowedInstances}`;
            }
            
            if (systemStatus.memoryUsage > this.memoryThreshold) {
                needCleanup = true;
                cleanupReason = `系统内存使用率过高: ${systemStatus.memoryUsage.toFixed(2)}%，内存阈值: ${this.memoryThreshold}%`;
            }
            
            if (needCleanup) {
                logger.warn(cleanupReason);
                await this.cleanupExcessBrowsers(systemStatus.browserProcesses);
            }

            if (this.db) {
                try {
                    // 记录系统状态
                    await this.db.run(
                        `INSERT INTO system_browser_stats (timestamp, browser_count, memory_usage, cpu_load)
                         VALUES (?, ?, ?, ?)`,
                        Date.now(),
                        systemStatus.browserCount,
                        systemStatus.memoryUsage,
                        systemStatus.cpuInfo.loadAvg[0]
                    );
                } catch (error) {
                    this.reconnectDatabase();
                }
            }
        } catch (error) {
            logger.debug('浏览器监控任务出错:', error);
        }
    }
    
    /**
     * 尝试重新连接数据库
     */
    async reconnectDatabase() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            logger.debug(`数据库重连尝试次数已达上限(${this.maxReconnectAttempts})，不再尝试重连`);
            return;
        }
        
        this.reconnectAttempts++;
        
        try {
            await DB.close();
            this.db = await DB.getInstance();
            logger.debug(`数据库连接已重新建立，重连尝试次数: ${this.reconnectAttempts}`);
            this.reconnectAttempts = 0;
        } catch (error) {
            logger.debug(`数据库重连失败，尝试次数: ${this.reconnectAttempts}`, error);
        }
    }
    
    /**
     * 报告浏览器实例状态
     */
    async reportStatus() {
        try {
            const now = Date.now();
            
            if (now - this.lastReport < this.reportFrequency) {
                return;
            }
            
            this.lastReport = now;
            const stats = await BrowserMonitorTool.getStats();
            
            if (!stats || !stats.currentStatus) {
                return;
            }
            
            const { currentStatus, historical } = stats;
            
            logger.line();
            logger.info(logger.gradient('浏览器监控状态报告'));
            logger.info(`当前浏览器实例数: ${currentStatus.browserCount}`);
            logger.info(`系统内存使用率: ${currentStatus.memoryUsage.toFixed(2)}%`);
            logger.info(`CPU负载: ${currentStatus.cpuInfo.loadAvg[0].toFixed(2)}`);
            
            if (historical && historical.measurementsCount > 0) {
                logger.info(`历史平均浏览器实例数: ${historical.avgBrowserCount}`);
                logger.info(`历史最大浏览器实例数: ${historical.maxBrowserCount}`);
                logger.info(`历史平均内存使用率: ${historical.avgMemoryUsage}%`);
            }
            
            logger.line();
        } catch (error) {
            logger.debug('生成浏览器状态报告失败:', error);
        }
    }
    
    /**
     * 获取系统状态，包括运行中的浏览器进程和内存使用情况
     * @returns {Promise<Object>} 系统状态对象
     */
    async getSystemStatus() {
        try {
            // 获取主浏览器进程（过滤掉辅助进程）
            const browserProcesses = await this.detectBrowserProcesses();
            const memoryInfo = await this.getSystemMemoryInfo();
            
            return {
                timestamp: new Date(),
                browserProcesses,
                browserCount: browserProcesses.length,
                memoryInfo,
                memoryUsage: memoryInfo.usedPercent,
                cpuInfo: await this.getSystemCPUInfo()
            };
        } catch (error) {
            logger.debug('获取系统状态失败:', error);
            return {
                timestamp: new Date(),
                browserProcesses: [],
                browserCount: 0,
                memoryInfo: { total: 0, used: 0, free: 0, usedPercent: 0 },
                memoryUsage: 0,
                cpuInfo: { loadAvg: [0, 0, 0] }
            };
        }
    }
    
    /**
     * 检测系统中运行的Chrome/Chromium进程
     * @returns {Promise<Array>} 浏览器进程信息数组
     */
    async detectBrowserProcesses() {
        try {
            // 使用缓存减少执行命令次数
            const now = Date.now();
            if (this.browserProcessCache.data.length > 0 && 
                (now - this.browserProcessCache.timestamp) < this.browserProcessCache.ttl) {
                return [...this.browserProcessCache.data];
            }
            
            const platform = process.platform;
            let command = '';
            let processParser;
            
            // 根据平台选择不同的命令和解析方法
            if (platform === 'win32') {
                // Windows平台
                command = 'wmic process where "name=\'chrome.exe\' or name=\'chromium.exe\' or name=\'msedge.exe\'" get processid,creationdate,name,commandline /format:csv';
                processParser = this.parseWindowsProcesses;
            } else if (platform === 'darwin') {
                // macOS平台
                command = 'ps -ax -o pid,etime,ppid,command | grep -E "([Cc]hrome|[Cc]hromium|[Mm]s[Ee]dge)" | grep -v grep';
                processParser = this.parseDarwinProcesses;
            } else {
                // Linux平台
                command = 'ps -eo pid,etime,ppid,cmd | grep -E "([Cc]hrome|[Cc]hromium|[Mm]s[Ee]dge)" | grep -v grep';
                processParser = this.parseLinuxProcesses;
            }
            
            try {
                const { stdout } = await execAsync(command);
                const allProcesses = await processParser.call(this, stdout);
                
                // 只保留主进程，过滤掉子进程和辅助进程
                const mainProcesses = this.filterMainBrowserProcesses(allProcesses);
                
                this.knownBrowserPIDs = new Set(mainProcesses.map(p => p.pid));
                this.browserProcessCache.data = mainProcesses;
                this.browserProcessCache.timestamp = now;
                
                return mainProcesses;
            } catch (cmdError) {
                logger.debug(`使用默认命令检测浏览器失败，尝试备用方法: ${cmdError.message}`);
                if (platform === 'win32') {
                    const { stdout } = await execAsync('tasklist /FO CSV');
                    const processes = await this.parseWindowsBackupList(stdout);
                    
                    this.browserProcessCache.data = processes;
                    this.browserProcessCache.timestamp = now;
                    
                    return processes;
                } else {
                    const { stdout } = await execAsync('ps -A');
                    const processes = await this.parseUnixBackupList(stdout);
                    
                    this.browserProcessCache.data = processes;
                    this.browserProcessCache.timestamp = now;
                    
                    return processes;
                }
            }
        } catch (error) {
            logger.debug('检测浏览器进程失败:', error);
            return [];
        }
    }
    
    /**
     * 过滤出浏览器主进程
     * @param {Array} processes - 所有浏览器相关进程
     * @returns {Array} 浏览器主进程列表
     */
    filterMainBrowserProcesses(processes) {
        if (!processes || processes.length === 0) return [];
        
        // 辅助进程关键词匹配模式
        const helperPatterns = [
            /helper/i, 
            /renderer/i, 
            /gpu-process/i,
            /utility/i, 
            /crashpad/i, 
            /plugin/i, 
            /extension/i,
            /--type=utility/i,
            /--type=renderer/i,
            /--type=gpu-process/i,
            /--type=extension/i,
            /notification/i,
            /nacl/i
        ];
        
        // 主进程通常不带--type参数或是--type=browser
        const mainProcessPatterns = [
            /--type=browser/i,
            /chrome.exe$/i,
            /chromium.exe$/i,
            /msedge.exe$/i,
            /google chrome$/i,
            /google chrome.app/i,
            /chromium$/i,
            /microsoft edge$/i
        ];
        
        // 先按进程ID分组，收集命令行参数
        const processGroups = new Map();
        
        for (const process of processes) {
            const { pid, command } = process;
            if (!processGroups.has(pid)) {
                processGroups.set(pid, process);
            }
        }
        
        // 过滤出主进程
        return Array.from(processGroups.values()).filter(process => {
            const command = process.command || '';
            
            // 是否是辅助进程
            const isHelper = helperPatterns.some(pattern => pattern.test(command));
            if (isHelper) return false;
            
            // 是否是主进程
            const isMain = mainProcessPatterns.some(pattern => pattern.test(command));
            if (isMain) return true;
            
            // 没有明确标志的，没有--type参数的可能是主进程
            return !command.includes('--type=');
        });
    }
    
    /**
     * Windows备用进程列表解析
     * @param {string} output - tasklist命令输出
     * @returns {Array} 浏览器进程数组
     */
    async parseWindowsBackupList(output) {
        const processes = [];
        const lines = output.split('\n');
        const now = Date.now();
        
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            try {
                const parts = line.split(',');
                if (parts.length >= 2) {
                    const name = parts[0].replace(/"/g, '').toLowerCase();
                    const pidStr = parts[1].replace(/"/g, '');
                    
                    if ((name.includes('chrome') || name.includes('chromium') || name.includes('msedge')) && 
                        !name.includes('crashpad')) {
                        const pid = parseInt(pidStr, 10);
                        if (!isNaN(pid)) {
                            const process = {
                                pid,
                                name: name.replace('.exe', ''),
                                startTime: now,
                                command: name
                            };
                            
                            await this.updateBrowserInstance(process);
                            processes.push(process);
                        }
                    }
                }
            } catch (e) {
                continue;
            }
        }
        
        // 过滤筛选最终的主浏览器进程
        return this.filterMainBrowserProcesses(processes);
    }
    
    /**
     * Unix备用进程列表解析
     * @param {string} output - ps命令输出
     * @returns {Array} 浏览器进程数组
     */
    async parseUnixBackupList(output) {
        const processes = [];
        const lines = output.split('\n');
        const now = Date.now();
        const browserPattern = /chrome|chromium|msedge/i;
        
        for (const line of lines) {
            if (!line.trim()) continue;
            
            try {
                if (browserPattern.test(line) && !line.includes('grep')) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 2) {
                        const pid = parseInt(parts[0], 10);
                        if (!isNaN(pid)) {
                            let name = 'browser';
                            if (/chrome/i.test(line)) name = 'chrome';
                            else if (/chromium/i.test(line)) name = 'chromium';
                            else if (/msedge/i.test(line)) name = 'msedge';
                            
                            const process = {
                                pid,
                                name,
                                startTime: now,
                                command: line.trim()
                            };
                            
                            await this.updateBrowserInstance(process);
                            processes.push(process);
                        }
                    }
                }
            } catch (e) {
                continue;
            }
        }
        
        // 过滤筛选最终的主浏览器进程
        return this.filterMainBrowserProcesses(processes);
    }
    
    /**
     * 解析Windows任务列表输出
     * @param {string} output - wmic命令输出
     * @returns {Array} 浏览器进程数组
     */
    async parseWindowsProcesses(output) {
        const processes = [];
        const lines = output.split('\n');
        const now = Date.now();
        
        // 进程映射，用于记录进程ID与命令行
        const processMap = new Map();
        
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            try {
                const parts = line.split(',');
                if (parts.length >= 4) {
                    const pidStr = parts[1];
                    const creationDateStr = parts[2];
                    const name = parts[3].toLowerCase();
                    const command = parts.slice(4).join(',');
                    
                    // 过滤辅助进程
                    if (command.includes('--type=') && 
                        !command.includes('--type=browser')) {
                        continue;
                    }
                    
                    // 过滤崩溃报告和其他非主进程
                    if (command.includes('crashpad') || 
                        command.includes('crash_report') || 
                        command.includes('--utility') || 
                        command.includes('--renderer')) {
                        continue;
                    }
                    
                    const pid = parseInt(pidStr, 10);
                    let startTime = now;
                    if (creationDateStr && creationDateStr.length >= 14) {
                        try {
                            const year = parseInt(creationDateStr.substring(0, 4), 10);
                            const month = parseInt(creationDateStr.substring(4, 6), 10) - 1;
                            const day = parseInt(creationDateStr.substring(6, 8), 10);
                            const hour = parseInt(creationDateStr.substring(8, 10), 10);
                            const minute = parseInt(creationDateStr.substring(10, 12), 10);
                            const second = parseInt(creationDateStr.substring(12, 14), 10);
                            
                            const date = new Date(year, month, day, hour, minute, second);
                            if (!isNaN(date.getTime())) {
                                startTime = date.getTime();
                            }
                        } catch (e) {
                            // 解析创建时间出错，使用当前时间
                        }
                    }
                    
                    if (!isNaN(pid) && (name.includes('chrome') || name.includes('chromium') || name.includes('msedge'))) {
                        // 记录到进程映射
                        if (!processMap.has(pid)) {
                            processMap.set(pid, {
                                pid,
                                name: name.replace('.exe', ''),
                                startTime,
                                command
                            });
                        }
                    }
                }
            } catch (e) {
                logger.debug(`解析Windows进程信息出错: ${e.message}`);
                continue;
            }
        }
        
        // 处理进程间关系
        for (const [pid, process] of processMap.entries()) {
            // 如果是主浏览器进程
            if (!process.command.includes('--type=') || process.command.includes('--type=browser')) {
                await this.updateBrowserInstance(process);
                processes.push(process);
            }
        }
        
        // 按启动时间排序，最新的在前面
        return processes.sort((a, b) => b.startTime - a.startTime);
    }
    
    /**
     * 解析Unix风格的elapsed time (etime)为毫秒
     * @param {string} etimeStr - 例如 "05:45", "2-03:45:12"
     * @returns {number} 毫秒时间戳
     */
    parseElapsedTime(etimeStr) {
        try {
            if (!etimeStr) return 0;
            
            const now = Date.now();
            const parts = etimeStr.trim().split(/[-:]/);
            let days = 0, hours = 0, minutes = 0, seconds = 0;
            
            if (parts.length === 2) {
                minutes = parseInt(parts[0], 10);
                seconds = parseInt(parts[1], 10);
            } else if (parts.length === 3) {
                hours = parseInt(parts[0], 10);
                minutes = parseInt(parts[1], 10);
                seconds = parseInt(parts[2], 10);
            } else if (parts.length === 4) {
                days = parseInt(parts[0], 10);
                hours = parseInt(parts[1], 10);
                minutes = parseInt(parts[2], 10);
                seconds = parseInt(parts[3], 10);
            } else {
                return now;
            }
            const totalMs = (days * 24 * 60 * 60 * 1000) + 
                          (hours * 60 * 60 * 1000) + 
                          (minutes * 60 * 1000) + 
                          (seconds * 1000);
            
            return now - totalMs;
        } catch (e) {
            return Date.now();
        }
    }
    
    /**
     * 解析macOS进程列表输出
     * @param {string} output - ps命令输出
     * @returns {Array} 浏览器进程数组
     */
    async parseDarwinProcesses(output) {
        const processes = [];
        const lines = output.split('\n');
        
        // 临时存储所有进程，以便后续筛选
        const allProcesses = new Map();
        
        for (const line of lines) {
            if (!line.trim()) continue;
            
            try {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 4) continue;
                
                const pid = parseInt(parts[0], 10);
                const etimeStr = parts[1];
                const ppid = parseInt(parts[2], 10); // 父进程ID
                const command = parts.slice(3).join(' ');
                
                // 过滤掉明显的辅助进程
                if (command.includes('Helper') || 
                    command.includes('renderer') ||
                    command.includes('--type=') && !command.includes('--type=browser')) {
                    continue;
                }
                
                const startTime = this.parseElapsedTime(etimeStr);
                
                if (!isNaN(pid)) {
                    let name = 'browser';
                    if (/chrome/i.test(command)) name = 'chrome';
                    else if (/chromium/i.test(command)) name = 'chromium';
                    else if (/msedge/i.test(command)) name = 'msedge';
                    
                    allProcesses.set(pid, {
                        pid,
                        ppid,
                        name,
                        startTime,
                        command,
                        isMainProcess: this.isBrowserMainProcess(command)
                    });
                }
            } catch (e) {
                logger.debug(`解析MacOS进程信息出错: ${e.message}`);
                continue;
            }
        }
        
        // 只保留主浏览器进程
        for (const [pid, process] of allProcesses.entries()) {
            if (process.isMainProcess) {
                delete process.isMainProcess;
                delete process.ppid;
                await this.updateBrowserInstance(process);
                processes.push(process);
            }
        }
        
        return processes.sort((a, b) => b.startTime - a.startTime);
    }
    
    /**
     * 判断是否是浏览器主进程
     * @param {string} command - 进程命令行
     * @returns {boolean} 是否是主进程
     */
    isBrowserMainProcess(command) {
        if (!command) return false;
        
        // 辅助进程排除条件
        if (command.includes('--type=') && !command.includes('--type=browser')) {
            return false;
        }
        
        if (command.includes('Helper') || 
            command.includes('renderer') || 
            command.includes('gpu-process') || 
            command.includes('utility') || 
            command.includes('crashpad')) {
            return false;
        }
        
        // 明确的主进程标志
        if (command.includes('--type=browser') || 
            /Google Chrome$/.test(command) || 
            /Microsoft Edge$/.test(command) || 
            /Chromium$/.test(command) ||
            /chrome.exe$/.test(command) ||
            /msedge.exe$/.test(command) ||
            /chromium.exe$/.test(command)) {
            return true;
        }
        
        // 没有类型标记的可能是主进程
        return !command.includes('--type=');
    }
    
    /**
     * 解析Linux进程列表输出
     * @param {string} output - ps命令输出
     * @returns {Array} 浏览器进程数组
     */
    async parseLinuxProcesses(output) {
        const processes = [];
        const lines = output.split('\n');
        
        // 临时存储所有进程，以便后续筛选
        const allProcesses = new Map();
        
        for (const line of lines) {
            if (!line.trim()) continue;
            
            try {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 4) continue;
                
                const pid = parseInt(parts[0], 10);
                const etimeStr = parts[1];
                const ppid = parseInt(parts[2], 10); // 父进程ID
                const command = parts.slice(3).join(' ');
                
                // 基础浏览器名称检测
                const isBrowser = /chrome|chromium|msedge/i.test(command);
                
                // 跳过辅助进程和非浏览器进程
                if (!isBrowser || 
                    (command.includes('--type=') && !command.includes('--type=browser')) || 
                    command.includes('crashpad') || 
                    command.includes('helper')) {
                    continue;
                }
                
                const startTime = this.parseElapsedTime(etimeStr);
                
                if (!isNaN(pid)) {
                    let name = 'browser';
                    if (/chrome/i.test(command)) name = 'chrome';
                    else if (/chromium/i.test(command)) name = 'chromium';
                    else if (/msedge/i.test(command)) name = 'msedge';
                    
                    allProcesses.set(pid, {
                        pid,
                        ppid,
                        name,
                        startTime,
                        command,
                        isMainProcess: this.isBrowserMainProcess(command)
                    });
                }
            } catch (e) {
                logger.debug(`解析Linux进程信息出错: ${e.message}`);
                continue;
            }
        }
        
        // 只保留主浏览器进程
        for (const [pid, process] of allProcesses.entries()) {
            if (process.isMainProcess) {
                delete process.isMainProcess;
                delete process.ppid;
                await this.updateBrowserInstance(process);
                processes.push(process);
            }
        }
        
        return processes.sort((a, b) => b.startTime - a.startTime);
    }
    
    /**
     * 更新数据库中的浏览器实例记录
     * @param {Object} process - 进程信息对象
     */
    async updateBrowserInstance(process) {
        if (!this.db || !process || !process.pid) return;
        
        try {
            const existing = await this.db.get(
                'SELECT * FROM browser_instances WHERE pid = ?',
                process.pid
            );
            
            const now = Date.now();
            const isMainProcess = process.isMainProcess !== false ? 1 : 0;
            
            if (existing) {
                await this.db.run(
                    'UPDATE browser_instances SET name = ?, last_seen = ?, command = ?, is_main_process = ? WHERE pid = ?',
                    process.name,
                    now,
                    process.command,
                    isMainProcess,
                    process.pid
                );
            } else {
                await this.db.run(
                    'INSERT INTO browser_instances (pid, name, start_time, last_seen, command, is_main_process) VALUES (?, ?, ?, ?, ?, ?)',
                    process.pid,
                    process.name,
                    process.startTime || now,
                    now,
                    process.command,
                    isMainProcess
                );
            }
        } catch (error) {
            logger.debug(`更新浏览器实例记录失败: ${error.message}`);
            this.reconnectDatabase();
        }
    }
    
    /**
     * 从数据库获取进程启动时间
     * @param {number} pid - 进程ID
     * @returns {Promise<number|null>} 进程启动时间戳或null
     */
    async getProcessStartTimeFromDB(pid) {
        if (!this.db || !pid) return null;
        
        try {
            const record = await this.db.get(
                'SELECT start_time FROM browser_instances WHERE pid = ?',
                pid
            );
            
            return record ? record.start_time : null;
        } catch (error) {
            return null;
        }
    }
    
    /**
     * 清理多余的浏览器实例
     * @param {Array} browserProcesses - 浏览器进程信息数组
     */
    async cleanupExcessBrowsers(browserProcesses) {
        if (!browserProcesses || browserProcesses.length === 0) return;
        
        // 确保只处理主浏览器进程
        const mainProcesses = browserProcesses;
        
        // 如果没有超过限制，则不需要清理
        if (mainProcesses.length <= this.maxAllowedInstances) {
            return;
        }
        
        const sortedProcesses = [...mainProcesses].sort((a, b) => b.startTime - a.startTime);
        
        const excessCount = Math.max(0, sortedProcesses.length - this.maxAllowedInstances);
        
        if (excessCount === 0) return;
        
        let toRemove = [];
        
        if (this.reserveNewest) {
            toRemove = sortedProcesses.slice(this.maxAllowedInstances);
            logger.debug(`保留${this.maxAllowedInstances}个最新浏览器实例，清理${toRemove.length}个最老的实例`);
        } else {
            toRemove = sortedProcesses.slice(this.maxAllowedInstances);
            logger.debug(`按照配置保留${this.maxAllowedInstances}个浏览器实例，清理${toRemove.length}个额外的实例`);
        }
        
        if (toRemove.length === 0) return;
        
        const pidsToKill = toRemove.map(p => p.pid);
        
        let successCount = 0;
        
        for (const pid of pidsToKill) {
            try {
                const killed = await this.killBrowserProcess(pid);
                if (killed) {
                    successCount++;
                }
            } catch (error) {
                // 静默处理错误
            }
        }
        if (successCount > 0) {
            logger.done(`成功清理了 ${successCount}/${toRemove.length} 个浏览器实例`);
        }
    }
    
    /**
     * 终止指定的浏览器进程
     * @param {number} pid - 进程ID
     * @returns {Promise<boolean>} 是否成功终止进程
     */
    async killBrowserProcess(pid) {
        if (!pid || isNaN(pid)) return false;
        
        const errorKey = `kill_${pid}`;
        
        try {
            const exists = await this.checkProcessExists(pid);
            if (!exists) {
                this.knownBrowserPIDs.delete(pid);
                if (this.db) {
                    await this.db.run('DELETE FROM browser_instances WHERE pid = ?', pid);
                }
                return true;
            }
            const command = process.platform === 'win32' ? 
                `taskkill /F /PID ${pid}` : `kill -15 ${pid}`;
            
            await execAsync(command);
            this.knownBrowserPIDs.delete(pid);
            if (this.db) {
                try {
                    await this.db.run('DELETE FROM browser_instances WHERE pid = ?', pid);
                } catch (dbError) {
                    this.reconnectDatabase();
                }
            }
            if (this.errorCounts[errorKey]) {
                delete this.errorCounts[errorKey];
            }
            
            return true;
        } catch (error) {
            this.errorCounts[errorKey] = (this.errorCounts[errorKey] || 0) + 1;
            if (this.errorCounts[errorKey] === 1) {
                logger.debug(`终止进程 ${pid} 失败: ${error.message}`);
            }
            if (process.platform !== 'win32' && this.errorCounts[errorKey] <= 3) {
                try {
                    await execAsync(`kill -9 ${pid}`);
                    this.knownBrowserPIDs.delete(pid);
                    if (this.db) {
                        try {
                            await this.db.run('DELETE FROM browser_instances WHERE pid = ?', pid);
                        } catch (dbError) {
                            this.reconnectDatabase();
                        }
                    }
                    
                    delete this.errorCounts[errorKey];
                    return true;
                } catch (innerError) {
                    const stillExists = await this.checkProcessExists(pid);
                    if (!stillExists) {
                        this.knownBrowserPIDs.delete(pid);
                        if (this.db) {
                            try {
                                await this.db.run('DELETE FROM browser_instances WHERE pid = ?', pid);
                            } catch (dbError) {
                                this.reconnectDatabase();
                            }
                        }
                        delete this.errorCounts[errorKey];
                        return true;
                    }
                }
            }
            
            return false;
        }
    }
    
    /**
     * 获取系统内存信息
     * @returns {Promise<Object>} 内存信息对象
     */
    async getSystemMemoryInfo() {
        try {
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const used = totalMem - freeMem;
            const usedPercent = (used / totalMem) * 100;
            
            return {
                total: totalMem,
                used,
                free: freeMem,
                usedPercent
            };
        } catch (error) {
            // 静默处理错误
            logger.debug('获取系统内存信息失败:', error);
            return {
                total: 0,
                used: 0,
                free: 0,
                usedPercent: 0
            };
        }
    }
    
    /**
     * 获取系统CPU信息
     * @returns {Promise<Object>} CPU信息对象
     */
    async getSystemCPUInfo() {
        try {
            const loadAvg = os.loadavg();
            
            return {
                loadAvg
            };
        } catch (error) {
            logger.debug('获取系统CPU信息失败:', error);
            return {
                loadAvg: [0, 0, 0]
            };
        }
    }
    
    /**
     * 强制清理所有浏览器实例
     * @param {Object} options - 清理选项
     * @param {boolean} options.preserveNewest - 是否保留最新的实例
     * @param {number} options.keepCount - 保留的实例数量
     */
    async forceCleanupAllBrowsers(options = {}) {
        try {
            const processes = await this.detectBrowserProcesses();
            
            if (processes.length === 0) {
                logger.debug('没有检测到浏览器实例');
                return { success: true, count: 0 };
            }
            
            let toRemove = [...processes];
            if (options.preserveNewest && processes.length > 0) {
                const keepCount = options.keepCount || 1;
                const sortedProcesses = [...processes].sort((a, b) => b.startTime - a.startTime);
                toRemove = sortedProcesses.slice(keepCount);
                
                logger.debug(`保留${keepCount}个最新的浏览器实例，准备清理${toRemove.length}个实例`);
            } else {
                logger.debug(`准备清理全部${toRemove.length}个浏览器实例`);
            }
            
            if (toRemove.length === 0) {
                return { success: true, count: 0, preserved: processes.length - toRemove.length };
            }
            
            let successCount = 0;
            for (const process of toRemove) {
                try {
                    const killed = await this.killBrowserProcess(process.pid);
                    if (killed) successCount++;
                } catch (error) {
                    // 静默处理错误
                }
            }
            
            const result = { 
                success: true, 
                count: successCount,
                total: toRemove.length,
                preserved: processes.length - toRemove.length
            };
            
            if (successCount > 0) {
                logger.done(`成功清理了 ${successCount}/${toRemove.length} 个浏览器实例`);
            } else if (toRemove.length > 0) {
                logger.warning(`未能成功清理任何浏览器实例`);
            }
            
            return result;
        } catch (error) {
            logger.debug('强制清理浏览器失败:', error);
            return { 
                success: false, 
                error: error.message,
                count: 0,
                total: 0
            };
        }
    }
}

/**
 * 浏览器监控工具
 * 提供独立的浏览器监控功能API
 */
class BrowserMonitorTool {
    static async getSystemStatus() {
        const monitor = BrowserMonitor.getInstance();
        return await monitor.getSystemStatus();
    }
    
    static async startMonitoring(interval = 30000, options = {}) {
        const monitor = BrowserMonitor.getInstance();
        const initialized = await monitor.init();
        
        if (!initialized) {
            logger.debug('浏览器监控已经在运行中，不需要重新启动');
            return true;
        }
        
        await monitor.startMonitoring(interval, options);
        return true;
    }
    
    static async stopMonitoring() {
        const monitor = BrowserMonitor.getInstance();
        await monitor.stopMonitoring();
        return true;
    }
    
    static async forceCleanupAllBrowsers(options = {}) {
        const monitor = BrowserMonitor.getInstance();
        return await monitor.forceCleanupAllBrowsers(options);
    }
    
    static async getStats() {
        try {
            const db = await DB.getInstance();
            const systemStats = await db.get(
                `SELECT AVG(browser_count) as avgBrowserCount,
                 MAX(browser_count) as maxBrowserCount,
                 AVG(memory_usage) as avgMemoryUsage,
                 COUNT(*) as measurementsCount
                 FROM system_browser_stats`
            );
            
            const monitor = BrowserMonitor.getInstance();
            const currentStatus = await monitor.getSystemStatus();
            
            return {
                currentStatus,
                historical: {
                    avgBrowserCount: systemStats ? Math.round(systemStats.avgBrowserCount || 0) : 0,
                    maxBrowserCount: systemStats ? systemStats.maxBrowserCount || 0 : 0,
                    avgMemoryUsage: systemStats ? Math.round(systemStats.avgMemoryUsage || 0) : 0,
                    measurementsCount: systemStats ? systemStats.measurementsCount || 0 : 0
                }
            };
        } catch (error) {
            logger.debug('获取监控统计信息失败:', error);
            return {
                currentStatus: null,
                historical: {
                    avgBrowserCount: 0,
                    maxBrowserCount: 0,
                    avgMemoryUsage: 0,
                    measurementsCount: 0
                }
            };
        }
    }
    
    static async isMonitorRunning() {
        try {
            const db = await DB.getInstance();
            const status = await db.get('SELECT * FROM browser_monitor_status WHERE id = 1');
            
            if (!status || status.is_running !== 1) {
                return false;
            }
            const monitor = BrowserMonitor.getInstance();
            const pidExists = await monitor.checkProcessExists(status.pid);
            
            return pidExists;
        } catch (error) {
            return false;
        }
    }
    
    static async reportCurrentStatus() {
        const monitor = BrowserMonitor.getInstance();
        await monitor.reportStatus();
        return true;
    }
    
    static async getBrowserInstances() {
        try {
            const db = await DB.getInstance();
            // 只获取主进程浏览器实例
            const instances = await db.all('SELECT * FROM browser_instances WHERE is_main_process = 1 ORDER BY start_time DESC');
            return instances || [];
        } catch (error) {
            logger.debug('获取浏览器实例列表失败:', error);
            return [];
        }
    }
}

process.on('exit', async () => {
    try {
        await DB.close();
    } catch (error) {
        // 静默处理错误
    }
});

// 导出监控工具和类
export const BrowserMonitorAPI = BrowserMonitorTool;
export { BrowserMonitor, DB };

export default async function startBrowserMonitoring(options = {}) {
    try {
        const isRunning = await BrowserMonitorTool.isMonitorRunning();
        
        if (isRunning) {
            logger.debug('浏览器监控服务已在运行，跳过启动');
            return true;
        }
        
        const defaultOptions = {
            interval: 30000,
            maxInstances: 3,
            memoryThreshold: 80,
            reportFrequency: 3600000, // 默认每小时报告一次
            reserveNewest: true // 默认保留最新打开的浏览器实例
        };
        
        const finalOptions = { ...defaultOptions, ...options };
        
        const success = await BrowserMonitorTool.startMonitoring(finalOptions.interval, {
            maxInstances: finalOptions.maxInstances,
            memoryThreshold: finalOptions.memoryThreshold,
            reportFrequency: finalOptions.reportFrequency,
            reserveNewest: finalOptions.reserveNewest
        });
        
        if (success) {
            logger.debug('浏览器监控服务已启动');
            logger.debug(`配置: 最大实例数:${finalOptions.maxInstances}, 保留最新实例:${finalOptions.reserveNewest ? '是' : '否'}`);
            setTimeout(() => {
                BrowserMonitorTool.reportCurrentStatus();
            }, 5000);
            
            return true;
        } else {
            logger.debug('浏览器监控服务启动失败');
            return false;
        }
    } catch (error) {
        logger.debug('启动浏览器监控失败:', error);
        return false;
    }
}